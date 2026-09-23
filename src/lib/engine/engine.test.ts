import { describe, expect, it } from 'vitest';
import { normalizeSegment } from './normalize';
import { MAX_BREAKTHROUGHS_PER_SEGMENT, resolveSegment } from './resolve';
import { parseSegmentProposal } from './schema';
import { TIME_ADVANCE_MAX, TIME_ADVANCE_MIN, type CharacterState, type LifeEntry, type SegmentProposal } from './types';
import { qingmingXiantu as world } from '@/lib/worlds/qingming-xiantu';

function makeCharacter(params: {
  age?: number;
  attributes?: Record<string, number>;
  talentId?: string;
} = {}): CharacterState {
  const character: CharacterState = {
    name: '测试者',
    age: params.age ?? 16,
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
      ...params.attributes,
    },
    traits: [],
    inventory: [],
    relationships: {},
  };
  if (params.talentId) character.talentId = params.talentId;
  return character;
}

/**
 * 造一个段落提议。
 *
 * 默认只放一条落在段尾的条目——这样结算的数学与重构前「一整段就是一次推进」
 * 完全一致，旧断言的数值可以直接沿用，不必因为换了数据结构而全部重算。
 */
function makeProposal(
  character: CharacterState,
  overrides: Partial<SegmentProposal> = {},
): SegmentProposal {
  const timeAdvance = overrides.timeAdvance ?? 1;
  const proposal: SegmentProposal = {
    entries: overrides.entries ?? [
      { age: character.age + timeAdvance, kind: 'event', text: '时间流逝。' },
    ],
    timeAdvance,
    attributeDeltas: overrides.attributeDeltas ?? {},
  };
  if (overrides.worldStatusUpdate !== undefined) proposal.worldStatusUpdate = overrides.worldStatusUpdate;
  if (overrides.traitOps) proposal.traitOps = overrides.traitOps;
  if (overrides.inventoryOps) proposal.inventoryOps = overrides.inventoryOps;
  if (overrides.relationshipOps) proposal.relationshipOps = overrides.relationshipOps;
  if (overrides.decision) proposal.decision = overrides.decision;
  if (overrides.endingProposal) proposal.endingProposal = overrides.endingProposal;
  return proposal;
}

/** 依次返回给定随机数，用完后固定返回最后一个。 */
function sequenceRng(values: number[]): () => number {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)] ?? 0;
    index += 1;
    return value;
  };
}

function resolve(
  character: CharacterState,
  overrides: Partial<SegmentProposal> = {},
  options: {
    segmentId?: number;
    lastDecisionSegmentId?: number;
    rng?: () => number;
  } = {},
) {
  return resolveSegment({
    world,
    character,
    worldStatus: '',
    proposal: makeProposal(character, overrides),
    segmentId: options.segmentId ?? 1,
    lastDecisionSegmentId: options.lastDecisionSegmentId ?? 0,
    stopPlan: { stop: false },
    rng: options.rng ?? sequenceRng([0.99]),
  });
}

// ────────────────────────────────────────────────────────────
// 结构校验
// ────────────────────────────────────────────────────────────

describe('parseSegmentProposal', () => {
  const valid = {
    entries: [
      { age: 17, kind: 'cultivation', text: '你闭门不出。' },
      { age: 18, kind: 'event', text: '山下的集市换了管事。' },
    ],
    timeAdvance: 3,
    attributeDeltas: { comprehension: 2 },
  };

  it('接受合法的段落提议', () => {
    const result = parseSegmentProposal(valid);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proposal.entries).toHaveLength(2);
      expect(result.proposal.timeAdvance).toBe(3);
    }
  });

  it('把数字字符串强制为数值', () => {
    const result = parseSegmentProposal({
      ...valid,
      timeAdvance: '5',
      entries: [{ age: '17', kind: 'event', text: '测试' }],
      attributeDeltas: { luck: '3' },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proposal.timeAdvance).toBe(5);
      expect(result.proposal.entries[0]?.age).toBe(17);
      expect(result.proposal.attributeDeltas['luck']).toBe(3);
    }
  });

  it('一条条目都没有时拒绝——段落不能是空的', () => {
    const result = parseSegmentProposal({ ...valid, entries: [] });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join('\n')).toContain('entries');
  });

  it('连续 3 条同类型的条目被判为流水账并拒绝', () => {
    const result = parseSegmentProposal({
      ...valid,
      entries: [
        { age: 17, kind: 'cultivation', text: '你修炼。' },
        { age: 18, kind: 'cultivation', text: '你继续修炼。' },
        { age: 19, kind: 'cultivation', text: '你还在修炼。' },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join('\n')).toContain('流水账');
  });

  it('同类型连续两条是允许的', () => {
    const result = parseSegmentProposal({
      ...valid,
      entries: [
        { age: 17, kind: 'cultivation', text: '你修炼。' },
        { age: 18, kind: 'cultivation', text: '你继续修炼。' },
        { age: 19, kind: 'event', text: '山下传来消息。' },
      ],
    });

    expect(result.ok).toBe(true);
  });

  it('允许没有决策点，也允许决策点缺少 stakes（由规整层兜底）', () => {
    const result = parseSegmentProposal({
      ...valid,
      decision: { prompt: '有人找上门。', options: ['见', '不见'] },
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.proposal.decision?.stakes).toBe('');
  });

  it('决策点只有一个选项时拒绝', () => {
    const result = parseSegmentProposal({
      ...valid,
      decision: { prompt: '有人找上门。', stakes: '', options: ['见'] },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join('\n')).toContain('decision');
  });

  it('忽略未定义的顶层字段', () => {
    const result = parseSegmentProposal({ ...valid, reasoning: '这是模型的额外解释' });
    expect(result.ok).toBe(true);
  });

  it('程序要求必须给决策点却缺失时，判为结构不合格（走回灌重试）', () => {
    const result = parseSegmentProposal(valid, { requireDecision: true });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // 错误信息要点名 decision，模型才知道该补什么
      expect(result.issues.join('\n')).toContain('decision');
    }
  });

  it('程序要求必须给决策点且模型给了时，正常通过', () => {
    const result = parseSegmentProposal(
      { ...valid, decision: { prompt: '岔路。', stakes: '', options: ['甲', '乙'] } },
      { requireDecision: true },
    );

    expect(result.ok).toBe(true);
  });

  it('程序没有要求时，缺决策点不算结构问题', () => {
    expect(parseSegmentProposal(valid).ok).toBe(true);
    expect(parseSegmentProposal(valid, { requireDecision: false }).ok).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────
// 数值规整
// ────────────────────────────────────────────────────────────

describe('normalizeSegment', () => {
  function normalize(overrides: Partial<SegmentProposal> = {}, character = makeCharacter()) {
    return normalizeSegment(makeProposal(character, overrides), world, character);
  }

  it('丢弃未定义的属性键并记警告', () => {
    const { proposal, warnings } = normalize({ attributeDeltas: { mana: 10, reputation: 5 } });

    expect(proposal.attributeDeltas).toEqual({ reputation: 5 });
    expect(warnings.join('\n')).toContain('mana');
  });

  it('忽略模型给出的修为变化——修为由程序结算', () => {
    const { proposal, warnings } = normalize({ attributeDeltas: { cultivation: 40 } });

    expect(proposal.attributeDeltas['cultivation']).toBeUndefined();
    expect(warnings.join('\n')).toContain('修为');
  });

  it('把超出上限的属性变化裁剪到 maxDeltaPerSegment', () => {
    const { proposal, warnings } = normalize({ attributeDeltas: { reputation: 100 } });

    expect(proposal.attributeDeltas['reputation']).toBe(world.mechanics.maxDeltaPerSegment);
    expect(warnings.join('\n')).toContain('超出上限');
  });

  it('把时间跨度限制在上下限之间', () => {
    const low = normalize({ timeAdvance: 1 });
    const high = normalize({ timeAdvance: 999 });

    expect(low.proposal.timeAdvance).toBe(TIME_ADVANCE_MIN);
    expect(high.proposal.timeAdvance).toBe(TIME_ADVANCE_MAX);
    expect(low.warnings.join('\n')).toContain('过短');
    expect(high.warnings.join('\n')).toContain('超出上限');
  });

  it('把条目的年龄校正为单调不减', () => {
    const character = makeCharacter({ age: 20 });
    const { proposal, warnings } = normalize(
      {
        timeAdvance: 10,
        entries: [
          { age: 25, kind: 'event', text: '第一条。' },
          { age: 22, kind: 'event', text: '第二条的时间倒流了。' },
          { age: 28, kind: 'event', text: '第三条。' },
        ],
      },
      character,
    );

    expect(proposal.entries.map((entry) => entry.age)).toEqual([25, 25, 28]);
    expect(warnings.join('\n')).toContain('年龄不单调');
  });

  it('把超出段尾的条目年龄压回段尾', () => {
    const character = makeCharacter({ age: 20 });
    const { proposal } = normalize(
      {
        timeAdvance: 5,
        entries: [
          { age: 22, kind: 'event', text: '第一条。' },
          { age: 99, kind: 'event', text: '这一条跑到段外去了。' },
        ],
      },
      character,
    );

    expect(proposal.entries.map((entry) => entry.age)).toEqual([22, 25]);
  });

  it('条目全部为空时补一条占位条目', () => {
    const { proposal, warnings } = normalize({
      entries: [{ age: 17, kind: 'event', text: '   ' }],
    });

    expect(proposal.entries).toHaveLength(1);
    expect(warnings.join('\n')).toContain('占位条目');
  });

  it('截断超长条目与 detail，并丢弃过短的决策点选项列表', () => {
    const longText = '啊'.repeat(300);
    const { proposal } = normalize({
      entries: [{ age: 17, kind: 'milestone', text: longText, detail: '细'.repeat(900) }],
      decision: { prompt: '岔路。', stakes: '', options: ['唯一选项'] },
    });

    expect(proposal.entries[0]?.text.length).toBe(60);
    expect(proposal.entries[0]?.detail?.length).toBe(400);
    expect(proposal.decision).toBeUndefined();
  });

  it('正常长度的条目不被截断——短句的价值在于读得快，不在于写得少', () => {
    const text = '周砚托人捎来一封信，说家里添了个儿子，取名念山';
    const { proposal, warnings } = normalize({
      entries: [{ age: 17, kind: 'relationship', text }],
    });

    expect(proposal.entries[0]?.text).toBe(text);
    expect(warnings.join('\n')).not.toContain('截断');
  });

  it('阻止模型用一次数值变化把心性直接扣到死亡线', () => {
    const character = makeCharacter({ attributes: { willpower: 10 } });
    const { proposal, warnings } = normalize({ attributeDeltas: { willpower: -60 } }, character);

    const willpowerDelta = proposal.attributeDeltas['willpower'] ?? 0;
    expect(10 + willpowerDelta).toBeGreaterThan(world.mechanics.death.willpowerThreshold);
    expect(warnings.join('\n')).toContain('心性');
  });

  it('给缺失的 stakes 填一句兜底文案', () => {
    const { proposal } = normalize({
      decision: { prompt: '有人找上门。', stakes: '', options: ['见', '不见'] },
    });

    expect(proposal.decision?.stakes).not.toBe('');
  });
});

// ────────────────────────────────────────────────────────────
// 规则结算
// ────────────────────────────────────────────────────────────

describe('resolveSegment', () => {
  it('凡人在寿元耗尽时由程序判定死亡', () => {
    const result = resolve(makeCharacter({ age: 68 }), { timeAdvance: 5 });

    expect(result.character.age).toBe(73);
    expect(result.character.isAlive).toBe(false);
    expect(result.ending?.type).toBe('death');
    expect(result.ending?.reason).toContain('寿元耗尽');
    expect(result.breakdown.endingNote).toContain('寿元上限');
  });

  it('修为圆满且判定通过时境界提升并结转溢出', () => {
    const result = resolve(makeCharacter({ attributes: { cultivation: 95 } }), {
      timeAdvance: 1,
    }, { rng: sequenceRng([0]) });

    // 基础 8 × (1 + 50/200) = 10；95 + 10 = 105
    expect(result.breakdown.breakthroughs).toHaveLength(1);
    expect(result.breakdown.breakthroughs[0]?.success).toBe(true);
    expect(result.character.attributes['realm']).toBe(1);
    expect(result.character.attributes['cultivation']).toBe(5);
  });

  it('突破失败时扣除修为', () => {
    const result = resolve(makeCharacter({ attributes: { cultivation: 95 } }), {
      timeAdvance: 1,
    }, { rng: sequenceRng([0.999]) });

    expect(result.breakdown.breakthroughs[0]?.success).toBe(false);
    expect(result.character.attributes['realm']).toBe(0);
    expect(result.character.attributes['cultivation']).toBe(105 - 30);
  });

  it('一段内可以连续突破多次，但受上限约束', () => {
    // 凡人期每年 10 点：60 年积累 600，够跨 6 个阶位，因此会撞到上限
    const result = resolve(makeCharacter(), { timeAdvance: 60 }, { rng: sequenceRng([0]) });

    expect(result.breakdown.breakthroughs).toHaveLength(MAX_BREAKTHROUGHS_PER_SEGMENT);
    expect(result.character.attributes['realm']).toBe(MAX_BREAKTHROUGHS_PER_SEGMENT);
    expect(result.warnings.join('\n')).toContain('突破次数达到上限');
  });

  it('条目是权威时间轴：寿元耗尽时截断到那一条', () => {
    const character = makeCharacter({ age: 68 });
    const entries: LifeEntry[] = [
      { age: 70, kind: 'event', text: '你还活着。' },
      { age: 72, kind: 'event', text: '这一条已经来不及发生。' },
      { age: 78, kind: 'event', text: '这一条更来不及。' },
    ];

    const result = resolve(character, { timeAdvance: 10, entries });

    expect(result.segment.entries.map((entry) => entry.age)).toEqual([70]);
    // 实际只推进了 2 年，而不是提议的 10 年
    expect(result.breakdown.timeAdvance).toBe(2);
    expect(result.character.age).toBe(70);
    expect(result.breakdown.endingCause).toBe('lifespan');
  });

  it('闭关越久修为积累越多——时间跨度线性放大修为收益', () => {
    const short = resolve(makeCharacter(), { timeAdvance: 1 });
    const long = resolve(makeCharacter(), { timeAdvance: 8 });

    // 每年 8 × (1 + 50/200) = 10；8 年得 80，两者都未触及突破线
    expect(short.character.attributes['cultivation']).toBe(10);
    expect(long.character.attributes['cultivation']).toBe(80);
  });

  it('心性归零时判定心魔噬身', () => {
    const result = resolve(makeCharacter({ attributes: { willpower: 0 } }));

    expect(result.ending?.type).toBe('death');
    expect(result.ending?.reason).toContain('心魔');
  });

  it('模型提议死亡但本段无致命情节时不予采纳，改为重伤', () => {
    const result = resolve(makeCharacter({ attributes: { willpower: 60 } }), {
      entries: [{ age: 17, kind: 'event', text: '与故人闲谈' }],
      endingProposal: { type: 'death', reason: '被仇家所杀' },
    });

    expect(result.ending).toBeUndefined();
    expect(result.character.attributes['willpower']).toBe(48);
    expect(result.warnings.join('\n')).toContain('未出现致命情节');
  });

  it('模型提议死亡、本段有致命情节且气运判定未通过时采纳', () => {
    const result = resolve(makeCharacter({ attributes: { luck: 0 } }), {
      entries: [{ age: 17, kind: 'setback', text: '你被一剑贯胸，重伤倒地' }],
      endingProposal: { type: 'death', reason: '为仇家所杀' },
    });

    expect(result.ending?.type).toBe('death');
    expect(result.ending?.reason).toBe('为仇家所杀');
    expect(result.character.isAlive).toBe(false);
  });

  it('气运判定通过时即使有致命情节也改为重伤', () => {
    const result = resolve(makeCharacter({ attributes: { luck: 100, willpower: 60 } }), {
      entries: [{ age: 17, kind: 'setback', text: '你被一剑贯胸，重伤倒地' }],
      endingProposal: { type: 'death', reason: '为仇家所杀' },
    });

    expect(result.ending).toBeUndefined();
    expect(result.warnings.join('\n')).toContain('气运判定通过');
  });

  it('境界不足时忽略模型提出的圆满结局', () => {
    const result = resolve(makeCharacter(), {
      endingProposal: { type: 'completion', reason: '你心满意足地过完了一生' },
    });

    expect(result.ending).toBeUndefined();
    expect(result.warnings.join('\n')).toContain('未达到');
  });

  it('渡劫期修为圆满且判定通过时羽化飞升', () => {
    const result = resolve(
      makeCharacter({ age: 900, attributes: { realm: 9, cultivation: 99 } }),
      { timeAdvance: 20 },
      { rng: sequenceRng([0]) },
    );

    expect(result.breakdown.breakthroughs).toHaveLength(1);
    expect(result.ending?.type).toBe('completion');
    expect(result.ending?.reason).toContain('飞升');
    expect(result.character.attributes['realm']).toBe(9);
  });

  it('寿元将尽之际突破成功可以续命——突破判定先于死亡判定', () => {
    const result = resolve(
      makeCharacter({ age: 68, attributes: { cultivation: 95 } }),
      { timeAdvance: 5 },
      { rng: sequenceRng([0]) },
    );

    expect(result.character.attributes['realm']).toBe(1);
    expect(result.ending).toBeUndefined();
    expect(result.character.age).toBe(73);
  });

  it('应用特质、物品与关系操作', () => {
    const result = resolve(makeCharacter(), {
      traitOps: [{ op: 'add', value: '剑心通明' }],
      inventoryOps: [{ op: 'add', value: '青锋剑' }],
      relationshipOps: [{ op: 'set', target: '师父', value: '亦师亦友' }],
    });

    expect(result.character.traits).toContain('剑心通明');
    expect(result.character.inventory).toContain('青锋剑');
    expect(result.character.relationships['师父']).toBe('亦师亦友');
  });

  it('世界局势只在模型给出更新时改变', () => {
    const kept = resolve(makeCharacter(), { worldStatusUpdate: undefined });
    const updated = resolve(makeCharacter(), { worldStatusUpdate: '魔道压境' });

    expect(kept.worldStatus).toBe('');
    expect(updated.worldStatus).toBe('魔道压境');
  });

  it('天赋修正器影响修为增速', () => {
    const plain = resolve(makeCharacter(), { timeAdvance: 5 });
    const talented = resolve(makeCharacter({ talentId: 'late-bloomer' }), { timeAdvance: 5 });

    // 大器晚成：修为增速 ×1.3（其「根骨 −10」是创角时的一次性加成，由创角流程负责，
    // 不在结算层重复施加，所以这里根骨仍是 50）
    expect(plain.character.attributes['cultivation']).toBe(50);
    expect(talented.character.attributes['cultivation']).toBe(65);
  });

  it('达到段落数软上限时强制收束', () => {
    const result = resolve(makeCharacter(), {}, {
      segmentId: world.mechanics.segmentSoftLimit,
    });

    expect(result.ending?.type).toBe('completion');
    expect(result.breakdown.endingNote).toContain('软上限');
  });

  it('记录属性变化的明细供界面展示', () => {
    const result = resolve(makeCharacter(), {
      attributeDeltas: { reputation: 8, spiritStones: 12 },
    });

    const labels = result.breakdown.attributeChanges.map((change) => change.label);
    expect(labels).toContain('声望');
    expect(labels).toContain('灵石');
    expect(labels).toContain('修为');
  });
});

// ────────────────────────────────────────────────────────────
// 决策点与结算的衔接
// ────────────────────────────────────────────────────────────

describe('决策点落账', () => {
  const decision = {
    prompt: '一位自称来自上宗的人找上门。',
    stakes: '无论怎么选，你都不会再回到从前的日子。',
    options: ['跟他走', '婉拒'],
  };

  it('突破发生的段落会把决策点采纳为 breakthrough 成因', () => {
    const result = resolve(
      makeCharacter({ attributes: { cultivation: 95 } }),
      { timeAdvance: 1, decision },
      { segmentId: 4, lastDecisionSegmentId: 0, rng: sequenceRng([0]) },
    );

    expect(result.segment.decision?.cause).toBe('breakthrough');
    expect(result.breakdown.decisionCause).toBe('breakthrough');
  });

  it('程序判定必须停车时采纳为强制成因', () => {
    const result = resolveSegment({
      world,
      character: makeCharacter(),
      worldStatus: '',
      proposal: makeProposal(makeCharacter(), { timeAdvance: 1, decision }),
      segmentId: 9,
      lastDecisionSegmentId: 1,
      stopPlan: { stop: true, cause: 'long-gap' },
      rng: sequenceRng([0.99]),
    });

    expect(result.segment.decision?.cause).toBe('long-gap');
  });

  it('距上次决策不足 2 段时丢弃决策点', () => {
    const result = resolveSegment({
      world,
      character: makeCharacter(),
      worldStatus: '',
      proposal: makeProposal(makeCharacter(), { timeAdvance: 1, decision }),
      segmentId: 6,
      lastDecisionSegmentId: 5,
      stopPlan: { stop: false },
      rng: sequenceRng([0]),
    });

    expect(result.segment.decision).toBeUndefined();
    expect(result.warnings.join('\n')).toContain('硬密度下限');
  });

  it('故事已经结束时不再留下岔路', () => {
    const result = resolveSegment({
      world,
      character: makeCharacter({ age: 68 }),
      worldStatus: '',
      proposal: makeProposal(makeCharacter({ age: 68 }), { timeAdvance: 5, decision }),
      segmentId: 4,
      lastDecisionSegmentId: 0,
      stopPlan: { stop: false },
      rng: sequenceRng([0]),
    });

    expect(result.ending).toBeDefined();
    expect(result.segment.decision).toBeUndefined();
  });
});
