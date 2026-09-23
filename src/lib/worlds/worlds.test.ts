import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WORLDS, getWorld } from './index';

/**
 * 界面层不允许出现任何**具体题材**的属性名。
 *
 * 这是「引擎与界面保持题材无关」这条架构约束的自动化守卫。
 * 它抓到过一个真实缺陷：状态面板把进度条写死成「修为 / 满则冲击下一境界」，
 * 换到现代都市或自定义世界就完全串味，而四个内置世界的截图里看不出来
 * ——因为默认那个恰好就是修仙。
 */
const FORBIDDEN_TERMS = ['修为', '境界', '心性', '气运', '灵石', '根骨', '悟性', '仙途'];

function collectSourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      found.push(...collectSourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

/** 去掉注释再检查——注释里提到这些词是在解释设计，不算违规。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('架构约束', () => {
  it('界面层不出现任何具体题材的属性名', () => {
    const offenders: string[] = [];

    for (const directory of ['src/components', 'src/app']) {
      for (const file of collectSourceFiles(directory)) {
        const code = stripComments(readFileSync(file, 'utf8'));
        for (const term of FORBIDDEN_TERMS) {
          if (code.includes(term)) offenders.push(`${file} 含「${term}」`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('引擎层不出现任何具体题材的属性名', () => {
    const offenders: string[] = [];

    for (const file of collectSourceFiles('src/lib/engine')) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const term of FORBIDDEN_TERMS) {
        if (code.includes(term)) offenders.push(`${file} 含「${term}」`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe('内置世界观', () => {
  it('注册表可按 id 取回', () => {
    expect(getWorld('qingming-xiantu')?.name).toBe('青冥仙途');
    expect(getWorld('not-exist')).toBeUndefined();
  });

  it.each(WORLDS.map((world) => [world.id, world] as const))(
    '「%s」的数据自洽',
    (_id, world) => {
      const { mechanics } = world;

      // 寿元表与境界名必须一一对应，否则程序判死会取到 undefined
      expect(mechanics.lifespanByRealm).toHaveLength(mechanics.realmNames.length);
      expect(mechanics.lifespanByRealm.every((value, index) => value > 0 || index === 0)).toBe(
        true,
      );

      // 寿元必须随境界单调不减，否则「提升境界续命」不成立
      for (let i = 1; i < mechanics.lifespanByRealm.length; i += 1) {
        const previous = mechanics.lifespanByRealm[i - 1] ?? 0;
        const current = mechanics.lifespanByRealm[i] ?? 0;
        expect(current).toBeGreaterThanOrEqual(previous);
      }

      const keys = new Set(world.attributes.map((attribute) => attribute.key));

      // mechanics 里引用的属性键都必须真实存在
      expect(keys.has(mechanics.cultivationKey)).toBe(true);
      expect(keys.has(mechanics.realmKey)).toBe(true);
      expect(keys.has(mechanics.cultivationGain.aptitudeKey)).toBe(true);
      expect(keys.has(mechanics.breakthrough.lowWillpowerKey)).toBe(true);
      expect(keys.has(mechanics.death.willpowerKey)).toBe(true);
      expect(keys.has(mechanics.death.luckKey)).toBe(true);
      for (const key of Object.keys(mechanics.breakthrough.weights)) {
        expect(keys.has(key)).toBe(true);
      }

      // 结局文案必须齐全，否则换个题材就会把「羽化飞升」这种串味措辞带到别的世界
      const endingTexts = [
        world.endings.lifespan.reason,
        world.endings.lifespan.narrative,
        world.endings.collapse.reason,
        world.endings.collapse.narrative,
        world.endings.ascension.reason,
        world.endings.ascension.narrative,
        world.endings.turnLimit.reason,
        world.endings.turnLimit.narrative,
        world.endings.deathByProposal,
        world.endings.completionByProposal,
      ];
      for (const text of endingTexts) {
        expect(text.trim()).not.toBe('');
      }

      // 模板里的占位符必须是引擎认识的那几个，写错了会被原样输出到界面上
      const allowedPlaceholders = new Set(['realm', 'lifespan', 'age', 'reason']);
      for (const text of endingTexts) {
        for (const match of text.matchAll(/\{(\w+)\}/g)) {
          expect(allowedPlaceholders.has(match[1] ?? '')).toBe(true);
        }
      }

      // 突破权重之和应为 1，便于把得分理解为「百分比基准」
      const weightSum = Object.values(mechanics.breakthrough.weights).reduce(
        (sum, weight) => sum + weight,
        0,
      );
      expect(weightSum).toBeCloseTo(1, 5);

      // 属性定义本身合法
      for (const attribute of world.attributes) {
        if (attribute.min !== undefined && attribute.max !== undefined) {
          expect(attribute.max).toBeGreaterThan(attribute.min);
        }
        if (attribute.roll) {
          expect(attribute.roll.max).toBeGreaterThanOrEqual(attribute.roll.min);
          // 随机区间必须落在合法范围内，否则创角就会产生越界属性
          if (attribute.min !== undefined) expect(attribute.roll.min).toBeGreaterThanOrEqual(attribute.min);
          if (attribute.max !== undefined) expect(attribute.roll.max).toBeLessThanOrEqual(attribute.max);
        }
      }

      // 天赋的加成键必须存在，修正器必须为正
      expect(world.talents.length).toBeGreaterThanOrEqual(2);
      const talentIds = new Set<string>();
      for (const talent of world.talents) {
        expect(talentIds.has(talent.id)).toBe(false);
        talentIds.add(talent.id);

        for (const key of Object.keys(talent.attributeBonus ?? {})) {
          expect(keys.has(key)).toBe(true);
        }
        if (talent.modifiers.cultivationGainMul !== undefined) {
          expect(talent.modifiers.cultivationGainMul).toBeGreaterThan(0);
        }
      }

      // 圆满结局的门槛必须落在合法境界范围内
      expect(mechanics.completionProposalMinRealm).toBeGreaterThanOrEqual(0);
      expect(mechanics.completionProposalMinRealm).toBeLessThanOrEqual(
        mechanics.realmNames.length - 1,
      );
    },
  );

  it('初始属性值都在各自合法区间内', () => {
    for (const world of WORLDS) {
      for (const attribute of world.attributes) {
        if (attribute.min !== undefined) {
          expect(attribute.initialValue).toBeGreaterThanOrEqual(attribute.min);
        }
        if (attribute.max !== undefined) {
          expect(attribute.initialValue).toBeLessThanOrEqual(attribute.max);
        }
      }
    }
  });
});
