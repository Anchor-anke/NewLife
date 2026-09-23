'use client';

import { useLiveQuery } from 'dexie-react-hooks';
import { getSaveBundle, listSaves, type SaveBundle } from '@/lib/storage/saves';

/**
 * 把 IndexedDB 当作唯一状态真源来订阅。
 *
 * `useLiveQuery` 会自动追踪查询里用到的表，任何写入都会触发重渲染——
 * 因此不需要在 React 里再维护一份游戏状态，也就不会出现
 * 「界面显示的属性和存档里的不一致」这类问题。
 */

export function useSaveBundle(saveId: string | null): SaveBundle | undefined {
  return useLiveQuery(async (): Promise<SaveBundle> => {
    if (!saveId) return { save: undefined, segments: [], pending: [] };
    return getSaveBundle(saveId);
  }, [saveId]);
}

export function useSaveList() {
  return useLiveQuery(() => listSaves(), []);
}
