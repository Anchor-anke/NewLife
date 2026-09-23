import { beforeEach, describe, expect, it } from 'vitest';
import type {
  CharacterState,
  LifeSegment,
  LifeSegmentRecord,
  SaveRecord,
} from '@/lib/engine/types';
import { SCHEMA_VERSION } from '@/lib/engine/types';
import { qingmingXiantu as world } from '@/lib/worlds/qingming-xiantu';
import { resetDbForTests } from './db';
import {
  abandonPendingSegment,
  beginPendingSegment,
  commitSegment,
  deleteSave,
  findSegmentByRequestId,
  getPendingSegments,
  getRecentSegments,
  getSave,
  getSegmentsAfter,
  listSaves,
  putSave,
} from './saves';

function makeCharacter(): CharacterState {
  return {
    name: '林砚',
    age: 16,
    isAlive: true,
    attributes: { realm: 0, cultivation: 0, aptitude: 50 },
    traits: [],
    inventory: [],
    relationships: {},
  };
}

function makeSave(overrides: Partial<SaveRecord> = {}): SaveRecord {
  return {
    id: 'save-1',
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    world,
    worldStatus: '',
    character: makeCharacter(),
    historySummary: '',
    summarizedThroughSegmentId: 0,
    latestSegmentId: 0,
    lastDecisionSegmentId: 0,
    status: 'active',
    stats: { totalSegments: 0, startedAt: 1_000 },
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function makeSegmentPayload(segmentId: number, withDecision = false): LifeSegment {
  const segment: LifeSegment = {
    entries: [{ age: 16 + segmentId, kind: 'event', text: `第 ${segmentId} 段。` }],
    timeAdvance: 3,
    attributeDeltas: {},
  };
  if (withDecision) {
    segment.decision = {
      prompt: '一个岔路。',
      stakes: '这一步会改变很多年。',
      options: ['往左', '往右'],
      cause: 'proposed',
    };
  }
  return segment;
}

function makeRecord(
  segmentId: number,
  requestId: string,
  saveId = 'save-1',
  withDecision = false,
): LifeSegmentRecord {
  return {
    saveId,
    segmentId,
    requestId,
    playerAction: `第 ${segmentId} 段的决定`,
    segment: makeSegmentPayload(segmentId, withDecision),
    resolvedCharacter: makeCharacter(),
    characterBefore: makeCharacter(),
    resolvedWorldStatus: '',
    validationWarnings: [],
    modelMeta: { provider: '测试', model: '测试模型', latencyMs: 1 },
    schemaVersion: SCHEMA_VERSION,
    createdAt: 2_000 + segmentId,
  };
}

function commitInput(
  segmentId: number,
  requestId: string,
  expectedRevision: number,
  withDecision = false,
) {
  return {
    saveId: 'save-1',
    requestId,
    expectedRevision,
    record: makeRecord(segmentId, requestId, 'save-1', withDecision),
    next: {
      character: makeCharacter(),
      worldStatus: `第 ${segmentId} 段后的局势`,
      status: 'active' as const,
      stats: { totalSegments: segmentId, startedAt: 1_000 },
    },
    now: 3_000 + segmentId,
  };
}

beforeEach(async () => {
  await resetDbForTests();
});

describe('存档仓库', () => {
  it('保存与读取存档', async () => {
    await putSave(makeSave());
    expect((await getSave('save-1'))?.id).toBe('save-1');
    expect(await listSaves()).toHaveLength(1);
  });

  it('列表按更新时间倒序', async () => {
    await putSave(makeSave({ id: 'a', updatedAt: 100 }));
    await putSave(makeSave({ id: 'b', updatedAt: 300 }));
    await putSave(makeSave({ id: 'c', updatedAt: 200 }));

    expect((await listSaves()).map((save) => save.id)).toEqual(['b', 'c', 'a']);
  });

  it('提交段落会写入记录、推进版本号并更新存档', async () => {
    await putSave(makeSave());

    const result = await commitSegment(commitInput(1, 'req-1', 0));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.revision).toBe(1);

    const save = await getSave('save-1');
    expect(save?.revision).toBe(1);
    expect(save?.latestSegmentId).toBe(1);
    expect(save?.worldStatus).toBe('第 1 段后的局势');
    expect(save?.updatedAt).toBe(3_001);
    expect(await findSegmentByRequestId('req-1')).toBeDefined();
  });

  it('带决策点的段落会把「上次介入的段号」推到这一段', async () => {
    await putSave(makeSave());
    await commitSegment(commitInput(1, 'req-1', 0, false));
    await commitSegment(commitInput(2, 'req-2', 1, true));
    await commitSegment(commitInput(3, 'req-3', 2, false));

    const save = await getSave('save-1');
    expect(save?.latestSegmentId).toBe(3);
    expect(save?.lastDecisionSegmentId).toBe(2);
  });

  it('同一个 requestId 重复提交只产生一条记录', async () => {
    await putSave(makeSave());

    const first = await commitSegment(commitInput(1, 'req-1', 0));
    // 模拟重复点击 / 刷新后重试：同一个 requestId，revision 也照旧传 0
    const second = await commitSegment(commitInput(1, 'req-1', 0));

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('already-committed');

    const segments = await getRecentSegments('save-1', 10);
    expect(segments).toHaveLength(1);
    expect((await getSave('save-1'))?.revision).toBe(1);
  });

  it('版本号不匹配时拒绝提交，避免覆盖并发写入', async () => {
    await putSave(makeSave());
    await commitSegment(commitInput(1, 'req-1', 0));

    // 第二个标签页仍拿着 revision=0 发起提交
    const stale = await commitSegment(commitInput(2, 'req-2', 0));

    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.reason).toBe('revision-mismatch');
      if (stale.reason === 'revision-mismatch') expect(stale.actualRevision).toBe(1);
    }
    expect(await getRecentSegments('save-1', 10)).toHaveLength(1);
  });

  it('已结束的存档不再接受新段落', async () => {
    await putSave(makeSave({ status: 'ended' }));

    const result = await commitSegment(commitInput(1, 'req-1', 0));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('save-ended');
  });

  it('存档不存在时拒绝提交', async () => {
    const result = await commitSegment(commitInput(1, 'req-1', 0));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('save-not-found');
  });

  it('提交成功会在同一事务里清掉 pending 记录', async () => {
    await putSave(makeSave());
    await beginPendingSegment({
      requestId: 'req-1',
      saveId: 'save-1',
      segmentId: 1,
      playerAction: '我要进山',
      expectedRevision: 0,
      createdAt: 2_000,
    });
    expect(await getPendingSegments('save-1')).toHaveLength(1);

    await commitSegment(commitInput(1, 'req-1', 0));

    expect(await getPendingSegments('save-1')).toHaveLength(0);
  });

  it('提交失败时保留 pending，供界面提示玩家恢复', async () => {
    await putSave(makeSave());
    await beginPendingSegment({
      requestId: 'req-9',
      saveId: 'save-1',
      segmentId: 1,
      playerAction: '我要进山',
      expectedRevision: 0,
      createdAt: 2_000,
    });

    // 用一个不相干的 requestId 提交，模拟崩溃后重新发起
    await commitSegment(commitInput(1, 'req-other', 0));

    const pending = await getPendingSegments('save-1');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.playerAction).toBe('我要进山');
  });

  it('放弃一个 pending 记录后它不再出现', async () => {
    await beginPendingSegment({
      requestId: 'req-x',
      saveId: 'save-1',
      segmentId: 1,
      expectedRevision: 0,
      createdAt: 1,
    });

    await abandonPendingSegment('req-x');

    expect(await getPendingSegments('save-1')).toHaveLength(0);
  });

  it('最近段落按 segmentId 升序返回', async () => {
    await putSave(makeSave());
    for (let segmentId = 1; segmentId <= 5; segmentId += 1) {
      await commitSegment(commitInput(segmentId, `req-${segmentId}`, segmentId - 1));
    }

    const recent = await getRecentSegments('save-1', 3);
    expect(recent.map((record) => record.segmentId)).toEqual([3, 4, 5]);
  });

  it('按 segmentId 取其后的段落，用于生成摘要', async () => {
    await putSave(makeSave());
    for (let segmentId = 1; segmentId <= 5; segmentId += 1) {
      await commitSegment(commitInput(segmentId, `req-${segmentId}`, segmentId - 1));
    }

    const after = await getSegmentsAfter('save-1', 3);
    expect(after.map((record) => record.segmentId)).toEqual([4, 5]);
  });

  it('删除存档会连带清除段落与 pending 记录', async () => {
    await putSave(makeSave());
    await commitSegment(commitInput(1, 'req-1', 0));
    await beginPendingSegment({
      requestId: 'req-2',
      saveId: 'save-1',
      segmentId: 2,
      playerAction: '继续',
      expectedRevision: 1,
      createdAt: 2_000,
    });

    await deleteSave('save-1');

    expect(await getSave('save-1')).toBeUndefined();
    expect(await getRecentSegments('save-1', 10)).toHaveLength(0);
    expect(await getPendingSegments('save-1')).toHaveLength(0);
    expect(await findSegmentByRequestId('req-1')).toBeUndefined();
  });

  it('不同存档的段落互不串扰', async () => {
    await putSave(makeSave({ id: 'a' }));
    await putSave(makeSave({ id: 'b' }));
    await commitSegment({
      ...commitInput(1, 'req-a', 0),
      saveId: 'a',
      record: makeRecord(1, 'req-a', 'a'),
    });
    await commitSegment({
      ...commitInput(1, 'req-b', 0),
      saveId: 'b',
      record: makeRecord(1, 'req-b', 'b'),
    });

    expect(await getRecentSegments('a', 10)).toHaveLength(1);
    expect((await getRecentSegments('a', 10))[0]?.saveId).toBe('a');
    expect((await getRecentSegments('b', 10))[0]?.saveId).toBe('b');
  });
});
