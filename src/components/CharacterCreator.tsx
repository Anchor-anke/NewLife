'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { WorldForge } from '@/components/WorldForge';
import { Badge, Button, EmptyState, Field, Panel, TextInput } from '@/components/ui';
import type { Talent, WorldSetting } from '@/lib/engine/types';
import { useCustomWorlds } from '@/lib/hooks/useCustomWorlds';
import { useModelSettings } from '@/lib/hooks/useModelSettings';
import { applyTalentBonus, createGame, rollBaseAttributes } from '@/lib/services/gameService';
import { deleteCustomWorld, type CustomWorldRecord } from '@/lib/storage/customWorlds';
import { WORLDS } from '@/lib/worlds';

/** 把天赋的程序可读修正器翻译成人话，让玩家知道这个选择到底影响什么。 */
function describeModifiers(talent: Talent): string[] {
  const notes: string[] = [];
  const { cultivationGainMul, breakthroughBonus, eventWeightMul } = talent.modifiers;
  if (cultivationGainMul !== undefined) notes.push(`积累速度 ×${cultivationGainMul.toFixed(2)}`);
  if (breakthroughBonus !== undefined) notes.push(`突破判定 +${breakthroughBonus}`);
  if (eventWeightMul !== undefined) notes.push(`机缘权重 ×${eventWeightMul.toFixed(2)}`);
  return notes;
}

export function CharacterCreator() {
  const router = useRouter();
  const { configured } = useModelSettings();
  const customWorlds = useCustomWorlds();

  const defaultWorld = WORLDS[0];
  const [worldId, setWorldId] = useState(defaultWorld?.id ?? '');
  const [name, setName] = useState('');
  const [talentId, setTalentId] = useState<string | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const [forging, setForging] = useState(false);

  /**
   * 掷点结果刻意保持为 null 直到挂载后再掷。
   *
   * 如果在渲染期直接 `Math.random()`，服务端预渲染出的数值和客户端水合时的数值
   * 必然不同，React 会报水合不匹配（#418）。所以掷点必须发生在 effect 里。
   */
  const [base, setBase] = useState<Record<string, number> | null>(null);
  /** 记住已经为哪个世界掷过点，避免依赖对象身份造成的重复掷点甚至死循环。 */
  const rolledFor = useRef('');

  const custom = useMemo(() => customWorlds ?? [], [customWorlds]);
  const allWorlds = useMemo<readonly WorldSetting[]>(
    () => [...WORLDS, ...custom.map((record) => record.world)],
    [custom],
  );

  const world = useMemo(
    () => allWorlds.find((candidate) => candidate.id === worldId) ?? defaultWorld,
    [allWorlds, worldId, defaultWorld],
  );

  const customById = useMemo(() => {
    const map = new Map<string, CustomWorldRecord>();
    for (const record of custom) map.set(record.world.id, record);
    return map;
  }, [custom]);

  // 属性集合变化（换世界或重新生成）时重新掷点。用内容签名而不是对象身份做判据，
  // 否则任何一次引用变化都会触发重掷，掷出的新值又引起渲染，直接死循环。
  const worldSignature = world
    ? `${world.id}:${world.attributes.map((attribute) => attribute.key).join(',')}`
    : '';

  useEffect(() => {
    if (!world || rolledFor.current === worldSignature) return;
    rolledFor.current = worldSignature;
    setBase(rollBaseAttributes(world, Math.random));
  }, [world, worldSignature]);

  if (!world) {
    return <EmptyState>没有可用的世界观。</EmptyState>;
  }

  const finalAttributes = base ? applyTalentBonus(world, base, talentId) : null;
  const selectedTalent = world.talents.find((talent) => talent.id === talentId);

  function handleWorldChange(nextId: string) {
    if (!allWorlds.some((candidate) => candidate.id === nextId)) return;
    setWorldId(nextId);
    setTalentId(undefined);
    // 具体掷点在 effect 里完成，这里只负责切换世界观
  }

  async function handleDeleteCustom(id: string) {
    await deleteCustomWorld(id);
    if (worldId === id) {
      setWorldId(defaultWorld?.id ?? '');
      setTalentId(undefined);
    }
  }

  function handleForged(record: CustomWorldRecord) {
    setWorldId(record.world.id);
    setTalentId(undefined);
    setForging(false);
  }

  async function handleStart() {
    // `world` 的类型收窄不会跨越闭包边界，这里显式再判一次
    if (!world || !finalAttributes) return;
    setCreating(true);
    try {
      const record = await createGame({
        world,
        name,
        ...(talentId ? { talentId } : {}),
        attributes: finalAttributes,
      });
      router.push(`/play?save=${encodeURIComponent(record.id)}`);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-6">
      {forging && <WorldForge onCreated={handleForged} onCancel={() => setForging(false)} />}

      <Panel
        title="选择世界观"
        description="规则一旦定下，程序与模型都不会改写它。"
        actions={!forging ? <Button onClick={() => setForging(true)}>＋ 创造新世界</Button> : undefined}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {allWorlds.map((candidate) => {
            const active = candidate.id === world.id;
            const record = customById.get(candidate.id);

            return (
              <div
                key={candidate.id}
                className={`relative rounded-md border transition-colors ${
                  active
                    ? 'border-jade-500/70 bg-jade-900/30'
                    : 'border-ink-700 bg-ink-900 hover:border-ink-600'
                }`}
              >
                <button
                  type="button"
                  onClick={() => handleWorldChange(candidate.id)}
                  className="w-full cursor-pointer p-4 text-left"
                >
                  <div className="mb-1 flex flex-wrap items-center gap-1.5 pr-14">
                    <span className="font-narrative tracking-wide text-ink-100">
                      {candidate.name}
                    </span>
                    {active && <Badge tone="jade">已选</Badge>}
                    {record && <Badge tone="gold">自定义</Badge>}
                  </div>
                  <p className="text-xs leading-relaxed text-ink-400">{candidate.description}</p>
                </button>

                {record && (
                  <button
                    type="button"
                    title="删除这个世界"
                    onClick={() => void handleDeleteCustom(record.id)}
                    className="absolute top-3 right-3 cursor-pointer rounded px-1.5 py-0.5 text-xs text-ink-500 transition-colors hover:bg-cinnabar-900/40 hover:text-cinnabar-300"
                  >
                    删除
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {customById.size === 0 && !forging && (
          <p className="mt-3 text-xs leading-relaxed text-ink-500">
            上面是四个内置世界。想玩别的题材，点右上角「创造新世界」——
            用一句话描述背景，剩下的交给模型。
          </p>
        )}
      </Panel>

      <Panel title="角色" description={`起始年龄 ${world.mechanics.startingAge} 岁。`}>
        <Field label="姓名" htmlFor="name" hint="留空会记为「无名」。">
          <TextInput
            id="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="你叫什么？"
            maxLength={16}
          />
        </Field>
      </Panel>

      <Panel
        title="资质"
        description="掷点只决定起点，天赋决定上限。换天赋不需要重掷——加成会直接叠上去。"
        actions={
          <Button
            disabled={base === null}
            onClick={() => setBase(rollBaseAttributes(world, Math.random))}
          >
            重掷
          </Button>
        }
      >
        {finalAttributes === null || base === null ? (
          <p className="text-sm text-ink-500">正在掷点…</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {world.attributes
              .filter((definition) => definition.roll)
              .map((definition) => {
                const value = finalAttributes[definition.key] ?? 0;
                const baseValue = base[definition.key] ?? 0;
                const bonus = value - baseValue;
                const max = definition.max ?? 100;
                const ratio = Math.min(1, Math.max(0, value / max));

                return (
                  <div key={definition.key} className="space-y-1">
                    <div className="flex items-baseline justify-between text-sm">
                      <span className="text-ink-300">{definition.label}</span>
                      <span className="font-narrative tabular-nums text-ink-100">
                        {value}
                        {bonus !== 0 && (
                          <span
                            className={`ml-2 text-xs ${bonus > 0 ? 'text-jade-400' : 'text-cinnabar-400'}`}
                          >
                            {bonus > 0 ? `+${bonus}` : bonus}
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="h-1 overflow-hidden rounded-full bg-ink-800">
                      <div
                        className="h-full rounded-full bg-jade-500/70 transition-[width] duration-500"
                        style={{ width: `${ratio * 100}%` }}
                      />
                    </div>
                  </div>
                );
              })}
          </div>
        )}
      </Panel>

      <Panel title="天赋" description="只能选一个。它通过数值修正真实影响结算，不只是设定文案。">
        <div className="grid gap-3 sm:grid-cols-2">
          {world.talents.map((talent) => {
            const active = talent.id === talentId;
            const modifiers = describeModifiers(talent);
            const bonuses = Object.entries(talent.attributeBonus ?? {});

            return (
              <button
                key={talent.id}
                type="button"
                onClick={() => setTalentId(active ? undefined : talent.id)}
                className={`cursor-pointer rounded-md border p-4 text-left transition-colors ${
                  active
                    ? 'border-gold-500/70 bg-gold-900/25'
                    : 'border-ink-700 bg-ink-900 hover:border-ink-600'
                }`}
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="font-narrative tracking-wide text-ink-100">{talent.name}</span>
                  {active && <Badge tone="gold">已选</Badge>}
                </div>
                <p className="mb-3 text-xs leading-relaxed text-ink-400">{talent.description}</p>
                <div className="flex flex-wrap gap-1.5">
                  {bonuses.map(([key, bonus]) => {
                    const label =
                      world.attributes.find((attribute) => attribute.key === key)?.label ?? key;
                    return (
                      <Badge key={key} tone={bonus > 0 ? 'jade' : 'danger'}>
                        {label} {bonus > 0 ? `+${bonus}` : bonus}
                      </Badge>
                    );
                  })}
                  {modifiers.map((note) => (
                    <Badge key={note} tone="gold">
                      {note}
                    </Badge>
                  ))}
                </div>
              </button>
            );
          })}
        </div>
      </Panel>

      <div className="flex flex-wrap items-center gap-4">
        <Button
          variant="primary"
          onClick={handleStart}
          disabled={creating || finalAttributes === null}
        >
          {creating ? '正在开辟…' : '开始这一生'}
        </Button>
        {selectedTalent ? (
          <span className="text-sm text-ink-400">
            已选天赋：<span className="text-gold-300">{selectedTalent.name}</span>
          </span>
        ) : (
          <span className="text-sm text-ink-500">未选天赋也可以开始。</span>
        )}
        {!configured && (
          <span className="text-sm text-gold-300">
            尚未配置模型接口，进入对局后将无法推进段落。
          </span>
        )}
      </div>
    </div>
  );
}
