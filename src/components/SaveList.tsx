'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { Badge, Button, EmptyState, Panel } from '@/components/ui';
import type { SaveRecord } from '@/lib/engine/types';
import { openLifeRules } from '@/lib/engine/ruleset';
import { useSaveList } from '@/lib/hooks/useSaves';
import { deleteSave, exportGameAsText, importGameFromText } from '@/lib/services/gameService';

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function SaveCard({
  save,
  onChanged,
  onError,
}: {
  save: SaveRecord;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const { world, character } = save;
  const open = openLifeRules(world);
  const realm = character.attributes[world.mechanics.realmKey] ?? 0;
  const realmLabel = world.mechanics.realmNames[realm] ?? `第 ${realm} 阶`;
  const ended = save.status === 'ended';
  const ageLabel = ended
    ? save.ending?.type === 'death' ? '享年' : '结束时年龄'
    : '年龄';

  async function handleExport() {
    setBusy(true);
    try {
      const text = await exportGameAsText(save.id);
      if (!text) {
        onError('导出失败：找不到这个存档。');
        return;
      }
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `人生引擎-${character.name}-${save.id.slice(-8)}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    setBusy(true);
    try {
      await deleteSave(save.id);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-narrative text-lg tracking-wide text-ink-100">
              {character.name}
            </span>
            <Badge tone="gold">{open ? `${character.age} 岁` : realmLabel}</Badge>
            {ended ? (
              <Badge tone="danger">已结束</Badge>
            ) : (
              <Badge tone="jade">进行中</Badge>
            )}
          </div>

          <p className="text-sm text-ink-400">
            {world.name} · {ageLabel} {character.age} 岁 · 已推进 {save.stats.totalSegments} 段
          </p>

          {ended && save.ending && (
            <p className="text-sm text-cinnabar-300/90">{save.ending.reason}</p>
          )}

          <p className="text-xs text-ink-500">最后更新：{formatTime(save.updatedAt)}</p>
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          <Link
            href={`/play?save=${encodeURIComponent(save.id)}`}
            className="rounded-md border border-jade-600 bg-jade-600 px-4 py-2 text-sm text-white transition-colors hover:border-jade-500 hover:bg-jade-500"
          >
            {ended ? '查看结局' : '继续'}
          </Link>
          <Button onClick={handleExport} disabled={busy}>
            导出
          </Button>
          {confirming ? (
            <>
              <Button variant="danger" onClick={handleDelete} disabled={busy}>
                确认删除
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                取消
              </Button>
            </>
          ) : (
            <Button variant="ghost" onClick={() => setConfirming(true)}>
              删除
            </Button>
          )}
        </div>
      </div>
    </Panel>
  );
}

export function SaveList() {
  const saves = useSaveList();
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [, forceRefresh] = useState(0);

  async function handleImport(file: File) {
    setError(null);
    setNotice(null);
    const text = await file.text();
    const result = await importGameFromText(text);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setNotice('导入成功。为了不覆盖已有存档，导入的存档会作为新的一份存在。');
  }

  if (saves === undefined) {
    return <EmptyState>正在读取存档…</EmptyState>;
  }

  return (
    <div className="space-y-5">
      {error && (
        <div className="rounded-md border border-cinnabar-500/40 bg-cinnabar-900/30 px-4 py-3 text-sm text-cinnabar-300">
          导入失败：{error}
        </div>
      )}

      {notice && (
        <div className="rounded-md border border-jade-500/40 bg-jade-900/30 px-4 py-3 text-sm text-jade-300">
          {notice}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Link
          href="/new"
          className="rounded-md border border-jade-600 bg-jade-600 px-4 py-2 text-sm text-white transition-colors hover:border-jade-500 hover:bg-jade-500"
        >
          开始新的一生
        </Link>
        <Button onClick={() => fileRef.current?.click()}>导入存档</Button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void handleImport(file);
          }}
        />
      </div>

      {saves.length === 0 ? (
        <EmptyState>还没有任何存档。先开始新的一生吧。</EmptyState>
      ) : (
        <div className="space-y-4">
          {saves.map((save) => (
            <SaveCard
              key={save.id}
              save={save}
              onChanged={() => forceRefresh((value) => value + 1)}
              onError={setError}
            />
          ))}
        </div>
      )}

      <p className="text-xs leading-relaxed text-ink-500">
        存档保存在本机浏览器的 IndexedDB 里。清理浏览器数据、更换浏览器或更换设备都会让它消失，
        所以重要的一局请用「导出」备份成 JSON 文件。导出的文件里包含完整的年表，可以直接重新导入继续。
      </p>
    </div>
  );
}
