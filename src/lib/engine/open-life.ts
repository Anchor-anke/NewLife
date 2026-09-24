import type {
  CharacterState,
  DecisionPoint,
  Ending,
  EndingCause,
  LifeEntry,
  LifeSegment,
  ResolveBreakdown,
} from './types';
import type { ResolveSegmentInput, ResolveSegmentResult } from './resolve';
import { resolveDecision } from './decision';
import { fillTemplate } from './labels';
import { decisionIntervalFor } from './pacing';
import { openLifeRules, visibleAttributes } from './ruleset';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function updateList(current: readonly string[], ops: readonly { op: 'add' | 'remove'; value: string }[] | undefined): string[] {
  const result = new Set(current);
  for (const op of ops ?? []) {
    if (op.op === 'add') result.add(op.value);
    else result.delete(op.value);
  }
  return [...result];
}

/** 《浮生记》新局的结算入口：事业与健康是独立属性，没有自动晋阶或阶层续命。 */
export function resolveOpenLife(input: ResolveSegmentInput): ResolveSegmentResult {
  const { world, proposal, segmentId } = input;
  const rules = openLifeRules(world);
  if (!rules) throw new Error('开放人生结算缺少规则');
  const activeRules = rules;

  const warnings: string[] = [];
  const attributes = { ...input.character.attributes };
  const definitions = new Map(visibleAttributes(world).map((definition) => [definition.key, definition]));
  const worldDefinitions = new Map((world.worldAttributes ?? []).map((definition) => [definition.key, definition]));
  const worldAttributes = Object.fromEntries([...worldDefinitions].map(([key, definition]) => [
    key, input.worldAttributes?.[key] ?? definition.initialValue,
  ]));
  const entries: LifeEntry[] = [];
  const startAge = input.character.age;
  let age = startAge;
  let ending: Ending | undefined;
  let endingCause: EndingCause | undefined;
  let endingNote: string | undefined;

  function setAttribute(key: string, value: number): void {
    const definition = definitions.get(key);
    if (!definition) return;
    attributes[key] = definition.integer
      ? Math.round(clamp(value, definition.min ?? -Infinity, definition.max ?? Infinity))
      : clamp(value, definition.min ?? -Infinity, definition.max ?? Infinity);
  }

  function setWorldAttribute(key: string, value: number): void {
    const definition = worldDefinitions.get(key);
    if (!definition) return;
    worldAttributes[key] = definition.integer
      ? Math.round(clamp(value, definition.min ?? -Infinity, definition.max ?? Infinity))
      : clamp(value, definition.min ?? -Infinity, definition.max ?? Infinity);
  }

  function advanceWorldStage(): string | undefined {
    const progression = activeRules.worldProgress;
    if (!progression) return;
    const maxStage = progression.stageNames.length - 1;
    const stage = worldAttributes[progression.stageKey] ?? 0;
    const progress = worldAttributes[progression.progressKey] ?? 0;
    if (stage >= maxStage) {
      setWorldAttribute(progression.progressKey, progress);
      return;
    }
    if (progress >= progression.threshold && stage < maxStage) {
      setWorldAttribute(progression.stageKey, stage + 1);
      setWorldAttribute(progression.progressKey, progress - progression.threshold);
      return progression.stageNames[stage + 1];
    }
  }

  function settleDeath(cause: 'health' | 'old-age'): void {
    const text = cause === 'health' ? activeRules.healthDeath : activeRules.naturalDeath;
    ending = {
      type: 'death',
      reason: fillTemplate(text.reason, { age }),
      narrative: fillTemplate(text.narrative, { age }),
      atSegmentId: segmentId,
    };
    endingCause = cause;
    endingNote = cause === 'health'
      ? `健康在 ${age} 岁归零，程序判定生命结束。`
      : `年龄达到本世界的自然生命上限 ${activeRules.maxAge} 岁。`;
  }

  function advanceTo(targetAge: number): void {
    while (age < Math.min(targetAge, activeRules.maxAge) && !ending) {
      age += 1;
      if (age > activeRules.agingStartAge) {
        setAttribute(activeRules.healthKey, (attributes[activeRules.healthKey] ?? 0) - activeRules.annualHealthLoss);
      }
      if ((attributes[activeRules.healthKey] ?? 0) <= 0) settleDeath('health');
      else if (age >= activeRules.maxAge) settleDeath('old-age');
    }
  }

  if ((attributes[rules.healthKey] ?? 0) <= 0) settleDeath('health');
  else if (age >= rules.maxAge) settleDeath('old-age');

  // 提议的属性变化属于整段：按条目累计分配，逐条快照不会提前展示段尾状态。
  const rankRule = rules.earnedRank;
  const hasRankEvidence = (entry: LifeEntry) => Boolean(rankRule && entry.kind === 'milestone' &&
    rankRule.evidenceKeywords.some((keyword) => entry.text.includes(keyword) || entry.detail?.includes(keyword)));
  const rankEvidence = rankRule && proposal.entries.some(hasRankEvidence);
  let rankChange = 0;
  const deltas = Object.entries(proposal.attributeDeltas)
    .filter(([key]) => definitions.has(key))
    .map(([key, rawDelta]) => {
      let delta = clamp(rawDelta, -rules.maxDeltaPerSegment, rules.maxDeltaPerSegment);
      if (rankRule && key === rankRule.key) {
        if (!rankEvidence) {
          if (delta !== 0) warnings.push('本段没有委托完成或公会评定事实，忽略评级变化');
          delta = 0;
        } else {
          delta = clamp(delta, 0, 1);
        }
        rankChange = delta;
        delta = 0;
      }
      return [key, delta] as const;
    });
  const worldDeltas = Object.entries(proposal.worldDeltas ?? {})
    .filter(([key]) => worldDefinitions.has(key) && key !== rules.worldProgress?.stageKey)
    .map(([key, delta]) => [key, clamp(delta, -rules.maxDeltaPerSegment, rules.maxDeltaPerSegment)] as const);
  const count = Math.max(1, proposal.entries.length);
  let rankSettled = false;
  for (const [index, entry] of proposal.entries.entries()) {
    advanceTo(entry.age);
    if (ending) {
      break;
    }
    for (const [key, total] of deltas) {
      const before = Math.round((total * index) / count);
      const after = Math.round((total * (index + 1)) / count);
      setAttribute(key, (attributes[key] ?? 0) + after - before);
    }
    for (const [key, total] of worldDeltas) {
      const before = Math.round((total * index) / count);
      const after = Math.round((total * (index + 1)) / count);
      const next = (worldAttributes[key] ?? 0) + after - before;
      if (key === rules.worldProgress?.progressKey) {
        // 保留越过 100 的余量，跨阶段时带入下一阶段。
        worldAttributes[key] = Math.max(0, next);
      } else {
        setWorldAttribute(key, next);
      }
    }
    const newStage = advanceWorldStage();
    const rankJustSettled = Boolean(rankRule && rankChange !== 0 && !rankSettled && hasRankEvidence(entry));
    if (rankRule && rankJustSettled) {
      const beforeRank = attributes[rankRule.key] ?? 0;
      setAttribute(rankRule.key, beforeRank + rankChange);
      rankChange = (attributes[rankRule.key] ?? 0) - beforeRank;
      rankSettled = rankChange !== 0;
      if (!rankSettled) warnings.push('公会评级已达上限，本段未再次晋级');
    }
    entries.push({
      ...entry,
      settledAttributes: { ...attributes },
      ...(world.worldAttributes ? { settledWorldAttributes: { ...worldAttributes } } : {}),
    });
    if (rankJustSettled && rankRule && rankSettled) {
      const rank = attributes[rankRule.key] ?? 0;
      entries.push({
        age, kind: 'milestone',
        text: `公会评定完成：${world.mechanics.realmNames[rank] ?? `第 ${rank} 级`}`,
        settledAttributes: { ...attributes },
      });
    }
    if (newStage) {
      entries.push({
        age, kind: 'milestone', text: `殖民地进入「${newStage}」阶段`,
        settledAttributes: { ...attributes }, settledWorldAttributes: { ...worldAttributes },
      });
    }
  }

  if (!ending) advanceTo(startAge + proposal.timeAdvance);
  if (ending && (endingCause === 'health' || endingCause === 'old-age')) {
    entries.push({
      age,
      kind: 'milestone',
      text: ending.reason,
      settledAttributes: { ...attributes },
      ...(world.worldAttributes ? { settledWorldAttributes: { ...worldAttributes } } : {}),
    });
  }

  if (!ending && proposal.endingProposal) {
    const { type, reason } = proposal.endingProposal;
    if (type === 'completion') {
      const objectiveMet = rules.worldProgress
        ? (worldAttributes[rules.worldProgress.stageKey] ?? 0) >= rules.worldProgress.stageNames.length - 1
        : age >= rules.completionMinAge;
      if (objectiveMet && entries.some((entry) => entry.kind === 'milestone')) {
        ending = {
          type: 'completion',
          reason,
          narrative: fillTemplate(world.endings.completionByProposal, { reason, age }),
          atSegmentId: segmentId,
        };
        endingCause = 'proposed-completion';
        endingNote = rules.worldProgress
          ? '世界建设达到最终阶段，本段发生重大转折，采纳目标完成提议。'
          : `角色已过 ${rules.completionMinAge} 岁，且本段发生重要转折，采纳人生收束提议。`;
      } else {
        warnings.push('模型提议目标完成，但未达到世界目标与重大事件条件，本段继续');
      }
    } else {
      const lethal = entries.some((entry) => rules.lethalEventKeywords.some(
        (keyword) => entry.text.includes(keyword) || entry.detail?.includes(keyword),
      ));
      const luck = attributes[rules.luckKey] ?? 0;
      if (lethal && (input.rng ?? Math.random)() * 100 > luck) {
        ending = {
          type: 'death',
          reason,
          narrative: fillTemplate(world.endings.deathByProposal, { reason, age }),
          atSegmentId: segmentId,
        };
        endingCause = 'proposed-death';
        endingNote = '本段包含致命事件，程序判定死亡提议成立。';
      } else {
        warnings.push('模型提议死亡，但致命事件或判定条件不足，未采纳');
      }
    }
  }

  if (!ending && segmentId >= rules.segmentSoftLimit) {
    ending = {
      type: 'completion',
      reason: fillTemplate(world.endings.turnLimit.reason, { age }),
      narrative: fillTemplate(world.endings.turnLimit.narrative, { age }),
      atSegmentId: segmentId,
    };
    endingCause = 'turn-limit';
    endingNote = `已达段落数上限 ${rules.segmentSoftLimit}，故事收束。`;
  }

  const changes = visibleAttributes(world)
    .map((definition) => {
      const from = input.character.attributes[definition.key] ?? definition.initialValue;
      const to = attributes[definition.key] ?? from;
      return { key: definition.key, label: definition.label, from, to, delta: to - from };
    })
    .filter((change) => change.delta !== 0);

  let decision: DecisionPoint | undefined;
  if (!ending) {
    const gate = resolveDecision({
      proposal: proposal.decision,
      deltaMagnitude: changes.reduce((sum, change) => sum + Math.abs(change.delta), 0),
      brokeThrough: false,
      entries,
      segmentId,
      lastDecisionSegmentId: input.lastDecisionSegmentId,
      stopPlan: input.stopPlan,
      decisionInterval: decisionIntervalFor(world),
    });
    warnings.push(...gate.warnings);
    decision = gate.decision;
  }

  const relationships = { ...input.character.relationships };
  for (const operation of proposal.relationshipOps ?? []) {
    if (operation.op === 'set') relationships[operation.target] = operation.value;
    else delete relationships[operation.target];
  }
  const character: CharacterState = {
    ...input.character,
    age,
    isAlive: ending?.type !== 'death',
    attributes,
    traits: updateList(input.character.traits, proposal.traitOps),
    inventory: updateList(input.character.inventory, proposal.inventoryOps),
    relationships,
  };
  const segment: LifeSegment = {
    entries,
    timeAdvance: age - startAge,
    attributeDeltas: {
      ...Object.fromEntries(deltas.filter(([, delta]) => delta !== 0)),
      ...(rankRule && rankSettled ? { [rankRule.key]: rankChange } : {}),
    },
    ...(worldDeltas.length > 0 ? { worldDeltas: Object.fromEntries(worldDeltas) } : {}),
  };
  if (proposal.worldStatusUpdate !== undefined) segment.worldStatusUpdate = proposal.worldStatusUpdate;
  if (proposal.traitOps) segment.traitOps = proposal.traitOps;
  if (proposal.inventoryOps) segment.inventoryOps = proposal.inventoryOps;
  if (proposal.relationshipOps) segment.relationshipOps = proposal.relationshipOps;
  if (proposal.endingProposal) segment.endingProposal = proposal.endingProposal;
  if (decision) segment.decision = decision;

  const breakdown: ResolveBreakdown = {
    attributeChanges: changes,
    timeAdvance: age - startAge,
    breakthroughs: [],
  };
  if (endingCause) breakdown.endingCause = endingCause;
  if (endingNote) breakdown.endingNote = endingNote;
  if (decision) breakdown.decisionCause = decision.cause;

  return {
    segment,
    character,
    worldStatus: proposal.worldStatusUpdate ?? input.worldStatus,
    ...(world.worldAttributes ? { worldAttributes } : {}),
    warnings,
    ...(ending ? { ending } : {}),
    breakdown,
  };
}
