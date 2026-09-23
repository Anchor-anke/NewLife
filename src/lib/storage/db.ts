import 'client-only';
import Dexie, { type Table, type Transaction } from 'dexie';
import type { LifeSegmentRecord, PendingSegment, SaveRecord } from '@/lib/engine/types';
import {
  convertLegacyPendingTurn,
  convertLegacyTurnEvent,
  stripTrailingDecision,
  upgradeSaveRecordLenient,
} from './migrate';
import type { CustomWorldRecord } from './customWorlds';

/**
 * 本地存档库。
 *
 * 拆成多张表而不是把整个存档塞进一个对象，是因为历史记录会随游玩线性增长——
 * 每段全量重写一个大对象，会让游戏越玩越卡。
 *
 * - `saves`            轻量元数据 + 硬状态快照 + 乐观并发版本号 + 决策密度水位
 * - `segments`         单段记录，主键 `[saveId+segmentId]`，`requestId` 建索引用于幂等
 * - `pendingSegments`  进行中的段落，用于崩溃/刷新后的恢复提示
 * - `customWorlds`     玩家用 AI 生成的自定义世界观
 *
 * 注意：本模块**绝不能**在模块顶层实例化 Dexie，否则服务端渲染时会因为
 * 没有 `indexedDB` 而报错。一律通过 `getDb()` 惰性获取。
 */

export class NewLifeDatabase extends Dexie {
  saves!: Table<SaveRecord, string>;
  segments!: Table<LifeSegmentRecord, [string, number]>;
  pendingSegments!: Table<PendingSegment, string>;
  customWorlds!: Table<CustomWorldRecord, string>;

  constructor() {
    super('newlife');

    this.version(1).stores({
      saves: 'id, status, updatedAt',
      events: '[saveId+turnId], saveId, requestId',
      pendingTurns: 'requestId, saveId',
    });

    // v2 新增自定义世界观表。Dexie 只声明新增的表即可，
    // 已有的表会原样保留，不需要重写它们的 schema。
    this.version(2).stores({
      customWorlds: 'id, createdAt',
    });

    // v3：叙事单位从「回合」换成「段落」。
    //
    // 表名一起改（events → segments、pendingTurns → pendingSegments）而不是只改
    // 对象形状：留着叫 events 的表装段落，下一个读代码的人一定会误判。
    // 旧表声明为 `null` 表示「升级完成后删除」，但 upgrade 期间仍然可读——
    // 这是 Dexie 官方推荐的表改名写法。
    this.version(3)
      .stores({
        segments: '[saveId+segmentId], saveId, requestId',
        pendingSegments: 'requestId, saveId',
        events: null,
        pendingTurns: null,
      })
      .upgrade((tx) => migrateToSegments(tx));
  }
}

/**
 * 读取一张「即将被删除」的旧表。
 *
 * 正常情况下 upgrade 期间旧表可读；万一运行时不支持，宁可让这一部分历史缺失，
 * 也不能让整个数据库打不开——打不开意味着玩家连存档列表都进不去。
 */
async function readLegacyTable(tx: Transaction, name: string): Promise<unknown[]> {
  try {
    return await tx.table(name).toArray();
  } catch {
    return [];
  }
}

/**
 * v2 → v3 的数据搬迁。
 *
 * 三张表都要动，而且顺序有讲究：存档要先升级，因为「已结束的存档不该再留岔路」
 * 这条规则要用到升级后的 status。
 */
async function migrateToSegments(tx: Transaction): Promise<void> {
  const rawSaves = await readLegacyTable(tx, 'saves');
  const saves = rawSaves
    .map((raw) => upgradeSaveRecordLenient(raw))
    .filter((save): save is Record<string, unknown> => save !== undefined);
  if (saves.length > 0) {
    await tx.table('saves').bulkPut(saves);
  }

  const statusById = new Map<string, string>();
  for (const save of saves) {
    const id = save['id'];
    const status = save['status'];
    if (typeof id === 'string' && typeof status === 'string') statusById.set(id, status);
  }

  const rawEvents = await readLegacyTable(tx, 'events');
  const bySave = new Map<string, LifeSegmentRecord[]>();
  for (const raw of rawEvents) {
    const record = convertLegacyTurnEvent(raw);
    if (!record) continue;
    const list = bySave.get(record.saveId) ?? [];
    list.push(record);
    bySave.set(record.saveId, list);
  }

  const segments: LifeSegmentRecord[] = [];
  for (const [saveId, list] of bySave) {
    const status = statusById.get(saveId) === 'ended' ? 'ended' : 'active';
    segments.push(...stripTrailingDecision(list, status));
  }
  if (segments.length > 0) {
    await tx.table('segments').bulkPut(segments);
  }

  const rawPending = await readLegacyTable(tx, 'pendingTurns');
  const pending = rawPending
    .map((raw) => convertLegacyPendingTurn(raw))
    .filter((item): item is PendingSegment => item !== undefined);
  if (pending.length > 0) {
    await tx.table('pendingSegments').bulkPut(pending);
  }
}

let instance: NewLifeDatabase | null = null;

/** 惰性单例。首次调用时才真正打开数据库。 */
export function getDb(): NewLifeDatabase {
  instance ??= new NewLifeDatabase();
  return instance;
}

/** 仅供测试：关闭并丢弃单例，让下一次调用重新打开一个干净的库。 */
export async function resetDbForTests(): Promise<void> {
  if (!instance) return;
  instance.close();
  await Dexie.delete('newlife');
  instance = null;
}
