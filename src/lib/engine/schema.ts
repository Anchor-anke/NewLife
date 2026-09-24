import { z } from 'zod';
import { ENTRY_KINDS, type SegmentProposal } from './types';

/**
 * 结构校验层。
 *
 * 职责边界很重要：这里**只判断「形状对不对」**，不判断「数值合不合理」。
 * 形状不对 → 触发带错误回灌的重试；数值越界 → 交给 `normalize.ts` 裁剪并记警告。
 * 这样划分可以避免因为「声望 +100」这类可修正的问题白白浪费一次模型调用。
 *
 * 唯一的例外是**条目类型分布**：连续 3 条同类型的条目属于「形状对了但写法错了」，
 * 修不回来（程序没法替模型想出别的类型），只能回灌重试，因此放在这一层。
 */

/**
 * 接受有限数值，也接受可解析为有限数的字符串——模型偶尔会把数字写成 `"12"`。
 * 无法解析为数值的输入原样返回，交由 `z.number()` 判为类型错误。
 */
const zNumeric = z.preprocess((value) => {
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return value;
}, z.number());

const zListOp = z.object({
  op: z.enum(['add', 'remove']),
  value: z.string().min(1).max(80),
});

const zRelOp = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('set'),
    target: z.string().min(1).max(80),
    value: z.string().min(1).max(200),
  }),
  z.object({
    op: z.literal('remove'),
    target: z.string().min(1).max(80),
  }),
]);

const zEndingProposal = z.object({
  type: z.enum(['death', 'completion']),
  reason: z.string().min(1).max(300),
});

// ────────────────────────────────────────────────────────────
// 段落提议
// ────────────────────────────────────────────────────────────

/** 单条条目。文本长度在这里放得很宽——超长属于「能修」的问题，交给 normalize 截断。 */
const zEntry = z.object({
  age: zNumeric,
  kind: z.enum(ENTRY_KINDS as unknown as [string, ...string[]]),
  text: z.string().min(1).max(200),
  detail: z.string().max(4000).nullish(),
});

const zDecisionProposal = z.object({
  prompt: z.string().min(1).max(600),
  // 缺失比出错好：没有 stakes 时由 normalize 填一句兜底，不值得为此重试一次
  stakes: z.string().max(300).default(''),
  options: z.array(z.string().min(1).max(120)).min(2).max(6),
});

/** 连续同类型的条目上限。达到这个数量就视为流水账，回灌重试。 */
const MAX_CONSECUTIVE_SAME_KIND = 3;

/** 找出最长的「同类型连续段」长度。 */
function longestSameKindRun(entries: readonly { kind: string }[]): number {
  let longest = 0;
  let current = 0;
  let previous: string | undefined;

  for (const entry of entries) {
    current = entry.kind === previous ? current + 1 : 1;
    previous = entry.kind;
    if (current > longest) longest = current;
  }

  return longest;
}

export const segmentProposalSchema = z
  .object({
    entries: z.array(zEntry).min(1).max(16),
    timeAdvance: zNumeric,
    attributeDeltas: z.record(z.string(), zNumeric).default({}),
    worldDeltas: z.record(z.string(), zNumeric).optional(),
    worldStatusUpdate: z.string().max(4000).nullish(),
    traitOps: z.array(zListOp).max(10).nullish(),
    inventoryOps: z.array(zListOp).max(20).nullish(),
    relationshipOps: z.array(zRelOp).max(20).nullish(),
    decision: zDecisionProposal.nullish(),
    endingProposal: zEndingProposal.nullish(),
  })
  // 条目写成流水账（「你修炼了」×N）是这套叙事最典型的退化形态，只能重试不能修
  .refine((proposal) => longestSameKindRun(proposal.entries) < MAX_CONSECUTIVE_SAME_KIND, {
    message: `连续 ${MAX_CONSECUTIVE_SAME_KIND} 条以上的条目类型完全相同，读起来像流水账；请把不同类型的事情交替铺开`,
    path: ['entries'],
  });

export type ParsedSegmentProposal = z.infer<typeof segmentProposalSchema>;

// ────────────────────────────────────────────────────────────
// 错误信息精简
// ────────────────────────────────────────────────────────────

interface ZodIssueLike {
  code?: string;
  path?: readonly PropertyKey[];
  message?: string;
  expected?: unknown;
  received?: unknown;
}

function describeIssue(issue: ZodIssueLike): string {
  const received = typeof issue.received === 'string' ? issue.received : undefined;

  switch (issue.code) {
    case 'invalid_type':
      return received
        ? `期望 ${String(issue.expected ?? '?')}，实际收到 ${received}`
        : (issue.message ?? '类型不符');
    case 'too_small':
    case 'too_big':
    case 'invalid_format':
    case 'invalid_value':
    case 'invalid_union':
      return issue.message ?? '取值不符合约定';
    case 'unrecognized_keys':
      return issue.message ?? '包含未约定的字段';
    default:
      return issue.message ?? '不符合约定结构';
  }
}

/**
 * 把 zod 的问题列表压成紧凑的中文说明。
 *
 * 回灌给模型的错误信息会占用上下文，因此必须精简：最多 8 条，
 * 每条形如 `attributeDeltas.cultivation: 期望 number，实际收到 string`。
 */
export function formatIssues(issues: readonly ZodIssueLike[]): string[] {
  return issues.slice(0, 8).map((issue) => {
    const path =
      issue.path && issue.path.length > 0 ? issue.path.map(String).join('.') : '(根对象)';
    return `${path}: ${describeIssue(issue)}`;
  });
}

// ────────────────────────────────────────────────────────────
// 解析入口
// ────────────────────────────────────────────────────────────

export type ParseResult =
  | { ok: true; proposal: SegmentProposal }
  | { ok: false; issues: string[] };

/** 把 schema 输出（含 null 的可选字段）收敛为严格的 `SegmentProposal`。 */
function toSegmentProposal(parsed: ParsedSegmentProposal): SegmentProposal {
  const proposal: SegmentProposal = {
    entries: parsed.entries.map((entry) => {
      const result: SegmentProposal['entries'][number] = {
        age: entry.age,
        kind: entry.kind as SegmentProposal['entries'][number]['kind'],
        text: entry.text,
      };
      if (entry.detail != null) result.detail = entry.detail;
      return result;
    }),
    timeAdvance: parsed.timeAdvance,
    attributeDeltas: { ...parsed.attributeDeltas },
  };

  if (parsed.worldDeltas != null) proposal.worldDeltas = { ...parsed.worldDeltas };

  if (parsed.worldStatusUpdate != null) proposal.worldStatusUpdate = parsed.worldStatusUpdate;
  if (parsed.traitOps != null) proposal.traitOps = parsed.traitOps;
  if (parsed.inventoryOps != null) proposal.inventoryOps = parsed.inventoryOps;
  if (parsed.relationshipOps != null) proposal.relationshipOps = parsed.relationshipOps;
  if (parsed.decision != null) proposal.decision = parsed.decision;
  if (parsed.endingProposal != null) proposal.endingProposal = parsed.endingProposal;

  return proposal;
}

/**
 * 解析选项。
 *
 * `requireDecision` 是**调用上下文带来的形状要求**：当程序判定「本段必须停车」时，
 * 提示词里已经明确要求给出决策点，漏掉它就等于没遵守输出契约。
 *
 * 之所以放在这一层而不是交给结算层兜底：程序替模型编一个「继续 / 停下」式的
 * 通用岔路，等于给玩家一个假的选择；而漏字段属于**回灌一次就能修好**的问题，
 * 正是这一层存在的理由。
 */
export interface ParseOptions {
  requireDecision?: boolean;
}

/**
 * 校验模型返回的原始对象。
 *
 * @param raw 已经过 JSON 解析的对象（未解析的文本应在适配层处理）
 */
export function parseSegmentProposal(raw: unknown, options: ParseOptions = {}): ParseResult {
  const result = segmentProposalSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false, issues: formatIssues(result.error.issues) };
  }

  if (options.requireDecision === true && result.data.decision == null) {
    return {
      ok: false,
      issues: [
        'decision: 本段必须给出一个决策点（prompt / stakes / options 三个字段都要有），但完全没有给',
      ],
    };
  }

  return { ok: true, proposal: toSegmentProposal(result.data) };
}

// ────────────────────────────────────────────────────────────
// 世界设定（同时用于存档导入校验）
// ────────────────────────────────────────────────────────────

const zAttributeDefinition = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  initialValue: z.number(),
  min: z.number().optional(),
  max: z.number().optional(),
  kind: z.enum(['counter', 'resource', 'progress']),
  integer: z.boolean().optional(),
  primary: z.boolean().optional(),
  unit: z.string().optional(),
  roll: z.object({ min: z.number(), max: z.number() }).optional(),
});

const zTalent = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  modifiers: z.object({
    cultivationGainMul: z.number().optional(),
    breakthroughBonus: z.number().optional(),
    eventWeightMul: z.number().optional(),
  }),
  attributeBonus: z.record(z.string(), z.number()).optional(),
});

const zEndingPair = z.object({ reason: z.string(), narrative: z.string() });

const zEndingTexts = z.object({
  lifespan: zEndingPair,
  collapse: zEndingPair,
  ascension: zEndingPair,
  turnLimit: zEndingPair,
  deathByProposal: z.string(),
  completionByProposal: z.string(),
});

const zWorldSetting = z.object({
  id: z.string().min(1),
  version: z.number(),
  name: z.string().min(1),
  description: z.string(),
  rules: z.array(z.string()),
  initialWorldStatus: z.string(),
  timeUnit: z.enum(['year', 'month', 'day']),
  attributes: z.array(zAttributeDefinition).min(1),
  worldAttributes: z.array(zAttributeDefinition).optional(),
  ruleset: z.object({
    kind: z.literal('open_life'),
    version: z.literal(2),
    healthKey: z.string(),
    spiritKey: z.string(),
    careerKey: z.string(),
    luckKey: z.string(),
    lethalEventKeywords: z.array(z.string()),
    startingAge: z.number(),
    legacyHiddenKeys: z.array(z.string()),
    agingStartAge: z.number(),
    annualHealthLoss: z.number(),
    maxAge: z.number(),
    completionMinAge: z.number(),
    maxDeltaPerSegment: z.number(),
    segmentSoftLimit: z.number(),
    naturalDeath: zEndingPair,
    healthDeath: zEndingPair,
    earnedRank: z.object({ key: z.string(), evidenceKeywords: z.array(z.string()) }).optional(),
    worldProgress: z.object({
      stageKey: z.string(), progressKey: z.string(), stageNames: z.array(z.string()), threshold: z.number(),
    }).optional(),
  }).optional(),
  mechanics: z.object({
    cultivationKey: z.string(),
    realmKey: z.string(),
    cultivationMax: z.number(),
    realmNames: z.array(z.string()).min(1),
    lifespanByRealm: z.array(z.number()),
    cultivationGain: z.object({
      base: z.number(),
      decayFactor: z.number(),
      min: z.number(),
      aptitudeKey: z.string(),
      aptitudeScale: z.number(),
    }),
    breakthrough: z.object({
      weights: z.record(z.string(), z.number()),
      penaltyPerRealm: z.number(),
      minProbability: z.number(),
      maxProbability: z.number(),
      failureCultivationLoss: z.number(),
      lowWillpowerKey: z.string(),
      lowWillpowerThreshold: z.number(),
      lowWillpowerPenalty: z.number(),
    }),
    death: z.object({
      willpowerKey: z.string(),
      willpowerThreshold: z.number(),
      luckKey: z.string(),
      lethalEventKeywords: z.array(z.string()),
    }),
    maxDeltaPerSegment: z.number(),
    startingAge: z.number(),
    completionProposalMinRealm: z.number(),
    segmentSoftLimit: z.number(),
  }),
  talents: z.array(zTalent),
  endings: zEndingTexts,
});

const zCharacterState = z.object({
  name: z.string(),
  age: z.number(),
  isAlive: z.boolean(),
  attributes: z.record(z.string(), z.number()),
  traits: z.array(z.string()),
  inventory: z.array(z.string()),
  relationships: z.record(z.string(), z.string()),
  talentId: z.string().optional(),
});

const zEnding = z.object({
  type: z.enum(['death', 'completion']),
  reason: z.string(),
  narrative: z.string(),
  atSegmentId: z.number(),
});

const zModelMeta = z.object({
  provider: z.string(),
  model: z.string(),
  latencyMs: z.number(),
  retries: z.number().optional(),
});

const zSaveRecord = z.object({
  id: z.string().min(1),
  schemaVersion: z.number(),
  rulesetVersion: z.number().optional(),
  revision: z.number(),
  world: zWorldSetting,
  worldStatus: z.string(),
  worldAttributes: z.record(z.string(), z.number()).optional(),
  character: zCharacterState,
  historySummary: z.string(),
  summarizedThroughSegmentId: z.number(),
  latestSegmentId: z.number(),
  lastDecisionSegmentId: z.number(),
  status: z.enum(['active', 'ended']),
  ending: zEnding.optional(),
  epilogue: z.string().optional(),
  summaryState: z
    .object({
      lastError: z.string().optional(),
      attempts: z.number(),
      lastAttemptAt: z.number(),
    })
    .optional(),
  stats: z.object({
    totalSegments: z.number(),
    startedAt: z.number(),
    endedAt: z.number().optional(),
  }),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const zLifeEntry = z.object({
  age: z.number(),
  kind: z.enum(ENTRY_KINDS as unknown as [string, ...string[]]),
  text: z.string(),
  detail: z.string().optional(),
  settledAttributes: z.record(z.string(), z.number()).optional(),
  settledWorldAttributes: z.record(z.string(), z.number()).optional(),
});

const zDecisionPoint = z.object({
  prompt: z.string(),
  stakes: z.string(),
  options: z.array(z.string()),
  cause: z.enum(['proposed', 'breakthrough', 'near-end', 'life-turn', 'long-gap']),
});

const zLifeSegment = z.object({
  entries: z.array(zLifeEntry).min(1),
  timeAdvance: z.number(),
  attributeDeltas: z.record(z.string(), z.number()),
  worldDeltas: z.record(z.string(), z.number()).optional(),
  worldStatusUpdate: z.string().optional(),
  traitOps: z.array(zListOp).optional(),
  inventoryOps: z.array(zListOp).optional(),
  relationshipOps: z.array(zRelOp).optional(),
  decision: zDecisionPoint.optional(),
  endingProposal: zEndingProposal.optional(),
  legacy: z.literal(true).optional(),
});

const zLifeSegmentRecord = z.object({
  saveId: z.string().min(1),
  segmentId: z.number(),
  requestId: z.string().min(1),
  playerAction: z.string().optional(),
  segment: zLifeSegment,
  resolvedCharacter: zCharacterState,
  characterBefore: zCharacterState,
  worldAttributesBefore: z.record(z.string(), z.number()).optional(),
  resolvedWorldStatus: z.string(),
  resolvedWorldAttributes: z.record(z.string(), z.number()).optional(),
  ending: zEnding.optional(),
  validationWarnings: z.array(z.string()),
  modelMeta: zModelMeta,
  schemaVersion: z.number(),
  createdAt: z.number(),
});

export const saveRecordSchema = zSaveRecord;
export const lifeSegmentSchema = zLifeSegment;
export const lifeSegmentRecordSchema = zLifeSegmentRecord;

export const gameSaveExportSchema = z.object({
  formatVersion: z.number(),
  save: zSaveRecord,
  segments: z.array(zLifeSegmentRecord),
});

// ────────────────────────────────────────────────────────────
// 旧版（v1「回合」模型）事件结构
//
// 只服务于旧存档迁移：v1 的导出文件与 IndexedDB 里的旧记录都长这样。
// 新代码不应该再产生这种结构，但**不能删**——删掉就等于让玩家手里的
// 导出 JSON 变成废纸。
// ────────────────────────────────────────────────────────────

export const legacyTurnEventSchema = z.object({
  saveId: z.string().min(1),
  turnId: z.number(),
  requestId: z.string().min(1),
  playerAction: z.string(),
  proposal: z.object({
    narrative: z.string(),
    timeAdvance: z.number(),
    attributeDeltas: z.record(z.string(), z.number()),
    worldStatusUpdate: z.string().optional(),
    options: z.array(z.string()),
    traitOps: z.array(zListOp).optional(),
    inventoryOps: z.array(zListOp).optional(),
    relationshipOps: z.array(zRelOp).optional(),
    events: z.array(z.string()).optional(),
    endingProposal: zEndingProposal.optional(),
  }),
  resolvedCharacter: zCharacterState,
  characterBefore: zCharacterState,
  resolvedWorldStatus: z.string(),
  ending: z
    .object({
      type: z.enum(['death', 'completion']),
      reason: z.string(),
      narrative: z.string(),
      atTurnId: z.number(),
    })
    .optional(),
  validationWarnings: z.array(z.string()),
  modelMeta: zModelMeta,
  schemaVersion: z.number(),
  createdAt: z.number(),
});

export type LegacyTurnEvent = z.infer<typeof legacyTurnEventSchema>;
