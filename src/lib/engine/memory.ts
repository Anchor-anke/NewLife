import type { LifeSegmentRecord } from './types';

/**
 * 三层记忆的调度规则。
 *
 * 1. **硬状态**：程序保存的角色属性，每段原样传入（见 `context.ts`）。
 * 2. **短期记忆**：尚未进入摘要的全部段落。
 * 3. **长期摘要**：压缩后的历史。
 *
 * 关键在于让「短期窗口」与「长期摘要」**永不重叠、永不遗漏**：
 * 摘要恰好覆盖 `segmentId <= summarizedThroughSegmentId`，窗口恰好取
 * `segmentId > summarizedThroughSegmentId`。两者拼起来就是完整历史，没有缝。
 *
 * 一个容易踩的坑：如果把窗口写死成「最近 5 段」，而摘要是每 10 段做一次，
 * 那么摘要末尾与窗口开头之间就会留出 5 段的**盲区**——这几段模型永远
 * 看不到，且玩家很难察觉。所以窗口必须是「全部未摘要段落」，上限只作安全阀。
 *
 * 摘要每次都把窗口之外的新段落合并进旧摘要，并且是**整体替换**而不是追加。
 * 只有替换才能让摘要长度有界——追加式摘要迟早会把上下文撑爆。
 */

/** 摘要时留给短期窗口的段数：摘要只推进到「最新段往前数这么多」。 */
export const SUMMARY_RESERVE_SEGMENTS = 5;

/** 未摘要的积压超过这个量才触发一次摘要，避免每段都调用模型。 */
export const SUMMARY_TRIGGER_BACKLOG = 15;

/** 短期窗口的安全上限。正常调度下积压不会超过触发阈值，因此不会被裁到。 */
export const MAX_WINDOW_SEGMENTS = 20;

export interface MemoryPlan {
  shouldSummarize: boolean;
  /**
   * 本次摘要应覆盖到的 segmentId（含）。
   * 只有在 `shouldSummarize` 为真时有意义。
   */
  targetSummarizedThroughSegmentId: number;
}

/**
 * 决定是否该做一次摘要，以及摘要要覆盖到哪里。
 *
 * 触发条件是「未摘要积压超过 `SUMMARY_TRIGGER_BACKLOG`」，摘要目标则停在
 * 「最新段往前留出整个预留窗口」的位置——这样摘要与窗口之间既不会重叠，
 * 也不会出现空档。
 */
export function planMemory(
  latestSegmentId: number,
  summarizedThroughSegmentId: number,
): MemoryPlan {
  const backlog = latestSegmentId - summarizedThroughSegmentId;

  if (backlog <= SUMMARY_TRIGGER_BACKLOG) {
    return {
      shouldSummarize: false,
      targetSummarizedThroughSegmentId: summarizedThroughSegmentId,
    };
  }

  return {
    shouldSummarize: true,
    targetSummarizedThroughSegmentId: Math.max(0, latestSegmentId - SUMMARY_RESERVE_SEGMENTS),
  };
}

/**
 * 短期窗口：全部尚未进入摘要的完整段落。
 *
 * `segments` 需按 segmentId 升序。上限只是安全阀——正常调度下不会被裁到，
 * 一旦被裁到就说明摘要没跟上，`verifyMemoryCoverage` 会报出盲区。
 */
export function selectRecentWindow(
  segments: readonly LifeSegmentRecord[],
  summarizedThroughSegmentId: number,
  maxSegments = MAX_WINDOW_SEGMENTS,
): LifeSegmentRecord[] {
  return segments
    .filter((segment) => segment.segmentId > summarizedThroughSegmentId)
    .slice(-maxSegments);
}

/**
 * 本次摘要需要合并的段落区间：`(summarizedThroughSegmentId, targetSummarizedThroughSegmentId]`。
 *
 * `segments` 需按 segmentId 升序。
 */
export function selectSummaryCandidates(
  segments: readonly LifeSegmentRecord[],
  summarizedThroughSegmentId: number,
  targetSummarizedThroughSegmentId: number,
): LifeSegmentRecord[] {
  return segments.filter(
    (segment) =>
      segment.segmentId > summarizedThroughSegmentId &&
      segment.segmentId <= targetSummarizedThroughSegmentId,
  );
}

export interface CoverageReport {
  ok: boolean;
  problem?: string;
  /** 既不在摘要、也不在窗口中的段号 */
  blindSpots: number[];
}

/**
 * 自检：窗口与摘要必须恰好拼成完整历史。
 *
 * 导出给测试与调试使用——这类「边界差一」的 bug 很难在界面上发现，
 * 但会让模型永远看不到某几个段落，或者反复看到同一段历史。
 */
export function verifyMemoryCoverage(
  segments: readonly LifeSegmentRecord[],
  summarizedThroughSegmentId: number,
): CoverageReport {
  const ordered = [...segments].sort((a, b) => a.segmentId - b.segmentId);

  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (!previous || !current) continue;
    if (current.segmentId !== previous.segmentId + 1) {
      return {
        ok: false,
        problem: `段落历史存在断档：${previous.segmentId} 之后是 ${current.segmentId}`,
        blindSpots: [],
      };
    }
  }

  // 刻意使用真实的安全上限而不是无限大：一旦积压被裁到，那部分就是真的盲区，
  // 自检必须如实报出来，而不是替调度逻辑打掩护。
  const window = selectRecentWindow(ordered, summarizedThroughSegmentId);
  const windowIds = new Set(window.map((segment) => segment.segmentId));

  const blindSpots = ordered
    .filter(
      (segment) =>
        segment.segmentId > summarizedThroughSegmentId && !windowIds.has(segment.segmentId),
    )
    .map((segment) => segment.segmentId);

  if (blindSpots.length > 0) {
    return { ok: false, problem: '存在既不在摘要、也不在窗口中的段落', blindSpots };
  }

  return { ok: true, blindSpots: [] };
}
