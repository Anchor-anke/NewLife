import { describe, expect, it } from 'vitest';
import { buildCharacter } from '@/lib/services/gameService';
import type { ChatRequest, ModelAdapter } from '@/lib/model/adapter';
import { saveRecordSchema } from '@/lib/engine/schema';
import { buildSaveRecord } from '@/lib/services/gameService';
import { checkOpenWorld, forgeOpenWorld, type OpenForgeDraft } from './open-forge';
import { resolveOpenLife } from '@/lib/engine/open-life';
import { buildSegmentUserMessage } from '@/lib/engine/context';
import { parseExport, serializeExport } from '@/lib/storage/migrate';

const draft: OpenForgeDraft = {
  name: '荒原书屋',
  description: '灾后荒原上的一座图书馆。你是留下来整理书籍的普通人。',
  initialWorldStatus: '补给线路中断，读者和邻居开始为取暖争执。',
  rules: ['食物要靠交换取得。', '严冬会损伤健康。', '图书馆的书无法重印。'],
  startingAge: 24,
  attributeLabels: {
    career: '守书', health: '体魄', insight: '学识', empathy: '人缘',
    fortune: '机运', spirit: '心气', wealth: '物资',
  },
  talents: [
    { name: '旧馆员', description: '记得每本书的位置。', bonusKey: 'insight', bonus: 12 },
    { name: '修理匠', description: '能修复破损的器具。', bonusKey: 'career', bonus: 10 },
    { name: '孤僻者', description: '习惯一个人工作。', bonusKey: 'empathy', bonus: -8 },
  ],
  lethalEventKeywords: ['重伤', '冻死', '濒死'],
  aging: false,
  worldResources: [
    { key: 'supplies', label: '公共补给', initialValue: 50, annualDelta: -2 },
    { key: 'archive', label: '馆藏完整度', initialValue: 30, annualDelta: 0 },
  ],
  objective: { scope: 'world', key: 'archive', threshold: 70, reason: '馆藏得以保存', narrative: '你在 {age} 岁见证了图书馆的延续。' },
  failure: { key: 'supplies', threshold: 0, reason: '公共补给耗尽', narrative: '补给耗尽，守护计划在你 {age} 岁时失败。' },
};

function adapter(handler: (request: ChatRequest) => string): ModelAdapter {
  return {
    provider: 'test', model: 'mock',
    async complete(request) { return { text: handler(request), latencyMs: 1 }; },
    async ping() { return { latencyMs: 1 }; },
  };
}

describe('开放人生世界工坊', () => {
  it('生成可保存的新规则世界，人物没有旧阶位，规则能自然收束', async () => {
    const result = await forgeOpenWorld({
      premise: '灾后图书馆', id: 'custom-open', adapter: adapter(() => JSON.stringify(draft)),
    });
    expect(result.world.ruleset?.kind).toBe('open_life');
    expect(result.world.ruleset?.custom?.objective.key).toBe('archive');
    expect(result.world.attributes.find((attribute) => attribute.key === 'career')?.label).toBe('守书');
    expect(result.problems).toEqual([]);
    expect(result.report.neutralEnding).not.toBe('missing');
    const character = buildCharacter(result.world, '阿宁', undefined, () => 0.5);
    expect(character.age).toBe(24);
    expect(character.attributes).not.toHaveProperty('stratum');
    expect(saveRecordSchema.safeParse(buildSaveRecord({ world: result.world, name: '阿宁', id: 'save-open' })).success).toBe(true);
    expect(checkOpenWorld(result.world).report.neutralSegments).toBeGreaterThan(0);
    expect(result.report.neutralEnding).toBe('resource');
  });

  it('资源耗尽由程序判失败，目标达成由程序判完成，且逐条快照同步', async () => {
    const { world } = await forgeOpenWorld({ premise: '灾后图书馆', id: 'custom-open', adapter: adapter(() => JSON.stringify(draft)) });
    const save = buildSaveRecord({ world, name: '阿宁', id: 'save-open', rng: () => 0.5 });
    const proposal = { entries: [{ age: 27, kind: 'milestone' as const, text: '邻居一起清点并保存馆藏。' }], timeAdvance: 3, attributeDeltas: {}, worldDeltas: { archive: 20 } };
    const success = resolveOpenLife({ world, character: save.character, worldStatus: save.worldStatus,
      worldAttributes: { supplies: 30, archive: 55 }, proposal, segmentId: 1, lastDecisionSegmentId: 0,
      stopPlan: { stop: false }, rng: () => 0.5 });
    expect(success.ending?.type).toBe('completion');
    expect(success.breakdown.endingCause).toBe('custom-objective');
    expect(success.segment.entries.at(-1)?.settledWorldAttributes?.archive).toBeGreaterThanOrEqual(70);
    const failure = resolveOpenLife({ world, character: save.character, worldStatus: save.worldStatus,
      worldAttributes: { supplies: 2, archive: 30 }, proposal: { ...proposal, worldDeltas: {} },
      segmentId: 1, lastDecisionSegmentId: 0, stopPlan: { stop: false }, rng: () => 0.5 });
    expect(failure.ending?.type).toBe('failure');
    expect(failure.character.isAlive).toBe(true);
    expect(failure.breakdown.endingCause).toBe('custom-failure');
    expect(failure.segment.entries.at(-1)?.settledWorldAttributes?.supplies).toBe(0);
    expect(saveRecordSchema.safeParse({ ...save, status: 'ended', ending: failure.ending,
      character: failure.character, worldAttributes: failure.worldAttributes }).success).toBe(true);
    const imported = parseExport(serializeExport({ ...save, status: 'ended', ending: failure.ending,
      character: failure.character, worldAttributes: failure.worldAttributes }, []));
    expect(imported.ok && imported.value.save.ending?.type).toBe('failure');
    expect(imported.ok && imported.value.save.world.ruleset?.custom?.annualWorldDeltas.supplies).toBe(-2);
    const message = buildSegmentUserMessage({ world, character: save.character, worldStatus: save.worldStatus,
      worldAttributes: save.worldAttributes, historySummary: '', recentSegments: [], playerAction: undefined });
    expect(message).toContain('补给');
    expect(message).toContain('程序每年自动调整');
    const noAging = resolveOpenLife({ world, character: { ...save.character, age: 104 }, worldStatus: save.worldStatus,
      worldAttributes: { supplies: 100, archive: 30 }, proposal: { ...proposal, entries: [{ age: 107, kind: 'event', text: '邻居们继续清理书架。' }], worldDeltas: {} },
      segmentId: 1, lastDecisionSegmentId: 0, stopPlan: { stop: false }, rng: () => 0.5 });
    expect(noAging.character.age).toBe(107);
    expect(noAging.ending).toBeUndefined();
  });

  it('拒绝无效资源引用和开局已触发的失败条件', async () => {
    let calls = 0;
    const invalid = { ...draft, failure: { ...draft.failure, key: 'unknown', threshold: 0 } };
    await forgeOpenWorld({ premise: '灾后图书馆', id: 'custom-open', adapter: adapter(() => {
      calls += 1;
      return JSON.stringify(calls === 1 ? invalid : draft);
    }) });
    expect(calls).toBe(2);
  });

  it('草稿结构错误时向模型请求修正', async () => {
    let calls = 0;
    const result = await forgeOpenWorld({
      premise: '灾后图书馆', id: 'custom-open',
      adapter: adapter((request) => {
        calls += 1;
        if (calls === 1) return '{"name":"太短"}';
        expect(request.messages.at(-1)?.content).toContain('不符合要求');
        return JSON.stringify(draft);
      }),
    });
    expect(calls).toBe(2);
    expect(result.modelMeta.retries).toBe(1);
  });
});
