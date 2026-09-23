import { DECISION_MIN_GAP, planStop } from './decision';
import { expectedSegments, timeAdvanceHint } from './pacing';
import { resolveSegment } from './resolve';
import type {
  CharacterState,
  EndingCause,
  EntryKind,
  LifeEntry,
  SegmentProposal,
  WorldSetting,
} from './types';

/**
 * 人生模拟器：用程序把一局人生跑完，用来回答一个设计问题——
 * **这个世界的数值到底能不能玩？**
 *
 * 它同时服务三处，保证标准一致：
 * - `balance.test.ts` 校验内置世界
 * - `worlds/forge.ts` 校验并自动校准 AI 生成的世界
 * - 决策密度的不变量（每局停车次数）——这是年表重构新增的核心约束
 *
 * 最典型的失败形态是「寿元耗尽永不触发」（寿元涨得比突破快，核心死亡机制形同虚设）
 * 和「顶阶不可达」（次高阶寿元低于踏入顶阶所需年龄，最高一档永远只是装饰）。
 * 年表重构后多了第三种：**决策密度失控**——程序门槛放得太松会退回「每段都停车」，
 * 放得太紧又会让玩家长时间没有参与感。
 */

/** 一局人生的设计不变量。内置世界与 AI 生成的世界共用同一套标准。 */
export const DESIGN_INVARIANTS = {
  /** 寿元耗尽占比：太低说明寿元没有约束力，太高说明没有别的出路 */
  lifespanRate: { min: 0.35, max: 0.95 },
  /** 登顶结局：必须存在，但必须稀有 */
  ascensionRate: { min: 0.005, max: 0.15 },
  /** 终局阶位至少铺开这么多种，不能所有人都卡在同一处 */
  distinctFinalTiers: { min: 5 },
  /**
   * 一局人生的段落数。
   *
   * 段数由「寿元表 ÷ 段跨度」决定，而段跨度又由 `pacing.timeAdvanceHint`
   * 按「典型寿元 ÷ 目标段数」反推，因此各题材的世界都落在同一量级
   * （实测 27~78 段，见 `docs/年表叙事重构实施说明.md`）。
   * 区间比方案里写的 30~60 略宽：短寿元的现代世界受「单段至少 3 年」这条
   * 下限约束，长寿元的修仙世界受「单段至多 60 年」这条上限约束，
   * 两端各自贴边，中间取一个足够容错的带宽。
   */
  averageSegments: { min: 24, max: 90 },
  /**
   * 每局真正停车的次数，也就是玩家的介入次数。
   *
   * 方案的目标区间，也是这套密度机制的**验收标准**。
   *
   * 注意它不是参数的来源：`pacing.decisionIntervalFor` 是对着实测标定出来的，
   * 不是从这个区间反推的——
   * 因为「一局多少段」本身只能估算，且估算误差不稳定。这条断言的作用是
   * **验收**：三种模型形态都必须落进来，任何一侧漂了都会被它抓住。
   */
  decisionsPerLife: { min: 8, max: 15 },
  /** 两次停车之间至少隔几段——硬密度下限，任何世界都不许违反 */
  minDecisionGap: DECISION_MIN_GAP,
  /** 次高阶必须有实际可达性 */
  nearTopRate: { min: 0.03 },
} as const;

const MAX_SEGMENTS = 2000;

/**
 * 模拟用的条目类型轮转表。
 *
 * 刻意让相邻条目的类型不同，这样模拟出来的段落和真实模型产出的段落
 * 在「条目类型分布」这条约束上是同一形态。
 */
const SIM_KINDS: readonly EntryKind[] = [
  'cultivation',
  'event',
  'cultivation',
  'setback',
  'relationship',
  'fortune',
];

/**
 * 条目文案的两种风格。
 *
 * 这决定了模拟能压到决策门槛的哪一条：
 *
 * - `plain`：中性短句，**不命中**「分量关键词」这道门槛。此时停车只可能由
 *   突破、程序侧强制、以及兜底门槛触发——这是介入次数的**下限**情形。
 * - `evocative`：措辞里带着「机缘 / 危机 / 抉择」这类词。真实模型写出来的条目
 *   几乎必然会命中关键词门槛——这是**上限**情形。
 *
 * 两个极值都落在目标区间内，密度才算真的稳。只测下限会给出虚假的安全感：
 * 模拟器说「每局 9 次介入」，接上真实模型却变成每两段停一次。
 */
const PLAIN_TEXTS: Record<EntryKind, readonly string[]> = {
  cultivation: ['你把时间花在打坐吐纳上', '一段漫长的积累期'],
  event: ['山下的集市换了新的管事', '风从谷口灌进来'],
  relationship: ['你与一位同行者结伴走了一段', '他走的时候没有留下姓名'],
  fortune: ['你在旧物堆里翻到一件东西', '山道上有人塞给你一样东西'],
  setback: ['你受了伤，养了很久', '你试着冲击下一阶，未果'],
  milestone: ['你跨过了一道多年未过的坎'],
};

const EVOCATIVE_TEXTS: Record<EntryKind, readonly string[]> = {
  cultivation: ['你闭门不出，气息渐厚', '漫长的积累期终于有了回报'],
  event: ['山下的集市换了管事，这算一桩变故', '外面的世道出了一场变故'],
  relationship: ['你与一位故人重逢', '有人把一件事托付给你'],
  fortune: ['一场机缘落到你头上', '你在旧物堆里翻到一件东西，像是机缘'],
  setback: ['你受了伤，养了很久', '一次危机让你失去了些东西'],
  milestone: ['你跨过了一道多年未过的坎，这是你人生的转折'],
};

export type EntryStyle = 'plain' | 'evocative';
export interface LifeOutcome {
  age: number;
  tier: number;
  cause: EndingCause | 'unfinished';
  /** 段落数 */
  segments: number;
  /** 真正停车的次数，即玩家的介入次数 */
  decisions: number;
  /** 本局中出现过的最小决策间隔。用来验证硬密度下限。 */
  minDecisionGap: number;
  /** 首次踏入各阶位时的年龄，索引即阶位 */
  tierAges: number[];
}

/** 确定性伪随机，保证同一 seed 跑出同一结果，便于复现与调参。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 铺开一段的条目。年龄单调不减且不超出段尾，与真实产出的形态一致。 */
function simulateEntries(
  startAge: number,
  timeAdvance: number,
  seed: number,
  style: EntryStyle,
): LifeEntry[] {
  const count = Math.max(4, Math.min(12, Math.round(timeAdvance / 2) + 3));
  const pool = style === 'evocative' ? EVOCATIVE_TEXTS : PLAIN_TEXTS;
  const entries: LifeEntry[] = [];

  for (let index = 0; index < count; index += 1) {
    const age = startAge + Math.round(((index + 1) / count) * timeAdvance);
    const kind = SIM_KINDS[(index + seed) % SIM_KINDS.length] ?? 'event';
    const texts = pool[kind];
    entries.push({
      age,
      kind,
      text: texts[(index + seed) % texts.length] ?? texts[0] ?? '时光流转',
    });
  }

  return entries;
}

export interface SimulateOptions {
  /** 条目文案风格。默认 `plain`（不命中关键词门槛，介入次数的下限情形）。 */
  entryStyle?: EntryStyle;
  /**
   * 模型提议岔路的积极程度。
   *
   * - `eager`（默认）：每一段都提一个 —— 「模型到处提议」的对抗**上界**，
   *   验证的是程序门槛能不能兜住它。
   * - `compliant`：只在程序下了「本段必须给出 decision」的强制指令时才提 ——
   *   一个遵守指令但从不主动的模型，这是介入次数的**下界**。
   *
   * 两个方向都要测。只测上界会漏掉「模型很吝啬，玩家几乎出不了手」；
   * 只测下界会漏掉「模型话太多，一局停三十次」——两个都真的发生过。
   */
  proposalStyle?: 'eager' | 'compliant';
}

/**
 * 验收要覆盖的三种模型形态。
 *
 * 定义在这里而不是测试文件里，是为了让**内置世界与 AI 生成的世界用同一套标准**——
 * 和 `DESIGN_INVARIANTS` 是同一条理由。`balance.test.ts` 直接引用它，
 * `checkInvariantsAcrossForms` 也用它。
 *
 * 用命名对象而不是数组：`checkInvariantsAcrossForms` 要按名字取其中两个，
 * 靠下标取会在有人调整顺序时静默错位。
 */
export const VERIFY_SCENARIOS = {
  eagerPlain: {
    label: '模型话多 · 中性文案',
    options: { proposalStyle: 'eager', entryStyle: 'plain' },
  },
  eagerEvocative: {
    label: '模型话多 · 带分量词',
    options: { proposalStyle: 'eager', entryStyle: 'evocative' },
  },
  compliant: {
    label: '模型只被强制时才提',
    options: { proposalStyle: 'compliant', entryStyle: 'plain' },
  },
} satisfies Record<string, { label: string; options: SimulateOptions }>;

/**
 * 跑完一条人生。
 *
 * 只做「持续投入」这一种行动——不模拟玩家的具体选择，因为要验证的是
 * 数值骨架本身，而不是某一套玩法策略。
 */
export function simulateLife(
  world: WorldSetting,
  seed: number,
  options: SimulateOptions = {},
): LifeOutcome {
  const style = options.entryStyle ?? 'plain';
  const proposalStyle = options.proposalStyle ?? 'eager';
  const rng = mulberry32(seed);
  const roll = (min: number, max: number) => min + Math.floor(rng() * (max - min + 1));

  const attributes: Record<string, number> = {};
  for (const definition of world.attributes) {
    attributes[definition.key] = definition.roll
      ? roll(definition.roll.min, definition.roll.max)
      : definition.initialValue;
  }

  let current: CharacterState = {
    name: '模拟者',
    age: world.mechanics.startingAge,
    isAlive: true,
    attributes,
    traits: [],
    inventory: [],
    relationships: {},
  };

  const tierAges = [current.age];
  let lastDecisionSegmentId = 0;
  let decisions = 0;
  let minDecisionGap = Number.POSITIVE_INFINITY;

  for (let segmentId = 1; segmentId <= MAX_SEGMENTS; segmentId += 1) {
    const tier = current.attributes[world.mechanics.realmKey] ?? 0;
    const [minYears, maxYears] = timeAdvanceHint(world, tier);
    const timeAdvance = minYears + Math.floor(rng() * (maxYears - minYears + 1));

    const stopPlan = planStop({
      world,
      character: current,
      segmentId,
      lastDecisionSegmentId,
    });

    const proposal: SegmentProposal = {
      entries: simulateEntries(current.age, timeAdvance, segmentId, style),
      timeAdvance,
      attributeDeltas: {},
    };

    // `compliant` 只在程序下了强制指令时才提岔路。
    // 注意这里的顺序：stopPlan 必须先算出来，因为「要不要提」取决于它。
    if (proposalStyle === 'eager' || stopPlan.stop) {
      proposal.decision = {
        prompt: '模拟岔路。',
        stakes: '模拟的分量说明。',
        options: ['向左', '向右'],
      };
    }

    const result = resolveSegment({
      world,
      character: current,
      worldStatus: '',
      proposal,
      segmentId,
      lastDecisionSegmentId,
      stopPlan,
      rng,
    });
    current = result.character;

    if (result.segment.decision) {
      // 只统计**两次停车之间**的间隔。
      //
      // 第一次停车没有「上一次」可比，硬密度上限对它本来也是豁免的
      // （那一条防的是「连着停两次」）。把它算成 gap = segmentId，
      // 会让「第一段就停车」被误报成「违反了 2 段下限」——一个纯属
      // 度量口径问题的假警报。
      if (lastDecisionSegmentId > 0) {
        minDecisionGap = Math.min(minDecisionGap, segmentId - lastDecisionSegmentId);
      }
      decisions += 1;
      lastDecisionSegmentId = segmentId;
    }

    const nextTier = current.attributes[world.mechanics.realmKey] ?? 0;
    if (tierAges.length <= nextTier) tierAges.push(current.age);

    if (result.ending) {
      return {
        age: current.age,
        tier: nextTier,
        cause: result.breakdown.endingCause ?? 'unfinished',
        segments: segmentId,
        decisions,
        minDecisionGap: Number.isFinite(minDecisionGap) ? minDecisionGap : 0,
        tierAges,
      };
    }
  }

  return {
    age: current.age,
    tier: current.attributes[world.mechanics.realmKey] ?? 0,
    cause: 'unfinished',
    segments: MAX_SEGMENTS,
    decisions,
    minDecisionGap: Number.isFinite(minDecisionGap) ? minDecisionGap : 0,
    tierAges,
  };
}

export interface SimulationReport {
  lives: LifeOutcome[];
  causeRates: Record<string, number>;
  tierHistogram: Map<number, number>;
  averageAge: number;
  averageSegments: number;
  averageDecisions: number;
  averageTier: number;
  lifespanRate: number;
  ascensionRate: number;
  nearTopRate: number;
  /** 全部样本中最小的决策间隔。低于硬密度下限就是程序门槛失守。 */
  minDecisionGap: number;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function simulateWorld(
  world: WorldSetting,
  count: number,
  options: SimulateOptions = {},
): SimulationReport {
  const lives: LifeOutcome[] = [];
  for (let seed = 1; seed <= count; seed += 1) {
    lives.push(simulateLife(world, seed, options));
  }

  const causeCounts = new Map<string, number>();
  const tierHistogram = new Map<number, number>();
  for (const life of lives) {
    causeCounts.set(life.cause, (causeCounts.get(life.cause) ?? 0) + 1);
    tierHistogram.set(life.tier, (tierHistogram.get(life.tier) ?? 0) + 1);
  }

  const causeRates: Record<string, number> = {};
  for (const [cause, count_] of causeCounts) {
    causeRates[cause] = count_ / lives.length;
  }

  const nearTopTier = world.mechanics.realmNames.length - 2;
  const gaps = lives.map((life) => life.minDecisionGap).filter((gap) => gap > 0);

  return {
    lives,
    causeRates,
    tierHistogram,
    averageAge: average(lives.map((life) => life.age)),
    averageSegments: average(lives.map((life) => life.segments)),
    averageDecisions: average(lives.map((life) => life.decisions)),
    averageTier: average(lives.map((life) => life.tier)),
    lifespanRate: causeRates['lifespan'] ?? 0,
    ascensionRate: causeRates['ascension'] ?? 0,
    nearTopRate: lives.filter((life) => life.tier >= nearTopTier).length / lives.length,
    minDecisionGap: gaps.length > 0 ? Math.min(...gaps) : 0,
  };
}

/**
 * 终局阶位需要铺开多少种。
 *
 * 不能一概而论地要求 5 种：只有 4 个阶位的世界无论如何也铺不出 5 种终局。
 * 这里按阶位数量缩放，同时对多阶位的世界保留「5 种」这条较严的要求。
 */
export function requiredDistinctTiers(world: WorldSetting): number {
  return Math.max(
    3,
    Math.min(DESIGN_INVARIANTS.distinctFinalTiers.min, world.mechanics.realmNames.length - 1),
  );
}

/**
 * 一局至少要跑多少段。
 *
 * 同样不能一概而论。段落数 = 人生长度 ÷ 单段跨度，而单段跨度有
 * `TIME_ADVANCE_MIN`（3 年）这条下限：终局寿元 62 岁的世界，哪怕每一段都
 * 贴着下限走，一辈子也就 20 段出头，永远达不到为修仙世界定的 24 段。
 *
 * 所以下限按世界自身的尺度缩放——这与 `requiredDistinctTiers` 是同一种处理，
 * 目的都是让断言表达「这个世界有没有发挥出它自己的潜力」，
 * 而不是拿一把尺子量所有题材。
 */
export function requiredMinSegments(world: WorldSetting): number {
  return Math.min(
    DESIGN_INVARIANTS.averageSegments.min,
    Math.max(8, Math.round(expectedSegments(world) * 0.4)),
  );
}

/**
 * 检查设计不变量，返回人话描述的违反项（空数组表示全部达标）。
 *
 * 返回字符串而不是直接断言，是为了让 AI 生成流程能把问题回灌给模型，
 * 也能让界面把「这个世界哪里不对劲」直接展示给玩家。
 */
export function checkInvariants(world: WorldSetting, report: SimulationReport): string[] {
  const problems: string[] = [];
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

  if (report.lifespanRate < DESIGN_INVARIANTS.lifespanRate.min) {
    problems.push(
      `寿元耗尽只占 ${percent(report.lifespanRate)}，低于 ${percent(DESIGN_INVARIANTS.lifespanRate.min)}——寿元几乎没有约束力`,
    );
  }
  if (report.lifespanRate > DESIGN_INVARIANTS.lifespanRate.max) {
    problems.push(
      `寿元耗尽占 ${percent(report.lifespanRate)}，高于 ${percent(DESIGN_INVARIANTS.lifespanRate.max)}——几乎没有别的出路`,
    );
  }

  if (report.ascensionRate <= 0) {
    problems.push('顶阶永远不可达：没有任何一条人生能走到最高阶位的圆满结局');
  } else if (report.ascensionRate > DESIGN_INVARIANTS.ascensionRate.max) {
    problems.push(
      `登顶占 ${percent(report.ascensionRate)}，高于 ${percent(DESIGN_INVARIANTS.ascensionRate.max)}——最高阶位太容易达到`,
    );
  }

  if (report.tierHistogram.size < requiredDistinctTiers(world)) {
    problems.push(
      `终局只铺开了 ${report.tierHistogram.size} 种阶位，少于 ${requiredDistinctTiers(world)} 种——大部分人都卡在同一个位置`,
    );
  }

  const minSegments = requiredMinSegments(world);
  if (report.averageSegments < minSegments) {
    problems.push(
      `平均只有 ${report.averageSegments.toFixed(1)} 段，少于 ${minSegments}——一段推进太粗，人生只剩几步`,
    );
  }
  if (report.averageSegments > DESIGN_INVARIANTS.averageSegments.max) {
    problems.push(
      `平均 ${report.averageSegments.toFixed(1)} 段，多于 ${DESIGN_INVARIANTS.averageSegments.max}——一段推进太碎，又回到了高频点击`,
    );
  }

  if (report.averageDecisions < DESIGN_INVARIANTS.decisionsPerLife.min) {
    problems.push(
      `平均只有 ${report.averageDecisions.toFixed(1)} 次介入，少于 ${DESIGN_INVARIANTS.decisionsPerLife.min}——玩家几乎没有参与感`,
    );
  }
  if (report.averageDecisions > DESIGN_INVARIANTS.decisionsPerLife.max) {
    problems.push(
      `平均 ${report.averageDecisions.toFixed(1)} 次介入，多于 ${DESIGN_INVARIANTS.decisionsPerLife.max}——决策又变回了负担`,
    );
  }

  if (report.minDecisionGap > 0 && report.minDecisionGap < DESIGN_INVARIANTS.minDecisionGap) {
    problems.push(
      `出现过间隔仅 ${report.minDecisionGap} 段的连续决策，低于硬密度下限 ${DESIGN_INVARIANTS.minDecisionGap} 段——模型连续停车没有被拦住`,
    );
  }

  if (report.nearTopRate < DESIGN_INVARIANTS.nearTopRate.min) {
    problems.push(
      `只有 ${percent(report.nearTopRate)} 的人生能走到次高阶位，低于 ${percent(DESIGN_INVARIANTS.nearTopRate.min)}——高阶只是阶梯上的装饰`,
    );
  }

  return problems;
}

/**
 * 完整校验：常规不变量跑一次，**决策密度两侧各跑一次**。
 *
 * 为什么密度要单独跑：其余不变量（寿元耗尽、突破、阶位分布）与模型形态**无关**——
 * 三种形态的随机数流完全一样，只是决策门槛的判定不同。重复跑它们既浪费，
 * 还会产生三份几乎相同的报告。
 *
 * 而密度恰好是唯一依赖模型形态的东西，也正是最容易漏的：
 * `eager` 是上界（模型爱提岔路），`compliant` 是下界（模型只在被强制时才提）。
 * 只测一侧会给出虚假的安全感——**两侧都真的漏过**。
 *
 * AI 生成的世界走的是这条完整校验；内置世界由 `balance.test.ts` 跑三种形态。
 */
export function checkInvariantsAcrossForms(world: WorldSetting, count: number): string[] {
  const problems = checkInvariants(
    world,
    simulateWorld(world, count, VERIFY_SCENARIOS.eagerPlain.options),
  );

  // 上界：措辞丰富会命中关键词门槛，比中性文案更容易停车
  const evocative = simulateWorld(world, count, VERIFY_SCENARIOS.eagerEvocative.options);
  if (evocative.averageDecisions > DESIGN_INVARIANTS.decisionsPerLife.max) {
    problems.push(
      `模型措辞丰富时平均 ${evocative.averageDecisions.toFixed(1)} 次介入，` +
        `多于 ${DESIGN_INVARIANTS.decisionsPerLife.max}——决策又变回了负担`,
    );
  }

  // 下界：模型从不主动提议时，只剩程序侧强制那几次
  const compliant = simulateWorld(world, count, VERIFY_SCENARIOS.compliant.options);
  if (compliant.averageDecisions < DESIGN_INVARIANTS.decisionsPerLife.min) {
    problems.push(
      `模型从不主动提议岔路时平均只有 ${compliant.averageDecisions.toFixed(1)} 次介入，` +
        `少于 ${DESIGN_INVARIANTS.decisionsPerLife.min}——玩家几乎出不了手`,
    );
  }

  return problems;
}
