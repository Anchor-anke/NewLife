import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatRequest, ModelAdapter } from '@/lib/model/adapter';
import { ModelError } from '@/lib/model/errors';
import { resetDbForTests } from '@/lib/storage/db';
import { getPendingSegments, getRecentSegments, getSave } from '@/lib/storage/saves';
import { qingmingXiantu as world } from '@/lib/worlds/qingming-xiantu';
import {
  buildSaveRecord,
  createGame,
  generateEpilogueForSave,
  rollAttributes,
} from './gameService';
import { maintainMemory, submitSegment } from './segmentService';

/** 从提示词里读出角色当前年龄，好让条目的年龄落在本段区间内。 */
function readAge(userMessage: string): number {
  const match = /年龄：(\d+)\s*岁/.exec(userMessage);
  return match?.[1] ? Number(match[1]) : 16;
}

/**
 * 用 `json` 标志区分「段落生成」与「摘要生成」两类调用。
 *
 * 段落的 timeAdvance 固定 3 年——规整层会把小于 3 的值顶到 3，用 3 才能
 * 让断言直接对上，不必每次心算裁剪结果。
 */
function makeAdapter(options: { failSegments?: boolean; proposeDecision?: boolean } = {}) {
  let segmentCounter = 0;
  let summaryCounter = 0;

  return {
    provider: '测试供应商',
    model: '测试模型',
    async complete(request: ChatRequest) {
      if (request.json === true) {
        if (options.failSegments) {
          throw new ModelError({ kind: 'auth', message: '密钥无效', status: 401 });
        }
        segmentCounter += 1;

        const userMessage = [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
        const age = readAge(userMessage);

        const payload: Record<string, unknown> = {
          entries: [
            { age, kind: 'cultivation', text: `第 ${segmentCounter} 段：你在山中静坐。` },
            { age: age + 3, kind: 'event', text: '山下的集市换了管事。' },
          ],
          timeAdvance: 3,
          attributeDeltas: { comprehension: 1 },
        };
        if (options.proposeDecision) {
          payload['decision'] = {
            prompt: '一位自称来自上宗的人找上门。',
            stakes: '无论怎么选，你都不会再回到从前的日子。',
            options: ['跟他走', '婉拒'],
          };
        }

        return { text: JSON.stringify(payload), latencyMs: 1 };
      }

      summaryCounter += 1;
      return { text: `第 ${summaryCounter} 版摘要：你一直在青冥山下过日子。`, latencyMs: 1 };
    },
    async ping() {
      return { latencyMs: 1 };
    },
  };
}

const FIXED_RNG = () => 0.5;

/** 造一个「修为刚好够突破」的角色，用来触发决策门槛里的突破通道。 */
function breakthroughAttributes() {
  const attributes = rollAttributes(world, undefined, FIXED_RNG);
  attributes['cultivation'] = 95;
  return attributes;
}

beforeEach(async () => {
  await resetDbForTests();
});

describe('创角', () => {
  it('初始属性落在各自的随机区间内', () => {
    const attributes = rollAttributes(world, undefined, FIXED_RNG);

    for (const definition of world.attributes) {
      const value = attributes[definition.key];
      expect(value).toBeDefined();
      if (!value === undefined) continue;

      if (definition.roll) {
        expect(value).toBeGreaterThanOrEqual(definition.roll.min);
        expect(value).toBeLessThanOrEqual(definition.roll.max);
      } else {
        expect(value).toBe(definition.initialValue);
      }
    }
  });

  it('天赋的一次性加成会叠加，并裁剪到合法范围', () => {
    const plain = rollAttributes(world, undefined, FIXED_RNG);
    const talented = rollAttributes(world, 'innate-dao-body', FIXED_RNG);

    // 天生道体：根骨 +20
    expect(talented['aptitude']).toBe((plain['aptitude'] ?? 0) + 20);

    // 大器晚成：根骨 −10，且不会掉到下限以下
    const lateBloomer = rollAttributes(world, 'late-bloomer', FIXED_RNG);
    expect(lateBloomer['aptitude']).toBeGreaterThanOrEqual(0);
  });

  it('起始年龄与初始世界局势来自世界观定义，决策水位从 0 起算', () => {
    const record = buildSaveRecord({ world, name: '林砚', now: 1_000 });

    expect(record.character.age).toBe(world.mechanics.startingAge);
    expect(record.worldStatus).toBe(world.initialWorldStatus);
    expect(record.status).toBe('active');
    expect(record.revision).toBe(0);
    expect(record.latestSegmentId).toBe(0);
    expect(record.lastDecisionSegmentId).toBe(0);
    expect(record.stats.totalSegments).toBe(0);
    expect(record.stats.startedAt).toBe(1_000);
  });

  it('空名字会兜底为「无名」', () => {
    expect(buildSaveRecord({ world, name: '   ' }).character.name).toBe('无名');
  });
});

describe('submitSegment', () => {
  it('完整跑通一段并落盘', async () => {
    const save = await createGame({ world, name: '林砚', rng: FIXED_RNG });
    const adapter = makeAdapter();

    const result = await submitSegment({ saveId: save.id, adapter });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.segmentId).toBe(1);
      expect(result.resolution.character.attributes['comprehension']).toBeGreaterThan(
        save.character.attributes['comprehension'] ?? 0,
      );
      // 世界自行运转的段落没有玩家行动
      expect(result.decision).toBeUndefined();
    }

    const updated = await getSave(save.id);
    expect(updated?.latestSegmentId).toBe(1);
    expect(updated?.revision).toBe(1);
    expect(updated?.stats.totalSegments).toBe(1);
    expect(updated?.lastDecisionSegmentId).toBe(0);

    const segments = await getRecentSegments(save.id, 10);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.playerAction).toBeUndefined();
    expect(segments[0]?.segment.entries).toHaveLength(2);
    expect(segments[0]?.segment.entries[0]?.text).toContain('山中静坐');
  });

  it('带上玩家决定时，决定会写进段落记录', async () => {
    const save = await createGame({ world, name: '林砚', rng: FIXED_RNG });
    const adapter = makeAdapter();

    await submitSegment({ saveId: save.id, playerAction: '跟他走', adapter });

    const segments = await getRecentSegments(save.id, 10);
    expect(segments[0]?.playerAction).toBe('跟他走');
  });

  it('连续推进多段，版本号与段号单调递增', async () => {
    const save = await createGame({ world, name: '林砚', rng: FIXED_RNG });
    const adapter = makeAdapter();

    for (let index = 1; index <= 5; index += 1) {
      const result = await submitSegment({ saveId: save.id, adapter });
      expect(result.ok).toBe(true);
    }

    const updated = await getSave(save.id);
    expect(updated?.latestSegmentId).toBe(5);
    expect(updated?.revision).toBe(5);
    expect(await getRecentSegments(save.id, 10)).toHaveLength(5);
  });

  it('突破发生的段落会停车，并把决策水位推到这一段', async () => {
    const save = await createGame({
      world,
      name: '林砚',
      rng: FIXED_RNG,
      attributes: breakthroughAttributes(),
    });

    const result = await submitSegment({
      saveId: save.id,
      adapter: makeAdapter({ proposeDecision: true }),
      // 突破判定是掷骰子，注入固定值让它必然成功，否则这条断言会随机失败
      rng: () => 0,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decision?.cause).toBe('breakthrough');
      expect(result.decision?.options).toEqual(['跟他走', '婉拒']);
    }

    const updated = await getSave(save.id);
    expect(updated?.lastDecisionSegmentId).toBe(1);
  });

  it('生成失败时不写入任何状态，并清掉 pending 记录', async () => {
    const save = await createGame({ world, name: '林砚', rng: FIXED_RNG });
    const before = await getSave(save.id);

    const result = await submitSegment({
      saveId: save.id,
      adapter: makeAdapter({ failSegments: true }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'generation-failed') {
      expect(result.hint).toContain('密钥');
    } else {
      throw new Error('应当以 generation-failed 失败');
    }

    const after = await getSave(save.id);
    expect(after?.revision).toBe(before?.revision);
    expect(after?.latestSegmentId).toBe(before?.latestSegmentId);
    expect(after?.character).toEqual(before?.character);
    expect(await getRecentSegments(save.id, 10)).toHaveLength(0);
    expect(await getPendingSegments(save.id)).toHaveLength(0);
  });

  it('已结束的存档拒绝继续推进', async () => {
    const save = await createGame({ world, name: '林砚', rng: FIXED_RNG });
    const db = (await import('@/lib/storage/db')).getDb();
    await db.saves.update(save.id, { status: 'ended' });

    const result = await submitSegment({ saveId: save.id, adapter: makeAdapter() });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('save-ended');
  });

  it('存档不存在时给出明确原因', async () => {
    const result = await submitSegment({ saveId: '不存在', adapter: makeAdapter() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('save-not-found');
  });
});

describe('maintainMemory', () => {
  async function playSegments(count: number) {
    const save = await createGame({ world, name: '林砚', rng: FIXED_RNG });
    const adapter = makeAdapter();
    for (let index = 1; index <= count; index += 1) {
      await submitSegment({ saveId: save.id, adapter });
    }
    return { save, adapter };
  }

  it('积压不足时不调用模型', async () => {
    const { save, adapter } = await playSegments(5);
    const result = await maintainMemory(save.id, adapter);

    expect(result.summarized).toBe(false);
    expect((await getSave(save.id))?.historySummary).toBe('');
  });

  it('积压足够时生成摘要并推进摘要水位', async () => {
    const { save, adapter } = await playSegments(16);
    const result = await maintainMemory(save.id, adapter);

    expect(result.summarized).toBe(true);

    const updated = await getSave(save.id);
    expect(updated?.historySummary).toContain('摘要');
    expect(updated?.summarizedThroughSegmentId).toBeGreaterThan(0);
    // 摘要水位必须落在「最新段往前留出预留窗口」的位置
    expect(updated?.summarizedThroughSegmentId).toBeLessThan(updated?.latestSegmentId ?? 0);
  });

  it('摘要失败时存档保持完好，只记录错误供重试', async () => {
    const { save } = await playSegments(16);
    const failing: ModelAdapter = {
      provider: '测试',
      model: '会失败',
      async complete(request) {
        if (request.json === true) {
          return {
            text: JSON.stringify({
              entries: [{ age: 20, kind: 'event', text: '叙事。' }],
              timeAdvance: 3,
              attributeDeltas: {},
            }),
            latencyMs: 1,
          };
        }
        throw new ModelError({ kind: 'server', message: '服务端错误', status: 500 });
      },
      async ping() {
        return { latencyMs: 1 };
      },
    };

    const before = await getSave(save.id);
    const result = await maintainMemory(save.id, failing);

    expect(result.summarized).toBe(false);
    expect(result.error).toContain('服务端错误');

    const after = await getSave(save.id);
    // 段落数据与摘要水位都不受影响——摘要失败绝不回滚已结算的段落
    expect(after?.latestSegmentId).toBe(before?.latestSegmentId);
    expect(after?.revision).toBe(before?.revision);
    expect(after?.historySummary).toBe(before?.historySummary);
    expect(after?.summarizedThroughSegmentId).toBe(before?.summarizedThroughSegmentId);
    expect(after?.summaryState?.lastError).toContain('服务端错误');
    expect(after?.summaryState?.attempts).toBe(1);
  });

  it('摘要成功后清掉上一次的错误记录', async () => {
    const { save, adapter } = await playSegments(16);
    const db = (await import('@/lib/storage/db')).getDb();
    await db.saves.update(save.id, {
      summaryState: { lastError: '上次失败了', attempts: 3, lastAttemptAt: 1 },
    });

    await maintainMemory(save.id, adapter);

    const updated = await getSave(save.id);
    expect(updated?.summaryState?.lastError).toBeUndefined();
    expect(updated?.summaryState?.attempts).toBe(4);
  });
});

describe('人生总结', () => {
  async function endedSave() {
    const save = await createGame({ world, name: '林砚', rng: FIXED_RNG });
    const db = (await import('@/lib/storage/db')).getDb();
    await db.saves.update(save.id, {
      status: 'ended',
      ending: {
        type: 'death',
        reason: '寿元耗尽',
        narrative: '你于静室中坐化。',
        atSegmentId: 3,
      },
    });
    return save;
  }

  it('为已结束的存档生成生平总结并落盘', async () => {
    const save = await endedSave();
    const result = await generateEpilogueForSave(save.id, makeAdapter());

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.epilogue).toContain('第 1 版摘要');

    expect((await getSave(save.id))?.epilogue).toContain('第 1 版摘要');
  });

  it('未结束的存档不生成生平总结', async () => {
    const save = await createGame({ world, name: '林砚', rng: FIXED_RNG });
    const result = await generateEpilogueForSave(save.id, makeAdapter());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('还没有结束');
  });

  it('生成失败时不改动存档，可以重试', async () => {
    const save = await endedSave();
    const failing: ModelAdapter = {
      provider: '测试',
      model: '会失败',
      async complete() {
        throw new ModelError({ kind: 'rate-limit', message: '限流', status: 429 });
      },
      async ping() {
        return { latencyMs: 1 };
      },
    };

    const result = await generateEpilogueForSave(save.id, failing);

    expect(result.ok).toBe(false);
    const after = await getSave(save.id);
    expect(after?.epilogue).toBeUndefined();
    // 结局本身不能被破坏
    expect(after?.ending?.reason).toBe('寿元耗尽');
    expect(after?.status).toBe('ended');
  });
});
