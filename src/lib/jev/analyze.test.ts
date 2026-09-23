import { describe, expect, it } from 'vitest';
import { analyzeJevAlignment, emptyReport, formatReport } from './analyze';
import type { DecisionPoint, JevScores, LifeSegmentRecord } from '@/lib/engine/types';

/**
 * 对齐分析的字段锁定。
 *
 * 配对规则是整个分析的地基：「岔路上的分数」在同一段记录里，
 * 「玩家的实际选择」在下一段的 playerAction 里——配错了对象，
 * 后面所有百分比都是废纸。
 */

const OPTIONS = ['跟他走', '婉拒', '追问他的来历'];

const DECISION: DecisionPoint = {
  prompt: '一位自称来自上宗的人找上门。',
  stakes: '无论怎么选，你都不会再回到从前的日子。',
  options: OPTIONS,
  cause: 'proposed',
};

function scores(topIndex: number): JevScores {
  const probabilities = OPTIONS.map((_, index) => (index === topIndex ? 0.5 : 0.25));
  return { probabilities, topIndex, confidence: 0.8, model: 'jev-mock' };
}

function makeRecord(
  segmentId: number,
  overrides: {
    decision?: DecisionPoint;
    jevScores?: JevScores;
    playerAction?: string;
  } = {},
): LifeSegmentRecord {
  return {
    saveId: 'save-1',
    segmentId,
    requestId: `req-${segmentId}`,
    ...(overrides.playerAction !== undefined ? { playerAction: overrides.playerAction } : {}),
    segment: {
      entries: [{ age: 20 + segmentId, kind: 'event', text: `${segmentId} 号段的事` }],
      timeAdvance: 2,
      attributeDeltas: {},
      ...(overrides.decision !== undefined ? { decision: overrides.decision } : {}),
    },
    characterBefore: {
      name: '林砚',
      age: 20,
      isAlive: true,
      attributes: {},
      traits: [],
      inventory: [],
      relationships: {},
    },
    resolvedCharacter: {
      name: '林砚',
      age: 22,
      isAlive: true,
      attributes: {},
      traits: [],
      inventory: [],
      relationships: {},
    },
    resolvedWorldStatus: '',
    validationWarnings: [],
    modelMeta: { provider: '测试', model: '测试模型', latencyMs: 1 },
    schemaVersion: 2,
    createdAt: 0,
    ...(overrides.jevScores !== undefined ? { jevScores: overrides.jevScores } : {}),
  };
}

describe('analyzeJevAlignment', () => {
  it('空输入得到全零报告', () => {
    expect(analyzeJevAlignment([])).toEqual(emptyReport());
  });

  it('配对规则：分数在本段、选择在下一段的 playerAction', () => {
    const report = analyzeJevAlignment([
      makeRecord(1, { decision: DECISION, jevScores: scores(1) }),
      makeRecord(2, { playerAction: '婉拒' }),
    ]);

    expect(report.decisionsTotal).toBe(1);
    expect(report.decisionsScored).toBe(1);
    expect(report.paired).toBe(1);
    expect(report.topPicked).toBe(1);
    expect(report.topPickRate).toBe(1);
  });

  it('选了非最高分选项时计入所选选项的概率质量', () => {
    const report = analyzeJevAlignment([
      makeRecord(1, { decision: DECISION, jevScores: scores(1) }),
      makeRecord(2, { playerAction: '跟他走' }),
    ]);

    expect(report.topPicked).toBe(0);
    expect(report.chosenMassAvg).toBeCloseTo(0.25);
    expect(report.topMassAvg).toBeCloseTo(0.5);
  });

  it('playerAction 没命中任何选项文本时计为自由输入', () => {
    const report = analyzeJevAlignment([
      makeRecord(1, { decision: DECISION, jevScores: scores(0) }),
      makeRecord(2, { playerAction: '我决定拜入青冥山' }),
    ]);

    expect(report.paired).toBe(0);
    expect(report.freeForm).toBe(1);
  });

  it('没有分数的岔路只进 decisionsTotal，不进可分析样本', () => {
    const report = analyzeJevAlignment([
      makeRecord(1, { decision: DECISION }),
      makeRecord(2, { playerAction: '婉拒' }),
      makeRecord(3, { decision: DECISION, jevScores: scores(2) }),
      makeRecord(4, { playerAction: '追问他的来历' }),
    ]);

    expect(report.decisionsTotal).toBe(2);
    expect(report.decisionsScored).toBe(1);
    expect(report.paired).toBe(1);
    expect(report.topPicked).toBe(1);
  });

  it('最后一段的岔路没有下文，不算样本', () => {
    const report = analyzeJevAlignment([
      makeRecord(1, { playerAction: '婉拒' }),
      makeRecord(2, { decision: DECISION, jevScores: scores(0) }),
    ]);

    expect(report.decisionsScored).toBe(1);
    expect(report.paired).toBe(0);
    expect(report.topPickRate).toBe(0);
  });

  it('输入乱序时按段号排序后配对', () => {
    const report = analyzeJevAlignment([
      makeRecord(2, { playerAction: '婉拒' }),
      makeRecord(1, { decision: DECISION, jevScores: scores(1) }),
    ]);

    expect(report.paired).toBe(1);
    expect(report.topPicked).toBe(1);
  });

  it('多个样本时比率与均值正确', () => {
    const report = analyzeJevAlignment([
      makeRecord(1, { decision: DECISION, jevScores: scores(1) }),
      makeRecord(2, { playerAction: '婉拒' }),
      makeRecord(3, { decision: DECISION, jevScores: scores(0) }),
      makeRecord(4, { playerAction: '婉拒' }),
    ]);

    expect(report.paired).toBe(2);
    expect(report.topPickRate).toBeCloseTo(0.5);
    expect(report.chosenMassAvg).toBeCloseTo((0.5 + 0.25) / 2);
    expect(report.topMassAvg).toBeCloseTo(0.5);
  });
});

describe('formatReport', () => {
  it('样本不足时明确说出来，而不是输出误导性的 0%', () => {
    const text = formatReport(emptyReport());
    expect(text).toContain('样本不足');
  });

  it('按差距给出三种读法之一', () => {
    const base = { ...emptyReport(), paired: 10, topMassAvg: 0.5 };
    expect(formatReport({ ...base, topPicked: 8, topPickRate: 0.8 })).toContain('有预测力');
    expect(formatReport({ ...base, topPicked: 2, topPickRate: 0.2 })).toContain('避开最高分选项');
    expect(formatReport({ ...base, topPicked: 5, topPickRate: 0.5 })).toContain('参考价值存疑');
  });
});
