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
});

export type OpenForgeDraft = z.infer<typeof zOpenDraft>;

export const OPEN_FORGE_SYSTEM_PROMPT = `你是互动人生模拟器的世界设计师。玩家选择了「开放人生」：人物经历选择、关系、健康和事业变化，绝无自动等级突破或按地位延长寿命。可写现实、历史或低奇幻题材，但玩家是会自然衰老的人类。

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
  "lethalEventKeywords": ["重伤", "事故", "濒死"]
}

要求：所有文案用简体中文；天赋给三到八个，bonusKey 只能是属性键之一；bonus 范围 -20 到 20。不要输出阶位、寿命表、突破概率或数值曲线。程序会校验并结算状态。`;

export interface OpenForgeReport {
  kind: 'open_life';
  startingAge: number;
  maxAge: number;
  /** 无模型、无事件变化的确定性推进，用于检查规则能否自然收束。 */
  neutralSegments: number;
  neutralEnding: 'health' | 'old-age' | 'missing';
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
      maxAge: 105,
    },
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
  let ending: 'health' | 'old-age' | 'missing' = 'missing';
  let neutralSegments = 0;
  while (neutralSegments < rules.segmentSoftLimit) {
    const nextAge = character.age + 3;
    const result = resolveOpenLife({
      world, character, worldStatus: world.initialWorldStatus,
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
    if (result.ending) {
      ending = result.breakdown.endingCause === 'health' ? 'health'
        : result.breakdown.endingCause === 'old-age' ? 'old-age' : 'missing';
      break;
    }
  }
  return {
    report: { kind: 'open_life', startingAge: rules.startingAge, maxAge: rules.maxAge, neutralSegments, neutralEnding: ending },
    problems: ending === 'missing' ? ['无事件变化时，人生未能按健康或年龄规则自然收束'] : [],
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
