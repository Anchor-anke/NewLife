import 'client-only';
import { generateEpilogue } from '@/lib/engine/summary';
import {
  SCHEMA_VERSION,
  type CharacterState,
  type SaveRecord,
  type WorldSetting,
} from '@/lib/engine/types';
import type { ModelAdapter } from '@/lib/model/adapter';
import { parseExport, remapSaveId, serializeExport } from '@/lib/storage/migrate';
import {
  deleteSave,
  getAllSegments,
  getSave,
  listSaves,
  patchSave,
  putSave,
} from '@/lib/storage/saves';

/**
 * 对局生命周期的编排：创角、列表、导入导出、结局总结。
 * 跨「引擎 + 存储」两层，所以单独放在 services 下。
 */

export type Rng = () => number;

/** 生成一个足够唯一的标识。优先用 crypto，降级到时间戳 + 随机串。 */
export function newId(prefix = 'save'): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function clampToDefinition(world: WorldSetting, key: string, value: number): number {
  const definition = world.attributes.find((attribute) => attribute.key === key);
  if (!definition) return value;
  const min = definition.min ?? Number.NEGATIVE_INFINITY;
  const max = definition.max ?? Number.POSITIVE_INFINITY;
  return Math.min(max, Math.max(min, definition.integer ? Math.round(value) : value));
}

/** 按属性定义里的随机区间掷出基础属性（不含天赋加成）。 */
export function rollBaseAttributes(
  world: WorldSetting,
  rng: Rng = Math.random,
): Record<string, number> {
  const attributes: Record<string, number> = {};

  for (const definition of world.attributes) {
    if (definition.roll) {
      const { min, max } = definition.roll;
      attributes[definition.key] = Math.floor(min + rng() * (max - min + 1));
    } else {
      attributes[definition.key] = definition.initialValue;
    }
  }

  return attributes;
}

/**
 * 叠加天赋的一次性加成。
 *
 * 与掷点分开，是为了让创角界面可以「先掷一次、反复换天赋看效果」而不重掷——
 * 否则玩家每换一个天赋资质就变了，根本没法比较优劣。
 */
export function applyTalentBonus(
  world: WorldSetting,
  base: Record<string, number>,
  talentId: string | undefined,
): Record<string, number> {
  const attributes = { ...base };
  const talent = world.talents.find((candidate) => candidate.id === talentId);

  if (talent?.attributeBonus) {
    for (const [key, bonus] of Object.entries(talent.attributeBonus)) {
      const current = attributes[key];
      if (current === undefined) continue;
      attributes[key] = clampToDefinition(world, key, current + bonus);
    }
  }

  for (const definition of world.attributes) {
    const value = attributes[definition.key];
    if (value !== undefined) {
      attributes[definition.key] = clampToDefinition(world, definition.key, value);
    }
  }

  return attributes;
}

/** 掷点 + 天赋加成，一步到位。 */
export function rollAttributes(
  world: WorldSetting,
  talentId: string | undefined,
  rng: Rng = Math.random,
): Record<string, number> {
  return applyTalentBonus(world, rollBaseAttributes(world, rng), talentId);
}

export function buildCharacter(
  world: WorldSetting,
  name: string,
  talentId: string | undefined,
  rng: Rng = Math.random,
  attributes?: Record<string, number>,
): CharacterState {
  const talent = world.talents.find((candidate) => candidate.id === talentId);
  const character: CharacterState = {
    name: name.trim() === '' ? '无名' : name.trim(),
    age: world.mechanics.startingAge,
    isAlive: true,
    attributes: attributes ?? rollAttributes(world, talentId, rng),
    // 天赋名进入特质列表，好让模型在叙事里知道角色的底色；
    // 数值修正则通过 talentId 在结算时读取，不依赖自然语言。
    traits: talent ? [talent.name] : [],
    inventory: [],
    relationships: {},
  };
  if (talentId) character.talentId = talentId;
  return character;
}

export interface CreateGameInput {
  world: WorldSetting;
  name: string;
  talentId?: string;
  rng?: Rng;
  now?: number;
  id?: string;
  /** 已经掷好的属性（创角界面预览后确认的那一份）。不给则现场掷。 */
  attributes?: Record<string, number>;
}

export function buildSaveRecord(input: CreateGameInput): SaveRecord {
  const now = input.now ?? Date.now();
  return {
    id: input.id ?? newId(),
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    world: input.world,
    worldStatus: input.world.initialWorldStatus,
    character: buildCharacter(
      input.world,
      input.name,
      input.talentId,
      input.rng ?? Math.random,
      input.attributes,
    ),
    historySummary: '',
    summarizedThroughSegmentId: 0,
    latestSegmentId: 0,
    lastDecisionSegmentId: 0,
    status: 'active',
    stats: { totalSegments: 0, startedAt: now },
    createdAt: now,
    updatedAt: now,
  };
}

export async function createGame(input: CreateGameInput): Promise<SaveRecord> {
  const record = buildSaveRecord(input);
  await putSave(record);
  return record;
}

export { listSaves, getSave, deleteSave };

// ────────────────────────────────────────────────────────────
// 导入导出
// ────────────────────────────────────────────────────────────

export async function exportGameAsText(saveId: string): Promise<string | undefined> {
  const save = await getSave(saveId);
  if (!save) return undefined;
  const segments = await getAllSegments(saveId);
  return serializeExport(save, segments);
}

export type ImportResult =
  | { ok: true; saveId: string }
  | { ok: false; error: string };

/** 导入存档。总是换一个新 id，绝不覆盖玩家已有的存档。 */
export async function importGameFromText(text: string): Promise<ImportResult> {
  const parsed = parseExport(text);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const remapped = remapSaveId(parsed.value, newId('imported'));
  await putSave(remapped.save);

  const db = (await import('@/lib/storage/db')).getDb();
  await db.segments.bulkPut(remapped.segments);

  return { ok: true, saveId: remapped.save.id };
}

// ────────────────────────────────────────────────────────────
// 结局总结
// ────────────────────────────────────────────────────────────

export type EpilogueResult =
  | { ok: true; epilogue: string }
  | { ok: false; error: string };

/**
 * 生成（或重新生成）人生总结。
 *
 * 失败时**什么都不改**：存档本身完好，玩家可以随时重试。
 */
export async function generateEpilogueForSave(
  saveId: string,
  adapter: ModelAdapter,
  options: { signal?: AbortSignal } = {},
): Promise<EpilogueResult> {
  const save = await getSave(saveId);
  if (!save) return { ok: false, error: '存档不存在' };
  if (!save.ending) return { ok: false, error: '这一局还没有结束，无法生成生平总结' };

  try {
    const segments = await getAllSegments(saveId);
    const { epilogue } = await generateEpilogue({
      world: save.world,
      adapter,
      character: save.character,
      historySummary: save.historySummary,
      segments,
      ending: save.ending,
      stats: save.stats,
      ...(options.signal ? { signal: options.signal } : {}),
    });

    await patchSave(saveId, { epilogue });
    return { ok: true, epilogue };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
