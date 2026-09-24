'use client';

import { Button, Panel, Spinner } from '@/components/ui';
import type { SegmentStage } from '@/lib/engine/segment';

/**
 * 顶部推进控制。
 *
 * 三个动作：
 * - **继续**：让世界自己往前走一段
 * - **连续推进 ×N**：一次跑很多段，进一步降低操作负担；遇到岔路自动停
 * - **暂停**：只在连续推进时出现，随时打断
 *
 * 「继续」不带任何玩家行动，这是重构后的核心变化——时间是世界自己在走的，
 * 玩家只在岔路口出手。连续推进遇到决策点自动停，所以它不会把重要的岔路冲掉。
 */

const STAGE_LABELS: Record<SegmentStage, string> = {
  generating: '正在推演这一段…',
  validating: '正在校验模型返回…',
  resolving: '正在结算与存档…',
};

/** 连续推进一次的段数。再大就失去「随时可以停」的意义了。 */
export const AUTO_RUN_STEPS = 5;

export function AdvanceBar({
  hasSegments,
  busy,
  stage,
  presenting,
  isEnded,
  running,
  remaining,
  onAdvance,
  onPause,
}: {
  hasSegments: boolean;
  busy: boolean;
  stage: SegmentStage | null;
  presenting: boolean;
  isEnded: boolean;
  /** 是否正在连续推进 */
  running: boolean;
  /** 连续推进还剩几段 */
  remaining: number;
  onAdvance: (count: number) => void;
  onPause: () => void;
}) {
  if (isEnded) {
    return (
      <Panel title="故事已结束">
        <p className="text-sm text-ink-400">
          这一生已经走到尽头，无法再推进。你可以在上方查看生平总结，或返回存档页开启新的一生。
        </p>
      </Panel>
    );
  }

  return (
    <Panel
      title={hasSegments ? '继续' : '开始这一生'}
      description={
        hasSegments
          ? '世界会自己往前走若干年，只在真正重要的岔路口才停下来问你。'
          : '第一段会交代你的出身与当下的处境。'
      }
    >
      {(stage || presenting) && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-jade-500/30 bg-jade-900/25 px-3 py-2 text-sm text-jade-300">
          <Spinner />
          {stage ? STAGE_LABELS[stage] : '正在呈现这一段…'}
          {running && remaining > 0 && (
            <span className="ml-auto text-xs text-ink-400">连续推进还剩 {remaining} 段</span>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={busy} onClick={() => onAdvance(1)}>
          {hasSegments ? '继续' : '开始这一生'}
        </Button>

        <Button disabled={busy} onClick={() => onAdvance(AUTO_RUN_STEPS)}>
          连续推进 ×{AUTO_RUN_STEPS}
        </Button>

        {running && (
          <Button variant="ghost" onClick={onPause}>
            暂停
          </Button>
        )}
      </div>
    </Panel>
  );
}
