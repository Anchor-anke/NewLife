import { describe, expect, it } from 'vitest';
import { checkInvariants, simulateWorld } from '@/lib/engine/simulate';
import type { ChatRequest, ModelAdapter } from '@/lib/model/adapter';
import { ForgeError, expandDraft, forgeWorld, tuneWorld, type ForgeDraft } from './forge';

/**
 * 生成器的质量全在「修复」与「校准」两段上。
 *
 * 模型给出的 JSON 看着永远合理，只有跑起来才知道顶阶能不能到、一局有多少段。
 * 所以这里的测试重点不是「模型写得好不好」，而是**程序能不能把写得不好的兜住**。
 */

function makeDraft(overrides: Partial<ForgeDraft> = {}): ForgeDraft {
  return {
    name: '雾港夜巡',
    description: '蒸汽与齿轮的年代，你刚拿到第一枚警徽。',
    initialWorldStatus: '连续七起失踪案被压了下去。',
    timeUnit: 'year',
    rules: ['雾里有东西。', '机械义体有代价。', '知道得越多越难睡着。'],
    startingAge: 19,
    realmNames: ['见习', '巡夜人', '探长', '缄默者', '守夜人'],
    lifespanByRealm: [58, 76, 98, 126, 160],
    attributes: [
      { key: 'rank', label: '职阶', kind: 'counter', min: 0, max: 4, initialValue: 0 },
      { key: 'insight', label: '洞察', kind: 'progress', min: 0, max: 100, initialValue: 0 },
      {
        key: 'nerve',
        label: '胆识',
        kind: 'counter',
        min: 0,
        max: 100,
        initialValue: 50,
        roll: { min: 30, max: 70 },
      },
      {
        key: 'reason',
        label: '理智',
        kind: 'counter',
        min: 0,
        max: 100,
        initialValue: 55,
        roll: { min: 30, max: 75 },
      },
      {
        key: 'luck',
        label: '运气',
        kind: 'counter',
        min: 0,
        max: 100,
        initialValue: 50,
        roll: { min: 20, max: 80 },
      },
      { key: 'cogs', label: '齿轮', kind: 'resource', min: 0, initialValue: 0, unit: '枚' },
    ],
    mechanics: {
      cultivationKey: 'insight',
      realmKey: 'rank',
      cultivationMax: 100,
      aptitudeKey: 'nerve',
      willpowerKey: 'reason',
      luckKey: 'luck',
      weights: { nerve: 0.5, reason: 0.3, luck: 0.2 },
      lethalEventKeywords: ['致命', '濒死', '坠落'],
      completionProposalMinRealm: 3,
    },
    talents: [
      { name: '铁胃', description: '你什么都能咽下去。', attributeBonus: { nerve: 15 } },
      { name: '义肢', description: '左臂是机械的。', cultivationGainMul: 1.2, attributeBonus: { reason: -10 } },
    ],
    endings: {
      lifespan: { reason: '旧伤与旧夜（{realm}·{lifespan} 岁）', narrative: '你没能再走进那条巷子，享年 {age} 岁。' },
      collapse: { reason: '理智耗尽', narrative: '你分不清哪些是雾里的东西，享年 {age} 岁。' },
      ascension: { reason: '你成了雾的一部分', narrative: '雾港的雾第一次散去。' },
      turnLimit: { reason: '故事在此收束', narrative: '你的故事在此收束。享年 {age} 岁。' },
      deathByProposal: '{reason}。你的一生在此戛然而止，享年 {age} 岁。',
      completionByProposal: '{reason}。你的故事在此收束，享年 {age} 岁。',
    },
    ...overrides,
  };
}

function makeAdapter(handler: (request: ChatRequest) => string): ModelAdapter {
  return {
    provider: '测试供应商',
    model: '测试模型',
    async complete(request: ChatRequest) {
      return { text: handler(request), latencyMs: 1 };
    },
    async ping() {
      return { latencyMs: 1 };
    },
  };
}

describe('expandDraft', () => {
  it('把合法草稿补成完整的 WorldSetting', () => {
    const { world } = expandDraft(makeDraft(), 'custom-test');

    expect(world.id).toBe('custom-test');
    expect(world.mechanics.realmNames).toHaveLength(5);
    expect(world.mechanics.lifespanByRealm).toHaveLength(5);
    expect(world.talents).toHaveLength(2);

    // 阶位属性的上限必须等于最高阶位序号
    const realmAttribute = world.attributes.find((a) => a.key === world.mechanics.realmKey);
    expect(realmAttribute?.max).toBe(4);
    expect(realmAttribute?.roll).toBeUndefined();

    // 进度属性固定为 0 起步、不参与掷点
    const progressAttribute = world.attributes.find((a) => a.key === world.mechanics.cultivationKey);
    expect(progressAttribute?.kind).toBe('progress');
    expect(progressAttribute?.initialValue).toBe(0);
    expect(progressAttribute?.roll).toBeUndefined();
  });

  it('寿元表长度与阶位数量不一致时按阶位对齐', () => {
    const draft = makeDraft({ lifespanByRealm: [58, 76] });
    const { world, notes } = expandDraft(draft, 'x');

    expect(world.mechanics.lifespanByRealm).toHaveLength(world.mechanics.realmNames.length);
    expect(notes.join('\n')).toContain('寿元表长度');
  });

  it('寿元表非单调时修正为单调不减', () => {
    const draft = makeDraft({ lifespanByRealm: [58, 200, 98, 126, 160] });
    const { world } = expandDraft(draft, 'x');

    const lifespans = world.mechanics.lifespanByRealm;
    for (let index = 1; index < lifespans.length; index += 1) {
      expect(lifespans[index]).toBeGreaterThanOrEqual(lifespans[index - 1] ?? 0);
    }
  });

  it('首阶寿元过短时抬到足以支撑一局', () => {
    const draft = makeDraft({ startingAge: 30, lifespanByRealm: [32, 40, 50, 60, 70] });
    const { world } = expandDraft(draft, 'x');

    expect(world.mechanics.lifespanByRealm[0] ?? 0).toBeGreaterThan(30);
  });

  it('mechanics 里引用不存在的属性键时自动替换', () => {
    const draft = makeDraft();
    draft.mechanics.aptitudeKey = '不存在的属性';
    draft.mechanics.weights = { 不存在的属性: 1 };

    const { world, notes } = expandDraft(draft, 'x');

    const keys = new Set(world.attributes.map((a) => a.key));
    expect(keys.has(world.mechanics.cultivationGain.aptitudeKey)).toBe(true);
    for (const key of Object.keys(world.mechanics.breakthrough.weights)) {
      expect(keys.has(key)).toBe(true);
    }
    expect(notes.length).toBeGreaterThan(0);
  });

  it('突破权重会归一化到 1', () => {
    const draft = makeDraft();
    draft.mechanics.weights = { nerve: 7, reason: 2, luck: 1 };

    const { world } = expandDraft(draft, 'x');
    const sum = Object.values(world.mechanics.breakthrough.weights).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 4);
  });

  it('掷点区间超出属性范围时被裁剪回来', () => {
    const draft = makeDraft();
    const nerve = draft.attributes.find((a) => a.key === 'nerve');
    if (nerve) nerve.roll = { min: -50, max: 999 };

    const { world } = expandDraft(draft, 'x');
    const definition = world.attributes.find((a) => a.key === 'nerve');
    expect(definition?.roll?.min).toBeGreaterThanOrEqual(definition?.min ?? 0);
    expect(definition?.roll?.max).toBeLessThanOrEqual(definition?.max ?? 100);
  });

  it('属性键含非法字符时会被规整成合法标识符，且引用同步更新', () => {
    const draft = makeDraft();
    draft.attributes = draft.attributes.map((attribute) =>
      attribute.key === 'nerve' ? { ...attribute, key: 'nerve-force' } : attribute,
    );
    draft.mechanics.aptitudeKey = 'nerve-force';
    draft.mechanics.weights = { 'nerve-force': 1 };

    const { world } = expandDraft(draft, 'x');

    for (const attribute of world.attributes) {
      expect(attribute.key).toMatch(/^[A-Za-z][A-Za-z0-9]*$/);
    }
    const keys = new Set(world.attributes.map((a) => a.key));
    expect(keys.has(world.mechanics.cultivationGain.aptitudeKey)).toBe(true);
  });

  it('阶位超过十个时截断，少于两个时补足', () => {
    const many = expandDraft(
      makeDraft({
        realmNames: Array.from({ length: 14 }, (_, index) => `第${index + 1}阶`),
        lifespanByRealm: Array.from({ length: 14 }, (_, index) => 50 + index * 20),
      }),
      'x',
    );
    expect(many.world.mechanics.realmNames.length).toBeLessThanOrEqual(10);

    const few = expandDraft(makeDraft({ realmNames: ['唯一'], lifespanByRealm: [80] }), 'x');
    expect(few.world.mechanics.realmNames.length).toBeGreaterThanOrEqual(2);
  });
});

describe('tuneWorld', () => {
  it('把「登顶太容易」的世界修到能达标', () => {
    // 模型给出了一个跨度过大的寿元表：末阶窗口高达数万年，
    // 一旦登顶就有无限次突破机会。展开阶段会压缩跨度，但登顶率仍然超标。
    const draft = makeDraft({ lifespanByRealm: [60, 200, 900, 5000, 30000] });
    const { world: expanded } = expandDraft(draft, 'x');

    const before = simulateWorld(expanded, 200);
    expect(checkInvariants(expanded, before).length).toBeGreaterThan(0);

    const tuned = tuneWorld(expanded);

    expect(tuned.problems).toEqual([]);
    expect(tuned.report.ascensionRate).toBeLessThanOrEqual(0.15);
    expect(tuned.notes.length).toBeGreaterThan(0);
  });

  it('把「顶阶不可达」的世界修到能达标', () => {
    // 绕过展开阶段的修复，直接把寿元表压平——模拟「展开后仍然不可达」的残留情况
    const { world } = expandDraft(makeDraft(), 'x');
    const broken = {
      ...world,
      mechanics: { ...world.mechanics, lifespanByRealm: [58, 59, 60, 61, 62] },
    };

    const before = simulateWorld(broken, 200);
    expect(before.ascensionRate).toBe(0);

    const tuned = tuneWorld(broken);

    expect(tuned.problems).toEqual([]);
    expect(tuned.report.ascensionRate).toBeGreaterThan(0);
  });

  it('校准是幂等的：已经达标的世界再跑一次不会再动', () => {
    const draft = makeDraft({ lifespanByRealm: [60, 200, 900, 5000, 30000] });
    const { world: expanded } = expandDraft(draft, 'x');

    const once = tuneWorld(expanded);
    expect(once.problems).toEqual([]);
    expect(once.notes.length).toBeGreaterThan(0);

    const twice = tuneWorld(once.world);
    expect(twice.problems).toEqual([]);
    expect(twice.notes).toEqual([]);
    expect(twice.world.mechanics.lifespanByRealm).toEqual(once.world.mechanics.lifespanByRealm);
  });

  it('原本就达标的世界不会被乱改', () => {
    const { world: expanded } = expandDraft(makeDraft(), 'x');
    const before = simulateWorld(expanded, 200);

    if (checkInvariants(expanded, before).length === 0) {
      const tuned = tuneWorld(expanded);
      expect(tuned.notes).toEqual([]);
      expect(tuned.world.mechanics.lifespanByRealm).toEqual(expanded.mechanics.lifespanByRealm);
    }
  });
});

describe('forgeWorld', () => {
  it('端到端产出一个通过全部设计不变量的世界', async () => {
    const adapter = makeAdapter(() => JSON.stringify(makeDraft()));

    const result = await forgeWorld({ premise: '蒸汽朋克夜巡人', adapter, id: 'custom-1' });

    expect(result.world.id).toBe('custom-1');
    expect(result.world.name).toBe('雾港夜巡');
    expect(result.problems).toEqual([]);
    expect(checkInvariants(result.world, result.report)).toEqual([]);
    expect(result.modelMeta.retries).toBe(0);
  });

  it('模型把 JSON 包进代码围栏也能解析', async () => {
    const adapter = makeAdapter(() => `\`\`\`json\n${JSON.stringify(makeDraft())}\n\`\`\``);
    const result = await forgeWorld({ premise: 'x', adapter, id: 'custom-2' });
    expect(result.world.name).toBe('雾港夜巡');
  });

  it('首次返回不合法时带着错误回灌重试', async () => {
    const seen: string[] = [];
    const adapter = makeAdapter((request) => {
      seen.push(request.messages.map((message) => message.content).join('\n'));
      if (seen.length === 1) return JSON.stringify({ name: '只有名字' });
      return JSON.stringify(makeDraft());
    });

    const result = await forgeWorld({ premise: '蒸汽朋克夜巡人', adapter, id: 'custom-3' });

    expect(result.modelMeta.retries).toBe(1);
    expect(result.world.name).toBe('雾港夜巡');
    // 第二次调用必须带上第一次的错误说明与原始输出
    expect(seen[1]).toContain('不符合要求');
    expect(seen[1]).toContain('只有名字');
  });

  it('连续失败时抛出可读的错误', async () => {
    const adapter = makeAdapter(() => '这不是 JSON');
    await expect(forgeWorld({ premise: 'x', adapter, id: 'custom-4' })).rejects.toBeInstanceOf(
      ForgeError,
    );
  });

  it('按阶段回调进度', async () => {
    const stages: string[] = [];
    const adapter = makeAdapter(() => JSON.stringify(makeDraft()));

    await forgeWorld({
      premise: 'x',
      adapter,
      id: 'custom-5',
      onStage: (stage) => stages.push(stage),
    });

    expect(stages).toContain('designing');
    expect(stages).toContain('tuning');
  });
});
