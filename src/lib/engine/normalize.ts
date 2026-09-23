import {
  TIME_ADVANCE_MAX,
  TIME_ADVANCE_MIN,
  type CharacterState,
  type DecisionProposal,
  type LifeEntry,
  type ListOp,
  type RelOp,
  type SegmentProposal,
  type WorldSetting,
} from './types';

/**
 * 数值规整层。
 *
 * 与 `schema.ts` 的分工：schema 只判「形状」，这里负责把所有「形状对但数值不合理」
 * 的内容修正到合法范围，并把每次修正记进 `warnings` 作为审计轨迹。
 * 这一层**从不抛错**——能修就修，修了就记。
 *
 * 年表重构后这一层多了一项关键职责：**条目年龄校正**。条目是权威时间轴，
 * 模型给出的 `age` 必须被压成「单调不减且不超出段尾」，否则年表上会出现
 * 时间倒流，或者条目落在这一段之外。
 */

const WORLD_STATUS_MAX = 1200;
const ENDING_REASON_MAX = 200;
const LIST_OP_MAX = 12;
const REL_OP_MAX = 12;
const TEXT_MAX = 60;

/**
 * 条目的显示上限。
 *
 * 提示词要求 15~40 字，这里留出余量到 60：**截断本身是有代价的**——
 * 一句写到一半被切断的条目比短句更难看，而 60 字仍在「一眼扫过」的量级内。
 * 真正超标（比如模型把整段叙事塞进 text）才截。
 */
const ENTRY_TEXT_MAX = 60;
/** 只有重要条目才给 detail，因此可以给得比较宽松。 */
const ENTRY_DETAIL_MAX = 400;

const DECISION_PROMPT_MAX = 200;
const DECISION_STAKES_MAX = 120;
const DECISION_OPTION_MAX = 6;

/** 条目全部被清洗掉时的兜底内容。刻意写得题材无关。 */
const FALLBACK_ENTRY_TEXT = '时光流转';

export interface NormalizeResult {
  proposal: SegmentProposal;
  warnings: string[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** 清洗一组文本：去空白、丢空串、去重、限量。 */
function cleanTextList(values: readonly string[], max: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    if (typeof raw !== 'string') continue;
    const text = raw.trim();
    if (text === '' || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= max) break;
  }
  return result;
}

function cleanListOps(
  ops: readonly ListOp[] | undefined,
  label: string,
  warnings: string[],
): ListOp[] | undefined {
  if (!ops || ops.length === 0) return undefined;

  const result: ListOp[] = [];
  for (const op of ops.slice(0, LIST_OP_MAX)) {
    const value = typeof op.value === 'string' ? truncate(op.value, TEXT_MAX) : '';
    if (value === '') {
      warnings.push(`${label}操作缺少有效名称，已忽略`);
      continue;
    }
    if (op.op !== 'add' && op.op !== 'remove') {
      warnings.push(`${label}操作「${value}」的动作类型不合法，已忽略`);
      continue;
    }
    result.push({ op: op.op, value });
  }
  return result.length > 0 ? result : undefined;
}

function cleanRelOps(ops: readonly RelOp[] | undefined, warnings: string[]): RelOp[] | undefined {
  if (!ops || ops.length === 0) return undefined;

  const result: RelOp[] = [];
  for (const op of ops.slice(0, REL_OP_MAX)) {
    const target = typeof op.target === 'string' ? truncate(op.target, TEXT_MAX) : '';
    if (target === '') {
      warnings.push('关系操作缺少目标人物，已忽略');
      continue;
    }
    if (op.op === 'set') {
      const value = typeof op.value === 'string' ? truncate(op.value, TEXT_MAX) : '';
      if (value === '') {
        warnings.push(`对「${target}」的关系设置缺少内容，已忽略`);
        continue;
      }
      result.push({ op: 'set', target, value });
    } else if (op.op === 'remove') {
      result.push({ op: 'remove', target });
    } else {
      warnings.push(`对「${target}」的关系操作类型不合法，已忽略`);
    }
  }
  return result.length > 0 ? result : undefined;
}

/**
 * 条目年龄校正。
 *
 * 规则只有两条，但都很要紧：
 * - **单调不减**：年表上不允许时间倒流
 * - **落在段内**：`[characterAge, characterAge + timeAdvance]`
 *
 * 校正而不是丢弃，是因为条目本身的内容仍然有价值；年龄错位属于
 * 「数值不合理」，正是这一层该修的东西。
 */
function cleanEntries(
  raw: readonly LifeEntry[],
  characterAge: number,
  timeAdvance: number,
  warnings: string[],
): LifeEntry[] {
  const segmentEnd = characterAge + timeAdvance;
  const entries: LifeEntry[] = [];
  let previousAge = characterAge;
  let correctedAges = 0;
  let dropped = 0;

  for (const entry of raw) {
    const text = typeof entry.text === 'string' ? truncate(entry.text, ENTRY_TEXT_MAX) : '';
    if (text === '') {
      dropped += 1;
      continue;
    }

    const rawAge = Math.round(Number(entry.age));
    const target = Number.isFinite(rawAge) ? rawAge : previousAge;
    const age = clamp(target, previousAge, segmentEnd);
    if (age !== target) correctedAges += 1;

    const clean: LifeEntry = { age, kind: entry.kind, text };
    if (entry.detail != null) {
      const detail = truncate(entry.detail, ENTRY_DETAIL_MAX);
      if (detail !== '') clean.detail = detail;
    }

    entries.push(clean);
    previousAge = age;
  }

  if (dropped > 0) warnings.push(`本段有 ${dropped} 条条目内容为空，已丢弃`);
  if (correctedAges > 0) {
    warnings.push(
      `本段有 ${correctedAges} 条条目的年龄不单调或超出段尾，已按段内时间轴校正到 ${characterAge}~${segmentEnd} 岁之间`,
    );
  }

  if (entries.length === 0) {
    warnings.push('本段没有留下任何有效条目，已补一条占位条目');
    entries.push({ age: segmentEnd, kind: 'event', text: FALLBACK_ENTRY_TEXT });
  }

  return entries;
}

/**
 * 决策点规整。
 *
 * 选项少于 2 个的决策点直接丢弃——只有一个选项的「选择」是在骗玩家。
 * 丢弃发生在这里而不是门槛判定里，因为「选项不够」是能一眼看出的残缺，
 * 不该占用一次门槛判定的语义。
 */
function cleanDecision(
  raw: DecisionProposal | undefined,
  warnings: string[],
): DecisionProposal | undefined {
  if (!raw) return undefined;

  const prompt = truncate(raw.prompt, DECISION_PROMPT_MAX);
  if (prompt === '') {
    warnings.push('模型给出了决策点但缺少引子，已忽略');
    return undefined;
  }

  const stakes =
    truncate(raw.stakes, DECISION_STAKES_MAX) || '这一步会改变之后很多年的走向。';

  const options = cleanTextList(raw.options, DECISION_OPTION_MAX);
  if (options.length < 2) {
    warnings.push('决策点的选项少于 2 个，玩家无从选择，已忽略这个决策点');
    return undefined;
  }

  return { prompt, stakes, options };
}

/**
 * 把模型提议规整为可直接用于结算的形态。
 *
 * @param raw       已通过结构校验的提议
 * @param world     当前世界观（提供属性定义与数值上限）
 * @param character 当前角色（提供当前年龄与意志类属性的安全边界）
 */
export function normalizeSegment(
  raw: SegmentProposal,
  world: WorldSetting,
  character: CharacterState,
): NormalizeResult {
  const warnings: string[] = [];
  const definitions = new Map(world.attributes.map((attribute) => [attribute.key, attribute]));
  const { cultivationKey, maxDeltaPerSegment } = world.mechanics;

  // ── 时间增量 ──────────────────────────────────────────────
  // 先算时间，因为条目年龄校正要用到它。
  let timeAdvance = Math.round(raw.timeAdvance);
  if (!Number.isFinite(timeAdvance) || timeAdvance < TIME_ADVANCE_MIN) {
    warnings.push(
      `本段时间跨度 ${raw.timeAdvance} 不合法或过短，已按 ${TIME_ADVANCE_MIN} 年推进`,
    );
    timeAdvance = TIME_ADVANCE_MIN;
  } else if (timeAdvance > TIME_ADVANCE_MAX) {
    warnings.push(`本段时间跨度 ${timeAdvance} 年超出上限 ${TIME_ADVANCE_MAX} 年，已裁剪`);
    timeAdvance = TIME_ADVANCE_MAX;
  }

  // ── 条目 ──────────────────────────────────────────────────
  const entries = cleanEntries(raw.entries, character.age, timeAdvance, warnings);

  // ── 属性变化 ──────────────────────────────────────────────
  const attributeDeltas: Record<string, number> = {};
  for (const [key, rawValue] of Object.entries(raw.attributeDeltas)) {
    const definition = definitions.get(key);
    if (!definition) {
      warnings.push(`忽略了未定义的属性键「${key}」`);
      continue;
    }

    // 「进度」类属性是程序拥有的量：由时间与资质结算，模型说了不算。
    if (key === cultivationKey) {
      const aptitudeLabel =
        definitions.get(world.mechanics.cultivationGain.aptitudeKey)?.label ?? '资质';
      warnings.push(
        `${definition.label}由系统按时间与${aptitudeLabel}结算，已忽略模型给出的${definition.label}增减`,
      );
      continue;
    }

    let value = rawValue;
    if (!Number.isFinite(value)) {
      warnings.push(`属性「${definition.label}」的变化量不是有限数值，按 0 处理`);
      value = 0;
    }
    if (definition.integer) value = Math.round(value);

    if (Math.abs(value) > maxDeltaPerSegment) {
      warnings.push(
        `属性「${definition.label}」单段变化 ${value} 超出上限 ±${maxDeltaPerSegment}，已裁剪`,
      );
      value = clamp(value, -maxDeltaPerSegment, maxDeltaPerSegment);
    }

    if (value !== 0) attributeDeltas[key] = value;
  }

  // 意志类属性归零会直接触发程序的死亡判定，
  // 因此不允许模型用一次数值变化把角色直接推死——最多扣到死亡线上方一点。
  const willpowerKey = world.mechanics.death.willpowerKey;
  const willpowerLabel = definitions.get(willpowerKey)?.label ?? willpowerKey;
  const willpowerDelta = attributeDeltas[willpowerKey];
  if (willpowerDelta !== undefined) {
    const current = character.attributes[willpowerKey] ?? 0;
    if (current + willpowerDelta <= world.mechanics.death.willpowerThreshold) {
      const capped = world.mechanics.death.willpowerThreshold + 1 - current;
      warnings.push(
        `属性「${willpowerLabel}」的变化会把角色直接推入崩溃结局，已限制为 ${capped}（程序不接受模型直接判死）`,
      );
      if (capped === 0) delete attributeDeltas[willpowerKey];
      else attributeDeltas[willpowerKey] = capped;
    }
  }

  // ── 世界局势 ──────────────────────────────────────────────
  let worldStatusUpdate: string | undefined;
  if (raw.worldStatusUpdate != null) {
    const text = truncate(raw.worldStatusUpdate, WORLD_STATUS_MAX);
    if (text.length < raw.worldStatusUpdate.trim().length) {
      warnings.push(`世界局势文本过长，已截断至 ${WORLD_STATUS_MAX} 字`);
    }
    if (text !== '') worldStatusUpdate = text;
  }

  // ── 结局提议 ──────────────────────────────────────────────
  let endingProposal: SegmentProposal['endingProposal'];
  if (raw.endingProposal != null) {
    const reason = truncate(raw.endingProposal.reason, ENDING_REASON_MAX);
    if (reason !== '') endingProposal = { type: raw.endingProposal.type, reason };
    else warnings.push('结局提议缺少原因说明，已忽略');
  }

  const proposal: SegmentProposal = {
    entries,
    timeAdvance,
    attributeDeltas,
  };

  if (worldStatusUpdate !== undefined) proposal.worldStatusUpdate = worldStatusUpdate;
  if (endingProposal !== undefined) proposal.endingProposal = endingProposal;

  const decision = cleanDecision(raw.decision, warnings);
  if (decision) proposal.decision = decision;

  const traitOps = cleanListOps(raw.traitOps, '特质', warnings);
  if (traitOps) proposal.traitOps = traitOps;

  const inventoryOps = cleanListOps(raw.inventoryOps, '物品', warnings);
  if (inventoryOps) proposal.inventoryOps = inventoryOps;

  const relationshipOps = cleanRelOps(raw.relationshipOps, warnings);
  if (relationshipOps) proposal.relationshipOps = relationshipOps;

  return { proposal, warnings };
}
