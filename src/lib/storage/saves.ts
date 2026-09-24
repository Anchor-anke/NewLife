import 'client-only';
import Dexie from 'dexie';
import type {
  CharacterState,
  Ending,
  JevScores,
  LifeSegmentRecord,
  PendingSegment,
  SaveRecord,
  SaveStats,
} from '@/lib/engine/types';
import { getDb } from './db';

/**
 * 存档仓库。
 *
 * 这里集中了本项目最容易出错的三件事，因此刻意收在一个模块里：
 *
 * 1. **幂等**：同一个 `requestId` 只会产生一条段落记录。玩家重复点击、网络重试、
 *    刷新后重试，都不会让同一段被结算两次。
 * 2. **乐观并发**：提交时校验 `expectedRevision`，多标签页同时操作时后来者被拒，
 *    而不是静默覆盖。
 * 3. **崩溃恢复**：模型调用**之前**先落一条 pending 记录，提交时在同一个事务里
 *    删掉。刷新页面后能发现「上一段没跑完」，而不是静默丢失玩家的行动。
 */

const LOCK_PREFIX = 'newlife:save:';

/**
 * 在同一存档的排他锁下执行任务。
 *
 * Web Locks 的作用域是**整个浏览器**，因此两个标签页打开同一个存档时，
 * 后发起的一方会等待而不是并发调用模型——既省 token，也避免重复结算。
 * 环境不支持时退化为直接执行（内存锁仍能挡住同一页面内的重复点击）。
 */
export async function withSaveLock<T>(saveId: string, task: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks) return task();
  return locks.request(`${LOCK_PREFIX}${saveId}`, () => task());
}

// ────────────────────────────────────────────────────────────
// 读
// ────────────────────────────────────────────────────────────

export async function listSaves(): Promise<SaveRecord[]> {
  const saves = await getDb().saves.toArray();
  return saves.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getSave(saveId: string): Promise<SaveRecord | undefined> {
  return getDb().saves.get(saveId);
}

/** 按 segmentId 升序返回全部段落。用于导出与人生总结。 */
export async function getAllSegments(saveId: string): Promise<LifeSegmentRecord[]> {
  return getDb()
    .segments.where('[saveId+segmentId]')
    .between([saveId, Dexie.minKey], [saveId, Dexie.maxKey])
    .toArray();
}

/** 取最近若干段，返回时按 segmentId 升序。 */
export async function getRecentSegments(
  saveId: string,
  limit: number,
): Promise<LifeSegmentRecord[]> {
  const segments = await getDb()
    .segments.where('[saveId+segmentId]')
    .between([saveId, Dexie.minKey], [saveId, Dexie.maxKey])
    .reverse()
    .limit(limit)
    .toArray();
  return segments.reverse();
}

/** 取 segmentId 大于 `afterSegmentId` 的段落，升序。用于生成摘要。 */
export async function getSegmentsAfter(
  saveId: string,
  afterSegmentId: number,
): Promise<LifeSegmentRecord[]> {
  return getDb()
    .segments.where('[saveId+segmentId]')
    .between([saveId, afterSegmentId + 1], [saveId, Dexie.maxKey])
    .toArray();
}

export async function findSegmentByRequestId(
  requestId: string,
): Promise<LifeSegmentRecord | undefined> {
  return getDb().segments.where('requestId').equals(requestId).first();
}

export async function getPendingSegments(saveId: string): Promise<PendingSegment[]> {
  const pending = await getDb().pendingSegments.where('saveId').equals(saveId).toArray();
  return pending.sort((a, b) => a.createdAt - b.createdAt);
}

export interface SaveBundle {
  save: SaveRecord | undefined;
  segments: LifeSegmentRecord[];
  pending: PendingSegment[];
}

/**
 * 一次读齐某个存档的全部界面所需数据。
 *
 * 界面通过 `useLiveQuery` 订阅这个函数，任何一张表发生变化都会自动重渲染——
 * 这样 IndexedDB 就是唯一的状态真源，不需要再维护一份内存状态。
 */
export async function getSaveBundle(saveId: string): Promise<SaveBundle> {
  const db = getDb();
  const [save, segments, pending] = await Promise.all([
    db.saves.get(saveId),
    db.segments
      .where('[saveId+segmentId]')
      .between([saveId, Dexie.minKey], [saveId, Dexie.maxKey])
      .toArray(),
    db.pendingSegments.where('saveId').equals(saveId).toArray(),
  ]);

  return {
    save,
    segments,
    pending: pending.sort((a, b) => a.createdAt - b.createdAt),
  };
}

// ────────────────────────────────────────────────────────────
// 写
// ────────────────────────────────────────────────────────────

export async function putSave(record: SaveRecord): Promise<void> {
  await getDb().saves.put(record);
}

/**
 * 登记一个进行中的段落。
 *
 * 必须在调用模型**之前**执行：这样即使随后刷新或崩溃，也能从 pending 记录
 * 知道「玩家提交过什么、还没跑完」，而不是让那次行动凭空消失。
 */
export async function beginPendingSegment(pending: PendingSegment): Promise<void> {
  await getDb().pendingSegments.put(pending);
}

export async function abandonPendingSegment(requestId: string): Promise<void> {
  await getDb().pendingSegments.delete(requestId);
}

export async function deleteSave(saveId: string): Promise<void> {
  const db = getDb();
  await db.transaction('rw', db.saves, db.segments, db.pendingSegments, async () => {
    await db.segments.where('saveId').equals(saveId).delete();
    await db.pendingSegments.where('saveId').equals(saveId).delete();
    await db.saves.delete(saveId);
  });
}

export interface CommitSegmentInput {
  saveId: string;
  requestId: string;
  /** 发起本段时记录的存档版本，用于拒绝并发覆盖 */
  expectedRevision: number;
  record: LifeSegmentRecord;
  next: {
    character: CharacterState;
    worldStatus: string;
    worldAttributes?: Record<string, number>;
    historySummary?: string;
    summarizedThroughSegmentId?: number;
    status: 'active' | 'ended';
    ending?: Ending;
    stats: SaveStats;
  };
  now?: number;
}

export type CommitSegmentResult =
  | { ok: true; revision: number; record: LifeSegmentRecord }
  | { ok: false; reason: 'already-committed'; record: LifeSegmentRecord }
  | { ok: false; reason: 'revision-mismatch'; actualRevision: number }
  | { ok: false; reason: 'save-not-found' }
  | { ok: false; reason: 'save-ended' };

/**
 * 原子提交一个段落。
 *
 * 段落写入、存档更新、pending 清理必须在同一个事务里完成——否则一旦中途失败，
 * 就会出现「段落已落盘但存档没更新」这类最难排查的不一致。
 *
 * `lastDecisionSegmentId` 刻意**从段落本身推导**而不是由调用方另传一份：
 * 带决策点的段落就是最后一次停车，这个事实只有一个来源，也就不会对不上。
 */
export async function commitSegment(input: CommitSegmentInput): Promise<CommitSegmentResult> {
  const db = getDb();
  const now = input.now ?? Date.now();

  return db.transaction('rw', db.saves, db.segments, db.pendingSegments, async () => {
    // 幂等闸门：同一个 requestId 已经结算过就直接返回既有记录
    const existing = await db.segments.where('requestId').equals(input.requestId).first();
    if (existing) return { ok: false, reason: 'already-committed', record: existing } as const;

    const save = await db.saves.get(input.saveId);
    if (!save) return { ok: false, reason: 'save-not-found' } as const;
    if (save.status === 'ended') return { ok: false, reason: 'save-ended' } as const;

    if (save.revision !== input.expectedRevision) {
      return {
        ok: false,
        reason: 'revision-mismatch',
        actualRevision: save.revision,
      } as const;
    }

    await db.segments.put(input.record);

    const updated: SaveRecord = {
      ...save,
      character: input.next.character,
      worldStatus: input.next.worldStatus,
      ...(input.next.worldAttributes ? { worldAttributes: input.next.worldAttributes } : {}),
      status: input.next.status,
      stats: input.next.stats,
      revision: save.revision + 1,
      latestSegmentId: input.record.segmentId,
      updatedAt: now,
    };

    if (input.record.segment.decision) {
      updated.lastDecisionSegmentId = input.record.segmentId;
    }
    if (input.next.historySummary !== undefined) {
      updated.historySummary = input.next.historySummary;
    }
    if (input.next.summarizedThroughSegmentId !== undefined) {
      updated.summarizedThroughSegmentId = input.next.summarizedThroughSegmentId;
    }
    if (input.next.ending) updated.ending = input.next.ending;
    else delete updated.ending;

    await db.saves.put(updated);
    await db.pendingSegments.delete(input.requestId);

    return { ok: true, revision: updated.revision, record: input.record } as const;
  });
}

/** 只更新存档本身（用于摘要回填、结局文本等不产生新段落的写入）。 */
export async function patchSave(
  saveId: string,
  patch: Partial<Omit<SaveRecord, 'id' | 'schemaVersion'>>,
  now = Date.now(),
): Promise<void> {
  const db = getDb();
  await db.transaction('rw', db.saves, async () => {
    const save = await db.saves.get(saveId);
    if (!save) return;
    await db.saves.put({ ...save, ...patch, updatedAt: now });
  });
}

/**
 * 事后补写某段岔路的 Jev 推演分数。
 *
 * 打分是段落数据落库之后异步回来的，所以只能对已提交的记录做一次定点更新。
 * 记录此时必然存在（提交先于决策卡渲染）；找不到说明存档被并发改动过，
 * 丢掉这条观测数据即可，它不影响任何玩法状态。
 */
export async function patchSegmentJevScores(
  saveId: string,
  segmentId: number,
  scores: JevScores,
): Promise<void> {
  const db = getDb();
  await db.segments.update([saveId, segmentId], { jevScores: scores });
}
