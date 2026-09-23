'use client';

import { useState } from 'react';
import { Badge, Button, Panel, Spinner, TextArea } from '@/components/ui';
import type { SimulationReport } from '@/lib/engine/simulate';
import { useModelSettings } from '@/lib/hooks/useModelSettings';
import { newId } from '@/lib/services/gameService';
import { putCustomWorld, type CustomWorldRecord } from '@/lib/storage/customWorlds';
import { ForgeError, forgeWorld, type ForgeStage } from '@/lib/worlds/forge';

const STAGE_LABELS: Record<ForgeStage, string> = {
  designing: '正在设计世界…',
  repairing: '正在修正设定…',
  tuning: '正在校准数值…',
};

const EXAMPLES = [
  '赛博朋克都市里的义体侦探',
  '中世纪的吸血鬼贵族家族',
  '末日之后守着一座图书馆的人',
  '深海殖民站里最后一批居民',
  '蒸汽朋克年代的雾港巡夜人',
];

function describePacing(report: SimulationReport): string[] {
  const percent = (value: number) => `${(value * 100).toFixed(0)}%`;
  return [
    `平均一局 ${report.averageSegments.toFixed(0)} 段`,
    `平均介入 ${report.averageDecisions.toFixed(0)} 次`,
    `寿元耗尽 ${percent(report.lifespanRate)}`,
    `登顶 ${percent(report.ascensionRate)}`,
    `终局阶位铺开 ${report.tierHistogram.size} 种`,
  ];
}

export function WorldForge({
  onCreated,
  onCancel,
}: {
  onCreated: (record: CustomWorldRecord) => void;
  onCancel: () => void;
}) {
  const { adapter, configured } = useModelSettings();

  const [premise, setPremise] = useState('');
  const [stage, setStage] = useState<ForgeStage | null>(null);
  const [record, setRecord] = useState<CustomWorldRecord | null>(null);
  const [report, setReport] = useState<SimulationReport | null>(null);
  const [error, setError] = useState<{ message: string; detail?: string } | null>(null);

  const busy = stage !== null;

  async function handleGenerate(reuseId: string | null) {
    if (!adapter || premise.trim().length < 4 || busy) return;

    setError(null);
    setStage('designing');

    try {
      const id = reuseId ?? newId('world');
      const result = await forgeWorld({
        premise: premise.trim(),
        adapter,
        id,
        onStage: setStage,
      });

      const now = Date.now();
      const next: CustomWorldRecord = {
        id,
        premise: premise.trim(),
        world: result.world,
        notes: result.notes,
        problems: result.problems,
        createdAt: record?.createdAt ?? now,
        updatedAt: now,
      };

      await putCustomWorld(next);
      setRecord(next);
      setReport(result.report);
    } catch (caught) {
      if (caught instanceof ForgeError) {
        setError({
          message: '模型连续几次都没能产出合法的世界设定。',
          detail: caught.issues.join('；'),
        });
      } else {
        setError({ message: caught instanceof Error ? caught.message : String(caught) });
      }
    } finally {
      setStage(null);
    }
  }

  return (
    <Panel
      title="用一句话创造一个世界"
      description="描述你想要的背景，剩下的交给模型：阶位体系、属性、天赋、世界法则与结局文案都由它设计，数值曲线由程序校准到可玩。"
      actions={
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          收起
        </Button>
      }
    >
      <div className="space-y-4">
        <TextArea
          rows={3}
          value={premise}
          onChange={(event) => setPremise(event.target.value)}
          placeholder="例如：蒸汽与齿轮的年代，雾港的夜晚属于巡夜人"
          maxLength={200}
          disabled={busy}
        />

        <div className="flex flex-wrap gap-1.5">
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              disabled={busy}
              onClick={() => setPremise(example)}
              className="cursor-pointer rounded border border-ink-600 bg-ink-800/60 px-2 py-0.5 text-xs text-ink-300 transition-colors hover:border-ink-500 hover:text-ink-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {example}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            disabled={busy || !configured || premise.trim().length < 4}
            onClick={() => void handleGenerate(record?.id ?? null)}
          >
            {busy ? <Spinner /> : null}
            {record ? '重新生成' : '生成世界'}
          </Button>
          <span className="text-xs text-ink-500">{premise.length} / 200</span>
          {!configured && <span className="text-sm text-gold-300">需要先在设置页配置模型接口。</span>}
        </div>

        {stage && (
          <div className="flex items-center gap-2 rounded-md border border-jade-500/30 bg-jade-900/25 px-3 py-2 text-sm text-jade-300">
            <Spinner />
            {STAGE_LABELS[stage]}
          </div>
        )}

        {error && (
          <div className="space-y-2 rounded-md border border-cinnabar-500/40 bg-cinnabar-900/30 px-4 py-3 text-sm">
            <p className="text-cinnabar-300">{error.message}</p>
            {error.detail && (
              <p className="font-mono text-xs break-all text-ink-500">{error.detail}</p>
            )}
          </div>
        )}

        {record && report && (
          <div className="space-y-4 rounded-md border border-ink-700 bg-ink-950/60 p-4">
            <div>
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <span className="font-narrative text-lg tracking-wide text-ink-100">
                  {record.world.name}
                </span>
                <Badge tone="jade">已生成</Badge>
              </div>
              <p className="text-sm leading-relaxed text-ink-400">{record.world.description}</p>
            </div>

            <div>
              <p className="mb-1.5 text-xs tracking-wide text-ink-500">阶位体系</p>
              <div className="flex flex-wrap items-center gap-1.5">
                {record.world.mechanics.realmNames.map((name, index) => (
                  <span key={name} className="flex items-center gap-1.5">
                    {index > 0 && <span className="text-ink-600">→</span>}
                    <Badge tone={index === record.world.mechanics.realmNames.length - 1 ? 'gold' : 'neutral'}>
                      {name}
                    </Badge>
                  </span>
                ))}
              </div>
              <p className="mt-2 text-xs text-ink-500">
                起始 {record.world.mechanics.startingAge} 岁 · 寿元上限{' '}
                {record.world.mechanics.lifespanByRealm[0]} →{' '}
                {record.world.mechanics.lifespanByRealm[record.world.mechanics.lifespanByRealm.length - 1]} 岁
              </p>
            </div>

            <div>
              <p className="mb-1.5 text-xs tracking-wide text-ink-500">属性</p>
              <div className="flex flex-wrap gap-1.5">
                {record.world.attributes.map((attribute) => (
                  <Badge key={attribute.key} tone={attribute.primary ? 'jade' : 'neutral'}>
                    {attribute.label}
                  </Badge>
                ))}
              </div>
            </div>

            <div>
              <p className="mb-1.5 text-xs tracking-wide text-ink-500">
                天赋（{record.world.talents.length}）
              </p>
              <div className="flex flex-wrap gap-1.5">
                {record.world.talents.map((talent) => (
                  <Badge key={talent.id} tone="gold">
                    {talent.name}
                  </Badge>
                ))}
              </div>
            </div>

            <div>
              <p className="mb-1.5 text-xs tracking-wide text-ink-500">数值校准结果</p>
              <p className="text-xs leading-relaxed text-ink-400">
                {describePacing(report).join(' · ')}
              </p>
            </div>

            {record.notes.length > 0 && (
              <div>
                <p className="mb-1.5 text-xs tracking-wide text-ink-500">程序做过的修正</p>
                <ul className="space-y-1 text-xs leading-relaxed text-ink-400">
                  {record.notes.map((note) => (
                    <li key={note} className="flex gap-1.5">
                      <span className="text-ink-600">·</span>
                      <span>{note}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {record.problems.length > 0 && (
              <div className="rounded border border-gold-500/40 bg-gold-900/25 px-3 py-2">
                <p className="mb-1 text-xs text-gold-300">这个世界的手感有瑕疵，但仍然可以玩：</p>
                <ul className="space-y-1 text-xs leading-relaxed text-ink-400">
                  {record.problems.map((problem) => (
                    <li key={problem} className="flex gap-1.5">
                      <span className="text-ink-600">·</span>
                      <span>{problem}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex flex-wrap gap-2 border-t border-ink-800 pt-4">
              <Button variant="primary" onClick={() => onCreated(record)}>
                用这个世界开始
              </Button>
              <Button onClick={() => void handleGenerate(record.id)} disabled={busy}>
                重新生成
              </Button>
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}
