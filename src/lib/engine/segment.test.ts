import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatRequest, ModelAdapter } from '@/lib/model/adapter';
import { qingmingXiantu as world } from '@/lib/worlds/qingming-xiantu';
import { SegmentGenerationError, runSegment } from './segment';
import type { CharacterState } from './types';

/**
 * 段落管线。
 *
 * 这一层不碰持久化也不碰界面，因此可以用假适配器把**失败路径**一条条跑出来：
 * 回灌重试、重试耗尽、规整与结算的警告合并、提示词里带了什么。
 *
 * 其中「程序判定必须停车、模型却没给决策点」是最要紧的一条：如果让它溜过去，
 * 一个总是不给岔路的模型会让玩家整局都出不了手——游戏退化成看小说，
 * 而这正是这次重构要解决的问题。
 */

interface FakeAdapter extends ModelAdapter {
  readonly calls: ChatRequest[];
}

function makeFakeAdapter(responses: readonly string[]): FakeAdapter {
  const calls: ChatRequest[] = [];
  let index = 0;

  return {
    provider: '测试供应商',
    model: '测试模型',
    calls,
    async complete(request) {
      calls.push(request);
      const text = responses[Math.min(index, responses.length - 1)] ?? '';
      index += 1;
      return { text, latencyMs: 7 };
    },
    async ping() {
      return { latencyMs: 1 };
    },
  };
}

function makeCharacter(): CharacterState {
  return {
    name: '林砚',
    age: 16,
    isAlive: true,
    attributes: {
      realm: 0,
      cultivation: 0,
      aptitude: 50,
      comprehension: 50,
      willpower: 50,
      luck: 50,
      reputation: 0,
      spiritStones: 0,
    },
    traits: [],
    inventory: [],
    relationships: {},
  };
}

const DECISION = {
  prompt: '一位自称来自上宗的人找上门。',
  stakes: '无论怎么选，你都不会再回到从前的日子。',
  options: ['跟他走', '婉拒'],
};

/** 一段合法的条目流。刻意让相邻条目的类型不同，免得撞上「流水账」校验。 */
const VALID_ENTRIES = [
  { age: 18, kind: 'cultivation', text: '你闭门不出，气息渐厚。' },
  { age: 19, kind: 'event', text: '山下的集市换了新的管事。' },
];

function segmentResponse(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    entries: VALID_ENTRIES,
    timeAdvance: 3,
    attributeDeltas: { comprehension: 2 },
    worldStatusUpdate: '青冥山一带灵气渐薄',
    ...extra,
  });
}

/** 让 planStop 判定「本段必须停车」：距上次介入刚好达到强制阈值。 */
const FORCED_STOP = { segmentId: 13, lastDecisionSegmentId: 1 } as const;

function baseInput(adapter: ModelAdapter, overrides: Partial<Parameters<typeof runSegment>[0]> = {}) {
  return {
    world,
    character: makeCharacter(),
    worldStatus: '',
    historySummary: '',
    recentSegments: [],
    segmentId: 1,
    lastDecisionSegmentId: 0,
    adapter,
    rng: () => 0.99,
    ...overrides,
  };
}

describe('runSegment', () => {
  it('模型返回合法结构时完成校验与结算', async () => {
    const adapter = makeFakeAdapter([segmentResponse()]);
    const result = await runSegment(baseInput(adapter));

    expect(result.proposal.entries).toHaveLength(2);
    expect(result.proposal.timeAdvance).toBe(3);
    expect(result.resolution.character.attributes['comprehension']).toBe(52);
    expect(result.resolution.worldStatus).toBe('青冥山一带灵气渐薄');
    expect(result.modelMeta.retries).toBe(0);
    expect(result.modelMeta.provider).toBe('测试供应商');
  });

  it('从 Markdown 围栏里也能解析出 JSON', async () => {
    const adapter = makeFakeAdapter([`\`\`\`json\n${segmentResponse()}\n\`\`\``]);
    const result = await runSegment(baseInput(adapter));

    expect(result.proposal.entries).toHaveLength(2);
    expect(result.modelMeta.retries).toBe(0);
  });

  it('结构不合规时带着错误回灌重试，并在第二次成功', async () => {
    const broken = JSON.stringify({ entries: [], timeAdvance: 3 });
    const adapter = makeFakeAdapter([broken, segmentResponse()]);

    const result = await runSegment(baseInput(adapter));

    expect(result.modelMeta.retries).toBe(1);
    expect(result.proposal.entries).toHaveLength(2);

    // 第二次请求必须带上原始返回与修正指令
    const secondCall = adapter.calls[1];
    expect(secondCall).toBeDefined();
    const roles = secondCall?.messages.map((message: ChatMessage) => message.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'user']);
    expect(secondCall?.messages[2]?.content).toContain('entries');
    expect(secondCall?.messages[3]?.content).toContain('不符合约定结构');
  });

  it('返回的不是 JSON 时同样触发重试', async () => {
    const adapter = makeFakeAdapter(['抱歉，我无法完成这个请求。', segmentResponse()]);
    const result = await runSegment(baseInput(adapter));

    expect(result.modelMeta.retries).toBe(1);
    expect(adapter.calls[1]?.messages[3]?.content).toContain('JSON');
  });

  it('连续失败达到上限后抛出可读错误，不写入任何状态', async () => {
    const broken = JSON.stringify({ entries: [], timeAdvance: 3 });
    const adapter = makeFakeAdapter([broken]);

    await expect(runSegment(baseInput(adapter))).rejects.toBeInstanceOf(SegmentGenerationError);

    // 初次 + 2 次重试
    expect(adapter.calls).toHaveLength(3);
  });

  it('把规整与结算的警告合并返回', async () => {
    const adapter = makeFakeAdapter([
      segmentResponse({ attributeDeltas: { mana: 10, reputation: 999 } }),
    ]);
    const result = await runSegment(baseInput(adapter));

    const joined = result.warnings.join('\n');
    expect(joined).toContain('mana');
    expect(joined).toContain('超出上限');
    // 规整层的警告也进入了结算结果，便于一起落盘审计
    expect(result.resolution.warnings).toEqual(result.warnings);
  });

  it('模型擅自写入境界增量时，最终境界只由一次程序突破决定', async () => {
    const adapter = makeFakeAdapter([
      segmentResponse({
        entries: [{ age: 17, kind: 'cultivation', text: '你尝试冲击瓶颈。' }],
        attributeDeltas: { realm: 1 },
      }),
    ]);
    const character = makeCharacter();
    character.attributes['cultivation'] = 95;
    const result = await runSegment(baseInput(adapter, {
      character,
      rng: () => 0,
    }));

    expect(result.resolution.character.attributes['realm']).toBe(1);
    expect(result.proposal.attributeDeltas['realm']).toBeUndefined();
    expect(result.proposal.entries.some((entry) => entry.text.includes('炼气'))).toBe(true);
    expect(result.warnings.join('\n')).toContain('境界由系统判定');
  });

  it('提示词里带上了角色硬状态与寿元余量', async () => {
    const adapter = makeFakeAdapter([segmentResponse()]);
    await runSegment(baseInput(adapter));

    const userMessage = adapter.calls[0]?.messages[1]?.content ?? '';
    expect(userMessage).toContain('林砚');
    expect(userMessage).toContain('16 岁');
    expect(userMessage).toContain('寿元上限 70 岁');
    // 世界自行运转的段落要说清「没有玩家介入」，否则模型会替玩家做重大决定
    expect(userMessage).toContain('没有介入');
    expect(userMessage).toContain('不要预判系统结算结果');
    expect(userMessage).toContain('不要在 text、detail、decision 或 worldStatusUpdate 中预判玩家突破成功或失败');
  });

  it('提示词里带上了条目的写法要求，并给出反面例子', async () => {
    const adapter = makeFakeAdapter([segmentResponse()]);
    await runSegment(baseInput(adapter));

    const userMessage = adapter.calls[0]?.messages[1]?.content ?? '';

    // 长度与句式
    expect(userMessage).toContain('一到两句话');
    expect(userMessage).toContain('15~40 字');

    // **反面例子是最要紧的一行**：删掉它，模型就会退回「主谓宾摘要」的写法
    // （「周砚捎信，得一子，唤作念山」那种电报体）。
    // 这条断言存在的意义就是挡住「顺手精简提示词」这个改动。
    expect(userMessage).toContain('不要写成电报');
    expect(userMessage).toContain('周砚捎信');
    expect(userMessage).toContain('省掉的是细节，不是句子本身');
  });

  it('带上玩家决定时，提示词里出现的是「岔路口的决定」', async () => {
    const adapter = makeFakeAdapter([segmentResponse()]);
    await runSegment(baseInput(adapter, { playerAction: '跟他走' }));

    const userMessage = adapter.calls[0]?.messages[1]?.content ?? '';
    expect(userMessage).toContain('玩家在岔路口的决定');
    expect(userMessage).toContain('跟他走');
  });
});

describe('强制停车', () => {
  it('程序判定必须停车时，提示词里带上强制指令', async () => {
    const adapter = makeFakeAdapter([segmentResponse({ decision: DECISION })]);
    const result = await runSegment(baseInput(adapter, FORCED_STOP));

    expect(result.stopPlan).toEqual({ stop: true, cause: 'long-gap' });

    const userMessage = adapter.calls[0]?.messages[1]?.content ?? '';
    expect(userMessage).toContain('本段结束时必须给出一个 decision');
  });

  it('模型漏掉决策点时触发回灌重试，补上后正常通过', async () => {
    const adapter = makeFakeAdapter([
      segmentResponse(),
      segmentResponse({ decision: DECISION }),
    ]);

    const result = await runSegment(baseInput(adapter, FORCED_STOP));

    expect(result.modelMeta.retries).toBe(1);
    expect(result.proposal.decision?.cause).toBe('long-gap');

    // 回灌的信息必须点名 decision，否则模型不知道该补什么
    expect(adapter.calls[1]?.messages[3]?.content).toContain('decision');
  });

  it('模型始终不给决策点时，最后一次尝试放宽要求、带警告照常结算', async () => {
    // 这一条刻意断言「照常结算 + 警告」，而不是「报错」。
    //
    // 程序判定必须停车，说明这一段是玩家该出手的地方，所以要先重试争取；
    // 但模型要是三次都不给，把整局卡死比「这一段没有岔路」糟糕得多。
    // 缺失是**自愈**的：lastDecisionSegmentId 没有推进，下一段的 planStop
    // 依然会判定必须停车，提示词会继续要求决策点。
    const adapter = makeFakeAdapter([segmentResponse()]);
    const result = await runSegment(baseInput(adapter, FORCED_STOP));

    expect(result.modelMeta.retries).toBe(2);
    expect(adapter.calls).toHaveLength(3);
    expect(result.proposal.decision).toBeUndefined();
    expect(result.proposal.entries).toHaveLength(2);
    expect(result.warnings.join('\n')).toContain('必须停车');
  });

  it('程序没有判定必须停车时，模型不给决策点也直接通过', async () => {
    const adapter = makeFakeAdapter([segmentResponse()]);
    const result = await runSegment(baseInput(adapter));

    expect(result.modelMeta.retries).toBe(0);
    expect(result.proposal.decision).toBeUndefined();
  });

  it('模型主动给了决策点但没到门槛时，走门槛判定而不是回灌', async () => {
    const adapter = makeFakeAdapter([segmentResponse({ decision: DECISION })]);
    const result = await runSegment(baseInput(adapter));

    // 第一段（gap = 1）——密度不够，门槛丢弃它，且不浪费一次重试
    expect(result.modelMeta.retries).toBe(0);
    expect(result.proposal.decision).toBeUndefined();
    expect(result.warnings.join('\n')).toContain('既不重大');
  });
});
