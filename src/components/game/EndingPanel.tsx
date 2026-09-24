'use client';

import { Button, Panel, Spinner } from '@/components/ui';
import type { SaveRecord } from '@/lib/engine/types';

export function EndingPanel({
  save,
  generating,
  error,
  onGenerate,
}: {
  save: SaveRecord;
  generating: boolean;
  error: string | null;
  onGenerate: () => void;
}) {
  if (save.status !== 'ended' || !save.ending) return null;

  const { ending } = save;
  const isDeath = ending.type === 'death';
  const isFailure = ending.type === 'failure';

  return (
    <Panel
      title={isDeath ? '此生终了' : isFailure ? '目标失败' : '故事收束'}
      description={`第 ${ending.atSegmentId} 段 · ${isDeath ? '享年' : '人物年龄'} ${save.character.age} 岁 · 共 ${save.stats.totalSegments} 段`}
      actions={
        <Button onClick={onGenerate} disabled={generating}>
          {generating ? <Spinner /> : null}
          {save.epilogue ? '重新生成生平总结' : '生成生平总结'}
        </Button>
      }
    >
      <div className="space-y-4">
        <div>
          <p className={`font-narrative tracking-wide ${isDeath || isFailure ? 'text-cinnabar-300' : 'text-gold-300'}`}>
            {ending.reason}
          </p>
          <p className="prose-narrative mt-2 text-ink-200">{ending.narrative}</p>
        </div>

        {save.epilogue ? (
          <div className="border-t border-ink-800 pt-4">
            <p className="mb-2 text-xs tracking-[0.3em] text-ink-500 uppercase">生平</p>
            <div className="prose-narrative text-ink-200">
              {save.epilogue
                .split(/\n+/)
                .filter((paragraph) => paragraph.trim() !== '')
                .map((paragraph, index) => (
                  <p key={index}>{paragraph}</p>
                ))}
            </div>
          </div>
        ) : (
          <p className="border-t border-ink-800 pt-4 text-sm text-ink-500">
            还没有生平总结。点击右上角按钮生成——它会回顾这一生的关键转折。生成失败不会影响存档，可以随时重试。
          </p>
        )}

        {error && (
          <p className="rounded-md border border-cinnabar-500/40 bg-cinnabar-900/30 px-4 py-3 text-sm text-cinnabar-300">
            生成失败：{error}
          </p>
        )}
      </div>
    </Panel>
  );
}
