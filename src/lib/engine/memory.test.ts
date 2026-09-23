import { describe, expect, it } from 'vitest';
import {
  MAX_WINDOW_SEGMENTS,
  SUMMARY_RESERVE_SEGMENTS,
  SUMMARY_TRIGGER_BACKLOG,
  planMemory,
  selectRecentWindow,
  selectSummaryCandidates,
  verifyMemoryCoverage,
} from './memory';
import type { LifeSegmentRecord } from './types';

function makeSegments(count: number): LifeSegmentRecord[] {
  return Array.from({ length: count }, (_, index) => {
    const segmentId = index + 1;
    return {
      saveId: 'save-1',
      segmentId,
      requestId: `req-${segmentId}`,
      playerAction: `决定 ${segmentId}`,
      segment: {
        entries: [{ age: 16 + segmentId, kind: 'event', text: `第 ${segmentId} 段。` }],
        timeAdvance: 1,
        attributeDeltas: {},
      },
      resolvedCharacter: {
        name: '林砚',
        age: 16 + segmentId,
        isAlive: true,
        attributes: {},
        traits: [],
        inventory: [],
        relationships: {},
      },
      characterBefore: {
        name: '林砚',
        age: 15 + segmentId,
        isAlive: true,
        attributes: {},
        traits: [],
        inventory: [],
        relationships: {},
      },
      resolvedWorldStatus: '',
      validationWarnings: [],
      modelMeta: { provider: '测试', model: '测试', latencyMs: 1 },
      schemaVersion: 2,
      createdAt: segmentId,
    } satisfies LifeSegmentRecord;
  });
}

describe('planMemory', () => {
  it('积压未超过阈值时不触发摘要', () => {
    expect(planMemory(SUMMARY_TRIGGER_BACKLOG, 0).shouldSummarize).toBe(false);
    expect(planMemory(SUMMARY_TRIGGER_BACKLOG + 1, 0).shouldSummarize).toBe(true);
  });

  it('摘要目标停在「最新段往前留出预留窗口」的位置', () => {
    const plan = planMemory(40, 0);
    expect(plan.shouldSummarize).toBe(true);
    expect(plan.targetSummarizedThroughSegmentId).toBe(40 - SUMMARY_RESERVE_SEGMENTS);
  });

  it('段数不足时不会把摘要目标推成负数', () => {
    const plan = planMemory(3, 0);
    expect(plan.targetSummarizedThroughSegmentId).toBeGreaterThanOrEqual(0);
    expect(plan.shouldSummarize).toBe(false);
  });
});

describe('短期窗口与摘要区间', () => {
  it('窗口取全部尚未进入摘要的段落，而不是固定条数', () => {
    const segments = makeSegments(30);
    const window = selectRecentWindow(segments, 20);
    // 21~30 共 10 条，全部保留——固定成 5 条就会丢掉 21~25
    expect(window.map((segment) => segment.segmentId)).toEqual([
      21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
    ]);
  });

  it('窗口超过安全上限时只保留最近的若干条', () => {
    const segments = makeSegments(60);
    const window = selectRecentWindow(segments, 0);
    expect(window).toHaveLength(MAX_WINDOW_SEGMENTS);
    expect(window.at(-1)?.segmentId).toBe(60);
  });

  it('摘要候选区间是左开右闭', () => {
    const segments = makeSegments(30);
    const candidates = selectSummaryCandidates(segments, 10, 15);
    expect(candidates.map((segment) => segment.segmentId)).toEqual([11, 12, 13, 14, 15]);
  });

  it('两者永不重叠、永不遗漏', () => {
    const segments = makeSegments(30);
    const summarizedThrough = 20;

    const summarized = segments.filter((segment) => segment.segmentId <= summarizedThrough);
    const window = selectRecentWindow(segments, summarizedThrough);

    const windowIds = new Set(window.map((segment) => segment.segmentId));
    expect(summarized.filter((segment) => windowIds.has(segment.segmentId))).toHaveLength(0);

    const covered = new Set([...summarized, ...window].map((segment) => segment.segmentId));
    expect(covered.size).toBe(segments.length);
  });

  it('连续推进 80 段，覆盖始终完整且窗口从不被裁到', () => {
    const segments = makeSegments(80);
    let summarizedThroughSegmentId = 0;
    let summaryCount = 0;
    let maxWindowSeen = 0;

    for (const segment of segments) {
      const history = segments.filter((candidate) => candidate.segmentId <= segment.segmentId);
      const plan = planMemory(segment.segmentId, summarizedThroughSegmentId);

      if (plan.shouldSummarize) {
        const candidates = selectSummaryCandidates(
          history,
          summarizedThroughSegmentId,
          plan.targetSummarizedThroughSegmentId,
        );
        // 每次摘要都必须真的有内容可合并
        expect(candidates.length).toBeGreaterThan(0);
        summarizedThroughSegmentId = plan.targetSummarizedThroughSegmentId;
        summaryCount += 1;
      }

      const coverage = verifyMemoryCoverage(history, summarizedThroughSegmentId);
      expect(coverage.blindSpots).toEqual([]);
      expect(coverage.ok).toBe(true);

      const window = selectRecentWindow(history, summarizedThroughSegmentId);
      maxWindowSeen = Math.max(maxWindowSeen, window.length);
      // 安全阀不该被触发：正常调度下积压不超过触发阈值
      expect(window.length).toBeLessThanOrEqual(MAX_WINDOW_SEGMENTS);
    }

    expect(summaryCount).toBeGreaterThan(0);
    expect(maxWindowSeen).toBeGreaterThan(SUMMARY_RESERVE_SEGMENTS);
  });
});

describe('verifyMemoryCoverage', () => {
  it('发现历史断档', () => {
    const segments = makeSegments(5).filter((segment) => segment.segmentId !== 3);
    const result = verifyMemoryCoverage(segments, 2);
    expect(result.ok).toBe(false);
    expect(result.problem).toContain('断档');
  });

  it('发现既不在摘要也不在窗口中的盲区', () => {
    // 摘要只推到 0，窗口被裁到最近 20 条，于是 1~5 成为盲区
    const segments = makeSegments(30);
    const result = verifyMemoryCoverage(segments, 0);
    expect(result.ok).toBe(false);
    expect(result.blindSpots).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('完整历史通过自检', () => {
    const result = verifyMemoryCoverage(makeSegments(20), 12);
    expect(result.ok).toBe(true);
    expect(result.blindSpots).toEqual([]);
  });
});
