import { describe, expect, it } from 'vitest';
import type { LifeSegmentRecord, SaveRecord } from '@/lib/engine/types';
import { EXPORT_FORMAT_VERSION, SCHEMA_VERSION } from '@/lib/engine/types';
import { qingmingXiantu as world } from '@/lib/worlds/qingming-xiantu';
import {
  buildExport,
  convertLegacyTurnEvent,
  migrateSaveRecord,
  parseExport,
  remapSaveId,
  serializeExport,
  stripTrailingDecision,
  upgradeSaveV1ToV2,
} from './migrate';

const CHARACTER = {
  name: '林砚',
  age: 42,
  isAlive: true,
  attributes: { realm: 1, cultivation: 30, aptitude: 62, comprehension: 55 },
  traits: ['剑心通明'],
  inventory: ['青锋剑'],
  relationships: { 师父: '亦师亦友' },
  talentId: 'sword-bone',
};

function makeSave(): SaveRecord {
  return {
    id: 'save-1',
    schemaVersion: SCHEMA_VERSION,
    revision: 3,
    world,
    worldStatus: '青冥山一带灵气渐薄',
    character: CHARACTER,
    historySummary: '你拜入青冥山，习剑十年。',
    summarizedThroughSegmentId: 10,
    latestSegmentId: 12,
    lastDecisionSegmentId: 11,
    status: 'active',
    stats: { totalSegments: 12, startedAt: 1_000 },
    createdAt: 1_000,
    updatedAt: 5_000,
  };
}

function makeRecord(segmentId: number): LifeSegmentRecord {
  return {
    saveId: 'save-1',
    segmentId,
    requestId: `req-${segmentId}`,
    playerAction: '闭关修炼',
    segment: {
      entries: [{ age: 40 + segmentId, kind: 'cultivation', text: '你在洞中静坐。' }],
      timeAdvance: 3,
      attributeDeltas: { comprehension: 1 },
      decision: {
        prompt: '一个岔路。',
        stakes: '这一步会改变很多年。',
        options: ['继续闭关', '出关'],
        cause: 'proposed',
      },
    },
    resolvedCharacter: CHARACTER,
    characterBefore: CHARACTER,
    resolvedWorldStatus: '',
    validationWarnings: ['忽略了未定义的属性键「mana」'],
    modelMeta: { provider: 'DeepSeek', model: 'deepseek-chat', latencyMs: 1200, retries: 1 },
    schemaVersion: SCHEMA_VERSION,
    createdAt: 2_000 + segmentId,
  };
}

/** 重构前的存档形状：字段全是 turn 语义。 */
function makeLegacySave() {
  return {
    id: 'save-1',
    schemaVersion: 1,
    revision: 3,
    world,
    worldStatus: '青冥山一带灵气渐薄',
    character: CHARACTER,
    historySummary: '你拜入青冥山，习剑十年。',
    summarizedThroughTurnId: 10,
    latestTurnId: 12,
    status: 'active',
    stats: { totalTurns: 12, startedAt: 1_000 },
    createdAt: 1_000,
    updatedAt: 5_000,
  };
}

/** 重构前的事件形状：一整个回合就是一段长散文。 */
function makeLegacyEvent(turnId: number) {
  return {
    saveId: 'save-1',
    turnId,
    requestId: `req-${turnId}`,
    playerAction: '闭关修炼',
    proposal: {
      narrative: '你在洞中静坐一年，山风穿堂而过。年末时你忽然有所悟，气息顺畅了许多。',
      timeAdvance: 1,
      attributeDeltas: { comprehension: 1 },
      options: ['继续闭关', '出关'],
    },
    resolvedCharacter: CHARACTER,
    characterBefore: CHARACTER,
    resolvedWorldStatus: '',
    validationWarnings: ['忽略了未定义的属性键「mana」'],
    modelMeta: { provider: 'DeepSeek', model: 'deepseek-chat', latencyMs: 1200, retries: 1 },
    schemaVersion: 1,
    createdAt: 2_000 + turnId,
  };
}

describe('导出与导入', () => {
  it('导出再导入后内容一致', () => {
    const save = makeSave();
    const segments = [makeRecord(1), makeRecord(2)];

    const text = serializeExport(save, segments);
    const parsed = parseExport(text);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.formatVersion).toBe(EXPORT_FORMAT_VERSION);
      expect(parsed.value.save.id).toBe('save-1');
      expect(parsed.value.save.historySummary).toBe('你拜入青冥山，习剑十年。');
      expect(parsed.value.save.lastDecisionSegmentId).toBe(11);
      expect(parsed.value.segments).toHaveLength(2);
      expect(parsed.value.segments[0]?.validationWarnings).toHaveLength(1);
      expect(parsed.value.segments[0]?.modelMeta.retries).toBe(1);
    }
  });

  it('导出时段落按 segmentId 升序排列', () => {
    const data = buildExport(makeSave(), [makeRecord(3), makeRecord(1), makeRecord(2)]);
    expect(data.segments.map((record) => record.segmentId)).toEqual([1, 2, 3]);
  });

  it('拒绝非 JSON 文件', () => {
    const result = parseExport('这不是 JSON');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('JSON');
  });

  it('拒绝来自更新版本的导出文件', () => {
    const text = JSON.stringify({
      formatVersion: EXPORT_FORMAT_VERSION + 1,
      save: makeSave(),
      segments: [],
    });
    const result = parseExport(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('更新的版本');
  });

  it('缺少段落历史时给出明确原因', () => {
    const text = JSON.stringify({ formatVersion: EXPORT_FORMAT_VERSION, save: makeSave() });
    const result = parseExport(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('段落历史');
  });

  it('存档结构不完整时指出具体字段', () => {
    const broken = { ...makeSave(), character: undefined };
    const text = JSON.stringify({ formatVersion: EXPORT_FORMAT_VERSION, save: broken, segments: [] });
    const result = parseExport(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('character');
  });

  it('段落结构不完整时给出明确原因', () => {
    const text = JSON.stringify({
      formatVersion: EXPORT_FORMAT_VERSION,
      save: makeSave(),
      segments: [{ segmentId: 1 }],
    });
    const result = parseExport(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('段落历史结构不完整');
  });
});

describe('存档迁移', () => {
  it('当前版本的存档直接通过校验', () => {
    const result = migrateSaveRecord(makeSave());
    expect(result.ok).toBe(true);
  });

  it('缺少 schemaVersion 时按 v1 处理', () => {
    const { schemaVersion: _ignored, ...rest } = makeSave();
    const result = migrateSaveRecord(rest);
    expect(result.ok).toBe(true);
  });

  it('v1 存档的 turn 语义字段被改名，并补上决策水位', () => {
    const upgraded = upgradeSaveV1ToV2(makeLegacySave());

    expect(upgraded['latestSegmentId']).toBe(12);
    expect(upgraded['summarizedThroughSegmentId']).toBe(10);
    expect(upgraded['lastDecisionSegmentId']).toBe(0);
    expect(upgraded['latestTurnId']).toBeUndefined();
    expect(upgraded['summarizedThroughTurnId']).toBeUndefined();
    expect((upgraded['stats'] as Record<string, unknown>)['totalSegments']).toBe(12);
    expect(upgraded['schemaVersion']).toBe(2);
  });

  it('v1 存档能走完升级链并通过校验', () => {
    const result = migrateSaveRecord(makeLegacySave());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.latestSegmentId).toBe(12);
      expect(result.value.stats.totalSegments).toBe(12);
      expect(result.value.lastDecisionSegmentId).toBe(0);
    }
  });

  it('v1 存档的结局时间戳一并改名', () => {
    const legacy = {
      ...makeLegacySave(),
      status: 'ended',
      ending: { type: 'death', reason: '寿元耗尽', narrative: '坐化。', atTurnId: 12 },
    };

    const result = migrateSaveRecord(legacy);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.ending?.atSegmentId).toBe(12);
  });

  it('拒绝比当前应用更新的存档版本', () => {
    const result = migrateSaveRecord({ ...makeSave(), schemaVersion: SCHEMA_VERSION + 5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('更新的版本');
  });

  it('非对象输入被拒绝', () => {
    expect(migrateSaveRecord(null).ok).toBe(false);
    expect(migrateSaveRecord([]).ok).toBe(false);
    expect(migrateSaveRecord('x').ok).toBe(false);
  });
});

describe('旧回合转段落', () => {
  it('长叙事被压成「一条 milestone 条目 + 完整 detail」，并打上旧版标记', () => {
    const record = convertLegacyTurnEvent(makeLegacyEvent(3));

    expect(record).toBeDefined();
    if (!record) return;

    expect(record.segmentId).toBe(3);
    expect(record.segment.legacy).toBe(true);
    expect(record.segment.entries).toHaveLength(1);

    const entry = record.segment.entries[0];
    expect(entry?.kind).toBe('milestone');
    // 条目正文取首句，detail 保留完整叙事
    expect(entry?.text).toBe('你在洞中静坐一年，山风穿堂而过');
    expect(entry?.detail).toContain('年末时你忽然有所悟');
    expect(entry?.age).toBe(CHARACTER.age);
  });

  it('旧回合末尾的选项转成一个决策点，旧存档可以接着玩', () => {
    const record = convertLegacyTurnEvent(makeLegacyEvent(1));

    expect(record?.segment.decision?.options).toEqual(['继续闭关', '出关']);
    expect(record?.segment.decision?.cause).toBe('proposed');
  });

  it('选项不足两个时不产生决策点', () => {
    const legacy = makeLegacyEvent(1);
    legacy.proposal.options = ['继续闭关'];
    expect(convertLegacyTurnEvent(legacy)?.segment.decision).toBeUndefined();
  });

  it('结构不符的旧记录返回 undefined，而不是抛错', () => {
    expect(convertLegacyTurnEvent({ turnId: 1 })).toBeUndefined();
    expect(convertLegacyTurnEvent(null)).toBeUndefined();
  });

  it('旧结局的时间戳被改名', () => {
    const legacy = { ...makeLegacyEvent(5), ending: { type: 'death', reason: '坐化', narrative: '…', atTurnId: 5 } };
    expect(convertLegacyTurnEvent(legacy)?.ending?.atSegmentId).toBe(5);
  });
});

describe('v1 导出文件的兼容导入', () => {
  it('整包导入后段落与存档都被升级', () => {
    const text = JSON.stringify({
      formatVersion: 1,
      save: makeLegacySave(),
      events: [makeLegacyEvent(1), makeLegacyEvent(2)],
    });

    const result = parseExport(text);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.formatVersion).toBe(EXPORT_FORMAT_VERSION);
    expect(result.value.save.latestSegmentId).toBe(12);
    expect(result.value.segments).toHaveLength(2);
    expect(result.value.segments.every((record) => record.segment.legacy === true)).toBe(true);
    // 最后一段仍然留着当时摆给玩家的两个选项
    expect(result.value.segments.at(-1)?.segment.decision?.options).toHaveLength(2);
  });

  it('已结束的旧存档不会留下一个无法继续的岔路', () => {
    const text = JSON.stringify({
      formatVersion: 1,
      save: { ...makeLegacySave(), status: 'ended' },
      events: [makeLegacyEvent(1), makeLegacyEvent(2)],
    });

    const result = parseExport(text);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.segments.at(-1)?.segment.decision).toBeUndefined();
    // 中间那一段的岔路保留——它本来就是历史的一部分
    expect(result.value.segments[0]?.segment.decision).toBeDefined();
  });

  it('旧回合结构不完整时给出可读错误', () => {
    const text = JSON.stringify({
      formatVersion: 1,
      save: makeLegacySave(),
      events: [{ turnId: 1 }],
    });

    const result = parseExport(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('旧版回合历史');
  });
});

describe('stripTrailingDecision', () => {
  it('存档仍在进行时原样返回', () => {
    const records = [makeRecord(1)];
    expect(stripTrailingDecision(records, 'active')).toBe(records);
  });

  it('存档已结束时摘掉最后一段的决策点', () => {
    const records = [makeRecord(1), makeRecord(2)];
    const stripped = stripTrailingDecision(records, 'ended');

    expect(stripped).toHaveLength(2);
    expect(stripped[1]?.segment.decision).toBeUndefined();
    expect(stripped[0]?.segment.decision).toBeDefined();
  });
});

describe('导入时换 id', () => {
  it('存档与段落的历史归属一起改写，避免覆盖已有存档', () => {
    const data = buildExport(makeSave(), [makeRecord(1), makeRecord(2)]);
    const remapped = remapSaveId(data, 'save-copy');

    expect(remapped.save.id).toBe('save-copy');
    expect(remapped.segments.every((record) => record.saveId === 'save-copy')).toBe(true);
    expect(remapped.segments).toHaveLength(2);
  });
});
