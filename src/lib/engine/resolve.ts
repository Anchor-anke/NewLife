import type {
  AttributeChange,
  BreakthroughRecord,
  CharacterState,
  DecisionCause,
  DecisionPoint,
  Ending,
  EndingCause,
  LifeEntry,
  LifeSegment,
  ListOp,
  RelOp,
  ResolveBreakdown,
  ResolveResult,
  SegmentProposal,
  TalentModifiers,
  WorldSetting,
} from './types';
import { attributeLabel, fillTemplate, tierName } from './labels';
import { resolveDecision, type StopPlan } from './decision';
import { decisionIntervalFor } from './pacing';
import { openLifeRules } from './ruleset';
import { resolveOpenLife } from './open-life';

/**
 * 规则结算层。
 *
 * 这是整个引擎里唯一有权改变角色状态的模块。模型给出的提议经过
 * `schema.ts`（形状）与 `normalize.ts`（数值）之后，由这里按世界规则
 * 真正落账，并**独立决定**死亡与结局——模型只能提议，不能裁决。
 *
 * 年表重构后这一层多了三件事，都是「一个段落跨越多年」带来的必然结果：
 *
 * 1. **条目级年龄推进**：条目是权威时间轴，逐条推进年龄，寿元耗尽就截断到那一条。
 * 2. **一段内的多次突破**：跨度变长之后，一段里连续突破两三次是正常的，
 *    必须循环处理而不是只判一次。
 * 3. **决策门槛**：段落末尾的岔路要不要真的停车，由 `decision.ts` 判定。
 */

/** 返回 [0, 1) 的随机数。注入以便测试可复现。 */
export type Rng = () => number;

/**
 * 一个段落内允许的最大突破次数。
 *
 * 上限存在的意义是防止「一段闭关千年」把整条阶位阶梯一次性走完；
 * 达到上限后剩余进度结转下一段，不会凭空蒸发。
 */
export const MAX_BREAKTHROUGHS_PER_SEGMENT = 5;

/** 模型提议死亡但未获采纳时，角色承受的「重伤」代价。 */
const NEAR_DEATH_WILLPOWER_LOSS = 12;

export interface ResolveSegmentInput {
  world: WorldSetting;
  character: CharacterState;
  worldStatus: string;
  worldAttributes?: Record<string, number>;
  /** 已规整的段落提议 */
  proposal: SegmentProposal;
  /** 本段的序号，从 1 开始 */
  segmentId: number;
  /** 上一次真正停车的段号，0 表示还没停过 */
  lastDecisionSegmentId: number;
  /**
   * 调用模型之前算出的强制停车计划。
   *
   * 刻意由调用方传入而不是在这里重算：同一个值既要写进提示词，又要参与
   * 后置门槛判定，两处必须是同一份结论。
   */
  stopPlan: StopPlan;
  rng?: Rng;
}

export interface ResolveSegmentResult extends ResolveResult {
  /** 已结算的段落，含经门槛采纳的决策点。 */
  segment: LifeSegment;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getTalentModifiers(world: WorldSetting, character: CharacterState): TalentModifiers {
  if (!character.talentId) return {};
  return world.talents.find((talent) => talent.id === character.talentId)?.modifiers ?? {};
}

/**
 * 把属性值收进它的合法区间，并处理取整。
 *
 * 取整放在这里而不是每个计算步骤上，是因为程序结算的量（修为）是
 * 「每年积累量 × 年数」累加出来的浮点数——一段跨越几十年、又分成若干条目
 * 逐条累加，误差会一直带到界面上，变成「修为 87.60000000000001 / 100」。
 */
function clampAttribute(world: WorldSetting, key: string, value: number): number {
  const definition = world.attributes.find((attribute) => attribute.key === key);
  const min = definition?.min ?? Number.NEGATIVE_INFINITY;
  const max = definition?.max ?? Number.POSITIVE_INFINITY;
  const clamped = clamp(value, min, max);
  return definition?.integer === true ? Math.round(clamped) : clamped;
}

/**
 * 突破成功率。
 *
 * `score = Σ(属性值 × 权重) + 天赋加成`，再按境界施加惩罚。
 * 高境界的惩罚是刻意设计成「越往上越难」的核心来源。
 */
export function computeBreakthroughProbability(
  world: WorldSetting,
  attributes: Record<string, number>,
  talentModifiers: TalentModifiers,
): number {
  const { breakthrough, realmKey } = world.mechanics;

  let score = 0;
  for (const [key, weight] of Object.entries(breakthrough.weights)) {
    score += (attributes[key] ?? 0) * weight;
  }
  score += talentModifiers.breakthroughBonus ?? 0;

  const realm = attributes[realmKey] ?? 0;
  const raw = (score - realm * breakthrough.penaltyPerRealm) / 100;
  return clamp(raw, breakthrough.minProbability, breakthrough.maxProbability);
}

/**
 * 程序侧每年能积累的修为。
 *
 * 修为是**程序拥有的量**：它由时间与根骨决定，模型只能通过 `timeAdvance`
 * 间接影响（闭关十年自然胜过修炼一年）。
 *
 * 境界带来的衰减是**几何**的：`base × decayFactor^realm`。这一点很关键——
 * 寿元随境界大致按几何增长，如果修为增速只是线性衰减，玩家突破所需的时间
 * 就永远追不上寿元的宽松度，「寿元耗尽」这个核心死亡机制便不会触发。
 */
export function computeCultivationPerYear(
  world: WorldSetting,
  attributes: Record<string, number>,
  talentModifiers: TalentModifiers,
): number {
  const { cultivationGain, realmKey } = world.mechanics;
  const realm = attributes[realmKey] ?? 0;
  const base = Math.max(
    cultivationGain.min,
    cultivationGain.base * cultivationGain.decayFactor ** realm,
  );
  const aptitude = attributes[cultivationGain.aptitudeKey] ?? 0;
  const aptitudeMultiplier = 1 + aptitude / cultivationGain.aptitudeScale;
  const talentMultiplier = talentModifiers.cultivationGainMul ?? 1;
  return base * aptitudeMultiplier * talentMultiplier;
}

function applyAttributeDeltas(
  world: WorldSetting,
  before: Record<string, number>,
  deltas: Record<string, number>,
): { next: Record<string, number>; changes: AttributeChange[] } {
  const next = { ...before };
  const changes: AttributeChange[] = [];

  for (const [key, delta] of Object.entries(deltas)) {
    if (key === world.mechanics.realmKey || key === world.mechanics.cultivationKey) continue;
    const definition = world.attributes.find((attribute) => attribute.key === key);
    if (!definition) continue;

    const from = before[key] ?? 0;
    const to = clampAttribute(world, key, from + delta);
    if (to === from) continue;

    next[key] = to;
    changes.push({ key, label: definition.label, from, to, delta: to - from });
  }

  return { next, changes };
}

function applyListOps(current: readonly string[], ops: readonly ListOp[] | undefined): string[] {
  if (!ops || ops.length === 0) return [...current];

  const result = new Set(current);
  for (const op of ops) {
    if (op.op === 'add') result.add(op.value);
    else result.delete(op.value);
  }
  return [...result];
}

function applyRelationshipOps(
  current: Record<string, string>,
  ops: readonly RelOp[] | undefined,
): Record<string, string> {
  if (!ops || ops.length === 0) return { ...current };

  const result = { ...current };
  for (const op of ops) {
    if (op.op === 'set') result[op.target] = op.value;
    else delete result[op.target];
  }
  return result;
}

function hasLethalEvent(entries: readonly LifeEntry[], keywords: readonly string[]): boolean {
  return entries.some((entry) =>
    keywords.some(
      (keyword) => entry.text.includes(keyword) || (entry.detail?.includes(keyword) ?? false),
    ),
  );
}

/** 把角色的全部属性收进各自的合法区间，作为结算的最后一道闸门。 */
function clampAllAttributes(world: WorldSetting, attributes: Record<string, number>): void {
  for (const definition of world.attributes) {
    const value = attributes[definition.key];
    if (value === undefined) continue;
    attributes[definition.key] = clampAttribute(world, definition.key, value);
  }
}

export function resolveSegment(input: ResolveSegmentInput): ResolveSegmentResult {
  if (openLifeRules(input.world)) return resolveOpenLife(input);
  const { world, proposal, segmentId } = input;
  const rng = input.rng ?? Math.random;
  const warnings: string[] = [];
  const { realmKey, cultivationKey, cultivationMax, realmNames, lifespanByRealm } =
    world.mechanics;

  const talentModifiers = getTalentModifiers(world, input.character);
  const maxRealmIndex = realmNames.length - 1;
  const startAge = input.character.age;
  const segmentEnd = startAge + proposal.timeAdvance;

  // ── 1. 应用模型提议的属性变化 ─────────────────────────────
  const { next: attributes, changes } = applyAttributeDeltas(
    world,
    input.character.attributes,
    proposal.attributeDeltas,
  );

  // ── 2. 列表与关系 ─────────────────────────────────────────
  const traits = applyListOps(input.character.traits, proposal.traitOps);
  const inventory = applyListOps(input.character.inventory, proposal.inventoryOps);
  const relationships = applyRelationshipOps(
    input.character.relationships,
    proposal.relationshipOps,
  );

  // ── 3. 世界局势 ───────────────────────────────────────────
  const worldStatus = proposal.worldStatusUpdate ?? input.worldStatus;

  // ── 4. 条目级推进 ─────────────────────────────────────────
  // 状态刻意放在闭包外的 `let` 上：推进、突破、死亡判定三件事必须共享同一份
  // 可变状态，拆成纯函数反而会把「谁改了年龄」这件事藏起来。
  let age = startAge;
  let cultivation = attributes[cultivationKey] ?? 0;
  let realm = attributes[realmKey] ?? 0;
  const breakthroughs: BreakthroughRecord[] = [];
  const keptEntries: LifeEntry[] = [];
  /**
   * 本段已经尝试过几次突破。
   *
   * 刻意放在段落作用域而不是 `runBreakthroughs` 里面：一次段落推进可能被
   * 条目切成好几小步，每一小步都会跑一次突破判定。上限是「一段最多 5 次」，
   * 若按小步计数就等于没有上限。
   */
  let breakthroughAttempts = 0;

  let ending: Ending | undefined;
  let endingNote: string | undefined;
  let endingCause: EndingCause | undefined;

  type Settlement = { ending: Ending; note: string; cause: EndingCause };

  /** 突破判定。一段内可能发生多次，因此是循环。 */
  function runBreakthroughs(): Settlement | undefined {
    while (cultivation >= cultivationMax && breakthroughAttempts < MAX_BREAKTHROUGHS_PER_SEGMENT) {
      breakthroughAttempts += 1;

      const probability = computeBreakthroughProbability(world, attributes, talentModifiers);
      const roll = rng();
      const success = roll < probability;
      const fromRealm = realm;

      if (success) {
        if (fromRealm >= maxRealmIndex) {
          // 已在顶阶且突破成功，本世界到此为止
          cultivation = 0;
          breakthroughs.push({
            attempted: true,
            success: true,
            fromRealm,
            toRealm: fromRealm,
            probability,
            roll,
            age,
          });
          const realmLabel = realmNames[fromRealm] ?? '巅峰';
          const text = world.endings.ascension;
          return {
            ending: {
              type: 'completion',
              reason: fillTemplate(text.reason, { realm: realmLabel, age }),
              narrative: fillTemplate(text.narrative, { realm: realmLabel, age }),
              atSegmentId: segmentId,
            },
            note: `已在「${realmLabel}」登顶且突破成功，触发圆满结局。`,
            cause: 'ascension',
          };
        }

        realm = fromRealm + 1;
        // 溢出部分结转到新阶位，不浪费
        cultivation = Math.max(0, cultivation - cultivationMax);
      } else {
        cultivation = Math.max(
          0,
          cultivation - world.mechanics.breakthrough.failureCultivationLoss,
        );
        const { lowWillpowerKey, lowWillpowerThreshold, lowWillpowerPenalty } =
          world.mechanics.breakthrough;
        const willpower = attributes[lowWillpowerKey] ?? 0;
        if (willpower < lowWillpowerThreshold) {
          attributes[lowWillpowerKey] = clampAttribute(
            world,
            lowWillpowerKey,
            willpower - lowWillpowerPenalty,
          );
          const willpowerLabel = attributeLabel(world, lowWillpowerKey);
          warnings.push(
            `突破失败且${willpowerLabel}不足 ${lowWillpowerThreshold}，额外损失${willpowerLabel} ${lowWillpowerPenalty} 点`,
          );
        }
      }

      attributes[realmKey] = realm;
      breakthroughs.push({
        attempted: true,
        success,
        fromRealm,
        toRealm: realm,
        probability,
        roll,
        age,
      });
    }

    return undefined;
  }

  /** 程序判定死亡。刻意排在突破之后，让「寿元将尽之际突破」成为可能。 */
  function settleDeath(): Settlement | undefined {
    const { willpowerKey, willpowerThreshold } = world.mechanics.death;
    const willpower = attributes[willpowerKey] ?? 0;

    if (willpower <= willpowerThreshold) {
      const text = world.endings.collapse;
      return {
        ending: {
          type: 'death',
          reason: fillTemplate(text.reason, { age }),
          narrative: fillTemplate(text.narrative, { age }),
          atSegmentId: segmentId,
        },
        note: `${attributeLabel(world, willpowerKey)}归零，触发崩溃结局。`,
        cause: 'collapse',
      };
    }

    const lifespan = lifespanByRealm[realm] ?? Number.POSITIVE_INFINITY;
    if (age >= lifespan) {
      const realmLabel = realmNames[realm] ?? '未知';
      const text = world.endings.lifespan;
      const vars = { realm: realmLabel, lifespan, age };
      return {
        ending: {
          type: 'death',
          reason: fillTemplate(text.reason, vars),
          narrative: fillTemplate(text.narrative, vars),
          atSegmentId: segmentId,
        },
        note: `年龄 ${age} 达到「${realmLabel}」的寿元上限 ${lifespan} 年。`,
        cause: 'lifespan',
      };
    }

    return undefined;
  }

  /** 把时间推进到 `targetAge`，沿途结算积累、突破与死亡。 */
  function advanceTo(targetAge: number): Settlement | undefined {
    const years = Math.max(0, targetAge - age);
    if (years > 0) {
      cultivation += computeCultivationPerYear(world, attributes, talentModifiers) * years;
      age = targetAge;
    }

    return runBreakthroughs() ?? settleDeath();
  }

  function snapshotAttributes(): Record<string, number> {
    return {
      ...attributes,
      [realmKey]: realm,
      [cultivationKey]: clampAttribute(world, cultivationKey, Math.max(0, cultivation)),
    };
  }

  /** 把系统判定写回年表，避免剧情只能猜测阶位，而状态栏显示另一套结果。 */
  function appendBreakthroughOutcome(
    fromIndex: number,
    settledAttributes: Record<string, number>,
  ): void {
    const attempts = breakthroughs.slice(fromIndex);
    if (attempts.length === 0) return;

    const first = attempts[0];
    const last = attempts[attempts.length - 1];
    if (!first || !last) return;

    const label = attributeLabel(world, realmKey);
    if (last.toRealm > first.fromRealm) {
      keptEntries.push({
        age: last.age,
        kind: 'milestone',
        text: `你的${label}提升至「${tierName(world, last.toRealm)}」。`,
        settledAttributes,
      });
    } else if (attempts.some((attempt) => !attempt.success)) {
      keptEntries.push({
        age: last.age,
        kind: 'setback',
        text: `你尝试提升${label}，未能成功，仍为「${tierName(world, last.toRealm)}」。`,
        settledAttributes,
      });
    }
  }

  for (const entry of proposal.entries) {
    const beforeAttributes = snapshotAttributes();
    const beforeBreakthroughs = breakthroughs.length;
    const settled = advanceTo(entry.age);
    const afterAttributes = snapshotAttributes();
    keptEntries.push({
      ...entry,
      // 先讲尝试，再显示系统结果；状态栏到结果条目出现时才切换阶位。
      settledAttributes: breakthroughs.length > beforeBreakthroughs
        ? beforeAttributes
        : afterAttributes,
    });
    appendBreakthroughOutcome(beforeBreakthroughs, afterAttributes);
    if (settled) {
      ending = settled.ending;
      endingNote = settled.note;
      endingCause = settled.cause;
      break;
    }
  }

  if (!ending) {
    const beforeBreakthroughs = breakthroughs.length;
    const settled = advanceTo(segmentEnd);
    appendBreakthroughOutcome(beforeBreakthroughs, snapshotAttributes());
    if (settled) {
      ending = settled.ending;
      endingNote = settled.note;
      endingCause = settled.cause;
    }
  }

  if (!ending && breakthroughAttempts >= MAX_BREAKTHROUGHS_PER_SEGMENT && cultivation >= cultivationMax) {
    warnings.push(
      `本段内突破次数达到上限 ${MAX_BREAKTHROUGHS_PER_SEGMENT} 次，剩余进度结转到下一段`,
    );
  }

  // ── 5. 模型提议的结局（需经程序确认）──────────────────────
  if (!ending && proposal.endingProposal) {
    const { type, reason } = proposal.endingProposal;
    const { luckKey, willpowerKey } = world.mechanics.death;
    const luck = attributes[luckKey] ?? 0;
    const luckLabel = attributeLabel(world, luckKey);

    if (type === 'death') {
      const lethal = hasLethalEvent(keptEntries, world.mechanics.death.lethalEventKeywords);
      if (!lethal) {
        warnings.push('模型提议死亡，但本段条目中未出现致命情节，不予采纳；改为重伤收场');
      } else if (rng() * 100 > luck) {
        ending = {
          type: 'death',
          reason,
          narrative: fillTemplate(world.endings.deathByProposal, { reason, age }),
          atSegmentId: segmentId,
        };
        endingNote = `模型提议死亡且本段出现致命事件，${luckLabel}判定未通过（${luckLabel} ${luck}）。`;
        endingCause = 'proposed-death';
      } else {
        warnings.push(`模型提议死亡，但${luckLabel}判定通过（${luckLabel} ${luck}），改为重伤收场`);
      }
    } else if (realm >= world.mechanics.completionProposalMinRealm) {
      ending = {
        type: 'completion',
        reason,
        narrative: fillTemplate(world.endings.completionByProposal, { reason, age }),
        atSegmentId: segmentId,
      };
      endingNote = '模型提议圆满结局且阶位达到门槛。';
      endingCause = 'proposed-completion';
    } else {
      const thresholdLabel = realmNames[world.mechanics.completionProposalMinRealm] ?? '门槛';
      warnings.push(`模型提议圆满结局，但阶位未达到「${thresholdLabel}」，不予采纳`);
    }

    // 死亡提议未被采纳时，角色仍要付出代价
    if (!ending) {
      attributes[willpowerKey] = clampAttribute(
        world,
        willpowerKey,
        (attributes[willpowerKey] ?? 0) - NEAR_DEATH_WILLPOWER_LOSS,
      );
      warnings.push(
        `死亡提议未获采纳，角色重伤，${attributeLabel(world, willpowerKey)} −${NEAR_DEATH_WILLPOWER_LOSS}`,
      );
    }
  }

  // ── 6. 段落数软上限 ───────────────────────────────────────
  if (!ending && segmentId >= world.mechanics.segmentSoftLimit) {
    const text = world.endings.turnLimit;
    ending = {
      type: 'completion',
      reason: fillTemplate(text.reason, { age }),
      narrative: fillTemplate(text.narrative, { age }),
      atSegmentId: segmentId,
    };
    endingNote = `已达段落数软上限 ${world.mechanics.segmentSoftLimit}，强制收束。`;
    endingCause = 'turn-limit';
  }

  // ── 7. 决策门槛 ───────────────────────────────────────────
  // 故事已经结束就不再留岔路：玩家没有下一步可走。
  let decision: DecisionPoint | undefined;
  if (!ending) {
    const deltaMagnitude = changes
      .filter((change) => change.key !== cultivationKey)
      .reduce((sum, change) => sum + Math.abs(change.delta), 0);

    const gate = resolveDecision({
      proposal: proposal.decision,
      deltaMagnitude,
      brokeThrough: breakthroughs.some((record) => record.attempted && record.success),
      entries: keptEntries,
      segmentId,
      lastDecisionSegmentId: input.lastDecisionSegmentId,
      stopPlan: input.stopPlan,
      decisionInterval: decisionIntervalFor(world),
    });
    warnings.push(...gate.warnings);
    decision = gate.decision;
  }

  // ── 8. 落账 ──────────────────────────────────────────────
  attributes[cultivationKey] = clampAttribute(world, cultivationKey, Math.max(0, cultivation));
  clampAllAttributes(world, attributes);

  const beforeCultivation = input.character.attributes[cultivationKey] ?? 0;
  const finalCultivation = attributes[cultivationKey] ?? 0;
  if (finalCultivation !== beforeCultivation) {
    const definition = world.attributes.find((attribute) => attribute.key === cultivationKey);
    changes.push({
      key: cultivationKey,
      label: definition?.label ?? cultivationKey,
      from: beforeCultivation,
      to: finalCultivation,
      delta: finalCultivation - beforeCultivation,
    });
  }

  const breakdown: ResolveBreakdown = {
    attributeChanges: changes,
    timeAdvance: age - startAge,
    breakthroughs,
  };
  if (decision !== undefined) breakdown.decisionCause = decision.cause;
  if (endingNote !== undefined) breakdown.endingNote = endingNote;
  if (endingCause !== undefined) breakdown.endingCause = endingCause;

  const character: CharacterState = {
    ...input.character,
    age,
    isAlive: ending ? ending.type !== 'death' : true,
    attributes,
    traits,
    inventory,
    relationships,
  };

  const segment: LifeSegment = {
    // 条目已按条目级推进逐条落账：寿元耗尽时后面的条目被整段丢弃
    entries: keptEntries,
    timeAdvance: age - startAge,
    attributeDeltas: proposal.attributeDeltas,
  };
  if (proposal.worldStatusUpdate !== undefined) {
    segment.worldStatusUpdate = proposal.worldStatusUpdate;
  }
  if (proposal.traitOps) segment.traitOps = proposal.traitOps;
  if (proposal.inventoryOps) segment.inventoryOps = proposal.inventoryOps;
  if (proposal.relationshipOps) segment.relationshipOps = proposal.relationshipOps;
  if (decision) segment.decision = decision;
  if (proposal.endingProposal) segment.endingProposal = proposal.endingProposal;

  return {
    segment,
    character,
    worldStatus,
    warnings,
    ...(ending ? { ending } : {}),
    breakdown,
  };
}

/** 决策成因的中文说明，供界面复用。 */
export type { DecisionCause };
