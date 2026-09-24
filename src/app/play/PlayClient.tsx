'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AdvanceBar } from '@/components/game/AdvanceBar';
import { DecisionCard } from '@/components/game/DecisionCard';
import { EndingPanel } from '@/components/game/EndingPanel';
import { StatusPanel } from '@/components/game/StatusPanel';
import { Timeline, type TimelineView } from '@/components/game/Timeline';
import { Button, EmptyState, Panel, Spinner } from '@/components/ui';
import { MAX_WINDOW_SEGMENTS, selectRecentWindow } from '@/lib/engine/memory';
import type { SegmentStage } from '@/lib/engine/segment';
import { useJevScores } from '@/lib/jev/useJevScores';
import { useModelSettings } from '@/lib/hooks/useModelSettings';
import { useSaveBundle } from '@/lib/hooks/useSaves';
import { generateEpilogueForSave } from '@/lib/services/gameService';
import { maintainMemory, submitSegment } from '@/lib/services/segmentService';
import { abandonPendingSegment, getSaveBundle } from '@/lib/storage/saves';

interface ActionError {
  message: string;
  hint: string;
  detail?: string;
}

const VIEW_LABELS: Record<TimelineView, string> = {
  chronicle: '年表',
  stream: '事件流',
};

const ENTRY_REVEAL_INTERVAL_MS = 420;

export function PlayClient() {
  const searchParams = useSearchParams();
  const saveId = searchParams.get('save');

  const { adapter, configured, ready } = useModelSettings();
  const bundle = useSaveBundle(saveId);

  const [stage, setStage] = useState<SegmentStage | null>(null);
  const [error, setError] = useState<ActionError | null>(null);
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [epilogueGenerating, setEpilogueGenerating] = useState(false);
  const [epilogueError, setEpilogueError] = useState<string | null>(null);
  const [view, setView] = useState<TimelineView>('chronicle');
  const [autoRemaining, setAutoRemaining] = useState(0);
  const [reveal, setReveal] = useState<{ segmentId: number; visibleCount: number } | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const lastSeenSegmentRef = useRef(0);
  /** 连续推进的中断开关。用 ref 而不是 state，因为循环里读到的必须是当前值。 */
  const pausedRef = useRef(false);
  /** 同一时刻只允许一条推进管线。 */
  const busyRef = useRef(false);

  const save = bundle?.save;
  const segments = bundle?.segments ?? [];
  const pending = bundle?.pending ?? [];
  const latestSegmentId = segments.at(-1)?.segmentId ?? 0;

  // 当前停车所在的段落记录。Jev 打分与决策卡共用它；key 用「存档 + 段号」，
  // 同一个岔路只发一次打分请求。
  const decisionRecord =
    save !== undefined && save.status === 'active' ? segments.at(-1) : undefined;
  const jevInput = useMemo(() => {
    const decision = decisionRecord?.segment.decision;
    if (!save || !decision) return null;
    return {
      world: save.world,
      character: save.character,
      worldStatus: save.worldStatus,
      ...(save.worldAttributes ? { worldAttributes: save.worldAttributes } : {}),
      historySummary: save.historySummary,
      recentSegments: selectRecentWindow(
        segments.slice(-MAX_WINDOW_SEGMENTS),
        save.summarizedThroughSegmentId,
      ),
      decision,
    };
  }, [save, decisionRecord, segments]);
  const { scores: jevScores } = useJevScores(
    jevInput,
    decisionRecord ? `${saveId ?? ''}:${decisionRecord.segmentId}` : null,
  );

  // 新段落及每条新条目出现时，跟随滚到年表末尾。
  useEffect(() => {
    const isNewSegment = latestSegmentId > lastSeenSegmentRef.current;
    if (isNewSegment) {
      lastSeenSegmentRef.current = latestSegmentId;
    }
    if (isNewSegment || (reveal?.segmentId === latestSegmentId && reveal.visibleCount > 0)) {
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      bottomRef.current?.scrollIntoView({
        behavior: reducedMotion ? 'auto' : 'smooth',
        block: 'end',
      });
    }
  }, [latestSegmentId, reveal?.segmentId, reveal?.visibleCount]);

  /**
   * 推进若干段。
   *
   * 遇到岔路或结局就停——「连续推进」不该把重要的决策冲掉，
   * 否则玩家会为了省事而错过唯一需要他出手的地方。
   */
  async function advance(count: number, firstAction?: string) {
    if (!saveId || !adapter || busyRef.current) return;

    busyRef.current = true;
    pausedRef.current = false;
    setError(null);
    setStage('generating');
    let nextSegmentId = latestSegmentId + 1;

    try {
      for (let index = 0; index < count; index += 1) {
        if (pausedRef.current) break;
        setAutoRemaining(count - index);
        setStage('generating');
        setReveal({ segmentId: nextSegmentId, visibleCount: 0 });

        const action = index === 0 ? firstAction : undefined;
        const result = await submitSegment({
          saveId,
          ...(action !== undefined ? { playerAction: action } : {}),
          adapter,
          onStage: setStage,
        });

        if (!result.ok) {
          switch (result.reason) {
            case 'generation-failed':
              setError({
                message: result.message,
                hint: result.hint,
                ...(result.detail ? { detail: result.detail } : {}),
              });
              break;
            case 'already-committed':
              setError({
                message: '这一段已经结算过了，不会重复扣减状态。',
                hint: '刷新页面即可看到最新进度。',
              });
              break;
            case 'save-ended':
              setError({ message: '故事已经结束，无法继续推进。', hint: '可以回到存档页开启新的一生。' });
              break;
            case 'revision-mismatch':
              setError({
                message: '存档在别处被更新了，本次提交已被拒绝以免覆盖。',
                hint: '刷新页面后重试即可。',
              });
              break;
            case 'save-not-found':
              setError({ message: '找不到这个存档。', hint: '它可能已经被删除了。' });
              break;
          }
          return;
        }

        nextSegmentId = result.segmentId + 1;
        setStage(null);
        const committed = await getSaveBundle(saveId);
        const entryCount = committed.segments.find(
          (record) => record.segmentId === result.segmentId,
        )?.segment.entries.length ?? 0;
        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        if (!reducedMotion && entryCount > 0) {
          setReveal({ segmentId: result.segmentId, visibleCount: 1 });
          for (let visibleCount = 2; visibleCount <= entryCount; visibleCount += 1) {
            await new Promise<void>((resolve) => {
              window.setTimeout(resolve, ENTRY_REVEAL_INTERVAL_MS);
            });
            setReveal({ segmentId: result.segmentId, visibleCount });
          }
          await new Promise<void>((resolve) => {
            window.setTimeout(resolve, ENTRY_REVEAL_INTERVAL_MS);
          });
        }
        setReveal(null);

        if (result.decision) break;
        if (result.resolution.ending) break;

        // 摘要是一次额外的模型调用，绝不能挡住段落结果的展示；
        // 失败也不影响已经结算完成的段落。
        setMemoryBusy(true);
        await maintainMemory(saveId, adapter).finally(() => setMemoryBusy(false));
      }
    } finally {
      setAutoRemaining(0);
      setStage(null);
      setReveal(null);
      busyRef.current = false;
    }
  }

  function handlePause() {
    pausedRef.current = true;
  }

  async function retryPending() {
    const item = pending[0];
    if (!item) return;
    await abandonPendingSegment(item.requestId);
    await advance(1, item.playerAction);
  }

  async function handleGenerateEpilogue() {
    if (!saveId || !adapter) return;
    setEpilogueGenerating(true);
    setEpilogueError(null);
    const result = await generateEpilogueForSave(saveId, adapter);
    if (!result.ok) setEpilogueError(result.error);
    setEpilogueGenerating(false);
  }

  if (!ready || bundle === undefined) {
    return (
      <div className="flex items-center gap-2 text-sm text-ink-500">
        <Spinner />
        正在读取存档…
      </div>
    );
  }

  if (!saveId) {
    return (
      <EmptyState>
        缺少存档参数。
        <Link href="/saves" className="ml-1 text-jade-400 underline">
          回到存档页
        </Link>
      </EmptyState>
    );
  }

  if (!save) {
    return (
      <EmptyState>
        这个存档不存在，可能已经被删除了。
        <Link href="/saves" className="ml-1 text-jade-400 underline">
          回到存档页
        </Link>
      </EmptyState>
    );
  }

  const busy = stage !== null || reveal !== null;
  const pendingSegment = pending[0];
  const pendingDecision = decisionRecord?.segment.decision;
  const revealingRecord = reveal
    ? segments.find((record) => record.segmentId === reveal.segmentId)
    : undefined;
  const visibleEntry = revealingRecord && reveal && reveal.visibleCount > 0
    ? revealingRecord.segment.entries[reveal.visibleCount - 1]
    : undefined;
  const presentedCharacter = revealingRecord && reveal &&
    reveal.visibleCount < revealingRecord.segment.entries.length
    ? {
        ...revealingRecord.characterBefore,
        age: visibleEntry?.age ?? revealingRecord.characterBefore.age,
        attributes: visibleEntry?.settledAttributes ?? revealingRecord.characterBefore.attributes,
      }
    : save.character;
  const previousRecord = revealingRecord
    ? segments.find((record) => record.segmentId === revealingRecord.segmentId - 1)
    : undefined;
  const presentedWorldStatus = revealingRecord && reveal &&
    reveal.visibleCount < revealingRecord.segment.entries.length
    ? previousRecord?.resolvedWorldStatus ?? save.world.initialWorldStatus
    : save.worldStatus;
  const presentedWorldAttributes = revealingRecord && reveal &&
    reveal.visibleCount < revealingRecord.segment.entries.length
    ? visibleEntry?.settledWorldAttributes ?? revealingRecord.worldAttributesBefore
    : save.worldAttributes;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="space-y-6">
        {!configured && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-gold-500/40 bg-gold-900/30 px-4 py-3 text-sm">
            <p className="text-gold-300">
              尚未配置模型接口，无法推进段落。已完成的存档不会受影响。
            </p>
            <Link
              href="/settings"
              className="shrink-0 rounded border border-gold-500/50 px-3 py-1 text-gold-300 transition-colors hover:bg-gold-900/60"
            >
              去配置
            </Link>
          </div>
        )}

        {pendingSegment && (
          <Panel title="上次的生成没有完成">
            <p className="text-sm leading-relaxed text-ink-300">
              检测到一条未完成的段落记录
              {pendingSegment.playerAction !== undefined && (
                <>：「{pendingSegment.playerAction}」</>
              )}
              。可能是在推演过程中刷新或关闭了页面。这次推进
              <strong className="text-ink-100">没有被结算</strong>
              ，也没有扣减任何状态。
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="primary" disabled={busy} onClick={() => void retryPending()}>
                重试这次推进
              </Button>
              <Button
                variant="ghost"
                onClick={() => void abandonPendingSegment(pendingSegment.requestId)}
              >
                丢弃
              </Button>
            </div>
          </Panel>
        )}

        {error && (
          <div className="space-y-2 rounded-md border border-cinnabar-500/40 bg-cinnabar-900/30 px-4 py-3 text-sm">
            <p className="text-cinnabar-300">{error.message}</p>
            <p className="leading-relaxed text-ink-300">{error.hint}</p>
            {error.detail && (
              <p className="font-mono text-xs break-all text-ink-500">{error.detail}</p>
            )}
          </div>
        )}

        {memoryBusy && (
          <p className="flex items-center gap-2 text-xs text-ink-500">
            <Spinner />
            正在整理长期记忆…
          </p>
        )}

        {save.summaryState?.lastError && !memoryBusy && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-ink-700 bg-ink-900/50 px-4 py-3 text-xs">
            <span className="text-ink-400">
              上一次整理长期记忆失败（{save.summaryState.lastError}）。这不影响已完成的段落，
              原始记录仍完整保存在存档里。
            </span>
            <Button
              variant="ghost"
              disabled={busy || !adapter}
              onClick={() => {
                if (!saveId || !adapter) return;
                setMemoryBusy(true);
                void maintainMemory(saveId, adapter).finally(() => setMemoryBusy(false));
              }}
            >
              重试整理
            </Button>
          </div>
        )}

        {segments.length > 0 && (
          <div className="flex items-center justify-end gap-1 text-xs">
            {(Object.keys(VIEW_LABELS) as TimelineView[]).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setView(option)}
                className={`cursor-pointer rounded border px-2.5 py-1 transition-colors ${
                  view === option
                    ? 'border-jade-500/60 bg-jade-900/40 text-jade-300'
                    : 'border-transparent text-ink-500 hover:text-ink-300'
                }`}
              >
                {VIEW_LABELS[option]}
              </button>
            ))}
          </div>
        )}

        <Timeline world={save.world} segments={segments} view={view} reveal={reveal} />
        <div ref={bottomRef} />

        {pendingDecision && !reveal && (
          <DecisionCard
            decision={pendingDecision}
            age={save.character.age}
            disabled={busy || !adapter}
            scores={jevScores}
            onDecide={(action) => void advance(1, action)}
          />
        )}

        {!reveal && (
          <EndingPanel
            save={save}
            generating={epilogueGenerating}
            error={epilogueError}
            onGenerate={handleGenerateEpilogue}
          />
        )}

        {!pendingDecision && (
          <AdvanceBar
            hasSegments={segments.length > 0}
            busy={busy || !adapter}
            stage={stage}
            presenting={reveal !== null && stage === null}
            isEnded={save.status === 'ended'}
            running={autoRemaining > 0}
            remaining={autoRemaining}
            onAdvance={(count) => void advance(count)}
            onPause={handlePause}
          />
        )}
      </div>

      {/* top 需要给悬浮导航让位：导航条约 53px，再留出原有间距 */}
      <aside className="lg:sticky lg:top-20 lg:self-start">
        <StatusPanel world={save.world} character={presentedCharacter} worldStatus={presentedWorldStatus} worldAttributes={presentedWorldAttributes} />

        {save.historySummary.trim() !== '' && (
          <div className="mt-4">
            <Panel title="往事">
              <p className="text-sm leading-relaxed text-ink-400">{save.historySummary}</p>
            </Panel>
          </div>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <Link
            href="/saves"
            className="rounded-md border border-ink-600 bg-ink-800/70 px-3 py-1.5 text-xs text-ink-300 transition-colors hover:bg-ink-700"
          >
            存档列表
          </Link>
        </div>
      </aside>
    </div>
  );
}
