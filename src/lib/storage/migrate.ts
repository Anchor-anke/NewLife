import { gameSaveExportSchema, legacyTurnEventSchema } from '@/lib/engine/schema';
import {
  EXPORT_FORMAT_VERSION,
  SCHEMA_VERSION,
  type GameSaveExport,
  type LifeEntry,
  type LifeSegment,
  type LifeSegmentRecord,
  type PendingSegment,
  type SaveRecord,
} from '@/lib/engine/types';

/**
 * 存档迁移与导入导出。
 *
 * 这里刻意区分两层职责，不要把两者混在一起：
 *
 * - **表结构**由 Dexie 的 `db.version(n).stores().upgrade()` 负责（见 `db.ts`）。
 * - **对象形状**由本模块的纯函数负责，是一条升级链，用于导出文件导入、
 *   跨版本读取，以及 Dexie 升级时把旧表内容搬进新表。
 *
 * 纯函数的好处是可以对每个历史版本写单测，而不必真的去开一个旧版数据库。
 * 因此 `db.ts` 里的 upgrade 也复用这里的函数，而不是自己再写一遍转换逻辑。
 *
 * v1 → v2 的核心变化是**叙事单位**：一个「回合」变成「一条 milestone 条目 +
 * 完整 detail 的段落」。这样旧存档在年表上仍然读得通，而不是变成废纸。
 */

type RawRecord = Record<string, unknown>;

function isRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readVersion(raw: RawRecord): number {
  const version = raw['schemaVersion'];
  return typeof version === 'number' && Number.isInteger(version) ? version : 1;
}

// ────────────────────────────────────────────────────────────
// 存档对象：v1 → v2
// ────────────────────────────────────────────────────────────

/**
 * v1 → v2 的字段改名。
 *
 * 只是改名与补默认值，不做校验——校验交给升级链末尾的 zod。
 * 刻意写成「不抛错」的形式：Dexie 升级过程中一条脏记录不应该让整个数据库打不开。
 */
export function upgradeSaveV1ToV2(raw: RawRecord): RawRecord {
  const next: RawRecord = { ...raw };

  next['summarizedThroughSegmentId'] = raw['summarizedThroughTurnId'] ?? 0;
  next['latestSegmentId'] = raw['latestTurnId'] ?? 0;
  delete next['summarizedThroughTurnId'];
  delete next['latestTurnId'];

  // 决策密度的状态是 v2 新增的。旧存档一律从 0 起算，也就是「还没停过车」。
  next['lastDecisionSegmentId'] = raw['lastDecisionSegmentId'] ?? 0;

  const stats = raw['stats'];
  if (isRecord(stats)) {
    const upgraded: RawRecord = {
      totalSegments: stats['totalSegments'] ?? stats['totalTurns'] ?? 0,
      startedAt: stats['startedAt'],
    };
    if (stats['endedAt'] !== undefined) upgraded['endedAt'] = stats['endedAt'];
    next['stats'] = upgraded;
  }

  const ending = raw['ending'];
  if (isRecord(ending)) {
    const upgradedEnding: RawRecord = { ...ending };
    upgradedEnding['atSegmentId'] = ending['atSegmentId'] ?? ending['atTurnId'] ?? 0;
    delete upgradedEnding['atTurnId'];
    next['ending'] = upgradedEnding;
  }

  next['schemaVersion'] = 2;
  return next;
}

/** 从 schemaVersion n 升到 n+1 的升级函数。新增版本时在此追加。 */
const SAVE_MIGRATIONS: Record<number, (save: RawRecord) => RawRecord> = {
  1: upgradeSaveV1ToV2,
};

/**
 * 把任意来源的存档对象升级到当前版本并校验。
 *
 * 失败时给出可读的中文原因，而不是抛异常——导入存档是玩家可见的操作，
 * 报错信息要能直接展示在界面上。
 */
export function migrateSaveRecord(raw: unknown): MigrateResult<SaveRecord> {
  if (!isRecord(raw)) {
    return { ok: false, error: '存档内容不是一个对象' };
  }

  let version = readVersion(raw);
  if (version > SCHEMA_VERSION) {
    return {
      ok: false,
      error: `存档来自更新的版本（v${version}），当前应用只支持到 v${SCHEMA_VERSION}，请升级后再导入`,
    };
  }

  // 缺失或非法的 schemaVersion 会被 readVersion 兜底为 1，这里回写进去，
  // 否则后续的结构校验会因为「缺字段」而拒绝一个本来完全可用的存档。
  let working: RawRecord = { ...raw, schemaVersion: version };
  while (version < SCHEMA_VERSION) {
    const migration = SAVE_MIGRATIONS[version];
    if (!migration) {
      return { ok: false, error: `缺少从 v${version} 到 v${version + 1} 的升级步骤` };
    }
    working = migration(working);
    version += 1;
    working['schemaVersion'] = version;
  }

  const parsed = gameSaveExportSchema.shape.save.safeParse(working);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.length ? first.path.map(String).join('.') : '存档';
    return { ok: false, error: `存档结构不完整：${path} ${first?.message ?? '不符合约定'}` };
  }

  return { ok: true, value: parsed.data as SaveRecord };
}

/**
 * 宽松升级，供 Dexie upgrade 使用。
 *
 * 与 `migrateSaveRecord` 的区别：**校验失败也不返回 undefined**，而是返回
 * 至少改过名字的对象。理由是迁移场景下「字段名还是旧的」比「校验没过」
 * 危险得多——前者会让读取方拿到一堆 undefined 而看不出哪里错了。
 * 真正非对象的输入才返回 undefined（那种记录本来也读不了）。
 */
export function upgradeSaveRecordLenient(raw: unknown): RawRecord | undefined {
  if (!isRecord(raw)) return undefined;

  const renamed = readVersion(raw) < SCHEMA_VERSION ? upgradeSaveV1ToV2(raw) : raw;
  const result = migrateSaveRecord(renamed);
  return result.ok ? (result.value as unknown as RawRecord) : renamed;
}

// ────────────────────────────────────────────────────────────
// 旧回合 → 段落
// ────────────────────────────────────────────────────────────

/** 取叙事的第一句作为条目正文。旧存档没有条目，只能这样还原一条时间轴。 */
function firstSentence(narrative: string): string {
  const trimmed = narrative.trim();
  if (trimmed === '') return '（旧版记录）';
  const match = /^[^。！？!?\n]{1,40}/.exec(trimmed);
  const sentence = (match?.[0] ?? trimmed.slice(0, 40)).trim();
  return sentence === '' ? '（旧版记录）' : sentence;
}

/**
 * 把一个 v1 回合事件转成 v2 段落记录。
 *
 * 迁移策略（方案第十一节）：
 * - `entries` 用 narrative 的首句，`detail` 放完整 narrative，并打上 `legacy` 标记，
 *   界面据此按「旧版长文」样式渲染，而不是假装它本来就是一个条目流。
 * - 旧回合末尾的 `options` 就是当时的岔路，因此转成一个决策点，
 *   这样旧存档继续玩下去时，玩家仍然能从那一步接着选。
 */
export function convertLegacyTurnEvent(raw: unknown): LifeSegmentRecord | undefined {
  const parsed = legacyTurnEventSchema.safeParse(raw);
  if (!parsed.success) return undefined;

  const event = parsed.data;
  const narrative = event.proposal.narrative.trim();

  const entry: LifeEntry = {
    age: event.resolvedCharacter.age,
    kind: 'milestone',
    text: firstSentence(narrative),
  };
  if (narrative !== '') entry.detail = narrative;

  const segment: LifeSegment = {
    entries: [entry],
    timeAdvance: event.proposal.timeAdvance,
    attributeDeltas: event.proposal.attributeDeltas,
    legacy: true,
  };
  if (event.proposal.worldStatusUpdate !== undefined) {
    segment.worldStatusUpdate = event.proposal.worldStatusUpdate;
  }
  if (event.proposal.traitOps) segment.traitOps = event.proposal.traitOps;
  if (event.proposal.inventoryOps) segment.inventoryOps = event.proposal.inventoryOps;
  if (event.proposal.relationshipOps) segment.relationshipOps = event.proposal.relationshipOps;

  const options = event.proposal.options.map((option) => option.trim()).filter((o) => o !== '');
  if (options.length >= 2) {
    segment.decision = {
      prompt: '旧版存档里留下的一个岔路口。',
      stakes: '这是当时摆在你面前的几个做法。',
      options,
      cause: 'proposed',
    };
  }

  const record: LifeSegmentRecord = {
    saveId: event.saveId,
    segmentId: event.turnId,
    requestId: event.requestId,
    playerAction: event.playerAction,
    segment,
    characterBefore: event.characterBefore,
    resolvedCharacter: event.resolvedCharacter,
    resolvedWorldStatus: event.resolvedWorldStatus,
    validationWarnings: event.validationWarnings,
    modelMeta: event.modelMeta,
    schemaVersion: SCHEMA_VERSION,
    createdAt: event.createdAt,
  };

  if (event.ending) {
    record.ending = { ...event.ending, atSegmentId: event.ending.atTurnId };
  }

  return record;
}

/** v1 的进行中回合 → v2 的进行中段落。 */
export function convertLegacyPendingTurn(raw: unknown): PendingSegment | undefined {
  if (!isRecord(raw)) return undefined;

  const requestId = raw['requestId'];
  const saveId = raw['saveId'];
  const turnId = raw['turnId'];
  if (typeof requestId !== 'string' || typeof saveId !== 'string' || typeof turnId !== 'number') {
    return undefined;
  }

  const pending: PendingSegment = {
    requestId,
    saveId,
    segmentId: turnId,
    expectedRevision: typeof raw['expectedRevision'] === 'number' ? raw['expectedRevision'] : 0,
    createdAt: typeof raw['createdAt'] === 'number' ? raw['createdAt'] : Date.now(),
  };

  const playerAction = raw['playerAction'];
  if (typeof playerAction === 'string' && playerAction.trim() !== '') {
    pending.playerAction = playerAction;
  }

  return pending;
}

/**
 * 已经结束的存档不该再留一个待玩家回答的岔路。
 *
 * 迁移过来的旧存档如果状态是 `ended`，最后一段的决策点要被摘掉——
 * 否则界面会在一个已经收束的故事末尾弹出一张无法继续的决策卡。
 */
export function stripTrailingDecision(
  segments: LifeSegmentRecord[],
  status: 'active' | 'ended',
): LifeSegmentRecord[] {
  if (status !== 'ended' || segments.length === 0) return segments;

  const ordered = [...segments].sort((a, b) => a.segmentId - b.segmentId);
  const last = ordered[ordered.length - 1];
  if (!last || !last.segment.decision) return segments;

  const { decision: _dropped, ...rest } = last.segment;
  return [...ordered.slice(0, -1), { ...last, segment: rest }];
}

// ────────────────────────────────────────────────────────────
// 导出与导入
// ────────────────────────────────────────────────────────────

/** 构造导出包。 */
export function buildExport(
  save: SaveRecord,
  segments: LifeSegmentRecord[],
): GameSaveExport {
  return {
    formatVersion: EXPORT_FORMAT_VERSION,
    save,
    segments: [...segments].sort((a, b) => a.segmentId - b.segmentId),
  };
}

export function serializeExport(save: SaveRecord, segments: LifeSegmentRecord[]): string {
  return JSON.stringify(buildExport(save, segments), null, 2);
}

export type MigrateResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * 解析导入文件。
 *
 * 同时接受 v1（`events` + 回合结构）与 v2（`segments` + 段落结构）两种导出包：
 * 导出/导入是玩家手里的资产，直接不兼容会让他们保存的 JSON 变成废纸。
 */
export function parseExport(text: string): MigrateResult<GameSaveExport> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: '文件内容不是合法的 JSON' };
  }

  if (!isRecord(raw)) {
    return { ok: false, error: '文件内容不是一个对象' };
  }

  const formatVersion = raw['formatVersion'];
  if (typeof formatVersion === 'number' && formatVersion > EXPORT_FORMAT_VERSION) {
    return {
      ok: false,
      error: `导出文件来自更新的版本（v${formatVersion}），请升级应用后再导入`,
    };
  }

  const migrated = migrateSaveRecord(raw['save']);
  if (!migrated.ok) return { ok: false, error: migrated.error };

  const legacy = raw['segments'] === undefined && Array.isArray(raw['events']);
  const rawHistory = legacy ? raw['events'] : raw['segments'];
  if (!Array.isArray(rawHistory)) {
    return { ok: false, error: '导出文件缺少段落历史' };
  }

  if (legacy) {
    const converted: LifeSegmentRecord[] = [];
    for (const item of rawHistory) {
      const record = convertLegacyTurnEvent(item);
      if (!record) {
        return { ok: false, error: '旧版回合历史结构不完整，无法转换' };
      }
      converted.push(record);
    }
    return {
      ok: true,
      value: {
        formatVersion: EXPORT_FORMAT_VERSION,
        save: migrated.value,
        segments: stripTrailingDecision(converted, migrated.value.status),
      },
    };
  }

  const parsed = gameSaveExportSchema.shape.segments.safeParse(rawHistory);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.length ? first.path.map(String).join('.') : '段落';
    return { ok: false, error: `段落历史结构不完整：${path} ${first?.message ?? '不符合约定'}` };
  }

  return {
    ok: true,
    value: {
      formatVersion: EXPORT_FORMAT_VERSION,
      save: migrated.value,
      segments: stripTrailingDecision(parsed.data as LifeSegmentRecord[], migrated.value.status),
    },
  };
}

/** 为导入的存档换一个不冲突的 id，避免覆盖玩家已有的存档。 */
export function remapSaveId(data: GameSaveExport, newId: string): GameSaveExport {
  return {
    formatVersion: data.formatVersion,
    save: { ...data.save, id: newId },
    segments: data.segments.map((record) => ({ ...record, saveId: newId })),
  };
}
