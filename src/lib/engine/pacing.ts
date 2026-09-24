import {
  TIME_ADVANCE_MAX,
  TIME_ADVANCE_MIN,
  type WorldSetting,
} from './types';
import { openLifeRules } from './ruleset';

/**
 * 节奏参数。
 *
 * 单独成一个模块，是因为「一段跨多少年」与「多久停一次车」是同一件事的两面：
 * 前者决定一屏能看多少年，后者决定一局要玩家出手几次，两者必须按同一套假设
 * 推导，否则改一个就会把另一个悄悄带偏。
 *
 * 分工上这属于**程序负责的部分**：模型只决定这一段具体跨多少年（在给定的
 * 上下限内），而上下限本身由世界的寿命尺度反推。这样短寿元的现代世界一段几年、
 * 长寿元的修仙世界一段几十年，玩家的体感是一致的。
 *
 * 本模块只依赖 `types.ts`，不依赖提示词或结算层——否则 `decision.ts` 与
 * `context.ts` 会互相引用成环。
 */

// ────────────────────────────────────────────────────────────
// 决策密度
// ────────────────────────────────────────────────────────────

/** 硬密度上限：任意 2 段之内最多 1 次决策。防止模型连续停车。 */
export const DECISION_MIN_GAP = 2;

/**
 * 决策间隔的上限（段）。
 *
 * 两个间隔都由「估算段数 ÷ 除数」反推，再夹在这个上限以内。
 * 上限存在的意义是：再长的世界也不该让玩家等超过十几段才出一次手。
 */
export const MAX_DECISION_INTERVAL = 12;

/** 寿元进入当前阶位的末段时，该给玩家一次收束的机会。 */
export const NEAR_END_RATIO = 0.15;

/**
 * 末段强制停车的间隔下限。
 *
 * 「末段」是一个会持续很多年的状态，不加下限的话每一段都会命中，
 * 变成连续停车。
 */
export const NEAR_END_MIN_GAP = 6;

/**
 * 命中「分量关键词」时的最小间隔。
 *
 * 关键词是**弱信号**——某个词出现在某条条目里，并不能说明这一段真的走到了岔路。
 * 如果让它单独把间隔压到硬密度下限（2 段），一个措辞丰富的模型会让一局停车
 * 三十多次。这不是推测，是实测：青冥仙途从 9.1 次飙到 38.6 次。
 *
 * 取 6 的依据：目标介入次数 8~15 对应「每 5~10 段停一次」，因此任何单一弱信号的
 * 触发频率都不该高于每 6 段一次。
 *
 * **强信号不受这条限制**——阶位突破、程序侧强制、属性总变动达标，都是程序
 * 结算出来的事实，不是措辞，它们可以贴着硬密度下限停车。
 */
export const KEYWORD_MIN_GAP = 6;

/**
 * 目标段落数：一局人生大约分成这么多段。
 *
 * 实际的单段跨度由「终局寿元 ÷ 这个数字」反推。太大则一段跨几十年、
 * 人生只剩几步；太小则又回到高频点击的老问题。
 */
export const TARGET_SEGMENTS_PER_LIFE = 60;

/**
 * 决策间隔的除数。
 *
 * 估算值仍有 +6%~+23% 的余量（见 `expectedSegments`），这个数就是把它连同
 * 目标介入次数一起吃掉之后标定出来的。它**不是**从「目标介入次数 8~15」
 * 直接推导的，而是对着实测标出来的——`balance.test.ts` 三种模型形态都跑，
 * 是这个数唯一的守卫。
 *
 * 换世界、改段跨度或改寿元表之后必须重跑它。
 */
const DECISION_GAP_DIVISOR = 10;

function clampInterval(raw: number): number {
  return Math.min(MAX_DECISION_INTERVAL, Math.max(DECISION_MIN_GAP + 1, raw));
}

/**
 * 决策间隔：距上次介入多少段之后，这一段就该给玩家一次出手的机会。
 *
 * **一个间隔服务两件事，而不是两个：**
 *
 * | 作用点 | 效果 |
 * | --- | --- |
 * | 调用**前**（`planStop`） | 达到它就在提示词里下「本段必须给出一个 decision」，把吝啬的模型叫回来——这是介入次数的**下界** |
 * | 调用**后**（`resolveDecision`） | 达到它，模型主动提的岔路就放行——这是**上界** |
 *
 * 同一个数能同时管两侧，是因为两条路径不冲突：程序要一次岔路，模型给了就采纳，
 * 正好构成一次介入。
 *
 * 这里曾经拆成两个间隔（一个管上界、一个管下界），理由是「两侧需求相反」。
 * 那个论证是从一个不可靠的算术模型推出来的，**实测证伪了它**：合并成同一个数
 * 之后，三种模型形态仍然全部落在 8~15。少一个旋钮，就少一处会漂的地方。
 */
export function decisionIntervalFor(world: WorldSetting): number {
  return clampInterval(Math.round(expectedSegments(world) / DECISION_GAP_DIVISOR));
}

// ────────────────────────────────────────────────────────────
// 时间跨度
// ────────────────────────────────────────────────────────────

/**
 * 按世界与阶位给出建议的时间跨度（年）。
 *
 * 这个函数同时被提示词、规整层与数值模拟复用，保证「我们让模型这么做」与
 * 「我们按什么假设调参」不会脱节。
 *
 * **必须按世界的寿命尺度来算**：修仙世界终局寿元数千岁，一段推进数十年很正常；
 * 现代都市活不到一百岁，如果也按数十年推进，一局人生只剩十几个段落，
 * 每个选择都会显得毫无分量。所以跨度上限取自「终局寿元 ÷ 目标段落数」，
 * 下限则由 `TIME_ADVANCE_MIN` 兜住——太碎的段落等于退回回合制。
 */
export function timeAdvanceHint(world: WorldSetting, tier: number): [number, number] {
  if (openLifeRules(world)) return [TIME_ADVANCE_MIN, TIME_ADVANCE_MIN];
  const maxTier = world.mechanics.realmNames.length - 1;
  const topLifespan = world.mechanics.lifespanByRealm[maxTier] ?? 100;
  const topStep = Math.min(
    TIME_ADVANCE_MAX,
    Math.max(TIME_ADVANCE_MIN, Math.round(topLifespan / TARGET_SEGMENTS_PER_LIFE)),
  );

  const t = maxTier <= 0 ? 0 : Math.min(1, Math.max(0, tier / maxTier));
  const curve = t * t;

  const span = topStep - TIME_ADVANCE_MIN;
  const min = Math.min(TIME_ADVANCE_MAX, Math.round(TIME_ADVANCE_MIN + curve * span * 0.4));
  // 允许 max === min：世界尺度小到算不出跨度区间时，稳定的单段长度比
  // 硬凑一个 1 年的浮动更有用——现代题材「一屏三年」本来就是个固定的节奏。
  const max = Math.max(
    min,
    Math.min(TIME_ADVANCE_MAX, Math.round(TIME_ADVANCE_MIN + curve * span)),
  );
  return [min, max];
}

/**
 * 这个世界的一局大约有多少段。
 *
 * 用「典型人生能达到的寿元 ÷ 全阶位平均段跨度」估算。
 *
 * **关键在于「典型」两个字**：最初的写法用的是终局寿元，等于假设角色一定活到
 * 最高阶位。可多数人生会提前结束，于是估算值系统性偏大，而且**偏差幅度不稳定**
 * （内置世界实测偏 1.1~2.7 倍，AI 生成的世界几乎不偏）。用一个除数去抵消
 * 一个不稳定的偏差，必然顾此失彼——实测就是这样：修好了内置世界，
 * AI 生成的世界冲到 18.9 次介入。
 *
 * 改成取「中上阶位」的寿元（`TYPICAL_TIER_RATIO`）当参照，偏差收敛到
 * +6%~+23%，剩下的这点余量用一个统一除数就能吃掉。
 */
const TYPICAL_TIER_RATIO = 0.75;

export function expectedSegments(world: WorldSetting): number {
  const open = openLifeRules(world);
  if (open) {
    return Math.ceil((open.maxAge - open.startingAge) / TIME_ADVANCE_MIN);
  }
  const maxTier = Math.max(0, world.mechanics.realmNames.length - 1);
  const typicalTier = Math.round(maxTier * TYPICAL_TIER_RATIO);
  const typicalLifespan = world.mechanics.lifespanByRealm[typicalTier] ?? 100;

  let total = 0;
  for (let tier = 0; tier <= maxTier; tier += 1) {
    const [min, max] = timeAdvanceHint(world, tier);
    total += (min + max) / 2;
  }
  const averageSpan = total / (maxTier + 1);

  return Math.max(10, Math.round(typicalLifespan / Math.max(1, averageSpan)));
}
