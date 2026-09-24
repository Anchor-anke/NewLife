/**
 * 核心数据契约。
 *
 * 对应设计稿《AI 人生引擎：产品与技术设计方案》第 5 节，并按《年表式叙事重构方案》
 * 把叙事单位从「回合」换成了「段落 + 条目」：
 *
 * - 一次模型调用产出**一个段落**（`LifeSegment`），段落覆盖若干年、由若干**条目**
 *   （`LifeEntry`）构成，条目是年表上一句可扫读的话。
 * - 段落结束时若到达重要节点，会带上一个**决策点**（`DecisionPoint`），玩家在这里停车。
 *
 * 设计原则不变：模型只负责提出 `SegmentProposal`，程序负责校验与结算，产出
 * `resolvedCharacter` / `resolvedWorldStatus` / `Ending`。
 */

/** 当前存档结构版本。结构变更时递增，并由 migrateSave 负责升级。 */
export const SCHEMA_VERSION = 2;

/** 导出文件的格式版本，与 SCHEMA_VERSION 解耦（导出包结构可独立演进）。 */
export const EXPORT_FORMAT_VERSION = 2;

/**
 * 一个段落覆盖的时间跨度上下限（年）。
 *
 * 这是「一屏能看多少年」的总闸门，同时被三处使用，必须只有一个定义：
 * 提示词（告诉模型）、规整层（裁剪模型给出的值）、数值模拟（按同一假设调参）。
 *
 * 上限**刻意比方案里写的 25 年宽**。方案的目标是「每局 30~60 段、一屏 20~40 年」，
 * 但终局寿元 3400 岁的世界若把单段封在 25 年，一局会碎成 130 多屏——与它自己的
 * 段数目标直接冲突。真正的节奏锚点是 `timeAdvanceHint` 里的
 * 「终局寿元 ÷ 目标段数」，这里的上下限只是防止模型给出离谱值的兜底。
 */
export const TIME_ADVANCE_MIN = 3;
export const TIME_ADVANCE_MAX = 60;

// ────────────────────────────────────────────────────────────
// 世界观
// ────────────────────────────────────────────────────────────

/**
 * 属性的结算语义。不同语义的裁剪与展示方式不同：
 * - `counter`  常规累积值，受 min/max 约束（根骨、心性、声望…）
 * - `resource` 可消耗资源，通常只有下限（灵石）
 * - `progress` 进度条，满值触发事件（修为）
 */
export type AttributeKind = 'counter' | 'resource' | 'progress';

export interface AttributeDefinition {
  key: string;
  label: string;
  initialValue: number;
  min?: number;
  max?: number;
  kind: AttributeKind;
  /** 结算后取整。避免浮点误差在 clamp 边界抖动。 */
  integer?: boolean;
  /** 是否在状态面板主区域突出展示 */
  primary?: boolean;
  /** 该属性在 UI 上的单位后缀，如「岁」「块」 */
  unit?: string;
  /**
   * 创角时的随机区间（含端点）。存在时由创角流程在 [min, max] 内取整随机，
   * 否则直接使用 initialValue。
   */
  roll?: { min: number; max: number };
}

/** 天赋的程序可读修正器。不能只写自然语言，否则无法参与结算。 */
export interface TalentModifiers {
  /** 修为增速倍率 */
  cultivationGainMul?: number;
  /** 突破判定的固定加成 */
  breakthroughBonus?: number;
  /** 剧情事件权重倍率（供未来事件表使用） */
  eventWeightMul?: number;
}

export interface Talent {
  id: string;
  name: string;
  description: string;
  modifiers: TalentModifiers;
  /** 创角时的一次性属性修正 */
  attributeBonus?: Record<string, number>;
}

/**
 * 结构化世界机制。程序判死、判突破必须读这里的数值，
 * 而不是去解析 `rules: string[]` 这种只给模型看的自然语言。
 */
export interface WorldMechanics {
  cultivationKey: string;
  realmKey: string;
  /** 修为进度上限，达到即进入突破判定 */
  cultivationMax: number;
  /** 按境界索引的境界名 */
  realmNames: string[];
  /** 按境界索引的寿元上限，末位通常为 Infinity */
  lifespanByRealm: number[];

  cultivationGain: {
    /** 凡人期每年积累的修为 */
    base: number;
    /**
     * 每提升一个境界，每年积累量的乘数（小于 1，即几何衰减）。
     *
     * 这是「越往上越慢」的唯一来源，也是寿元机制能成立的前提：
     * 线性衰减不够用，因为寿元随境界的增长会盖过它，导致玩家永远追不上寿元的宽松度。
     * 只有「突破所需年数」的增长快过「寿元」的增长，寿元耗尽才会真正咬人。
     */
    decayFactor: number;
    /** 每年积累量的下限，避免高境界完全停滞 */
    min: number;
    /** 对增速产生加成的属性键（根骨） */
    aptitudeKey: string;
    /** 加成公式：perYear *= 1 + aptitude / aptitudeScale */
    aptitudeScale: number;
  };

  breakthrough: {
    /** 参与突破判定的属性键及权重 */
    weights: Record<string, number>;
    /** 每提升一个境界，判定值需要额外高出的量 */
    penaltyPerRealm: number;
    minProbability: number;
    maxProbability: number;
    /** 突破失败时扣除的修为 */
    failureCultivationLoss: number;
    /** 心性低于阈值时，失败额外扣心性 */
    lowWillpowerKey: string;
    lowWillpowerThreshold: number;
    lowWillpowerPenalty: number;
  };

  death: {
    /** 心性低于等于该值判定「心魔噬身」 */
    willpowerKey: string;
    willpowerThreshold: number;
    /**
     * 模型提议死亡时用于判定的「气运」属性键。气运越高，越可能化险为夷。
     * 不能写死成 `luck`——不同题材里这个属性可能叫气运、运气、机敏或根本不存在。
     */
    luckKey: string;
    /** 模型提议死亡时，本段事件必须命中这些关键词之一才考虑采纳 */
    lethalEventKeywords: string[];
  };

  /**
   * 单个段落内任一 counter 属性的变化幅度上限（绝对值）。超出则裁剪并记警告，
   * 防止模型给出「一次跨越十年就声望 +100」这类离谱数值。
   *
   * 一个段落 = 一次模型调用，因此这个上限天然覆盖了段落跨越的若干年。
   */
  maxDeltaPerSegment: number;

  /** 创角时的起始年龄（岁）。 */
  startingAge: number;

  /**
   * 模型提议 completion 结局时，角色境界至少需达到该值才予采纳；
   * 未达到则忽略该提议并记警告（程序不承认「叙事上的圆满」等同于结局）。
   */
  completionProposalMinRealm: number;

  /** 段落数软上限，超过则强制结局 */
  segmentSoftLimit: number;
}

/**
 * 非阶位人生的第一套规则。旧世界快照没有 ruleset，始终按原阶位规则运行。
 * 过渡期仍保留 WorldMechanics 字段供旧世界工坊和模拟器使用；open_life 结算
 * 不读取其中的阶位、突破或寿元表。
 */
export interface OpenLifeRules {
  kind: 'open_life';
  version: 2;
  healthKey: string;
  spiritKey: string;
  careerKey: string;
  luckKey: string;
  lethalEventKeywords: string[];
  startingAge: number;
  /** 仅供旧结算使用、不在新玩法出现的属性键。 */
  legacyHiddenKeys: string[];
  agingStartAge: number;
  annualHealthLoss: number;
  maxAge: number;
  completionMinAge: number;
  maxDeltaPerSegment: number;
  segmentSoftLimit: number;
  naturalDeath: { reason: string; narrative: string };
  healthDeath: { reason: string; narrative: string };
  /** 评级由有证据的委托或机构评定推动，每段最多升一级。 */
  earnedRank?: { key: string; evidenceKeywords: string[] };
  /** 集体建设的阶段属于世界，不能作为人物的寿命等级。 */
  worldProgress?: { stageKey: string; progressKey: string; stageNames: string[]; threshold: number };
}

/**
 * 结局文本模板。
 *
 * 这些文字原本写死在结算层里，全是修仙措辞（「羽化飞升」「坐化」），
 * 换成现代都市或科幻题材就驴唇不对马嘴。抽到世界观数据里之后，
 * 引擎只负责判定「是什么结局」，措辞由题材自己决定。
 *
 * 支持占位符：`{realm}` 当前阶位名、`{lifespan}` 寿元上限、`{age}` 享年、
 * `{reason}` 模型给出的原因。
 */
export interface WorldEndingTexts {
  /** 抵达当前阶位的寿元上限 */
  lifespan: { reason: string; narrative: string };
  /** 意志 / 理智归零 */
  collapse: { reason: string; narrative: string };
  /** 已在顶阶且突破成功——本世界的「圆满」结局 */
  ascension: { reason: string; narrative: string };
  /** 达到段落数上限，强制收束 */
  turnLimit: { reason: string; narrative: string };
  /** 模型提议的死亡获采纳时的收束句式 */
  deathByProposal: string;
  /** 模型提议的圆满结局获采纳时的收束句式 */
  completionByProposal: string;
}

export interface WorldSetting {
  id: string;
  version: number;
  name: string;
  description: string;
  /** 固定世界法则。只作为叙事约束传给模型，程序不解析。 */
  rules: string[];
  /** 开局时的世界局势，作为第一段的上下文起点。 */
  initialWorldStatus: string;
  timeUnit: 'year' | 'month' | 'day';
  attributes: AttributeDefinition[];
  /** 与人物属性分开的世界状态定义；旧世界快照没有此字段。 */
  worldAttributes?: AttributeDefinition[];
  mechanics: WorldMechanics;
  /** 缺失表示 v1 阶位寿元规则，保证旧存档与旧自定义世界的行为不变。 */
  ruleset?: OpenLifeRules;
  talents: Talent[];
  endings: WorldEndingTexts;
}

// ────────────────────────────────────────────────────────────
// 年表：条目、段落、决策点
// ────────────────────────────────────────────────────────────

/**
 * 条目类型。决定年表上的图标与配色，也参与「条目类型分布」的密度校验
 * （连续同类型的条目会被判为流水账）。
 */
export type EntryKind =
  | 'cultivation'
  | 'event'
  | 'relationship'
  | 'fortune'
  | 'setback'
  | 'milestone';

export const ENTRY_KINDS: readonly EntryKind[] = [
  'cultivation',
  'event',
  'relationship',
  'fortune',
  'setback',
  'milestone',
];

/**
 * 时间轴上的一个条目。一句话，可扫读。
 *
 * 条目是**权威时间轴**：程序按条目逐条推进年龄，寿元耗尽时就截断到那一条。
 */
export interface LifeEntry {
  /** 发生时的年龄。程序会校正为单调递增且不超出段尾。 */
  age: number;
  kind: EntryKind;
  /** 一句话，25 字以内 */
  text: string;
  /** 可选。只有重要条目才给，100~200 字的完整叙事 */
  detail?: string;
  /** 程序结算的条目时点属性快照，供逐条呈现时同步状态栏；旧存档可缺失。 */
  settledAttributes?: Record<string, number>;
  settledWorldAttributes?: Record<string, number>;
}

/**
 * 决策点的成因。程序侧记录，用于调参与界面展示。
 *
 * - `proposed`     模型提议且通过了门槛
 * - `breakthrough` 本段发生了阶位突破
 * - `near-end`     寿元进入末段
 * - `long-gap`     距上次介入太久，强制给一次参与感
 */
export type DecisionCause = 'proposed' | 'breakthrough' | 'near-end' | 'life-turn' | 'long-gap';

/** 模型提议的岔路。此时还没有成因，成因由程序判定后补上。 */
export interface DecisionProposal {
  /** 引子，1~3 句话，说清现在发生了什么 */
  prompt: string;
  /** 为什么这是个重要节点。写给玩家看，让他明白这次选择的分量 */
  stakes: string;
  /** 2~4 个选项 */
  options: string[];
}

/** 经过程序门槛、真的停在玩家面前的一个岔路。 */
export interface DecisionPoint extends DecisionProposal {
  cause: DecisionCause;
}

/**
 * 模型对下一段的提议。**这不是结算结果**，必须经过校验与规则结算后才生效。
 *
 * `attributeDeltas` 采用「出现的键才应用」语义：`{ cultivation: 0 }` 表示显式
 * 将修为变化量设为 0，而键不出现表示不涉及该属性。
 */
export interface SegmentProposal {
  /** 本段的条目流。至少 1 条，程序会校正年龄并检查类型分布。 */
  entries: LifeEntry[];
  /** 本段覆盖的时间增量，单位由 world.timeUnit 决定 */
  timeAdvance: number;
  attributeDeltas: Record<string, number>;
  worldDeltas?: Record<string, number>;
  worldStatusUpdate?: string;
  traitOps?: ListOp[];
  inventoryOps?: ListOp[];
  relationshipOps?: RelOp[];
  /** 模型认为本段结束时到了岔路口 */
  decision?: DecisionProposal;
  endingProposal?: {
    type: 'death' | 'completion';
    reason: string;
  };
}

/**
 * 已结算的一个段落。
 *
 * 与 `SegmentProposal` 的差别只有一处：`decision` 带上了程序判定的成因。
 * 判定未通过的决策点会被整段丢弃，不打断玩家。
 */
export interface LifeSegment {
  entries: LifeEntry[];
  timeAdvance: number;
  attributeDeltas: Record<string, number>;
  worldDeltas?: Record<string, number>;
  worldStatusUpdate?: string;
  traitOps?: ListOp[];
  inventoryOps?: ListOp[];
  relationshipOps?: RelOp[];
  decision?: DecisionPoint;
  endingProposal?: {
    type: 'death' | 'completion';
    reason: string;
  };
  /**
   * 由旧版存档迁移而来。
   *
   * 旧存档每个回合是一整段长叙事，迁移时压成「一条 milestone 条目 + 完整 detail」。
   * 界面据此标注「旧版记录」，而不是假装它本来就是一个段落。
   */
  legacy?: true;
}

/** 列表类字段（特质、物品）的增删操作 */
export type ListOp = { op: 'add' | 'remove'; value: string };

/** 关系类字段的增删改操作 */
export type RelOp =
  | { op: 'set'; target: string; value: string }
  | { op: 'remove'; target: string };

// ────────────────────────────────────────────────────────────
// 角色与存档状态
// ────────────────────────────────────────────────────────────

export interface CharacterState {
  name: string;
  /** 年龄，单位为年 */
  age: number;
  isAlive: boolean;
  attributes: Record<string, number>;
  traits: string[];
  inventory: string[];
  relationships: Record<string, string>;
  /** 创角时选定的天赋 id，用于结算时取修正器 */
  talentId?: string;
}

export interface Ending {
  type: 'death' | 'completion';
  reason: string;
  /** 结局时的叙事收束文本 */
  narrative: string;
  atSegmentId: number;
}

export interface SummaryState {
  lastError?: string;
  attempts: number;
  lastAttemptAt: number;
}

export interface SaveStats {
  totalSegments: number;
  startedAt: number;
  endedAt?: number;
}

export interface ModelMeta {
  provider: string;
  model: string;
  latencyMs: number;
  /** 结构校验失败后的回灌重试次数 */
  retries?: number;
}

// ────────────────────────────────────────────────────────────
// 结算
// ────────────────────────────────────────────────────────────

export interface AttributeChange {
  key: string;
  label: string;
  from: number;
  to: number;
  delta: number;
}

/**
 * 结局的成因。
 *
 * 刻意做成枚举而不是让调用方去匹配 `reason` 文案——文案属于世界观数据，
 * 换个题材就会变，拿它做判断的代码迟早会悄悄失效。
 */
export type EndingCause =
  | 'lifespan'
  | 'health'
  | 'old-age'
  | 'collapse'
  | 'ascension'
  | 'turn-limit'
  | 'proposed-death'
  | 'proposed-completion';

export interface BreakthroughRecord {
  attempted: boolean;
  success: boolean;
  fromRealm: number;
  toRealm: number;
  probability: number;
  roll: number;
  /** 这次突破发生在角色几岁时。一个段落可能横跨多年、发生多次突破。 */
  age: number;
}

export interface ResolveBreakdown {
  attributeChanges: AttributeChange[];
  /** 实际推进的年数。寿元耗尽被截断时会小于提议的 timeAdvance。 */
  timeAdvance: number;
  /** 本段内发生的全部突破尝试，按时间先后排列。 */
  breakthroughs: BreakthroughRecord[];
  /** 被程序采纳的决策点成因。没有停车时为 undefined。 */
  decisionCause?: DecisionCause;
  /** 程序侧的结局判定说明，便于在 UI 上向玩家解释「为什么结束了」 */
  endingNote?: string;
  /** 结局成因。没有结局时为 undefined。 */
  endingCause?: EndingCause;
}

export interface ResolveResult {
  character: CharacterState;
  worldStatus: string;
  worldAttributes?: Record<string, number>;
  /** 校验或修正过程中产生的审计轨迹，例如丢弃未知属性键、越界 clamp */
  warnings: string[];
  ending?: Ending;
  breakdown: ResolveBreakdown;
}

// ────────────────────────────────────────────────────────────
// 持久化记录
// ────────────────────────────────────────────────────────────

/**
 * 存档主记录（Dexie 表 `saves`）。
 *
 * 刻意不包含段落列表：历史存在独立的 `segments` 表，避免每段全量重写
 * 一个随历史线性增长的大对象。
 */
export interface SaveRecord {
  id: string;
  schemaVersion: number;
  /** 规则语义版本；旧存档缺失时视为 v1。与存档对象版本独立。 */
  rulesetVersion?: number;
  /** 乐观并发版本号，每次成功提交段落 +1 */
  revision: number;
  world: WorldSetting;
  worldStatus: string;
  worldAttributes?: Record<string, number>;
  character: CharacterState;
  historySummary: string;
  /** 已包含在 historySummary 中的连续最后一个 segmentId（含） */
  summarizedThroughSegmentId: number;
  /** 已提交的最大 segmentId */
  latestSegmentId: number;
  /**
   * 上一次真正停车的段号（即最后一个带决策点的段落）。0 表示还没有停过车。
   *
   * 这是决策密度的唯一状态来源：`latestSegmentId - lastDecisionSegmentId`
   * 就是「距上次介入已经自动推进了多少段」。
   */
  lastDecisionSegmentId: number;
  status: 'active' | 'ended';
  ending?: Ending;
  /** 人生总结长文本 */
  epilogue?: string;
  summaryState?: SummaryState;
  stats: SaveStats;
  createdAt: number;
  updatedAt: number;
}

/**
 * Jev（决策打分模型）对本段岔路各选项的推演分数。
 *
 * 纯观测数据：跟着段记录落盘、随导出走，用于事后分析「分数与玩家实际选择」
 * 的对齐程度。它**不参与结算**，也永远不该参与——评分层和剧情层必须分开。
 */
export interface JevScores {
  /** 与决策点 options 同序的概率，0~1 */
  probabilities: number[];
  /** probabilities 的 argmax */
  topIndex: number;
  /** 打分模型对这次推演的置信度，0~1 */
  confidence: number;
  /** 打分时实际使用的模型名（`jev-latest` 可能解析成具体版本号） */
  model: string;
}

/**
 * 单个段落记录（Dexie 表 `segments`，主键 `[saveId+segmentId]`）。
 * 记录模型提议与程序结算后的最终状态，作为可追溯的审计轨迹。
 */
export interface LifeSegmentRecord {
  saveId: string;
  segmentId: number;
  /** 用于幂等识别，防止重试或重复点击造成重复结算 */
  requestId: string;
  /** 触发本段的玩家决定。第一段（以及世界自行运转的段）没有。 */
  playerAction?: string;
  segment: LifeSegment;
  /** 本段开始前的角色状态。让每条记录都能独立解释「从什么变成了什么」。 */
  characterBefore: CharacterState;
  worldAttributesBefore?: Record<string, number>;
  resolvedCharacter: CharacterState;
  resolvedWorldStatus: string;
  resolvedWorldAttributes?: Record<string, number>;
  ending?: Ending;
  validationWarnings: string[];
  modelMeta: ModelMeta;
  schemaVersion: number;
  createdAt: number;
  /**
   * 本段岔路的 Jev 推演分数。
   *
   * 可选字段，段落后于打分返回到达，所以是**事后补写**进记录的；
   * 缺失只说明「当时没配 Jev 或打分失败」，不参与任何迁移判断。
   */
  jevScores?: JevScores;
}

/**
 * 进行中的段落（Dexie 表 `pendingSegments`，主键 `requestId`）。
 *
 * 在调用模型**之前**写入，成功提交后在同一个事务里删除。用于在生成期间
 * 刷新页面后提示玩家「上次生成未完成」，避免静默丢失行动与白烧 token。
 */
export interface PendingSegment {
  requestId: string;
  saveId: string;
  segmentId: number;
  playerAction?: string;
  /** 发起该段落时的存档版本，提交时校验以拒绝并发覆盖 */
  expectedRevision: number;
  createdAt: number;
}

/** 导出/导入用的完整存档包（对应设计稿的 GameSave 聚合形态）。 */
export interface GameSaveExport {
  formatVersion: number;
  save: SaveRecord;
  segments: LifeSegmentRecord[];
}

// ────────────────────────────────────────────────────────────
// 模型适配层输入
// ────────────────────────────────────────────────────────────

export interface SegmentContext {
  world: WorldSetting;
  worldStatus: string;
  worldAttributes?: Record<string, number>;
  character: CharacterState;
  historySummary: string;
  recentSegments: LifeSegmentRecord[];
  /** 玩家在上一处岔路口的决定。世界自行运转时为 undefined。 */
  playerAction?: string;
  /**
   * 程序判定本段必须停车时，这里给出提示词要用的强制指令。
   *
   * 只可能是这两种成因：`breakthrough` 是事后才知道的（调用前还没发生），
   * `proposed` 也不是程序能预先强制的。写成窄联合而不是 `DecisionCause`，
   * 是为了让「哪些原因能提前知道」这件事在类型上就说得清楚。
   */
  mustStop?: 'near-end' | 'life-turn' | 'long-gap';
}

export interface SummaryInput {
  world: WorldSetting;
  previousSummary: string;
  segments: LifeSegmentRecord[];
  character: CharacterState;
}

export interface EpilogueInput {
  world: WorldSetting;
  character: CharacterState;
  historySummary: string;
  segments: LifeSegmentRecord[];
  ending: Ending;
  stats: SaveStats;
}
