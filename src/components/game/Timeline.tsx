'use client';

import { useState } from 'react';
import { Badge, EmptyState } from '@/components/ui';
import type {
  CharacterState,
  EntryKind,
  LifeEntry,
  LifeSegmentRecord,
  WorldSetting,
} from '@/lib/engine/types';
import { openLifeRules, visibleAttributes } from '@/lib/engine/ruleset';

/**
 * 年表。
 *
 * 这是重构后的主视图：读年表，而不是读小说。
 *
 * 三层信息密度：
 * - **条目**：一句话，默认展开，可扫读
 * - **详情**：100~200 字的完整叙事，只有 `milestone` 默认展开，其余点击才展开
 * - **本段变化**：属性增减、突破、修正记录，折叠在段落末尾
 *
 * 「只有 milestone 默认展开」这一条是「一屏能看到 20~40 年」的关键。
 * 方案原文写的是「milestone 或带 detail 的条目都默认展开」，但那样只要模型
 * 多给几个 detail，一屏又只剩几年——而方案自己的界面草图里，带 detail 的
 * 挫折条目也是折叠的（显示「⌄ 展开」）。这里按草图的形态实现。
 */

const KIND_LABELS: Record<EntryKind, string> = {
  cultivation: '修行',
  event: '世事',
  relationship: '人际',
  fortune: '际遇',
  setback: '挫折',
  milestone: '转折',
};

type Tone = 'neutral' | 'jade' | 'gold' | 'danger';

const KIND_TONES: Record<EntryKind, Tone> = {
  cultivation: 'jade',
  event: 'neutral',
  relationship: 'neutral',
  fortune: 'gold',
  setback: 'danger',
  milestone: 'gold',
};

function diffAttributes(world: WorldSetting, record: LifeSegmentRecord) {
  return visibleAttributes(world)
    .map((definition) => {
      const from = record.characterBefore.attributes[definition.key] ?? definition.initialValue;
      const to = record.resolvedCharacter.attributes[definition.key] ?? from;
      return { key: definition.key, label: definition.label, from, to, delta: to - from };
    })
    .filter((change) => change.delta !== 0);
}

function realmOf(world: WorldSetting, character: CharacterState): number {
  return character.attributes[world.mechanics.realmKey] ?? 0;
}

/** 单条条目。默认折叠，只有 milestone 例外。 */
function EntryRow({ entry, entering = false, openLife = false }: { entry: LifeEntry; entering?: boolean; openLife?: boolean }) {
  const [open, setOpen] = useState(entry.kind === 'milestone');

  return (
    <li className={entering ? 'animate-fade-rise py-1' : 'py-1'}>
      <div className="flex items-start gap-2">
        <span className="mt-[0.4rem] size-1.5 shrink-0 rounded-full bg-ink-500" aria-hidden />
        <p className="min-w-0 flex-1 text-sm leading-relaxed text-ink-200">
          {entry.age > 0 && <span className="mr-2 text-ink-500 tabular-nums">{entry.age} 岁</span>}
          {entry.text}
        </p>
        <Badge tone={KIND_TONES[entry.kind]}>{openLife && entry.kind === 'cultivation' ? '经历' : KIND_LABELS[entry.kind]}</Badge>
        {entry.detail !== undefined && (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            className="shrink-0 cursor-pointer text-xs text-ink-500 transition-colors hover:text-ink-300"
          >
            {open ? '⌃ 收起' : '⌄ 展开'}
          </button>
        )}
      </div>

      {open && entry.detail !== undefined && (
        <p className="prose-narrative mt-1.5 pl-4 text-ink-300">{entry.detail}</p>
      )}
    </li>
  );
}

/** 段落末尾的折叠元信息：属性增减、突破、修正记录。 */
function SegmentMeta({ world, record }: { world: WorldSetting; record: LifeSegmentRecord }) {
  const changes = diffAttributes(world, record);
  const open = openLifeRules(world);
  const realmFrom = open ? 0 : realmOf(world, record.characterBefore);
  const realmTo = open ? 0 : realmOf(world, record.resolvedCharacter);
  const breakthroughs = open ? 0 : Math.max(0, realmTo - realmFrom);
  const warnings = record.validationWarnings;

  if (changes.length === 0 && breakthroughs === 0 && warnings.length === 0) return null;

  const summary: string[] = [];
  if (breakthroughs > 0) {
    summary.push(`阶位 +${breakthroughs}`);
  }
  if (changes.length > 0) summary.push(`${changes.length} 处变化`);
  if (warnings.length > 0) summary.push(`${warnings.length} 处修正`);

  return (
    <details className="mt-2 text-xs text-ink-500">
      <summary className="cursor-pointer select-none hover:text-ink-400">
        本段：{summary.join(' · ')}
      </summary>

      <div className="mt-2 space-y-2 pl-1">
        {breakthroughs > 0 && (
          <p className="text-gold-300">
            阶位提升 {breakthroughs} 次：
            {world.mechanics.realmNames[realmFrom] ?? realmFrom} →{' '}
            {world.mechanics.realmNames[realmTo] ?? realmTo}
          </p>
        )}

        {changes.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {changes.map((change) => (
              <Badge key={change.key} tone={change.delta > 0 ? 'jade' : 'danger'}>
                {change.label} {change.delta > 0 ? `+${change.delta}` : change.delta}
                <span className="ml-1 text-ink-500 tabular-nums">
                  {change.from}→{change.to}
                </span>
              </Badge>
            ))}
          </div>
        )}

        {warnings.length > 0 && (
          <ul className="space-y-1 pl-4">
            {warnings.map((warning) => (
              <li key={warning} className="list-disc">
                {warning}
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

/**
 * 一个段落。
 *
 * 段落边界就是玩家上一次出手的位置，因此「你的选择」作为段落的前导行，
 * 而不是塞进条目里——它是玩家的动作，不是世界发生的事。
 */
function SegmentBlock({
  world,
  record,
  showYears,
  visibleCount,
}: {
  world: WorldSetting;
  record: LifeSegmentRecord;
  showYears: boolean;
  visibleCount?: number;
}) {
  const entries = visibleCount === undefined
    ? record.segment.entries
    : record.segment.entries.slice(0, visibleCount);

  // 按年龄分组。条目年龄已在规整层校正为单调不减，因此顺序分组即可。
  const groups: { age: number; entries: LifeEntry[] }[] = [];
  for (const entry of entries) {
    const last = groups[groups.length - 1];
    if (last && last.age === entry.age) last.entries.push(entry);
    else groups.push({ age: entry.age, entries: [entry] });
  }

  return (
    // data-segment-id 是端到端脚本的稳定锚点：它要按「年表上又多了几段」来等待推进落定，
    // 而段落本身没有可读的编号文本（编号对玩家没有意义）。
    <section className="space-y-2" data-segment-id={record.segmentId}>
      {record.playerAction !== undefined && (
        <p className="flex items-baseline gap-2 border-l-2 border-jade-500/60 pl-3 text-sm text-ink-300">
          <span className="shrink-0 text-xs tracking-wide text-ink-500">你的选择</span>
          {record.playerAction}
        </p>
      )}

      {record.segment.legacy === true && (
        <p className="text-xs text-ink-500">
          <Badge>旧版记录</Badge>
          <span className="ml-2">这一段来自重构前的存档，保留为长文形态。</span>
        </p>
      )}

      <div className="space-y-1">
        {groups.map((group) => (
          <div key={`${record.segmentId}-${group.age}`}>
            {showYears && (
              // data-year-header 是端到端脚本的锚点。不能靠「文本是 N 岁」来定位：
              // 条目行里的年龄标签文本也是「N 岁」，两者会被同一个选择器一起命中，
              // 于是「按年份分组」这条断言实际数的是条目数，看着通过而已。
              <div className="flex items-center gap-3 pt-2 pb-1" data-year-header={group.age}>
                <span className="font-narrative text-sm tracking-wide text-ink-400 tabular-nums">
                  {group.age} 岁
                </span>
                <span className="h-px flex-1 bg-ink-800" aria-hidden />
              </div>
            )}
            <ul>
              {group.entries.map((entry, index) => (
                <EntryRow
                  key={`${entry.age}-${index}-${entry.text}`}
                  entry={entry}
                  openLife={openLifeRules(world) !== undefined}
                  entering={visibleCount !== undefined}
                />
              ))}
            </ul>
          </div>
        ))}
      </div>

      {visibleCount === undefined || visibleCount >= record.segment.entries.length ? (
        <SegmentMeta world={world} record={record} />
      ) : null}
    </section>
  );
}

export type TimelineView = 'chronicle' | 'stream';

export function Timeline({
  world,
  segments,
  view = 'chronicle',
  reveal,
}: {
  world: WorldSetting;
  segments: readonly LifeSegmentRecord[];
  view?: TimelineView;
  reveal?: { segmentId: number; visibleCount: number } | null;
}) {
  if (segments.length === 0) {
    return (
      <EmptyState>
        年表还是空的。点击下方的「继续」，让这个世界自己往前走一段。
      </EmptyState>
    );
  }

  return (
    <div className={view === 'chronicle' ? 'space-y-6' : 'space-y-5'}>
      {segments.map((record) => (
        <SegmentBlock
          key={record.segmentId}
          world={world}
          record={record}
          showYears={view === 'chronicle'}
          visibleCount={reveal?.segmentId === record.segmentId ? reveal.visibleCount : undefined}
        />
      ))}
    </div>
  );
}
