import type { OpenLifeRules, WorldSetting } from './types';

/** 旧存档和旧自定义世界没有规则标记，仍使用原阶位寿元结算。 */
export function openLifeRules(world: WorldSetting): OpenLifeRules | undefined {
  return world.ruleset?.kind === 'open_life' ? world.ruleset : undefined;
}

export function visibleAttributes(world: WorldSetting) {
  const hidden = new Set(openLifeRules(world)?.legacyHiddenKeys ?? []);
  return world.attributes.filter((attribute) => !hidden.has(attribute.key));
}

export function rulesetVersion(world: WorldSetting): number {
  return openLifeRules(world)?.version ?? 1;
}
