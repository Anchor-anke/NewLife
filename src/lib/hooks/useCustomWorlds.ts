'use client';

import { useLiveQuery } from 'dexie-react-hooks';
import { listCustomWorlds } from '@/lib/storage/customWorlds';

/** 订阅玩家用 AI 生成的自定义世界观。写入后界面会自动刷新。 */
export function useCustomWorlds() {
  return useLiveQuery(() => listCustomWorlds(), []);
}
