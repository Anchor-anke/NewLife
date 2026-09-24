import { describe, expect, it } from 'vitest';
import { WORLDS } from '@/lib/worlds';
import { VERIFY_SCENARIOS, checkInvariants, simulateWorld } from './simulate';
import type { EndingCause } from './types';
import { openLifeRules } from './ruleset';

/**
 * 数值手感模拟。
 *
 * 目的不是断言精确数值，而是回答两个设计问题：
 * 1. **「寿元耗尽」这个核心死亡机制到底会不会真的触发？** 如果玩家在纯推进路径下
 *    总能轻松跨过下一阶，那寿元表就形同虚设，整个「时间有限」的张力也就没了。
 * 2. **决策密度是否失控？** 年表叙事把「停车」交给程序判定，程序门槛松一点就会
 *    退回每段都停车的回合制，紧一点又会变成看小说。
 *
 * 每个世界都要单独跑一遍——新增世界观时这个测试会自动覆盖到它。
 * 判定标准与 `simulate.ts` 里的 `DESIGN_INVARIANTS` 共用，AI 生成的世界
 * 走的是同一套校验。
 */

const LIVES_PER_WORLD = 200;

const CAUSE_LABELS: Record<EndingCause | 'unfinished', string> = {
  lifespan: '寿元耗尽',
  health: '健康耗尽',
  'old-age': '自然离世',
  collapse: '意志崩溃',
  ascension: '登顶（圆满）',
  'turn-limit': '段落数上限',
  'proposed-death': '剧情致死',
  'proposed-completion': '剧情圆满',
  unfinished: '未结束',
};

/**
 * 三种模型形态都要跑。**这是这个测试最容易漏掉的一环**，两侧都真的漏过：
 *
 * - 只跑第一种（模型话多 + 中性文案）时报「每局 9.1 次介入」，看着完美；
 *   换成第二种（措辞丰富）就飙到 38.6 次——因为中性文案从不命中关键词门槛，
 *   测出来的只是**上界**的一个偏乐观的版本。
 * - 反过来只测「话多」这一侧，就发现不了第三种（模型从不主动提议）时
 *   玩家整局只出 2.0 次手——那是**下界**。
 *
 * 三种形态都落在目标区间内，密度才算真的稳。
 *
 * 形态定义在 `simulate.ts` 里（`VERIFY_SCENARIOS`），与 AI 生成世界走的那条
 * 校验路径共用同一份——「内置世界与生成世界用同一套标准」是这套设计的铁律。
 */
const SCENARIOS = Object.values(VERIFY_SCENARIOS);
const BASELINE = VERIFY_SCENARIOS.eagerPlain;

describe('阶位寿元规则的数值手感模拟', () => {
  it.each(WORLDS.filter((world) => !openLifeRules(world)).map((world) => [world.name, world] as const))(
    '「%s」的人生分布符合设计预期',
    (_name, world) => {
      const maxTier = world.mechanics.realmNames.length - 1;
      const baseline = simulateWorld(world, LIVES_PER_WORLD, BASELINE.options);
      const lines: string[] = ['', `  ── ${world.name} · 结局分布 ─────────────────`];

      for (const [cause, rate] of Object.entries(baseline.causeRates).sort((a, b) => b[1] - a[1])) {
        const label = CAUSE_LABELS[cause as EndingCause | 'unfinished'] ?? cause;
        lines.push(`  ${label.padEnd(12, '　')} ${(rate * 100).toFixed(1).padStart(5)}%`);
      }

      lines.push(`  ── ${world.name} · 终局阶位分布 ──────────────`);
      for (const tier of [...baseline.tierHistogram.keys()].sort((a, b) => a - b)) {
        const count = baseline.tierHistogram.get(tier) ?? 0;
        const label = world.mechanics.realmNames[tier] ?? '?';
        lines.push(
          `  ${String(tier).padStart(2)} ${label.padEnd(6, '　')} ${((count / LIVES_PER_WORLD) * 100).toFixed(1).padStart(5)}%`,
        );
      }

      lines.push(`  ── ${world.name} · 各阶位达成年龄 vs 寿元上限 ─`);
      for (let tier = 1; tier <= maxTier; tier += 1) {
        const ages = baseline.lives
          .map((life) => life.tierAges[tier])
          .filter((age): age is number => age !== undefined)
          .sort((a, b) => a - b);
        const label = world.mechanics.realmNames[tier] ?? '?';
        const previousLabel = world.mechanics.realmNames[tier - 1] ?? '?';
        const lifespan = world.mechanics.lifespanByRealm[tier - 1] ?? Number.NaN;
        const reached = ((ages.length / LIVES_PER_WORLD) * 100).toFixed(0).padStart(3);
        const median = ages.length > 0 ? ages[Math.floor(ages.length / 2)] : undefined;
        lines.push(
          `  踏入${label.padEnd(5, '　')} 中位 ${String(median?.toFixed(0) ?? '—').padStart(4)} 岁  ` +
            `(${reached}% 到达)  ← 需在${previousLabel}寿元 ${lifespan} 岁前完成`,
        );
      }

      lines.push(`  ── ${world.name} · 汇总 ──────────────────────`);
      lines.push(`  平均享年 ${baseline.averageAge.toFixed(1)} 岁`);
      lines.push(`  平均段落 ${baseline.averageSegments.toFixed(1)} 段`);
      lines.push(`  平均终局阶位 ${baseline.averageTier.toFixed(2)}`);

      lines.push(`  ── ${world.name} · 决策密度（三种模型形态）──`);
      for (const scenario of SCENARIOS) {
        const report =
          scenario === BASELINE
            ? baseline
            : simulateWorld(world, LIVES_PER_WORLD, scenario.options);

        lines.push(
          `  ${scenario.label.padEnd(22, '　')} 介入 ${report.averageDecisions.toFixed(1).padStart(4)} 次` +
            `  最小间隔 ${report.minDecisionGap} 段`,
        );

        // 全部设计不变量由共享模块判定，违反项会以人话列出来
        expect(checkInvariants(world, report)).toEqual([]);
      }

      console.log(lines.join('\n'));
    },
  );
});
