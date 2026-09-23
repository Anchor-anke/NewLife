import { describe, expect, it } from 'vitest';
import { fushengJi } from '@/lib/worlds/fusheng-ji';
import { qingmingXiantu as world } from '@/lib/worlds/qingming-xiantu';
import {
  DECISION_DELTA_THRESHOLD,
  DECISION_MIN_GAP,
  KEYWORD_MIN_GAP,
  NEAR_END_MIN_GAP,
  decisionGap,
  isNearEnd,
  planStop,
  resolveDecision,
} from './decision';
import {
  MAX_DECISION_INTERVAL,
  decisionIntervalFor,
  expectedSegments,
} from './pacing';
import type { CharacterState, DecisionProposal, LifeEntry } from './types';

/**
 * 决策点判定。
 *
 * 这是年表叙事里最容易失控的一环：模型天然倾向于到处提议岔路，而
 * 「每一次停车都要玩家付出注意力」这件事是没法用提示词约束的，
 * 只能由程序守住。因此这里重点测的是**拒绝路径**，而不是采纳路径。
 */

function makeCharacter(params: { age?: number; realm?: number } = {}): CharacterState {
  return {
    name: '测试者',
    age: params.age ?? 20,
    isAlive: true,
    attributes: { realm: params.realm ?? 0 },
    traits: [],
    inventory: [],
    relationships: {},
  };
}

const PROPOSAL: DecisionProposal = {
  prompt: '一位自称来自上宗的人找上门。',
  stakes: '无论怎么选，你都不会再回到从前的日子。',
  options: ['跟他走', '婉拒'],
};

const PLAIN_ENTRIES: LifeEntry[] = [{ age: 21, kind: 'event', text: '日子照旧。' }];

function gate(overrides: Partial<Parameters<typeof resolveDecision>[0]> = {}) {
  return resolveDecision({
    proposal: PROPOSAL,
    deltaMagnitude: 0,
    brokeThrough: false,
    entries: PLAIN_ENTRIES,
    segmentId: 10,
    lastDecisionSegmentId: 0,
    stopPlan: { stop: false },
    decisionInterval: 5,
    ...overrides,
  });
}

describe('decisionGap', () => {
  it('没停过车时以段号本身计', () => {
    expect(decisionGap(7, 0)).toBe(7);
  });

  it('停过车时以差值计', () => {
    expect(decisionGap(12, 5)).toBe(7);
  });
});

describe('节奏参数', () => {
  it('决策间隔落在硬密度下限与上限之间', () => {
    const gap = decisionIntervalFor(world);
    expect(gap).toBeGreaterThan(DECISION_MIN_GAP);
    expect(gap).toBeLessThanOrEqual(MAX_DECISION_INTERVAL);
  });

  it('大世界估算出的段数明显多于小世界——密度参数正是为此而存在', () => {
    expect(expectedSegments(world)).toBeGreaterThan(10);
  });

  it('决策间隔跟着世界规模走，而不是固定常量', () => {
    // 这一条是踩过坑之后补的：间隔一度是固定 12 段，
    // 结果浮生记（平均 26.8 段）一局只有 2.0 次介入，玩家几乎出不了手。
    expect(decisionIntervalFor(fushengJi)).toBeLessThan(decisionIntervalFor(world));

    for (const candidate of [world, fushengJi]) {
      const gap = decisionIntervalFor(candidate);
      expect(gap).toBeGreaterThan(DECISION_MIN_GAP);
      expect(gap).toBeLessThanOrEqual(MAX_DECISION_INTERVAL);
    }
  });
});

describe('isNearEnd', () => {
  it('凡人寿元 70，59 岁之后算进入末段', () => {
    expect(isNearEnd(world, makeCharacter({ age: 50 }))).toBe(false);
    expect(isNearEnd(world, makeCharacter({ age: 62 }))).toBe(true);
  });
});

describe('planStop', () => {
  it('第一段不会强制停车——故事才刚开始', () => {
    const plan = planStop({ world, character: makeCharacter(), segmentId: 1, lastDecisionSegmentId: 0 });
    expect(plan.stop).toBe(false);
  });

  it('距上次介入达到阈值时强制停车，成因是 long-gap', () => {
    const plan = planStop({
      world,
      character: makeCharacter(),
      segmentId: 1 + decisionIntervalFor(world),
      lastDecisionSegmentId: 1,
    });
    expect(plan).toEqual({ stop: true, cause: 'long-gap' });
  });

  it('一次都没停过车的新档，久未介入同样会强制停车', () => {
    // `decisionGap` 在从未停车时以段号本身计，所以「第一段不停」与
    // 「第一次决策之前也从不强制停」是两回事。后者会让话少的模型把玩家
    // 一直晾着——恰恰是最需要强制指令的时期。
    const plan = planStop({
      world,
      character: makeCharacter(),
      segmentId: decisionIntervalFor(world) + 5,
      lastDecisionSegmentId: 0,
    });
    expect(plan).toEqual({ stop: true, cause: 'long-gap' });
  });

  it('进入寿元末段时强制停车，成因是 near-end', () => {
    const plan = planStop({
      world,
      character: makeCharacter({ age: 64 }),
      segmentId: 20,
      lastDecisionSegmentId: 20 - NEAR_END_MIN_GAP,
    });
    expect(plan).toEqual({ stop: true, cause: 'near-end' });
  });

  it('刚进末段但间隔还不够时不停车，避免连续停车', () => {
    const plan = planStop({
      world,
      character: makeCharacter({ age: 64 }),
      segmentId: 20,
      lastDecisionSegmentId: 19,
    });
    expect(plan.stop).toBe(false);
  });
});

describe('resolveDecision', () => {
  it('模型没提议、程序也没要求时，什么都不发生', () => {
    const result = gate({ proposal: undefined });
    expect(result.decision).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it('程序要求停车但模型没给决策点时记一条警告', () => {
    const result = gate({ proposal: undefined, stopPlan: { stop: true, cause: 'long-gap' } });
    expect(result.decision).toBeUndefined();
    expect(result.warnings.join('\n')).toContain('必须停车');
  });

  it('距上次决策不足 2 段时无条件丢弃——硬密度上限优先于一切门槛', () => {
    const result = gate({
      segmentId: 11,
      lastDecisionSegmentId: 10,
      brokeThrough: true,
      deltaMagnitude: 999,
      stopPlan: { stop: true, cause: 'long-gap' },
    });

    expect(result.decision).toBeUndefined();
    expect(result.warnings.join('\n')).toContain(`低于硬密度下限 ${DECISION_MIN_GAP} 段`);
  });

  it('刚过密度下限时允许停车', () => {
    const result = gate({ segmentId: 12, lastDecisionSegmentId: 10, brokeThrough: true });
    expect(result.decision?.cause).toBe('breakthrough');
  });

  it('本段发生突破时采纳，成因优先标为 breakthrough', () => {
    const result = gate({ brokeThrough: true, stopPlan: { stop: true, cause: 'long-gap' } });
    expect(result.decision?.cause).toBe('breakthrough');
  });

  it('属性变动幅度达到阈值时采纳', () => {
    const result = gate({ deltaMagnitude: DECISION_DELTA_THRESHOLD });
    expect(result.decision?.cause).toBe('proposed');
  });

  it('命中分量关键词时采纳', () => {
    const result = gate({
      entries: [{ age: 21, kind: 'fortune', text: '一场机缘落到你头上。' }],
    });
    expect(result.decision?.cause).toBe('proposed');
  });

  it('detail 里的关键词同样算数', () => {
    const result = gate({
      entries: [{ age: 21, kind: 'event', text: '他留下一句话。', detail: '这是你人生的转折。' }],
    });
    expect(result.decision?.cause).toBe('proposed');
  });

  it('关键词是弱信号：间隔不够时不采纳', () => {
    // 兜底门槛抬到 20，确保这次拒绝是关键词门槛自己造成的，
    // 而不是被兜底门槛顺手挡掉的
    const result = gate({
      segmentId: 4,
      lastDecisionSegmentId: 1,
      decisionInterval: 20,
      entries: [{ age: 21, kind: 'fortune', text: '一场机缘落到你头上。' }],
    });

    expect(result.decision).toBeUndefined();
    expect(result.warnings.join('\n')).toContain('既不重大');
  });

  it('关键词的间隔刚好达到阈值时采纳', () => {
    const result = gate({
      segmentId: 1 + KEYWORD_MIN_GAP,
      lastDecisionSegmentId: 1,
      decisionInterval: 20,
      entries: [{ age: 21, kind: 'fortune', text: '一场机缘落到你头上。' }],
    });

    expect(result.decision?.cause).toBe('proposed');
  });

  it('强信号不受关键词那道间隔限制——突破可以贴着硬密度下限停车', () => {
    const result = gate({
      segmentId: 3,
      lastDecisionSegmentId: 1,
      decisionInterval: 20,
      brokeThrough: true,
      entries: [{ age: 21, kind: 'fortune', text: '一场机缘落到你头上。' }],
    });

    expect(result.decision?.cause).toBe('breakthrough');
  });

  it('日常小事 + 间隔不够长时丢弃，不打断玩家', () => {
    const result = gate({ segmentId: 4, lastDecisionSegmentId: 1 });
    expect(result.decision).toBeUndefined();
    expect(result.warnings.join('\n')).toContain('既不重大');
  });

  it('玩家已经很久没介入时，模型主动提的岔路直接放行', () => {
    const result = gate({ segmentId: 5, lastDecisionSegmentId: 0, decisionInterval: 5 });
    expect(result.decision?.cause).toBe('proposed');
  });

  it('采纳时把成因补进决策点，选项原样保留', () => {
    const result = gate({ brokeThrough: true });
    expect(result.decision?.options).toEqual(PROPOSAL.options);
    expect(result.decision?.prompt).toBe(PROPOSAL.prompt);
  });
});
