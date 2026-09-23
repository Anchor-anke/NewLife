import { z } from 'zod';
import {
  DESIGN_INVARIANTS,
  checkInvariants,
  checkInvariantsAcrossForms,
  requiredMinSegments,
  simulateWorld,
  type SimulationReport,
} from '@/lib/engine/simulate';
import type {
  AttributeDefinition,
  ModelMeta,
  Talent,
  WorldEndingTexts,
  WorldSetting,
} from '@/lib/engine/types';
import type { ChatMessage, ModelAdapter } from '@/lib/model/adapter';
import { extractJsonObject } from '@/lib/model/json';
import {
  FORGE_SYSTEM_PROMPT,
  buildForgeRepairMessage,
  buildForgeUserMessage,
} from './forge-prompt';

/**
 * 自定义世界生成。
 *
 * 分工原则见 `forge-prompt.ts`：模型出题材与文案，程序出数值并负责验证。
 * 这里的三段式流程是：
 *
 *   1. **解析**——zod 判形状，不合格就带着错误回灌重试（和段落生成同一套思路）
 *   2. **展开**——把模型给的扁平草稿补成完整 `WorldSetting`，并修正所有引用错误
 *   3. **校准**——用真实结算跑几百条人生，按设计不变量反推数值曲线
 *
 * 第三步是关键。模型写出来的 JSON 看着永远合理，只有跑起来才知道顶阶能不能到、
 * 一局有多少段。
 */

/** 相邻阶位寿元上限的最大倍数。内置世界实测都在 1.1~1.6 之间。 */
const MAX_LIFESPAN_RATIO = 2.2;

/** 结构校验失败后允许的重试次数。初次请求 + 2 次重试 = 最多 3 次调用。 */
export const MAX_FORGE_ATTEMPTS = 2;

const zAttributeDraft = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(['counter', 'progress', 'resource']),
  min: z.coerce.number().optional(),
  max: z.coerce.number().optional(),
  initialValue: z.coerce.number(),
  integer: z.coerce.boolean().optional(),
  primary: z.coerce.boolean().optional(),
  roll: z.object({ min: z.coerce.number(), max: z.coerce.number() }).optional(),
  unit: z.string().optional(),
});

const zTalentDraft = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  attributeBonus: z.record(z.string(), z.coerce.number()).optional(),
  cultivationGainMul: z.coerce.number().optional(),
  breakthroughBonus: z.coerce.number().optional(),
  eventWeightMul: z.coerce.number().optional(),
});

const zEndingPair = z.object({ reason: z.string().min(1), narrative: z.string().min(1) });

const zForgeDraft = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  initialWorldStatus: z.string().min(1),
  timeUnit: z.enum(['year', 'month', 'day']).default('year'),
  rules: z.array(z.string().min(1)).min(1),
  startingAge: z.coerce.number(),
  realmNames: z.array(z.string().min(1)).min(2),
  lifespanByRealm: z.array(z.coerce.number()).min(2),
  attributes: z.array(zAttributeDraft).min(2),
  mechanics: z.object({
    cultivationKey: z.string(),
    realmKey: z.string(),
    cultivationMax: z.coerce.number().optional(),
    aptitudeKey: z.string(),
    willpowerKey: z.string(),
    luckKey: z.string(),
    weights: z.record(z.string(), z.coerce.number()),
    lethalEventKeywords: z.array(z.string()).min(1),
    completionProposalMinRealm: z.coerce.number().optional(),
  }),
  talents: z.array(zTalentDraft).min(1),
  endings: z.object({
    lifespan: zEndingPair,
    collapse: zEndingPair,
    ascension: zEndingPair,
    turnLimit: zEndingPair,
    deathByProposal: z.string().min(1),
    completionByProposal: z.string().min(1),
  }),
});

export type ForgeDraft = z.infer<typeof zForgeDraft>;

// ────────────────────────────────────────────────────────────
// 工具
// ────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
  return Number.isFinite(value) ? Math.round(value) : 0;
}

/** 把模型给的 key 规整成合法的 camelCase 标识符，并保证互不重复。 */
function sanitizeKey(raw: string, used: Set<string>): string {
  const ascii = raw
    .trim()
    .replace(/[^A-Za-z0-9]+(.)?/g, (_, next: string | undefined) =>
      next ? next.toUpperCase() : '',
    )
    .replace(/^[^A-Za-z]+/, '');

  let key = ascii === '' ? 'attr' : ascii.charAt(0).toLowerCase() + ascii.slice(1);
  if (key.length > 24) key = key.slice(0, 24);

  let candidate = key;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${key}${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

/**
 * 拟合 `base × decayFactor^tier` 形式的积累曲线。
 *
 * 目标是「第 k 阶在上一阶寿元的 ratio(k) 处踏入」。把每阶需要的年数换算成
 * 每年的积累量，再对 (阶位, ln(积累量)) 做线性回归即可直接解出两个参数——
 * 比让模型猜、或者手工试凑都可靠得多。
 */
function fitGainCurve(gains: number[]): { base: number; decayFactor: number } {
  const n = gains.length;
  if (n === 0) return { base: 10, decayFactor: 0.85 };
  if (n === 1) return { base: clamp(gains[0] ?? 10, 1, 80), decayFactor: 0.85 };

  const xs = gains.map((_, index) => index);
  const ys = gains.map((gain) => Math.log(Math.max(0.05, gain)));
  const meanX = xs.reduce((sum, value) => sum + value, 0) / n;
  const meanY = ys.reduce((sum, value) => sum + value, 0) / n;

  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < n; index += 1) {
    numerator += ((xs[index] ?? 0) - meanX) * ((ys[index] ?? 0) - meanY);
    denominator += ((xs[index] ?? 0) - meanX) ** 2;
  }

  const slope = denominator === 0 ? 0 : numerator / denominator;
  return {
    // decay 必须小于 1（越往上越难）。下限放到 0.05 是有原因的：
    // 寿元跨度大的世界（例如 60 岁 → 30000 岁）要求积累速度下降几百倍，
    // 下限设得太高会把曲线截断，导致高阶推进远快于设计，登顶率飙升。
    decayFactor: clamp(Math.exp(slope), 0.05, 0.98),
    base: clamp(Math.exp(meanY - slope * meanX), 1, 80),
  };
}

/**
 * 从寿元表反推积累曲线。
 *
 * 「踏入第 k 阶的年龄」取为「第 k-1 阶寿元上限的 ratio(k) 倍」，ratio 从
 * 0.38 线性升到 0.92——这是四个内置世界跑出来的经验形状：前期宽裕，
 * 后期越来越紧，但始终留有余地，所以顶阶可达而稀有。
 */
function deriveGains(
  lifespans: number[],
  startingAge: number,
  tierCount: number,
  cultivationMax: number,
): number[] {
  const gains: number[] = [];
  let previousAge = startingAge;

  for (let k = 1; k < tierCount; k += 1) {
    const ratio = 0.38 + 0.54 * (k / (tierCount - 1));
    const lifespan = lifespans[k - 1] ?? 100;
    const targetAge = Math.max(previousAge + 2, ratio * lifespan);
    const years = Math.max(1, targetAge - previousAge);
    gains.push(cultivationMax / years);
    previousAge = targetAge;
  }

  return gains;
}

// ────────────────────────────────────────────────────────────
// 展开：草稿 → 完整世界观
// ────────────────────────────────────────────────────────────

export interface ExpandResult {
  world: WorldSetting;
  notes: string[];
}

export function expandDraft(draft: ForgeDraft, id: string): ExpandResult {
  const notes: string[] = [];

  // ── 阶位与寿元 ───────────────────────────────────────────
  let realmNames = draft.realmNames.map((name) => name.trim()).filter((name) => name !== '');
  if (realmNames.length < 2) {
    realmNames = ['初阶', '中阶', '高阶'];
    notes.push('阶位少于两个，已补足为三阶');
  }
  if (realmNames.length > 10) {
    realmNames = realmNames.slice(0, 10);
    notes.push('阶位超过十个，已截断到十阶');
  }
  const tierCount = realmNames.length;
  const maxTier = tierCount - 1;

  const startingAge = clamp(round(draft.startingAge), 8, 60);

  // 寿元表：先对齐长度，再保证单调不减，最后保证与起始年龄自洽
  const lifespans: number[] = [];
  for (let index = 0; index < tierCount; index += 1) {
    const proposed = round(draft.lifespanByRealm[index] ?? Number.NaN);
    lifespans.push(Number.isFinite(proposed) ? proposed : 0);
  }
  if (lifespans.length !== draft.lifespanByRealm.length) {
    notes.push('寿元表长度与阶位数量不一致，已按阶位数量对齐');
  }

  const minimumFirst = startingAge + 20;
  if (!(lifespans[0] !== undefined && lifespans[0] >= minimumFirst)) {
    lifespans[0] = minimumFirst;
    notes.push('首阶寿元过短，已抬高到足以支撑一局');
  }
  for (let index = 1; index < tierCount; index += 1) {
    const previous = lifespans[index - 1] ?? minimumFirst;
    const current = lifespans[index] ?? 0;
    if (current < previous) {
      lifespans[index] = previous;
      notes.push('寿元表不是单调不减，已修正');
    }
  }
  // 最高阶寿元至少要显著高于首阶，否则「提升阶位续命」不成立。
  // 关键点：**必须整张表一起重塑，而不是只在末尾补一个跳变**——
  // 补跳变会让末段窗口过大，玩家轻易就能登顶。
  const minimumTop = Math.round((lifespans[0] ?? minimumFirst) * 1.8);
  const currentTop = lifespans[tierCount - 1] ?? minimumTop;
  if (currentTop < minimumTop && tierCount >= 3) {
    const first = lifespans[0] ?? minimumFirst;
    for (let index = 1; index < tierCount; index += 1) {
      const t = index / (tierCount - 1);
      lifespans[index] = Math.round(first * (minimumTop / first) ** t);
    }
    notes.push('寿元阶梯过于扁平，已按等比级数重新铺开');
  } else if (currentTop < minimumTop) {
    lifespans[tierCount - 1] = minimumTop;
    notes.push('最高阶寿元偏低，已抬高以拉开阶梯感');
  }
  for (let index = tierCount - 2; index >= 0; index -= 1) {
    if ((lifespans[index] ?? 0) > (lifespans[index + 1] ?? 0)) {
      lifespans[index] = lifespans[index + 1] ?? 0;
    }
  }

  // 相邻阶位的寿元跨度不能太大。
  // 像 [60, 200, 900, 5000, 30000] 这样的表，末阶窗口高达数万年，
  // 玩家一旦登顶就有无限次突破机会，登顶率会失控到 70% 以上。
  for (let index = 1; index < tierCount; index += 1) {
    const previous = lifespans[index - 1] ?? minimumFirst;
    const cap = Math.round(previous * MAX_LIFESPAN_RATIO);
    if ((lifespans[index] ?? 0) > cap) {
      lifespans[index] = cap;
      notes.push('寿元阶梯跨度过大，已压缩到合理倍数');
    }
  }

  // ── 属性 ─────────────────────────────────────────────────
  const usedKeys = new Set<string>();
  const keyMap = new Map<string, string>();
  const attributes: AttributeDefinition[] = [];

  for (const raw of draft.attributes) {
    const key = sanitizeKey(raw.key, usedKeys);
    if (key !== raw.key) keyMap.set(raw.key, key);
    else keyMap.set(raw.key, key);

    const kind = raw.kind;
    const min = kind === 'progress' ? 0 : Math.max(0, round(raw.min ?? 0));
    let max: number | undefined;
    if (kind === 'progress') max = 100;
    else if (raw.max !== undefined) max = round(raw.max);
    if (max !== undefined && max <= min) max = min + 1;

    const definition: AttributeDefinition = {
      key,
      label: raw.label.trim(),
      initialValue: round(raw.initialValue),
      min,
      kind,
      integer: raw.integer ?? true,
      primary: raw.primary ?? false,
    };
    if (max !== undefined) definition.max = max;
    if (raw.unit && raw.unit.trim() !== '') definition.unit = raw.unit.trim();

    if (raw.roll && max !== undefined) {
      const rollMin = clamp(round(raw.roll.min), min, max);
      const rollMax = clamp(round(raw.roll.max), rollMin, max);
      definition.roll = { min: rollMin, max: rollMax };
    }

    // 初值必须落在合法区间内，否则创角一开局就越界
    if (max !== undefined) {
      definition.initialValue = clamp(definition.initialValue, min, max);
    } else if (definition.initialValue < min) {
      definition.initialValue = min;
    }

    attributes.push(definition);
  }

  // ── mechanics 引用修正 ───────────────────────────────────
  const resolveKey = (raw: string): string | undefined => keyMap.get(raw) ?? (usedKeys.has(raw) ? raw : undefined);
  const findFirst = (predicate: (attribute: AttributeDefinition) => boolean): string | undefined =>
    attributes.find(predicate)?.key;

  const realmKey =
    resolveKey(draft.mechanics.realmKey) ??
    findFirst((attribute) => attribute.kind === 'counter' && attribute.primary === true) ??
    attributes[0]?.key ??
    'rank';

  let cultivationKey = resolveKey(draft.mechanics.cultivationKey);
  if (cultivationKey === undefined || cultivationKey === realmKey) {
    cultivationKey = findFirst((attribute) => attribute.kind === 'progress') ?? realmKey;
    notes.push('进度属性的引用无效，已自动指定');
  }

  // 进度属性的上限由程序统一，保证进度条语义一致
  const cultivationMax = clamp(round(draft.mechanics.cultivationMax ?? 100), 40, 200);

  const pickCounter = (rawKey: string, exclude: string[]): string => {
    const resolved = resolveKey(rawKey);
    if (resolved !== undefined && !exclude.includes(resolved)) return resolved;
    const fallback = findFirst(
      (attribute) =>
        attribute.kind === 'counter' && !exclude.includes(attribute.key) && attribute.roll !== undefined,
    );
    return fallback ?? exclude[0] ?? realmKey;
  };

  const aptitudeKey = pickCounter(draft.mechanics.aptitudeKey, [realmKey, cultivationKey]);
  const willpowerKey = pickCounter(draft.mechanics.willpowerKey, [realmKey, cultivationKey, aptitudeKey]);
  const luckKey = pickCounter(draft.mechanics.luckKey, [
    realmKey,
    cultivationKey,
    aptitudeKey,
    willpowerKey,
  ]);

  const referenced = new Set([realmKey, cultivationKey]);
  for (const rawKey of [draft.mechanics.aptitudeKey, draft.mechanics.willpowerKey, draft.mechanics.luckKey]) {
    if (resolveKey(rawKey) === undefined) notes.push(`属性引用「${rawKey}」不存在，已自动替换`);
  }

  // 阶位属性的上限必须等于最高阶位序号，否则程序判阶位会越界
  const realmAttribute = attributes.find((attribute) => attribute.key === realmKey);
  if (realmAttribute) {
    realmAttribute.min = 0;
    realmAttribute.max = maxTier;
    realmAttribute.initialValue = 0;
    realmAttribute.integer = true;
    realmAttribute.kind = 'counter';
    delete realmAttribute.roll;
  }

  // 进度属性固定为 0 起步、上限 100、不参与掷点
  const progressAttribute = attributes.find((attribute) => attribute.key === cultivationKey);
  if (progressAttribute) {
    progressAttribute.kind = 'progress';
    progressAttribute.min = 0;
    progressAttribute.max = cultivationMax;
    progressAttribute.initialValue = 0;
    progressAttribute.integer = true;
    delete progressAttribute.roll;
  }

  // ── 突破权重 ─────────────────────────────────────────────
  const weights: Record<string, number> = {};
  for (const [rawKey, value] of Object.entries(draft.mechanics.weights)) {
    const key = resolveKey(rawKey);
    if (key === undefined) continue;
    if (key === realmKey || key === cultivationKey) continue;
    if (!Number.isFinite(value) || value <= 0) continue;
    weights[key] = (weights[key] ?? 0) + value;
    referenced.add(key);
  }
  if (Object.keys(weights).length === 0) {
    weights[aptitudeKey] = 1;
    notes.push('突破权重为空，已退化为只按资质判定');
  }
  const weightSum = Object.values(weights).reduce((sum, value) => sum + value, 0);
  for (const key of Object.keys(weights)) {
    weights[key] = Number(((weights[key] ?? 0) / weightSum).toFixed(4));
  }
  // 归一化后的舍入误差补到第一项，保证和恰好为 1
  const keys = Object.keys(weights);
  const drift = 1 - Object.values(weights).reduce((sum, value) => sum + value, 0);
  if (keys[0] !== undefined) weights[keys[0]] = Number(((weights[keys[0]] ?? 0) + drift).toFixed(4));

  // ── 天赋 ─────────────────────────────────────────────────
  const talents: Talent[] = draft.talents.map((raw, index) => {
    const attributeBonus: Record<string, number> = {};
    for (const [rawKey, value] of Object.entries(raw.attributeBonus ?? {})) {
      const key = resolveKey(rawKey);
      if (key === undefined || !Number.isFinite(value) || value === 0) continue;
      attributeBonus[key] = Math.round(value);
    }

    const modifiers: Talent['modifiers'] = {};
    if (raw.cultivationGainMul !== undefined) {
      modifiers.cultivationGainMul = clamp(raw.cultivationGainMul, 0.5, 2);
    }
    if (raw.breakthroughBonus !== undefined) {
      modifiers.breakthroughBonus = clamp(Math.round(raw.breakthroughBonus), -20, 20);
    }
    if (raw.eventWeightMul !== undefined) {
      modifiers.eventWeightMul = clamp(raw.eventWeightMul, 0.5, 2);
    }

    const talent: Talent = {
      id: `talent-${index + 1}`,
      name: raw.name.trim(),
      description: raw.description.trim(),
      modifiers,
    };
    if (Object.keys(attributeBonus).length > 0) talent.attributeBonus = attributeBonus;
    return talent;
  });

  // ── 结局文案 ─────────────────────────────────────────────
  const endings: WorldEndingTexts = {
    lifespan: draft.endings.lifespan,
    collapse: draft.endings.collapse,
    ascension: draft.endings.ascension,
    turnLimit: draft.endings.turnLimit,
    deathByProposal: draft.endings.deathByProposal,
    completionByProposal: draft.endings.completionByProposal,
  };

  // ── 数值推导 ─────────────────────────────────────────────
  const gains = deriveGains(lifespans, startingAge, tierCount, cultivationMax);
  const { base, decayFactor } = fitGainCurve(gains);

  const attributeRange =
    attributes.find((attribute) => attribute.key === aptitudeKey)?.max ?? cultivationMax;
  const maxDeltaPerSegment = clamp(Math.round(attributeRange * 0.3), 10, 60);

  const completionProposalMinRealm = clamp(
    round(draft.mechanics.completionProposalMinRealm ?? Math.max(1, maxTier - 1)),
    1,
    maxTier,
  );

  const world: WorldSetting = {
    id,
    version: 1,
    name: draft.name.trim(),
    description: draft.description.trim(),
    initialWorldStatus: draft.initialWorldStatus.trim(),
    timeUnit: draft.timeUnit,
    rules: draft.rules.map((rule) => rule.trim()).filter((rule) => rule !== ''),
    attributes,
    mechanics: {
      cultivationKey,
      realmKey,
      cultivationMax,
      realmNames,
      lifespanByRealm: lifespans,
      cultivationGain: {
        base: Number(base.toFixed(3)),
        decayFactor: Number(decayFactor.toFixed(4)),
        min: Number(Math.max(0.3, base * 0.04).toFixed(3)),
        aptitudeKey,
        aptitudeScale: 200,
      },
      breakthrough: {
        weights,
        penaltyPerRealm: clamp(Math.round(50 / tierCount), 3, 9),
        minProbability: 0.05,
        maxProbability: 0.95,
        failureCultivationLoss: Math.round(cultivationMax * 0.28),
        lowWillpowerKey: willpowerKey,
        lowWillpowerThreshold: 35,
        lowWillpowerPenalty: 4,
      },
      death: {
        willpowerKey,
        willpowerThreshold: 0,
        luckKey,
        lethalEventKeywords: draft.mechanics.lethalEventKeywords
          .map((keyword) => keyword.trim())
          .filter((keyword) => keyword !== '')
          .slice(0, 12),
      },
      maxDeltaPerSegment,
      startingAge,
      completionProposalMinRealm,
      segmentSoftLimit: Math.max(120, tierCount * 40),
    },
    talents,
    endings,
  };

  if (world.mechanics.death.lethalEventKeywords.length === 0) {
    world.mechanics.death.lethalEventKeywords = ['致命', '濒死', '死亡'];
    notes.push('致命事件关键词为空，已填入兜底值');
  }

  return { world, notes: [...new Set(notes)] };
}

// ────────────────────────────────────────────────────────────
// 校准：用真实结算把数值跑到达标
// ────────────────────────────────────────────────────────────

export interface TuneResult {
  world: WorldSetting;
  notes: string[];
  report: SimulationReport;
  problems: string[];
}

/**
 * 每轮校准的样本量。
 *
 * 必须与最终校验用同一批 seed：如果循环用 80 条、校验用 200 条，
 * 小样本会先「达标」而提前退出，最终校验却报出残留问题。
 */
const TUNE_LIVES = 200;
const TUNE_MAX_ROUNDS = 8;

/**
 * 按设计不变量反推数值。
 *
 * 每一轮只动一个杠杆，避免多个调整互相抵消：
 * - 顶阶不可达 → 抬高次高与最高的寿元
 * - 寿元耗尽过多 → 整体放宽寿元（给突破留时间）
 * - 寿元耗尽过少 → 整体收紧寿元
 * - 段数偏离 → 调整积累速度（进度快 → 更快进入大跨度阶段 → 段数更少）
 */
export function tuneWorld(input: WorldSetting, maxRounds = TUNE_MAX_ROUNDS): TuneResult {
  let world = input;
  const notes: string[] = [];
  let report = simulateWorld(world, TUNE_LIVES);

  // 积累速度的调整必须**跨轮累积**：每轮都从 1 重新算的话，
  // 调整量会被下一轮的重新拟合抹掉，永远收敛不了。
  let gainMul = 1;

  for (let round = 0; round < maxRounds; round += 1) {
    const problems = checkInvariants(world, report);
    if (problems.length === 0) break;

    const mechanics = world.mechanics;
    const tierCount = mechanics.realmNames.length;
    const lifespans = [...mechanics.lifespanByRealm];
    let changed = false;

    const ascensionDead = report.ascensionRate <= 0;
    const tooMuchLifespanDeath = report.lifespanRate > 0.95;
    const tooLittleLifespanDeath = report.lifespanRate < 0.35;
    // 段数是否偏离，直接读共享的设计不变量，避免这里再维护一份阈值
    const tooFewSegments = report.averageSegments < requiredMinSegments(world);
    const tooManySegments = report.averageSegments > DESIGN_INVARIANTS.averageSegments.max;
    const nearTopUnreachable = report.nearTopRate < 0.03;

    if (ascensionDead || nearTopUnreachable) {
      // 顶阶到不了：抬高末段寿元，给突破留出窗口
      for (let index = Math.max(0, tierCount - 2); index < tierCount; index += 1) {
        lifespans[index] = Math.round((lifespans[index] ?? 100) * 1.35);
      }
      changed = true;
      notes.push('抬高高阶寿元上限，使顶阶可达');
    } else if (report.ascensionRate > DESIGN_INVARIANTS.ascensionRate.max) {
      // 登顶太容易：压缩末段窗口。只在「登顶过多」时才压，避免与上一分支来回拉锯。
      const floor = lifespans[Math.max(0, tierCount - 3)] ?? mechanics.startingAge + 20;
      for (let index = Math.max(0, tierCount - 2); index < tierCount; index += 1) {
        lifespans[index] = Math.max(floor + 1, Math.round((lifespans[index] ?? 100) * 0.8));
      }
      changed = true;
      notes.push('压缩末段寿元窗口，让登顶更难');
    } else if (tooMuchLifespanDeath) {
      for (let index = 0; index < tierCount; index += 1) {
        lifespans[index] = Math.round((lifespans[index] ?? 100) * 1.12);
      }
      changed = true;
      notes.push('整体放宽寿元上限，给突破留出时间');
    } else if (tooLittleLifespanDeath) {
      const floor = mechanics.startingAge + 20;
      for (let index = 0; index < tierCount; index += 1) {
        lifespans[index] = Math.max(floor, Math.round((lifespans[index] ?? 100) * 0.92));
      }
      changed = true;
      notes.push('收紧寿元上限，恢复时间压力');
    }

    if (tooFewSegments) gainMul *= 0.78;
    if (tooManySegments) gainMul *= 1.22;
    if (tooFewSegments || tooManySegments) {
      changed = true;
      notes.push(tooFewSegments ? '放慢积累速度，拉长一局' : '加快积累速度，缩短一局');
    }

    if (!changed) break;

    // 寿元变动后必须重新保证单调不减
    for (let index = 1; index < tierCount; index += 1) {
      if ((lifespans[index] ?? 0) < (lifespans[index - 1] ?? 0)) {
        lifespans[index] = lifespans[index - 1] ?? 0;
      }
    }

    const gains = deriveGains(
      lifespans,
      mechanics.startingAge,
      tierCount,
      mechanics.cultivationMax,
    );
    const fitted = fitGainCurve(gains);
    const nextBase = clamp(fitted.base * gainMul, 1, 80);

    world = {
      ...world,
      mechanics: {
        ...mechanics,
        lifespanByRealm: lifespans,
        cultivationGain: {
          ...mechanics.cultivationGain,
          base: Number(nextBase.toFixed(3)),
          decayFactor: Number(fitted.decayFactor.toFixed(4)),
          min: Number(Math.max(0.3, nextBase * 0.04).toFixed(3)),
        },
      },
    };

    report = simulateWorld(world, TUNE_LIVES);
  }

  // 最终用更大的样本复核一次，避免小样本偶然达标。
  //
  // 校验走 `checkInvariantsAcrossForms` 而不是单形态的 `checkInvariants`：
  // 决策密度是唯一依赖模型形态的不变量，只测一侧会漏（两侧都真的漏过）。
  // 调参循环里仍然用单形态——那是每轮都要跑的，反馈要便宜。
  const finalReport = simulateWorld(world, TUNE_LIVES);
  return {
    world,
    notes: [...new Set(notes)],
    report: finalReport,
    problems: checkInvariantsAcrossForms(world, TUNE_LIVES),
  };
}

// ────────────────────────────────────────────────────────────
// 主流程
// ────────────────────────────────────────────────────────────

export type ForgeStage = 'designing' | 'repairing' | 'tuning';

export interface ForgeInput {
  premise: string;
  adapter: ModelAdapter;
  /** 由调用方生成，保证同一份草稿得到同一个 id */
  id: string;
  signal?: AbortSignal;
  onStage?: (stage: ForgeStage) => void;
}

export interface ForgeOutput {
  world: WorldSetting;
  /** 程序做过的修正，用于在界面上如实告诉玩家「AI 的方案哪里被兜住了」 */
  notes: string[];
  report: SimulationReport;
  /** 校准后仍不达标的项。非空说明这个世界手感有瑕疵，但仍然可以玩。 */
  problems: string[];
  modelMeta: ModelMeta;
}

export class ForgeError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`连续 ${MAX_FORGE_ATTEMPTS + 1} 次都没能产出合法的世界设定`);
    this.name = 'ForgeError';
    this.issues = issues;
  }
}

export async function forgeWorld(input: ForgeInput): Promise<ForgeOutput> {
  const messages: ChatMessage[] = [
    { role: 'system', content: FORGE_SYSTEM_PROMPT },
    { role: 'user', content: buildForgeUserMessage(input.premise) },
  ];

  let lastIssues: string[] = [];
  let totalLatencyMs = 0;
  let retries = 0;

  for (let attempt = 0; attempt <= MAX_FORGE_ATTEMPTS; attempt += 1) {
    input.onStage?.(attempt === 0 ? 'designing' : 'repairing');

    const { text, latencyMs } = await input.adapter.complete(
      { messages, json: true, temperature: 0.9 },
      input.signal ? { signal: input.signal } : {},
    );
    totalLatencyMs += latencyMs;

    // 与段落生成共用同一套宽松解析：模型常常把 JSON 包进代码围栏
    const parsed = extractJsonObject(text);
    if (parsed === null) {
      lastIssues = ['返回内容不是合法的 JSON 对象，请只输出 JSON'];
      retries += 1;
      messages.push({ role: 'assistant', content: text.slice(0, 4000) });
      messages.push({ role: 'user', content: buildForgeRepairMessage(lastIssues, text) });
      continue;
    }

    const validated = zForgeDraft.safeParse(parsed);
    if (!validated.success) {
      lastIssues = validated.error.issues
        .slice(0, 8)
        .map((issue) => `${issue.path.join('.') || '(根)'}：${issue.message}`);
      retries += 1;
      messages.push({ role: 'assistant', content: text.slice(0, 4000) });
      messages.push({ role: 'user', content: buildForgeRepairMessage(lastIssues, text) });
      continue;
    }

    const { world: expanded, notes: expandNotes } = expandDraft(validated.data, input.id);

    input.onStage?.('tuning');
    const tuned = tuneWorld(expanded);

    return {
      world: tuned.world,
      notes: [...expandNotes, ...tuned.notes],
      report: tuned.report,
      problems: tuned.problems,
      modelMeta: {
        provider: input.adapter.provider,
        model: input.adapter.model,
        latencyMs: totalLatencyMs,
        retries,
      },
    };
  }

  throw new ForgeError(lastIssues);
}
