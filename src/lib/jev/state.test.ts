import { describe, expect, it } from 'vitest';
import { attributeLabel, tierName } from '@/lib/engine/labels';
import { qingmingXiantu as world } from '@/lib/worlds/qingming-xiantu';
import {
  buildJevInstructions,
  buildJevScoreRequest,
  buildJevState,
} from './state';
import type { CharacterState, DecisionPoint, LifeSegmentRecord, LifeEntry } from '@/lib/engine/types';

/**
 * Jev state 组装的字段锁定。
 *
 * state 是打分的事实基础，也是发往第三方的载荷：它必须带全人格与处境、
 * 必须带编号选项列表（client 的 criteria 契约），又必须足够紧凑。
 * 这里逐字段钉死，改格式前这些断言会先亮红灯。
 */

const DECISION: DecisionPoint = {
  prompt: '一位自称来自上宗的人找上门，说可以带你走。',
  stakes: '无论怎么选，你都不会再回到从前的日子。',
  options: ['跟他走', '婉拒', '追问他的来历'],
  cause: 'proposed',
};

function makeCharacter(overrides: Partial<CharacterState> = {}): CharacterState {
  return {
    name: '林砚',
    age: 27,
    isAlive: true,
    attributes: Object.fromEntries(
      world.attributes.map((attribute) => [attribute.key, attribute.initialValue]),
    ),
    traits: ['坚韧', '寡言'],
    inventory: ['半页残卷'],
    relationships: { 周砚: '旧识' },
    ...overrides,
  };
}

function makeEntry(age: number, overrides: Partial<LifeEntry> = {}): LifeEntry {
  return { age, kind: 'event', text: `${age} 岁的那件事`, ...overrides };
}

function makeSegment(segmentId: number, entries: LifeEntry[]): LifeSegmentRecord {
  return {
    saveId: 'save-1',
    segmentId,
    requestId: `req-${segmentId}`,
    segment: { entries, timeAdvance: 3, attributeDeltas: {} },
    characterBefore: makeCharacter(),
    resolvedCharacter: makeCharacter(),
    resolvedWorldStatus: '',
    validationWarnings: [],
    modelMeta: { provider: '测试', model: '测试模型', latencyMs: 1 },
    schemaVersion: 2,
    createdAt: 0,
  };
}

function makeInput(overrides: Partial<Parameters<typeof buildJevState>[0]> = {}) {
  return {
    world,
    character: makeCharacter(),
    worldStatus: '青冥山一带的灵气又薄了一分。',
    historySummary: '你自青冥山下一户人家醒来，此后一直在山中修炼。',
    recentSegments: [
      makeSegment(1, [makeEntry(24, { kind: 'cultivation', text: '你闭门不出，修为渐厚' })]),
      makeSegment(2, [makeEntry(26, { kind: 'setback', text: '冲击筑基未果，心气受损' })]),
    ],
    decision: DECISION,
    ...overrides,
  };
}

describe('buildJevState', () => {
  it('编号选项列表按原顺序出现，序号与 client 的 criteria 键对应', () => {
    const state = buildJevState(makeInput());

    const positions = DECISION.options.map((_, index) =>
      state.indexOf(`${index}. ${DECISION.options[index]}`),
    );
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('带年龄、阶位名与寿元余量，不暴露阶位键的裸索引', () => {
    const realmIndex = 2;
    const character = makeCharacter({
      age: 60,
      attributes: Object.fromEntries(
        world.attributes.map((attribute) => [
          attribute.key,
          attribute.key === world.mechanics.realmKey ? realmIndex : attribute.initialValue,
        ]),
      ),
    });
    const state = buildJevState(makeInput({ character }));

    expect(state).toContain('60 岁');
    expect(state).toContain(tierName(world, realmIndex));
    expect(state).toContain('寿元尚余约');
    // 阶位在 state 里只以阶位名出现；「label + 数值」的写法会暴露索引
    expect(state).not.toContain(
      `${attributeLabel(world, world.mechanics.realmKey)} ${realmIndex}`,
    );
  });

  it('属性带界面名，修为写成进度形式', () => {
    const { cultivationKey, cultivationMax } = world.mechanics;
    const state = buildJevState(makeInput());

    expect(state).toMatch(
      new RegExp(`${attributeLabel(world, cultivationKey)} \\d+/${cultivationMax}`),
    );
  });

  it('带特质、持有与关系', () => {
    const state = buildJevState(makeInput());

    expect(state).toContain('特质：坚韧、寡言');
    expect(state).toContain('持有：半页残卷');
    expect(state).toContain('关系：周砚（旧识）');
  });

  it('长期摘要超长时取尾部（最新的部分）', () => {
    // 开头标记之后全部用同质填充撑过 240 字，截断后开头的标记必然不在 state 里
    const summary = `开头标记。${'相同的填充句。'.repeat(60)}最新的执念是那半页残卷。`;
    const state = buildJevState(makeInput({ historySummary: summary }));

    expect(state).toContain('最新的执念是那半页残卷。');
    expect(state).not.toContain('开头标记');
  });

  it('近期条目只取最后 6 条，且 detail 不进 state', () => {
    const entries: LifeEntry[] = [];
    for (let age = 10; age <= 29; age += 1) {
      entries.push(makeEntry(age));
    }
    entries.push(makeEntry(30, { detail: '这段完整叙事不该出现在打分 state 里。' }));
    const state = buildJevState(makeInput({ recentSegments: [makeSegment(1, entries)] }));

    expect(state).toContain('25 岁 · 25 岁的那件事');
    expect(state).toContain('30 岁 · 30 岁的那件事');
    expect(state).not.toContain('10 岁');
    expect(state).not.toContain('24 岁 · 24 岁的那件事');
    expect(state).not.toContain('这段完整叙事不该出现在打分 state 里。');
  });

  it('岔路与分量原文进入 state', () => {
    const state = buildJevState(makeInput());

    expect(state).toContain(`【岔路】${DECISION.prompt}`);
    expect(state).toContain(`【分量】${DECISION.stakes}`);
  });

  it('空摘要、空局势、空历史不产生空段落', () => {
    const state = buildJevState(
      makeInput({ historySummary: '  ', worldStatus: '', recentSegments: [] }),
    );

    expect(state).not.toContain('【经历摘要】');
    expect(state).not.toContain('【世界局势】');
    expect(state).not.toContain('【近年经历】');
  });

  it('state 保持紧凑（远低于一次段落生成的体量）', () => {
    const state = buildJevState(makeInput());

    expect(state.length).toBeLessThan(1200);
  });
});

describe('buildJevInstructions', () => {
  it('口径是「契合角色」而不是「收益最优」', () => {
    const instructions = buildJevInstructions();

    expect(instructions).toContain('最像「他」');
    expect(instructions).toContain('不要选看起来收益最大的');
  });
});

describe('buildJevScoreRequest', () => {
  it('一次给出 client.score 的全部输入，选项与决策点一致', () => {
    const request = buildJevScoreRequest(makeInput());

    expect(request.options).toEqual(DECISION.options);
    expect(request.instructions).toBe(buildJevInstructions());
    expect(request.state).toContain('【选项】');
    // state 与 options 出自同一个 decision，两边不会各改各的
    DECISION.options.forEach((option, index) => {
      expect(request.state).toContain(`${index}. ${option}`);
    });
  });
});
