import { describe, expect, it } from 'vitest';
import { buildCharacter } from '@/lib/services/gameService';
import type { ChatRequest, ModelAdapter } from '@/lib/model/adapter';
import { saveRecordSchema } from '@/lib/engine/schema';
import { buildSaveRecord } from '@/lib/services/gameService';
import { checkOpenWorld, forgeOpenWorld, type OpenForgeDraft } from './open-forge';

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
    expect(result.world.attributes.find((attribute) => attribute.key === 'career')?.label).toBe('守书');
    expect(result.problems).toEqual([]);
    expect(result.report.neutralEnding).not.toBe('missing');
    const character = buildCharacter(result.world, '阿宁', undefined, () => 0.5);
    expect(character.age).toBe(24);
    expect(character.attributes).not.toHaveProperty('stratum');
    expect(saveRecordSchema.safeParse(buildSaveRecord({ world: result.world, name: '阿宁', id: 'save-open' })).success).toBe(true);
    expect(checkOpenWorld(result.world).report.neutralSegments).toBeGreaterThan(0);
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
