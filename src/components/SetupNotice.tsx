'use client';

import Link from 'next/link';
import { useModelSettings } from '@/lib/hooks/useModelSettings';

/**
 * 未配置模型时的引导条。
 *
 * 纯前端 BYOK 方案下，没填 Key 什么都做不了，所以必须主动提示，
 * 而不是等玩家点了「开始」才报错。
 */
export function SetupNotice() {
  const { ready, configured } = useModelSettings();

  if (!ready || configured) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-gold-500/40 bg-gold-900/30 px-4 py-3 text-sm">
      <p className="text-gold-300">
        还没有配置模型接口。这个模拟器由你自己的模型驱动，需要先填入 API Key。
      </p>
      <Link
        href="/settings"
        className="shrink-0 rounded border border-gold-500/50 px-3 py-1 text-gold-300 transition-colors hover:bg-gold-900/60"
      >
        去配置
      </Link>
    </div>
  );
}
