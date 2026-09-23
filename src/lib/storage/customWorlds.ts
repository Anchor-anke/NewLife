import 'client-only';
import type { WorldSetting } from '@/lib/engine/types';
import { getDb } from './db';

/**
 * 自定义世界观存储。
 *
 * 玩家用 AI 生成的世界与内置世界走**同一条渲染与结算路径**——它就是一个普通的
 * `WorldSetting`，只是存在 IndexedDB 而不是写在代码里。所以界面层不需要任何分支，
 * 存档里也会完整带上 `world` 快照，即使之后删掉这个自定义世界，旧存档照样能读。
 */

export interface CustomWorldRecord {
  id: string;
  /** 玩家当初输入的那句话，用于展示与「重新生成」 */
  premise: string;
  world: WorldSetting;
  /** 生成过程中程序做过的修正，如实展示给玩家 */
  notes: string[];
  /** 校准后仍未达标的项。非空说明手感有瑕疵，但世界仍然可玩。 */
  problems: string[];
  createdAt: number;
  updatedAt: number;
}

export async function listCustomWorlds(): Promise<CustomWorldRecord[]> {
  const records = await getDb().customWorlds.toArray();
  return records.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getCustomWorld(id: string): Promise<CustomWorldRecord | undefined> {
  return getDb().customWorlds.get(id);
}

export async function putCustomWorld(record: CustomWorldRecord): Promise<void> {
  await getDb().customWorlds.put(record);
}

export async function deleteCustomWorld(id: string): Promise<void> {
  await getDb().customWorlds.delete(id);
}

/**
 * 删除自定义世界。
 *
 * **不会**连带删除用它创建的存档——存档里已经带了 `world` 快照，
 * 自己就是完整的。这里只影响「新建角色时还能不能选到它」。
 */
export async function countSavesUsingWorld(worldId: string): Promise<number> {
  return getDb().saves.where('id').notEqual('').filter((save) => save.world.id === worldId).count();
}
