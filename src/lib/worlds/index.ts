import type { WorldSetting } from '@/lib/engine/types';
import { ashenThrone } from './ashen-throne';
import { fushengJi } from './fusheng-ji';
import { qingmingXiantu } from './qingming-xiantu';
import { starArk } from './star-ark';

/**
 * 内置世界观注册表。
 *
 * 数组顺序即界面上的展示顺序，第一项是创角页默认选中的那个。
 * 新增世界只需写好 `WorldSetting` 并在这里登记——引擎与界面都不需要改动。
 */
export const WORLDS: readonly WorldSetting[] = [
  qingmingXiantu,
  fushengJi,
  ashenThrone,
  starArk,
];

export function getWorld(id: string): WorldSetting | undefined {
  return WORLDS.find((world) => world.id === id);
}

export { qingmingXiantu, fushengJi, ashenThrone, starArk };
