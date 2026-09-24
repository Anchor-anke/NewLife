import { z } from 'zod';
import { resolveOpenLife } from '@/lib/engine/open-life';
import type { CharacterState, ModelMeta, WorldSetting } from '@/lib/engine/types';
import type { ChatMessage, ModelAdapter } from '@/lib/model/adapter';
import { extractJsonObject } from '@/lib/model/json';
import { fushengJi } from './fusheng-ji';
import { buildForgeRepairMessage } from './forge-prompt';
import { ForgeError, MAX_FORGE_ATTEMPTS, type ForgeStage } from './forge';

const zOpenDraft = z.object({
  name: z.string().trim().min(2).max(24),
  description: z.string().trim().min(10),
  initialWorldStatus: z.string().trim().min(8),
  rules: z.array(z.string().trim().min(4)).min(3).max(8),
  startingAge: z.coerce.number().int().min(16).max(40),
  attributeLabels: z.object({
    career: z.string().trim().min(1).max(8),
    health: z.string().trim().min(1).max(8),
    insight: z.string().trim().min(1).max(8),
    empathy: z.string().trim().min(1).max(8),
    fortune: z.string().trim().min(1).max(8),
    spirit: z.string().trim().min(1).max(8),
    wealth: z.string().trim().min(1).max(8),
  }),
  talents: z.array(z.object({
    name: z.string().trim().min(1),
    description: z.string().trim().min(4),
    bonusKey: z.enum(['career', 'health', 'insight', 'empathy', 'fortune', 'spirit', 'wealth']),
    bonus: z.coerce.number().int().min(-20).max(20),
  })).min(3).max(8),
  lethalEventKeywords: z.array(z.string().trim().min(2)).min(2).max(12),
  aging: z.boolean(),
  worldResources: z.array(z.object({
    key: z.string().regex(/^[a-z][a-z0-9_]{1,19}$/),
    label: z.string().trim().min(2).max(10),
    initialValue: z.number().int().min(10).max(90),
    annualDelta: z.number().int().min(-5).max(0),
  })).min(1).max(3),
  objective: z.object({
    scope: z.enum(['actor', 'world']),
    key: z.string(),
    threshold: z.number().int().min(10).max(100),
    reason: z.string().trim().min(2).max(40),
    narrative: z.string().trim().min(8).max(200),
  }),
  failure: z.object({
    key: z.string(),
    threshold: z.number().int().min(0).max(30),
    reason: z.string().trim().min(2).max(40),
    narrative: z.string().trim().min(8).max(200),
  }),
}).superRefine((draft, ctx) => {
  const resources = new Map(draft.worldResources.map((resource) => [resource.key, resource]));
  if (resources.size !== draft.worldResources.length) ctx.addIssue({ code: 'custom', path: ['worldResources'], message: '资源键不能重复' });
  const failureResource = resources.get(draft.failure.key);
  if (!failureResource || failureResource.annualDelta >= 0 || draft.failure.threshold >= failureResource.initialValue) {
    ctx.addIssue({ code: 'custom', path: ['failure'], message: '失败条件必须引用会逐年消耗、且开局尚未耗尽的世界资源' });
  }
  const goalResource = draft.objective.scope === 'world' ? resources.get(draft.objective.key) : undefined;
  if (draft.objective.scope === 'world' && (!goalResource || draft.objective.threshold <= goalResource.initialValue)) {
    ctx.addIssue({ code: 'custom', path: ['objective'], message: '世界目标必须引用资源，目标值高于开局值' });
  }
  if (draft.objective.scope === 'actor' && (draft.objective.key !== 'career' || draft.objective.threshold <= 0)) {
    ctx.addIssue({ code: 'custom', path: ['objective'], message: '人物目标目前只能引用 career，目标值需高于开局值' });
  }
  if (fushengJi.attributes.some((attribute) => resources.has(attribute.key))) {
    ctx.addIssue({ code: 'custom', path: ['worldResources'], message: '资源键不能与人物属性或旧版阶位键冲突' });
  }
});

export type OpenForgeDraft = z.infer<typeof zOpenDraft>;

export const OPEN_FORGE_SYSTEM_PROMPT = `你是互动人生模拟器的世界设计师。玩家选择了「开放人生」：人物经历选择、关系、健康和事业变化，绝无自动等级突破或按地位延长寿命。请设计可由程序执行的资源、目标和失败条件。

只输出一个 JSON 对象，结构如下：
{
  "name": "世界名",
  "description": "两句话说明背景与玩家身份",
  "initialWorldStatus": "开局时的具体局势",
  "rules": ["三到八条具体且可执行的世界法则"],
  "startingAge": 20,
  "attributeLabels": {
    "career": "事业或个人目标的名称",
    "health": "健康或体魄的名称",
    "insight": "知识或技能的名称",
    "empathy": "社交或关系能力的名称",
    "fortune": "运气的名称",
    "spirit": "精神或意志的名称",
    "wealth": "可支配资源的名称"
  },
  "talents": [{"name":"出身或特质","description":"具体来历与代价","bonusKey":"insight","bonus":12}],
  "lethalEventKeywords": ["重伤", "事故", "濒死"],
  "aging": true,
  "worldResources": [{"key":"supplies","label":"公共补给","initialValue":50,"annualDelta":-2}],
  "objective": {"scope":"actor","key":"career","threshold":70,"reason":"完成守护目标","narrative":"你在 {age} 岁完成了长期目标。"},
  "failure": {"key":"supplies","threshold":0,"reason":"公共补给耗尽","narrative":"补给耗尽，这一轮守护在你 {age} 岁时失败。"}
}

要求：所有文案用简体中文；天赋给三到八个，bonusKey 只能是属性键之一；bonus 范围 -20 到 20。worldResources 给 1~3 个世界资源，key 用小写英文且不得与人物属性重名，数值范围 0~100，开局 10~90，annualDelta 为 -5~0。failure 必须引用其中一个 annualDelta 为负的资源，阈值低于开局值。objective 可引用人物 career 或一个世界资源，目标阈值高于开局值。aging 表示角色是否会自然衰老；无衰老不等于不会受伤。资源耗尽与目标达成由程序自动判定，不要让自然语言法则与这些数值条件冲突。不要输出阶位、突破概率或寿命阶梯。`;

export interface OpenForgeReport {
  kind: 'open_life';
  startingAge: number;
  maxAge: number;
  /** 无模型、无事件变化的确定性推进，用于检查规则能否自然收束。 */
  neutralSegments: number;
  neutralEnding: 'health' | 'old-age' | 'objective' | 'resource' | 'turn-limit' | 'missing';
}

export interface OpenForgeOutput {
  world: WorldSetting;
  notes: string[];
  problems: string[];
  report: OpenForgeReport;
  modelMeta: ModelMeta;
}

export interface OpenForgeInput {
  premise: string;
  adapter: ModelAdapter;
  id: string;
  signal?: AbortSignal;
  onStage?: (stage: ForgeStage) => void;
}

export function expandOpenDraft(draft: OpenForgeDraft, id: string): WorldSetting {
  return {
    ...fushengJi,
    id,
    name: draft.name,
    description: draft.description,
    initialWorldStatus: draft.initialWorldStatus,
    rules: draft.rules,
    attributes: fushengJi.attributes.map((attribute) => ({
      ...attribute,
      ...(attribute.key in draft.attributeLabels
        ? { label: draft.attributeLabels[attribute.key as keyof OpenForgeDraft['attributeLabels']] }
        : {}),
    })),
    // 旧版 mechanics 只满足存档结构；open_life 从不读取其中的阶位与寿元。
    mechanics: structuredClone(fushengJi.mechanics),
    ruleset: {
      ...fushengJi.ruleset!,
      kind: 'open_life',
      startingAge: draft.startingAge,
      lethalEventKeywords: draft.lethalEventKeywords,
      maxAge: draft.aging ? 105 : 10000,
      custom: {
        aging: draft.aging,
        annualWorldDeltas: Object.fromEntries(draft.worldResources.map((resource) => [resource.key, resource.annualDelta])),
        objective: { ...draft.objective, operator: 'gte' },
        failure: { ...draft.failure, scope: 'world', operator: 'lte' },
      },
    },
    worldAttributes: draft.worldResources.map((resource) => ({
      key: resource.key, label: resource.label, initialValue: resource.initialValue,
      min: 0, max: 100, kind: 'resource', integer: true, primary: true,
    })),
    talents: draft.talents.map((talent, index) => ({
      id: `talent-${index + 1}`,
      name: talent.name,
      description: talent.description,
      modifiers: {},
      attributeBonus: { [talent.bonusKey]: talent.bonus },
    })),
    endings: {
      ...fushengJi.endings,
      turnLimit: {
        reason: '这一段人生在此收束',
        narrative: '你在 {age} 岁回望走过的路，为这一段人生画下句点。',
      },
      deathByProposal: '{reason}。你在 {age} 岁离开了这个世界。',
      completionByProposal: '{reason}。你在 {age} 岁为这一段人生作了收束。',
    },
  };
}

/** 只检查规则本身；这不是对模型实际剧情分布的预测。 */
export function checkOpenWorld(world: WorldSetting): { report: OpenForgeReport; problems: string[] } {
  const rules = world.ruleset;
  if (!rules || rules.kind !== 'open_life') throw new Error('开放人生世界缺少规则');
  let character: CharacterState = {
    name: '规则检查', age: rules.startingAge, isAlive: true,
    attributes: Object.fromEntries(world.attributes.filter((attribute) => !rules.legacyHiddenKeys.includes(attribute.key))
      .map((attribute) => [attribute.key, attribute.initialValue])),
    traits: [], inventory: [], relationships: {},
  };
  let ending: OpenForgeReport['neutralEnding'] = 'missing';
  let worldAttributes = Object.fromEntries((world.worldAttributes ?? []).map((resource) => [resource.key, resource.initialValue]));
  let neutralSegments = 0;
  while (neutralSegments < rules.segmentSoftLimit) {
    const nextAge = character.age + 3;
    const result = resolveOpenLife({
      world, character, worldStatus: world.initialWorldStatus, worldAttributes,
      proposal: {
        entries: [{ age: nextAge, kind: 'event', text: '平静的三年过去了。' }],
        timeAdvance: 3,
        attributeDeltas: {},
      },
      segmentId: neutralSegments + 1,
      lastDecisionSegmentId: 0,
      stopPlan: { stop: false },
      rng: () => 0.5,
    });
    neutralSegments += 1;
    character = result.character;
    worldAttributes = result.worldAttributes ?? worldAttributes;
    if (result.ending) {
      ending = result.breakdown.endingCause === 'health' ? 'health'
        : result.breakdown.endingCause === 'old-age' ? 'old-age'
          : result.breakdown.endingCause === 'custom-objective' ? 'objective'
            : result.breakdown.endingCause === 'custom-failure' ? 'resource'
              : result.breakdown.endingCause === 'turn-limit' ? 'turn-limit' : 'missing';
      break;
    }
  }
  return {
    report: { kind: 'open_life', startingAge: rules.startingAge, maxAge: rules.maxAge, neutralSegments, neutralEnding: ending },
    problems: ending === 'missing' ? ['无事件变化时，故事未能按世界规则收束'] : [],
  };
}

export async function forgeOpenWorld(input: OpenForgeInput): Promise<OpenForgeOutput> {
  const messages: ChatMessage[] = [
    { role: 'system', content: OPEN_FORGE_SYSTEM_PROMPT },
    { role: 'user', content: `玩家想经历的世界：\n「${input.premise.trim()}」\n请按开放人生模板扩展，只输出 JSON。` },
  ];
  let latencyMs = 0;
  let retries = 0;
  let issues: string[] = [];
  for (let attempt = 0; attempt <= MAX_FORGE_ATTEMPTS; attempt += 1) {
    input.onStage?.(attempt === 0 ? 'designing' : 'repairing');
    const response = await input.adapter.complete(
      { messages, json: true, temperature: 0.9 },
      input.signal ? { signal: input.signal } : {},
    );
    latencyMs += response.latencyMs;
    const raw = extractJsonObject(response.text);
    const validated = raw === null ? null : zOpenDraft.safeParse(raw);
    if (validated?.success) {
      const world = expandOpenDraft(validated.data, input.id);
      input.onStage?.('tuning');
      const { report, problems } = checkOpenWorld(world);
      return {
        world, report, problems, notes: [],
        modelMeta: { provider: input.adapter.provider, model: input.adapter.model, latencyMs, retries },
      };
    }
    issues = raw === null ? ['返回内容不是合法的 JSON 对象']
      : validated && !validated.success
        ? validated.error.issues.slice(0, 8).map((issue) => `${issue.path.join('.') || '(根)'}：${issue.message}`)
        : ['世界草稿不合法'];
    retries += 1;
    messages.push({ role: 'assistant', content: response.text.slice(0, 4000) });
    messages.push({ role: 'user', content: buildForgeRepairMessage(issues, response.text) });
  }
  throw new ForgeError(issues);
}
