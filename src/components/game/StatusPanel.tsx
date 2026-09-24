'use client';

import { Badge, Panel, StatBar } from '@/components/ui';
import { attributeLabel } from '@/lib/engine/labels';
import type { CharacterState, WorldSetting } from '@/lib/engine/types';
import { openLifeRules, visibleAttributes } from '@/lib/engine/ruleset';

/**
 * 角色状态面板。
 *
 * 寿元条刻意做得显眼：这是整个玩法的核心压力来源，玩家需要随时看到
 * 「还剩多少年」才能理解每一次闭关的代价。
 */
export function StatusPanel({
  world,
  character,
  worldStatus,
  worldAttributes,
}: {
  world: WorldSetting;
  character: CharacterState;
  worldStatus: string;
  worldAttributes?: Record<string, number>;
}) {
  const open = openLifeRules(world);
  const { realmKey, cultivationKey, cultivationMax, realmNames, lifespanByRealm } =
    world.mechanics;

  const realm = character.attributes[realmKey] ?? 0;
  const realmLabel = realmNames[realm] ?? `第 ${realm} 阶`;
  const lifespan = lifespanByRealm[realm] ?? Number.POSITIVE_INFINITY;
  const remaining = Number.isFinite(lifespan) ? Math.max(0, lifespan - character.age) : undefined;

  const displayAttributes = visibleAttributes(world);
  const reserved = open
    ? [open.healthKey, open.careerKey]
    : [realmKey, cultivationKey];
  const primary = displayAttributes.filter(
    (definition) =>
      !reserved.includes(definition.key) &&
      definition.primary === true,
  );
  const secondary = displayAttributes.filter(
    (definition) =>
      !reserved.includes(definition.key) &&
      definition.primary !== true,
  );

  const relationships = Object.entries(character.relationships);
  const custom = open?.custom;
  const conditionValue = (scope: 'actor' | 'world', key: string) =>
    scope === 'actor' ? character.attributes[key] : worldAttributes?.[key];
  const conditionLabel = (scope: 'actor' | 'world', key: string) =>
    (scope === 'actor' ? world.attributes : world.worldAttributes)?.find((attribute) => attribute.key === key)?.label ?? key;

  return (
    <div className="space-y-4">
      <Panel>
        <div className="mb-4 flex items-baseline justify-between gap-3">
          <div>
            <p className="font-narrative text-lg tracking-wide text-ink-100">{character.name}</p>
            <p className="text-xs text-ink-500">{world.name}</p>
          </div>
          <Badge tone="gold">{open ? `${character.age} 岁` : realmLabel}</Badge>
        </div>

        {open ? (
          <div className="space-y-4">
            <StatBar
              label={attributeLabel(world, open.healthKey)}
              value={character.attributes[open.healthKey] ?? 0}
              max={100}
              tone="jade"
            />
            <StatBar
              label={attributeLabel(world, open.careerKey)}
              value={character.attributes[open.careerKey] ?? 0}
              max={100}
              tone="plain"
            />
          </div>
        ) : <div className="space-y-4">
          <StatBar
            label="寿元"
            value={character.age}
            min={0}
            max={Number.isFinite(lifespan) ? lifespan : Math.max(character.age, 100)}
            suffix=" 岁"
            tone="plain"
            {...(remaining !== undefined
              ? { hint: `尚余约 ${Math.round(remaining)} 年` }
              : { hint: '寿元绵长，近乎不朽' })}
          />

          <StatBar
            label={attributeLabel(world, cultivationKey)}
            value={character.attributes[cultivationKey] ?? 0}
            max={cultivationMax}
            tone="jade"
            hint="满则可冲击下一阶位"
          />
        </div>}
      </Panel>

      {custom && (
        <Panel title="本局目标">
          <div className="space-y-2 text-sm text-ink-300">
            <p>达成：{custom.objective.reason} · {conditionLabel(custom.objective.scope, custom.objective.key)} {conditionValue(custom.objective.scope, custom.objective.key) ?? '—'} / {custom.objective.threshold}</p>
            <p>失败：{custom.failure.reason} · {conditionLabel(custom.failure.scope, custom.failure.key)} {conditionValue(custom.failure.scope, custom.failure.key) ?? '—'}，降至 {custom.failure.threshold} 时结束</p>
            <p className="text-xs text-ink-500">{custom.aging ? '人物会自然衰老' : '人物不会因年龄自然衰老'}</p>
          </div>
        </Panel>
      )}

      {primary.length > 0 && (
        <Panel title="属性">
          <div className="space-y-3">
            {primary.map((definition) => (
              <StatBar
                key={definition.key}
                label={definition.label}
                value={character.attributes[definition.key] ?? definition.initialValue}
                min={definition.min}
                max={definition.max}
                tone="jade"
                {...(definition.key === open?.earnedRank?.key
                  ? { hint: world.mechanics.realmNames[character.attributes[definition.key] ?? 0] ?? '' }
                  : {})}
              />
            ))}
          </div>
        </Panel>
      )}

      {secondary.length > 0 && (
        <Panel title="其他">
          <div className="space-y-3">
            {secondary.map((definition) => {
              const value = character.attributes[definition.key] ?? definition.initialValue;
              return (
                <StatBar
                  key={definition.key}
                  label={definition.label}
                  value={value}
                  {...(definition.max !== undefined ? { min: definition.min ?? 0, max: definition.max } : {})}
                  suffix={definition.unit ?? ''}
                  tone="plain"
                />
              );
            })}
          </div>
        </Panel>
      )}

      {world.worldAttributes && world.worldAttributes.length > 0 && worldAttributes && (
        <Panel title="世界进展">
          <div className="space-y-3">
            {world.worldAttributes.map((definition) => {
              const value = worldAttributes[definition.key] ?? definition.initialValue;
              const progression = open?.worldProgress;
              if (definition.key === progression?.stageKey) {
                return <p key={definition.key} className="text-sm text-ink-300">{definition.label}：{progression.stageNames[value] ?? `第 ${value} 阶段`}</p>;
              }
              return <StatBar key={definition.key} label={definition.label} value={value}
                {...(definition.max !== undefined ? { min: definition.min ?? 0, max: definition.max } : {})}
                suffix={definition.unit ?? ''} tone="jade" />;
            })}
          </div>
        </Panel>
      )}

      {(character.traits.length > 0 ||
        character.inventory.length > 0 ||
        relationships.length > 0) && (
        <Panel title="际遇">
          <div className="space-y-4 text-sm">
            {character.traits.length > 0 && (
              <div>
                <p className="mb-1.5 text-xs tracking-wide text-ink-500">特质</p>
                <div className="flex flex-wrap gap-1.5">
                  {character.traits.map((trait) => (
                    <Badge key={trait} tone="gold">
                      {trait}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {character.inventory.length > 0 && (
              <div>
                <p className="mb-1.5 text-xs tracking-wide text-ink-500">持有</p>
                <div className="flex flex-wrap gap-1.5">
                  {character.inventory.map((item) => (
                    <Badge key={item}>{item}</Badge>
                  ))}
                </div>
              </div>
            )}

            {relationships.length > 0 && (
              <div>
                <p className="mb-1.5 text-xs tracking-wide text-ink-500">关系</p>
                <ul className="space-y-1 text-ink-300">
                  {relationships.map(([person, relation]) => (
                    <li key={person} className="flex justify-between gap-3">
                      <span>{person}</span>
                      <span className="text-ink-500">{relation}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </Panel>
      )}

      {worldStatus.trim() !== '' && (
        <Panel title="时局">
          <p className="text-sm leading-relaxed text-ink-300">{worldStatus}</p>
        </Panel>
      )}
    </div>
  );
}
