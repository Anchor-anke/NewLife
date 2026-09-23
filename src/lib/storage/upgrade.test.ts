import { beforeEach, describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { SCHEMA_VERSION } from '@/lib/engine/types';
import { qingmingXiantu as world } from '@/lib/worlds/qingming-xiantu';
import { getDb, resetDbForTests } from './db';

/**
 * 表结构迁移（Dexie v2 → v3）。
 *
 * 这是整个重构里唯一**不能靠纯函数单测覆盖**的一段：`migrate.ts` 里的转换逻辑
 * 本身有单测，但「Dexie 升级时旧表到底读不读得到」只有真的开一次库才知道。
 *
 * 具体风险在于 v3 把 `events` / `pendingTurns` 声明成了 `null`（升级后删除）。
 * 如果 Dexie 在跑 upgrade 之前就把它们删了，`tx.table('events')` 会抛错，
 * 而 `readLegacyTable` 的兜底会把它咽下去——结果是**玩家的全部历史静默消失**，
 * 界面上只表现为「年表是空的」。所以这里必须真的造一个 v2 的库再打开。
 */

/** 重构前的库结构。用来把数据写成旧形状。 */
class LegacyDatabase extends Dexie {
  constructor() {
    super('newlife');
    this.version(1).stores({
      saves: 'id, status, updatedAt',
      events: '[saveId+turnId], saveId, requestId',
      pendingTurns: 'requestId, saveId',
    });
    this.version(2).stores({
      customWorlds: 'id, createdAt',
    });
  }
}

const CHARACTER = {
  name: '林砚',
  age: 42,
  isAlive: true,
  attributes: { realm: 1, cultivation: 30, aptitude: 62, comprehension: 55 },
  traits: ['剑心通明'],
  inventory: ['青锋剑'],
  relationships: { 师父: '亦师亦友' },
  talentId: 'sword-bone',
};

function makeLegacySave(status: 'active' | 'ended') {
  return {
    id: 'save-1',
    schemaVersion: 1,
    revision: 2,
    world,
    worldStatus: '青冥山一带灵气渐薄',
    character: CHARACTER,
    historySummary: '你拜入青冥山，习剑十年。',
    summarizedThroughTurnId: 0,
    latestTurnId: 2,
    status,
    stats: { totalTurns: 2, startedAt: 1_000 },
    createdAt: 1_000,
    updatedAt: 4_000,
  };
}

function makeLegacyEvent(turnId: number) {
  return {
    saveId: 'save-1',
    turnId,
    requestId: `req-${turnId}`,
    playerAction: '闭关修炼',
    proposal: {
      narrative: `第 ${turnId} 段长叙事。你在洞中静坐一年，山风穿堂而过。年末时忽然有所悟。`,
      timeAdvance: 1,
      attributeDeltas: { comprehension: 1 },
      options: ['继续闭关', '出关'],
    },
    resolvedCharacter: CHARACTER,
    characterBefore: CHARACTER,
    resolvedWorldStatus: '宗门安稳',
    validationWarnings: [],
    modelMeta: { provider: 'DeepSeek', model: 'deepseek-chat', latencyMs: 900 },
    schemaVersion: 1,
    createdAt: 2_000 + turnId,
  };
}

/** 造一个停在 v2、装着旧数据的库。 */
async function seedLegacyDatabase(status: 'active' | 'ended' = 'active') {
  const legacy = new LegacyDatabase();
  await legacy.table('saves').put(makeLegacySave(status));
  await legacy.table('events').bulkPut([makeLegacyEvent(1), makeLegacyEvent(2)]);
  await legacy.table('pendingTurns').put({
    requestId: 'req-pending',
    saveId: 'save-1',
    turnId: 3,
    playerAction: '我要进山',
    expectedRevision: 2,
    createdAt: 5_000,
  });
  legacy.close();
}

beforeEach(async () => {
  await resetDbForTests();
  await Dexie.delete('newlife');
});

describe('Dexie v2 → v3 升级', () => {
  it('旧存档的 turn 语义字段被改名，并补上决策水位', async () => {
    await seedLegacyDatabase();

    const save = await getDb().saves.get('save-1');

    expect(save).toBeDefined();
    expect(save?.schemaVersion).toBe(SCHEMA_VERSION);
    expect(save?.latestSegmentId).toBe(2);
    expect(save?.summarizedThroughSegmentId).toBe(0);
    expect(save?.lastDecisionSegmentId).toBe(0);
    expect(save?.stats.totalSegments).toBe(2);
    // 旧字段不该留在记录里，否则读取方会拿到一堆看着有值的死字段
    expect((save as unknown as Record<string, unknown>)['latestTurnId']).toBeUndefined();
    expect((save as unknown as Record<string, unknown>)['summarizedThroughTurnId']).toBeUndefined();
  });

  it('旧回合被搬进 segments，压成「一条 milestone 条目 + 完整 detail」', async () => {
    await seedLegacyDatabase();

    const segments = await getDb()
      .segments.where('saveId')
      .equals('save-1')
      .sortBy('segmentId');

    expect(segments).toHaveLength(2);
    expect(segments.map((record) => record.segmentId)).toEqual([1, 2]);
    expect(segments[0]?.segment.legacy).toBe(true);
    expect(segments[0]?.segment.entries).toHaveLength(1);
    expect(segments[0]?.segment.entries[0]?.kind).toBe('milestone');
    expect(segments[0]?.segment.entries[0]?.detail).toContain('山风穿堂而过');
    // 旧回合末尾的选项转成决策点，旧存档能从那一步接着玩
    expect(segments[0]?.segment.decision?.options).toEqual(['继续闭关', '出关']);
  });

  it('进行中的回合搬到 pendingSegments，行动文案一并保留', async () => {
    await seedLegacyDatabase();

    const pending = await getDb().pendingSegments.toArray();

    expect(pending).toHaveLength(1);
    expect(pending[0]?.segmentId).toBe(3);
    expect(pending[0]?.playerAction).toBe('我要进山');
    expect(pending[0]?.expectedRevision).toBe(2);
  });

  it('旧表在升级后被删掉，不留一张装着段落的 events 表', async () => {
    await seedLegacyDatabase();

    const names = getDb()
      .tables.map((table) => table.name)
      .sort();

    expect(names).toContain('segments');
    expect(names).toContain('pendingSegments');
    expect(names).toContain('saves');
    expect(names).not.toContain('events');
    expect(names).not.toContain('pendingTurns');
  });

  it('已结束的旧存档不会留下一个无法继续的岔路', async () => {
    await seedLegacyDatabase('ended');

    const segments = await getDb()
      .segments.where('saveId')
      .equals('save-1')
      .sortBy('segmentId');

    expect(segments[1]?.segment.decision).toBeUndefined();
    // 中间那一段的岔路保留——它本来就是历史的一部分
    expect(segments[0]?.segment.decision).toBeDefined();
  });

  it('升级后的存档可以继续往下写——段号接得上，不会覆盖历史', async () => {
    await seedLegacyDatabase();

    const save = await getDb().saves.get('save-1');
    expect(save).toBeDefined();
    if (!save) return;

    // 模拟提交下一段：段号从旧存档的 latestTurnId 之后接着走
    const nextSegmentId = save.latestSegmentId + 1;
    expect(nextSegmentId).toBe(3);

    await getDb().segments.put({
      saveId: save.id,
      segmentId: nextSegmentId,
      requestId: 'req-new',
      segment: {
        entries: [{ age: 45, kind: 'event', text: '新的世界开始运转。' }],
        timeAdvance: 3,
        attributeDeltas: {},
      },
      characterBefore: save.character,
      resolvedCharacter: save.character,
      resolvedWorldStatus: '',
      validationWarnings: [],
      modelMeta: { provider: '测试', model: '测试', latencyMs: 1 },
      schemaVersion: SCHEMA_VERSION,
      createdAt: 9_000,
    });

    const all = await getDb().segments.where('saveId').equals('save-1').toArray();
    expect(all).toHaveLength(3);
  });

  it('库里没有旧数据时升级照常完成', async () => {
    // 全新的库直接由新版本建起来：不该因为「没有旧表可读」而出错
    const save = await getDb().saves.toArray();
    expect(save).toEqual([]);
    expect(getDb().tables.map((table) => table.name)).toContain('segments');
  });
});
