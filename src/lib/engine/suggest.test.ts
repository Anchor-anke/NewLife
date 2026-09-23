import { describe, expect, it } from 'vitest';
import type { ChatRequest, ModelAdapter } from '@/lib/model/adapter';
import { qingmingXiantu as world } from '@/lib/worlds/qingming-xiantu';
import { SuggestError, suggestAction, suggestOption } from './suggest';
import type { CharacterState, DecisionPoint, LifeSegmentRecord } from './types';

/**
 * AI 辅助决策。
 *
 * 重点不是「模型答得好不好」，而是**答歪了程序能不能兜住**：
 * 这两条路径的产物会直接变成玩家的决定，越界或空值必须在提交之前就被拦下来。
 */

const OPTIONS = ['继续闭关', '下山走一遭', '去拜访故人'];

const DECISION: DecisionPoint = {
  prompt: '一位自称来自上宗的人找上门。',
  stakes: '无论怎么选，你都不会再回到从前的日子。',
  options: OPTIONS,
  cause: 'proposed',
};

function makeCharacter(): CharacterState {
  return {
    name: '林砚',
    age: 20,
    isAlive: true,
    attributes: Object.fromEntries(
      world.attributes.map((attribute) => [attribute.key, attribute.initialValue]),
    ),
    traits: [],
    inventory: [],
    relationships: {},
  };
}

function makeSegment(segmentId: number): LifeSegmentRecord {
  return {
    saveId: 'save-1',
    segmentId,
    requestId: `req-${segmentId}`,
    segment: {
      entries: [{ age: 19 + segmentId, kind: 'cultivation', text: '你在山中静坐。' }],
      timeAdvance: 3,
      attributeDeltas: {},
      decision: DECISION,
    },
    characterBefore: makeCharacter(),
    resolvedCharacter: makeCharacter(),
    resolvedWorldStatus: '',
    validationWarnings: [],
    modelMeta: { provider: '测试', model: '测试模型', latencyMs: 1 },
    schemaVersion: 2,
    createdAt: 0,
  };
}

function makeAdapter(replies: readonly string[]): {
  adapter: ModelAdapter;
  prompts: string[];
} {
  let callIndex = 0;
  const prompts: string[] = [];

  return {
    prompts,
    adapter: {
      provider: '测试供应商',
      model: '测试模型',
      async complete(request: ChatRequest) {
        prompts.push(request.messages.map((message) => message.content).join('\n'));
        const reply = replies[Math.min(callIndex, replies.length - 1)] ?? '{}';
        callIndex += 1;
        return { text: reply, latencyMs: 1 };
      },
      async ping() {
        return { latencyMs: 1 };
      },
    },
  };
}

const BASE = {
  world,
  character: makeCharacter(),
  worldStatus: '山雨欲来。',
  historySummary: '你自幼在青冥山下长大。',
  recentSegments: [makeSegment(1)],
};

describe('suggestOption', () => {
  it('返回模型选中的下标与理由', async () => {
    const { adapter } = makeAdapter([JSON.stringify({ index: 1, reason: '他早就想下山了' })]);
    const result = await suggestOption({ ...BASE, decision: DECISION, adapter });

    expect(result.index).toBe(1);
    expect(result.reason).toContain('下山');
  });

  it('把选项列表、岔路引子与世界法则一起送进提示词', async () => {
    const { adapter, prompts } = makeAdapter([JSON.stringify({ index: 0 })]);
    await suggestOption({ ...BASE, decision: DECISION, adapter });

    const prompt = prompts[0] ?? '';
    for (const option of OPTIONS) {
      expect(prompt).toContain(option);
    }
    // 岔路本身要说清楚，否则 AI 是在没有情境的情况下瞎选
    expect(prompt).toContain(DECISION.prompt);
    expect(prompt).toContain(DECISION.stakes);
    // 世界法则是 system prompt 的一部分，必须带上，否则建议会脱离设定
    expect(prompt).toContain(world.rules[0] ?? '');
  });

  it('下标越界时回灌错误并要求重选', async () => {
    const { adapter, prompts } = makeAdapter([
      JSON.stringify({ index: 99, reason: '乱选的' }),
      JSON.stringify({ index: 2, reason: '这次对了' }),
    ]);

    const result = await suggestOption({ ...BASE, decision: DECISION, adapter });

    expect(result.index).toBe(2);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain(`0 到 ${OPTIONS.length - 1} 之间`);
  });

  it('返回的不是 JSON 时也会重试', async () => {
    const { adapter } = makeAdapter(['我觉得第二个不错。', JSON.stringify({ index: 1 })]);

    const result = await suggestOption({ ...BASE, decision: DECISION, adapter });
    expect(result.index).toBe(1);
  });

  it('两次都拿不到合法下标时抛出可读错误', async () => {
    const { adapter } = makeAdapter(['随便', '还是随便']);

    await expect(
      suggestOption({ ...BASE, decision: DECISION, adapter }),
    ).rejects.toBeInstanceOf(SuggestError);
  });

  it('没有选项时直接拒绝，不浪费一次调用', async () => {
    const { adapter, prompts } = makeAdapter([JSON.stringify({ index: 0 })]);

    await expect(
      suggestOption({ ...BASE, decision: { ...DECISION, options: [] }, adapter }),
    ).rejects.toBeInstanceOf(SuggestError);
    expect(prompts).toHaveLength(0);
  });

  it('理由为空时给出兜底文案，不把空字符串抛给界面', async () => {
    const { adapter } = makeAdapter([JSON.stringify({ index: 0 })]);
    const result = await suggestOption({ ...BASE, decision: DECISION, adapter });

    expect(result.reason.trim()).not.toBe('');
  });
});

describe('suggestAction', () => {
  it('返回写好的决定', async () => {
    const { adapter } = makeAdapter([
      JSON.stringify({ action: '我决定下山，去青冥山外的镇子看看。', reason: '想弄清身世' }),
    ]);

    const result = await suggestAction({ ...BASE, adapter });

    expect(result.action).toContain('下山');
    expect(result.reason).toContain('身世');
  });

  it('没有理由时只返回决定本身', async () => {
    const { adapter } = makeAdapter([JSON.stringify({ action: '继续闭关三年。' })]);
    const result = await suggestAction({ ...BASE, adapter });

    expect(result.action).toBe('继续闭关三年。');
    expect(result.reason).toBeUndefined();
  });

  it('输出不含 action 字段时抛出可读错误', async () => {
    const { adapter } = makeAdapter([JSON.stringify({ reason: '我忘了写行动' })]);

    await expect(suggestAction({ ...BASE, adapter })).rejects.toBeInstanceOf(SuggestError);
  });

  it('决定为空白时同样拒绝', async () => {
    const { adapter } = makeAdapter([JSON.stringify({ action: '   ' })]);

    await expect(suggestAction({ ...BASE, adapter })).rejects.toBeInstanceOf(SuggestError);
  });

  it('过长的决定会被截断，避免污染段落上下文', async () => {
    const { adapter } = makeAdapter([JSON.stringify({ action: '打'.repeat(500) })]);
    const result = await suggestAction({ ...BASE, adapter });

    expect(result.action.length).toBeLessThanOrEqual(120);
  });
});
