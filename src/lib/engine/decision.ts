import {
  DECISION_MIN_GAP,
  KEYWORD_MIN_GAP,
  NEAR_END_MIN_GAP,
  NEAR_END_RATIO,
  decisionIntervalFor,
} from './pacing';
import type {
  CharacterState,
  DecisionCause,
  DecisionPoint,
  DecisionProposal,
  LifeEntry,
  WorldSetting,
} from './types';
import { openLifeRules } from './ruleset';

/**
 * 决策点判定。
 *
 * 这是《年表式叙事重构方案》第五节的核心机制，延续既有的架构铁律——
 * **模型只提议，程序才结算**：模型可以在任何地方说「这里是个岔路」，
 * 但只有程序才有权决定要不要真的停下来打断玩家。
 *
 * 分两步：
 *
 * 1. **调用前 `planStop`** —— 程序先算「这一段必须停」，把结论写进提示词。
 *    这是为了不让参与感消失：模型自己判断不出「玩家已经很久没说话了」。
 * 2. **调用后 `resolveDecision`** —— 模型给了决策点，还要过门槛才真的停车。
 *    不通过的直接丢弃，不打断玩家。
 *
 * 判定全部只依赖存档里已有的两个数字（`segmentId` 与 `lastDecisionSegmentId`），
 * 不引入额外的状态，这样多标签页与崩溃恢复都不需要额外处理。
 *
 * 密度参数（`DECISION_MIN_GAP` / `KEYWORD_MIN_GAP` / `NEAR_END_*` 常量，
 * 以及按世界规模反推的 `decisionIntervalFor`）住在 `pacing.ts`，
 * 因为「多久停一次车」与「一段跨多少年」是同一个节奏问题的两面。
 */

/** 本段属性总变动幅度达到这个量级，说明确实是大事，不是日常。 */
export const DECISION_DELTA_THRESHOLD = 25;

/**
 * 密度参数住在 `pacing.ts`，这里原样转出。
 *
 * 调用方按「决策」这个概念来引用这些常量更自然（`decision.DECISION_MIN_GAP`
 * 比 `pacing.DECISION_MIN_GAP` 好读），但定义只能有一处。
 */
export { DECISION_MIN_GAP, KEYWORD_MIN_GAP, NEAR_END_MIN_GAP, NEAR_END_RATIO };

/**
 * 「分量」关键词。
 *
 * 模型用词可以反映它自己判断的分量。刻意保持题材无关——这里放的是
 * 「这件事很重要」的通用说法，不是任何具体世界的专有名词。
 */
export const DECISION_KEYWORDS: readonly string[] = [
  '机缘',
  '机遇',
  '危机',
  '变故',
  '抉择',
  '转折',
  '杀机',
  '邀请',
  '拜师',
  '出走',
  '诀别',
  '生死',
  '托付',
  '结仇',
  '迁徙',
  '放弃',
];

/** 把「距上次决策过了几段」算出来。从没停过车时以段号本身计。 */
export function decisionGap(segmentId: number, lastDecisionSegmentId: number): number {
  return lastDecisionSegmentId > 0 ? segmentId - lastDecisionSegmentId : segmentId;
}

export interface StopPlan {
  /** 为真时，提示词里会明确要求模型「本段结束时必须给出一个决策点」。 */
  stop: boolean;
  cause?: Extract<DecisionCause, 'long-gap' | 'near-end' | 'life-turn'>;
}

/** 角色是否已进入当前阶位的寿元末段。 */
export function isNearEnd(world: WorldSetting, character: CharacterState): boolean {
  const open = openLifeRules(world);
  if (open) {
    return character.age >= open.maxAge - 15 ||
      (character.attributes[open.healthKey] ?? 100) <= 15;
  }
  const realm = character.attributes[world.mechanics.realmKey] ?? 0;
  const lifespan = world.mechanics.lifespanByRealm[realm] ?? Number.POSITIVE_INFINITY;
  if (!Number.isFinite(lifespan)) return false;
  return character.age >= lifespan * (1 - NEAR_END_RATIO);
}

/**
 * 调用模型**之前**的程序侧预判。
 *
 * 命中的条件会以自然语言写进提示词，让模型知道「这一段必须停」。
 *
 * 间隔按**世界规模**反推（`decisionIntervalFor`），不是固定常量。
 * 用固定 12 段时，浮生记（平均 26.8 段）一局只有 2.0 次介入，玩家几乎出不了手——
 * 一个从不主动提议岔路的模型只能靠这条间隔把玩家叫回来。
 */
export function planStop(input: {
  world: WorldSetting;
  character: CharacterState;
  segmentId: number;
  lastDecisionSegmentId: number;
}): StopPlan {
  const gap = decisionGap(input.segmentId, input.lastDecisionSegmentId);

  // 不要在这里加「已经停过车」的保护条件。
  //
  // `decisionGap` 在从未停车时返回 `segmentId`，所以新档天然不会过早触发
  // （第 1 段的 gap 是 1，远小于决策间隔）。若额外要求
  // `lastDecisionSegmentId > 0`，就会让强制停车在**第一次决策之前完全不生效**——
  // 而那段时期恰恰是「模型话少、玩家干等」最可能发生的时候。
  if (gap >= decisionIntervalFor(input.world)) {
    return { stop: true, cause: 'long-gap' };
  }

  if (gap >= NEAR_END_MIN_GAP && isNearEnd(input.world, input.character)) {
    return { stop: true, cause: openLifeRules(input.world) ? 'life-turn' : 'near-end' };
  }

  return { stop: false };
}

export interface DecisionGateInput {
  proposal: DecisionProposal | undefined;
  /** 本段**不含进度类属性**的变动幅度之和。进度类由程序结算，量级天然很大，不该算作「大事」。 */
  deltaMagnitude: number;
  /** 本段是否发生过阶位突破 */
  brokeThrough: boolean;
  /** 本段的条目，用于关键词判定 */
  entries: readonly LifeEntry[];
  segmentId: number;
  lastDecisionSegmentId: number;
  stopPlan: StopPlan;
  /**
   * 决策间隔：距上次介入达到这么多段之后，模型提议的岔路就放行。
   *
   * 与 `planStop` 用的是同一个数（都来自 `pacing.decisionIntervalFor`）：
   * 程序在这个间隔上要一次岔路，模型给了就采纳，正好构成一次介入。
   */
  decisionInterval: number;
}

export interface DecisionGateResult {
  decision?: DecisionPoint;
  /** 被丢弃的原因。会写进 `validationWarnings`，便于调参时发现门槛跑偏。 */
  warnings: string[];
}

function hitsKeyword(entries: readonly LifeEntry[]): boolean {
  return entries.some((entry) =>
    DECISION_KEYWORDS.some((keyword) => entry.text.includes(keyword) || entry.detail?.includes(keyword)),
  );
}

/**
 * 调用模型**之后**的门槛判定。
 *
 * 四条门槛（本段属性变动幅度 / 关键词 / 突破 / 程序侧强制）任意命中一条即采纳，
 * 但都要先过「2 段内最多 1 次」的硬密度上限。
 */
export function resolveDecision(input: DecisionGateInput): DecisionGateResult {
  const warnings: string[] = [];
  const gap = decisionGap(input.segmentId, input.lastDecisionSegmentId);

  if (!input.proposal) {
    if (input.stopPlan.stop) {
      warnings.push('程序要求本段必须停车，但模型没有给出决策点，本段直接追加到年表');
    }
    return { warnings };
  }

  // 硬密度上限优先于一切门槛：连续停车比漏掉一次岔路更伤体验
  if (input.lastDecisionSegmentId > 0 && gap < DECISION_MIN_GAP) {
    warnings.push(
      `距上次决策仅 ${gap} 段，低于硬密度下限 ${DECISION_MIN_GAP} 段，本段的决策点已丢弃`,
    );
    return { warnings };
  }

  let cause: DecisionCause | undefined;

  // 门槛按**信号强度**分层，而不是一视同仁：
  // 突破、程序侧强制、属性总变动是程序结算出来的事实，可以贴着硬密度下限停车；
  // 关键词只是一个词，属于弱信号，必须多等几段才允许它把玩家叫回来。
  if (input.brokeThrough) {
    cause = 'breakthrough';
  } else if (input.stopPlan.stop) {
    cause = input.stopPlan.cause ?? 'long-gap';
  } else if (input.deltaMagnitude >= DECISION_DELTA_THRESHOLD) {
    cause = 'proposed';
  } else if (hitsKeyword(input.entries) && gap >= KEYWORD_MIN_GAP) {
    cause = 'proposed';
  } else if (gap >= input.decisionInterval) {
    // 兜底：玩家已经好几段没说话了，模型主动提的岔路就放行
    cause = 'proposed';
  }

  if (!cause) {
    warnings.push('模型提议了决策点，但本段既不重大、也没有命中强制条件，已丢弃');
    return { warnings };
  }

  return { decision: { ...input.proposal, cause }, warnings };
}

/** 决策成因的中文说明，供界面与调试输出使用。 */
export const DECISION_CAUSE_LABELS: Record<DecisionCause, string> = {
  proposed: '模型提议',
  breakthrough: '阶位突破',
  'near-end': '寿元将尽',
  'life-turn': '人生转折',
  'long-gap': '久未介入',
};
