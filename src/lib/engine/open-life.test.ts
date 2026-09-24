import { describe, expect, it } from 'vitest';
import { buildSaveRecord } from '@/lib/services/gameService';
import { parseExport, serializeExport } from '@/lib/storage/migrate';
import { fushengJi } from '@/lib/worlds/fusheng-ji';
import { ashenThrone } from '@/lib/worlds/ashen-throne';
import { starArk } from '@/lib/worlds/star-ark';
import { buildSegmentUserMessage, buildSystemPrompt } from './context';
import { normalizeSegment } from './normalize';
import { planStop } from './decision';
import { resolveSegment } from './resolve';
import { parseSegmentProposal } from './schema';
import type { CharacterState, SegmentProposal, WorldSetting } from './types';

function character(age = 18): CharacterState {
  return {
    name: '阿遥',
    age,
    isAlive: true,
    attributes: Object.fromEntries(fushengJi.attributes.map((attribute) => [attribute.key, attribute.initialValue])),
    traits: [],
    inventory: [],
    relationships: {},
  };
}

function proposal(age: number, deltas: Record<string, number> = {}): SegmentProposal {
  return {
    entries: [
      { age: age + 1, kind: 'event', text: '她接下一份新工作，开始学习陌生的业务。' },
      { age: age + 2, kind: 'relationship', text: '她和朋友一起搬家，彼此照应。' },
      { age: age + 3, kind: 'milestone', text: '她决定调整此后的人生方向。' },
    ],
    timeAdvance: 3,
    attributeDeltas: deltas,
  };
}

describe('开放人生规则', () => {
  it('殖民地阶段在世界状态里结算，不改变人物年龄上限', () => {
    const save = buildSaveRecord({ world: starArk, name: '林澈', now: 1, id: 'star-new', rng: () => 0.5 });
    expect(save.character.attributes.stage).toBeUndefined();
    expect(save.worldAttributes?.stage).toBe(0);
    const beforeWorld = { ...save.worldAttributes, progress: 90 };
    const raw = proposal(20, { work: 3, health: -1 });
    raw.entries[2]!.text = '新的生态仓完成验收，殖民地开始修建第二座农场。';
    raw.worldDeltas = { progress: 20, stage: 7, tech: 2 };
    const parsed = parseSegmentProposal(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const normalized = normalizeSegment(parsed.proposal, starArk, save.character);
    expect(normalized.proposal.worldDeltas).toEqual({ progress: 20, tech: 2 });
    const result = resolveSegment({
      world: starArk, character: save.character, worldStatus: '', worldAttributes: beforeWorld,
      proposal: normalized.proposal, segmentId: 1, lastDecisionSegmentId: 0, stopPlan: { stop: false },
    });
    expect(result.worldAttributes?.stage).toBe(1);
    expect(result.worldAttributes?.progress).toBe(10);
    expect(result.character.attributes.stage).toBeUndefined();
    expect(result.character.age).toBe(23);
    expect(result.segment.entries.some((entry) => entry.text.includes('立足'))).toBe(true);
    expect(result.segment.entries[0]?.settledWorldAttributes?.stage).toBe(0);
    expect(result.breakdown.breakthroughs).toEqual([]);
    for (const stage of [0, 7]) {
      const oldCharacter = { ...save.character, age: 108, attributes: { ...save.character.attributes, health: 80 } };
      const nearEnd = resolveSegment({
        world: starArk, character: oldCharacter, worldStatus: '',
        worldAttributes: { ...save.worldAttributes, stage },
        proposal: proposal(108), segmentId: 30, lastDecisionSegmentId: 24,
        stopPlan: { stop: false },
      });
      expect(nearEnd.character.age).toBe(110);
      expect(nearEnd.breakdown.endingCause).toBe('old-age');
    }
    const exported = parseExport(serializeExport(save, []));
    expect(exported.ok).toBe(true);
    if (exported.ok) expect(exported.value.save.worldAttributes?.stage).toBe(0);
    const progressedSave = {
      ...save, revision: 1, latestSegmentId: 1, character: result.character,
      worldAttributes: result.worldAttributes,
    };
    const roundtrip = parseExport(serializeExport(progressedSave, [{
      saveId: save.id, segmentId: 1, requestId: 'star-segment-1',
      segment: { ...result.segment, decision: {
        prompt: '是否继续建设', stakes: '未来几年会受到影响', options: ['继续', '暂停'], cause: 'life-turn',
      } }, characterBefore: save.character,
      worldAttributesBefore: beforeWorld, resolvedCharacter: result.character,
      resolvedWorldStatus: result.worldStatus, resolvedWorldAttributes: result.worldAttributes,
      validationWarnings: result.warnings, modelMeta: { provider: 'test', model: 'mock', latencyMs: 0 },
      schemaVersion: save.schemaVersion, createdAt: 2,
    }]));
    expect(roundtrip.ok).toBe(true);
    if (roundtrip.ok) {
      expect(roundtrip.value.save.worldAttributes?.stage).toBe(1);
      expect(roundtrip.value.segments[0]?.segment.worldDeltas?.progress).toBe(20);
      expect(roundtrip.value.segments[0]?.resolvedWorldAttributes?.stage).toBe(1);
      expect(roundtrip.value.segments[0]?.segment.decision?.cause).toBe('life-turn');
    }
  });

  it('公会评级只在委托完成后变化，单段最多一级', () => {
    const save = buildSaveRecord({ world: ashenThrone, name: '阿灰', now: 1, id: 'ash-new', rng: () => 0.5 });
    const noEvidence = proposal(16, { rank: 2, exploits: 5 });
    const ignored = resolveSegment({
      world: ashenThrone, character: save.character, worldStatus: '', proposal: noEvidence,
      segmentId: 1, lastDecisionSegmentId: 0, stopPlan: { stop: false },
    });
    expect(ignored.character.attributes.rank).toBe(0);
    expect(ignored.segment.attributeDeltas.rank).toBeUndefined();
    const earned = proposal(16, { rank: 2, exploits: 5 });
    earned.entries[2]!.text = '委托完成后，公会核对证词并准备评定你。';
    const result = resolveSegment({
      world: ashenThrone, character: save.character, worldStatus: '', proposal: earned,
      segmentId: 1, lastDecisionSegmentId: 0, stopPlan: { stop: false },
    });
    expect(result.character.attributes.rank).toBe(1);
    expect(result.segment.entries.at(-1)?.text).toContain('铜牌');
    expect(result.character.age).toBe(19);
    expect(result.breakdown.breakthroughs).toEqual([]);
  });
  it('事业变化来自事件提议，不触发阶层突破或阶层续命', () => {
    const before = character();
    const normalized = normalizeSegment(proposal(18, { career: 9, stratum: 4, health: -2 }), fushengJi, before);
    expect(normalized.proposal.attributeDeltas).toEqual({ career: 9, health: -2 });

    const result = resolveSegment({
      world: fushengJi,
      character: before,
      worldStatus: '',
      proposal: normalized.proposal,
      segmentId: 1,
      lastDecisionSegmentId: 0,
      stopPlan: { stop: false },
      rng: () => 0,
    });

    expect(result.character.attributes.career).toBe(9);
    expect(result.character.attributes.stratum).toBe(0);
    expect(result.breakdown.breakthroughs).toEqual([]);
    expect(result.segment.entries.map((entry) => entry.settledAttributes?.career)).toEqual([3, 6, 9]);
    expect(result.ending).toBeUndefined();
  });

  it('健康与年龄决定死亡，未来条目不会被写成已经发生', () => {
    const before = character(45);
    before.attributes.health = 1;
    const result = resolveSegment({
      world: fushengJi,
      character: before,
      worldStatus: '',
      proposal: proposal(45),
      segmentId: 1,
      lastDecisionSegmentId: 0,
      stopPlan: { stop: false },
    });
    expect(result.character.age).toBe(46);
    expect(result.breakdown.endingCause).toBe('health');
    expect(result.segment.entries).toHaveLength(1);
    expect(result.segment.entries[0]?.text).toBe('健康耗尽');
  });

  it('完整人生在健康耗尽时收束，全程没有自动晋阶', () => {
    let current = character();
    let ended = false;
    for (let segmentId = 1; segmentId <= 40 && !ended; segmentId += 1) {
      const stopPlan = planStop({
        world: fushengJi,
        character: current,
        segmentId,
        lastDecisionSegmentId: 0,
      });
      const normalized = normalizeSegment(proposal(current.age, { career: 3 }), fushengJi, current);
      const result = resolveSegment({
        world: fushengJi,
        character: current,
        worldStatus: '',
        proposal: normalized.proposal,
        segmentId,
        lastDecisionSegmentId: 0,
        stopPlan,
      });
      current = result.character;
      expect(current.attributes.stratum).toBe(0);
      expect(result.breakdown.breakthroughs).toEqual([]);
      ended = result.ending !== undefined;
      if (ended) expect(result.breakdown.endingCause).toMatch(/health|old-age/);
    }
    expect(ended).toBe(true);
    expect(current.age).toBeGreaterThan(70);
    expect(current.age).toBeLessThanOrEqual(105);
  });

  it('旧世界快照仍按原阶位规则结算', () => {
    const legacy: WorldSetting = { ...fushengJi };
    delete legacy.ruleset;
    const normalized = normalizeSegment(proposal(18, { career: 9, stratum: 4 }), legacy, character());
    expect(normalized.proposal.attributeDeltas).toEqual({});
    const result = resolveSegment({
      world: legacy,
      character: character(),
      worldStatus: '',
      proposal: normalized.proposal,
      segmentId: 1,
      lastDecisionSegmentId: 0,
      stopPlan: { stop: false },
      rng: () => 0.5,
    });
    expect(result.character.attributes.career).toBeGreaterThan(0);
  });

  it('人生收束有年龄和事件门槛，完成结局不误写成死亡', () => {
    const early = proposal(18);
    early.endingProposal = { type: 'completion', reason: '决定退休' };
    const earlyResult = resolveSegment({
      world: fushengJi,
      character: character(),
      worldStatus: '',
      proposal: early,
      segmentId: 1,
      lastDecisionSegmentId: 0,
      stopPlan: { stop: false },
    });
    expect(earlyResult.ending).toBeUndefined();

    const mature = proposal(55);
    mature.endingProposal = { type: 'completion', reason: '决定退休' };
    const result = resolveSegment({
      world: fushengJi,
      character: character(55),
      worldStatus: '',
      proposal: mature,
      segmentId: 13,
      lastDecisionSegmentId: 0,
      stopPlan: { stop: false },
    });
    expect(result.ending?.type).toBe('completion');
    expect(result.ending?.narrative).not.toContain('享年');
    expect(result.character.isAlive).toBe(true);
  });

  it('新规则随存档导出导入，旧规则版本与对象版本分开', () => {
    const save = buildSaveRecord({ world: fushengJi, name: '阿遥', now: 1, id: 'open-life-test' });
    expect(save.rulesetVersion).toBe(2);
    expect(save.character.attributes.stratum).toBeUndefined();
    const imported = parseExport(serializeExport(save, []));
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value.save.world.ruleset?.kind).toBe('open_life');
    expect(imported.value.save.rulesetVersion).toBe(2);
    expect(imported.value.save.schemaVersion).toBe(save.schemaVersion);

    const legacyWorld: WorldSetting = { ...fushengJi };
    delete legacyWorld.ruleset;
    const legacySave = buildSaveRecord({ world: legacyWorld, name: '旧档', now: 1, id: 'legacy-test' });
    delete legacySave.rulesetVersion;
    const legacyImport = parseExport(serializeExport(legacySave, []));
    expect(legacyImport.ok).toBe(true);
    if (legacyImport.ok) {
      expect(legacyImport.value.save.world.ruleset).toBeUndefined();
      expect(legacyImport.value.save.rulesetVersion).toBeUndefined();
    }
  });

  it('新世界提示词没有阶位寿命口径', () => {
    const system = buildSystemPrompt(fushengJi);
    const user = buildSegmentUserMessage({
      world: fushengJi,
      character: character(),
      worldStatus: fushengJi.initialWorldStatus,
      historySummary: '',
      recentSegments: [],
    });
    expect(system).not.toContain('寿元上限');
    expect(user).not.toContain('当前阶位');
    expect(user).toContain('"career"（事业）');
    expect(user).toContain('"health"（体魄）');
  });
});
