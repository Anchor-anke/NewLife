import 'client-only';
import {
  MAX_WINDOW_SEGMENTS,
  planMemory,
  selectRecentWindow,
  selectSummaryCandidates,
} from '@/lib/engine/memory';
import {
  SegmentGenerationError,
  runSegment,
  type RunSegmentOutput,
  type SegmentStage,
} from '@/lib/engine/segment';
import { summarizeHistory } from '@/lib/engine/summary';
import {
  SCHEMA_VERSION,
  type DecisionPoint,
  type LifeSegmentRecord,
  type ResolveResult,
} from '@/lib/engine/types';
import type { ModelAdapter } from '@/lib/model/adapter';
import { hintFor, toModelError } from '@/lib/model/errors';
import {
  abandonPendingSegment,
  beginPendingSegment,
  commitSegment,
  getAllSegments,
  getRecentSegments,
  getSave,
  patchSave,
  withSaveLock,
} from '@/lib/storage/saves';
import { newId } from './gameService';

/**
 * 段落编排。
 *
 * 把「幂等 + 并发 + 崩溃恢复」三件事都收在这里，是因为它们必须一起成立才有意义：
 *
 * 1. 整个流程跑在**同一存档的 Web Lock** 下，多标签页不会并发调用模型。
 * 2. 调模型**之前**先落 pending 记录，提交成功后在同一个事务里删掉。
 *    页面在生成中途被刷新/关闭，下次进来就能发现「这一段没跑完」。
 * 3. 提交时校验 `expectedRevision` 与 `requestId`，重复提交与并发覆盖都会被拒。
 *
 * 任何一步失败都不会写入角色状态——玩家可以原样重试。
 */

export interface SubmitSegmentInput {
  saveId: string;
  /**
   * 玩家在上一处岔路口的决定。
   *
   * 不传表示「世界自行运转」——第一段以及玩家点了「继续」的情况都是如此。
   */
  playerAction?: string;
  adapter: ModelAdapter;
  rng?: () => number;
  signal?: AbortSignal;
  now?: number;
  /** 阶段回调，供界面展示「生成中 / 校验中 / 结算中」 */
  onStage?: (stage: SegmentStage) => void;
}

export type SubmitSegmentResult =
  | {
      ok: true;
      segmentId: number;
      resolution: ResolveResult;
      warnings: string[];
      /** 本段结束时是否停在了一个岔路口。界面据此决定要不要弹决策卡。 */
      decision?: DecisionPoint;
    }
  | { ok: false; reason: 'save-not-found' }
  | { ok: false; reason: 'save-ended' }
  | { ok: false; reason: 'already-committed'; segmentId: number }
  | { ok: false; reason: 'revision-mismatch' }
  | {
      ok: false;
      reason: 'generation-failed';
      message: string;
      hint: string;
      detail?: string;
    };

function describeGenerationError(error: unknown): {
  message: string;
  hint: string;
  detail?: string;
} {
  if (error instanceof SegmentGenerationError) {
    return {
      message: '模型返回的内容连续多次都不符合约定结构，本段未结算。',
      hint: '可以直接重试；若反复出现，换一个遵循指令能力更强的模型，或在设置页关掉「结构化输出」。',
      detail: error.issues.join('；'),
    };
  }

  const modelError = toModelError(error);
  const result: { message: string; hint: string; detail?: string } = {
    message: modelError.message,
    hint: hintFor(modelError.kind),
  };
  if (modelError.detail !== undefined) result.detail = modelError.detail;
  return result;
}

export async function submitSegment(input: SubmitSegmentInput): Promise<SubmitSegmentResult> {
  return withSaveLock(input.saveId, async () => {
    const save = await getSave(input.saveId);
    if (!save) return { ok: false, reason: 'save-not-found' } as const;
    if (save.status === 'ended') return { ok: false, reason: 'save-ended' } as const;

    const segmentId = save.latestSegmentId + 1;
    const requestId = newId('segment');
    const now = input.now ?? Date.now();

    // 先登记再调用：这样即便进程被打断，也能知道玩家提交过什么
    await beginPendingSegment({
      requestId,
      saveId: save.id,
      segmentId,
      ...(input.playerAction !== undefined ? { playerAction: input.playerAction } : {}),
      expectedRevision: save.revision,
      createdAt: now,
    });

    const recent = await getRecentSegments(save.id, MAX_WINDOW_SEGMENTS);
    const window = selectRecentWindow(recent, save.summarizedThroughSegmentId);

    let output: RunSegmentOutput;
    try {
      output = await runSegment({
        world: save.world,
        character: save.character,
        worldStatus: save.worldStatus,
        ...(save.worldAttributes ? { worldAttributes: save.worldAttributes } : {}),
        historySummary: save.historySummary,
        recentSegments: window,
        ...(input.playerAction !== undefined ? { playerAction: input.playerAction } : {}),
        segmentId,
        lastDecisionSegmentId: save.lastDecisionSegmentId,
        adapter: input.adapter,
        ...(input.rng ? { rng: input.rng } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.onStage ? { onStage: input.onStage } : {}),
      });
    } catch (error) {
      // 明确的失败：清掉 pending，让玩家看到一个干净的「重试」而不是一条幽灵记录。
      // 只有进程被强行打断（刷新/关闭页面）时 pending 才会留下。
      await abandonPendingSegment(requestId);
      return { ok: false, reason: 'generation-failed', ...describeGenerationError(error) };
    }

    const ending = output.resolution.ending;
    const record: LifeSegmentRecord = {
      saveId: save.id,
      segmentId,
      requestId,
      ...(input.playerAction !== undefined ? { playerAction: input.playerAction } : {}),
      segment: output.proposal,
      characterBefore: save.character,
      ...(save.worldAttributes ? { worldAttributesBefore: save.worldAttributes } : {}),
      resolvedCharacter: output.resolution.character,
      resolvedWorldStatus: output.resolution.worldStatus,
      ...(output.resolution.worldAttributes ? { resolvedWorldAttributes: output.resolution.worldAttributes } : {}),
      ...(ending ? { ending } : {}),
      validationWarnings: output.warnings,
      modelMeta: output.modelMeta,
      schemaVersion: SCHEMA_VERSION,
      createdAt: now,
    };

    const commit = await commitSegment({
      saveId: save.id,
      requestId,
      expectedRevision: save.revision,
      record,
      next: {
        character: output.resolution.character,
        worldStatus: output.resolution.worldStatus,
        ...(output.resolution.worldAttributes ? { worldAttributes: output.resolution.worldAttributes } : {}),
        status: ending ? 'ended' : 'active',
        stats: {
          totalSegments: segmentId,
          startedAt: save.stats.startedAt,
          ...(ending ? { endedAt: now } : {}),
        },
        ...(ending ? { ending } : {}),
      },
      now,
    });

    if (!commit.ok) {
      if (commit.reason === 'already-committed') {
        return { ok: false, reason: 'already-committed', segmentId: commit.record.segmentId };
      }
      return { ok: false, reason: commit.reason };
    }

    return {
      ok: true,
      segmentId,
      resolution: output.resolution,
      warnings: output.warnings,
      ...(output.proposal.decision ? { decision: output.proposal.decision } : {}),
    };
  });
}

export interface MaintainMemoryResult {
  summarized: boolean;
  error?: string;
}

/**
 * 维护长期摘要。
 *
 * 刻意与 `submitSegment` 分开调用：摘要是一次额外的模型调用，绝不能挡住段落结果的展示，
 * 更不能因为摘要失败而回滚已经结算的段落。失败时只把错误记进 `summaryState`，
 * 存档本身保持完好，玩家随时可以重试。
 */
export async function maintainMemory(
  saveId: string,
  adapter: ModelAdapter,
  options: { signal?: AbortSignal; now?: number } = {},
): Promise<MaintainMemoryResult> {
  const save = await getSave(saveId);
  if (!save) return { summarized: false, error: '存档不存在' };

  const plan = planMemory(save.latestSegmentId, save.summarizedThroughSegmentId);
  if (!plan.shouldSummarize) return { summarized: false };

  const all = await getAllSegments(saveId);
  const candidates = selectSummaryCandidates(
    all,
    save.summarizedThroughSegmentId,
    plan.targetSummarizedThroughSegmentId,
  );
  if (candidates.length === 0) return { summarized: false };

  const attempts = (save.summaryState?.attempts ?? 0) + 1;
  const now = options.now ?? Date.now();

  try {
    const { summary } = await summarizeHistory({
      world: save.world,
      adapter,
      previousSummary: save.historySummary,
      segments: candidates,
      character: save.character,
      ...(options.signal ? { signal: options.signal } : {}),
    });

    await patchSave(
      saveId,
      {
        historySummary: summary,
        summarizedThroughSegmentId: plan.targetSummarizedThroughSegmentId,
        // 整体替换 summaryState，成功时自然清掉上一次的 lastError
        summaryState: { attempts, lastAttemptAt: now },
      },
      now,
    );

    return { summarized: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await patchSave(saveId, { summaryState: { lastError: message, attempts, lastAttemptAt: now } }, now);
    return { summarized: false, error: message };
  }
}
