import type {
  CharacterState,
  DecisionPoint,
  LifeSegmentRecord,
  WorldSetting,
} from '@/lib/engine/types';
import { tierName } from '@/lib/engine/labels';
import { openLifeRules, visibleAttributes } from '@/lib/engine/ruleset';

/**
 * Jev 打分的 state 组装。
 *
 * 打分语义是「这个选项对这个角色有多自然」，不是「哪个收益最大」——
 * 与 suggest 层反最优解的设计哲学同源。因此 state 的重点是**人格与处境**，
 * 收益对比交给选项文案本身；口径固定落在 `buildJevInstructions` 里。
 *
 * 成本纪律与 context.ts 同源：state 是每张决策卡都要发的东西，必须紧凑，
 * 目标 1000 token 以内——摘要取尾部、近期条目只取最后几条、不带 detail、
 * 不带世界法则全文。与 segment 提示词共用同一份事实基础，但**不复用它的
 * 格式化函数**：那是给生成模型的长上下文，这里是给打分模型的压缩快照，
 * 两者的取舍标准不同。
 */

/** 近期条目最多带几条。岔路评分看重「最近的处境」，更早的交给摘要。 */
const RECENT_ENTRY_LIMIT = 6;
/** 长期摘要截断后的字符数。摘要是按时间顺序写的，取尾部即「最新的部分」。 */
const SUMMARY_CHAR_LIMIT = 240;
/** 世界局势截断后的字符数。 */
const WORLD_STATUS_CHAR_LIMIT = 160;
/** 世界描述截断后的字符数。只需给打分模型定题材，不需要全文。 */
const WORLD_DESC_CHAR_LIMIT = 80;
/** 特质最多带几个。特质按加入顺序排列，创角时的核心人格在前，优先保留。 */
const TRAIT_LIMIT = 8;

export interface JevStateInput {
  world: WorldSetting;
  character: CharacterState;
  worldStatus: string;
  worldAttributes?: Record<string, number>;
  historySummary: string;
  recentSegments: readonly LifeSegmentRecord[];
  decision: DecisionPoint;
}

function head(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : trimmed.slice(0, limit);
}

function tail(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : trimmed.slice(-limit);
}

/** 单行紧凑角色快照。阶位键是序号，只以阶位名的形式出现，不暴露裸索引。 */
function formatCharacterLine(world: WorldSetting, character: CharacterState): string {
  if (openLifeRules(world)) {
    const parts = [`${character.age} 岁`];
    const attributes = visibleAttributes(world)
      .map((definition) => `${definition.label} ${character.attributes[definition.key] ?? definition.initialValue}`);
    if (attributes.length > 0) parts.push(attributes.join('、'));
    if (character.traits.length > 0) parts.push(`特质：${character.traits.slice(0, TRAIT_LIMIT).join('、')}`);
    if (character.inventory.length > 0) parts.push(`持有：${character.inventory.join('、')}`);
    const relationships = Object.entries(character.relationships);
    if (relationships.length > 0) {
      parts.push(`关系：${relationships.map(([name, relation]) => `${name}（${relation}）`).join('、')}`);
    }
    return parts.join('；');
  }
  const { realmKey, cultivationKey, cultivationMax, lifespanByRealm } = world.mechanics;
  const realm = character.attributes[realmKey] ?? 0;
  const lifespan = lifespanByRealm[realm] ?? Number.POSITIVE_INFINITY;
  const remaining = lifespan - character.age;

  const parts: string[] = [`${character.age} 岁`, tierName(world, realm)];
  parts.push(
    Number.isFinite(lifespan)
      ? `寿元尚余约 ${Math.max(0, Math.round(remaining))} 年`
      : '寿元绵长',
  );

  const attributes = world.attributes
    .filter((definition) => definition.key !== realmKey)
    .map((definition) => {
      const value = character.attributes[definition.key] ?? definition.initialValue;
      return definition.key === cultivationKey
        ? `${definition.label} ${value}/${cultivationMax}`
        : `${definition.label} ${value}`;
    });
  if (attributes.length > 0) parts.push(attributes.join('、'));

  if (character.traits.length > 0) {
    parts.push(`特质：${character.traits.slice(0, TRAIT_LIMIT).join('、')}`);
  }
  if (character.inventory.length > 0) {
    parts.push(`持有：${character.inventory.join('、')}`);
  }
  const relationships = Object.entries(character.relationships);
  if (relationships.length > 0) {
    parts.push(
      `关系：${relationships.map(([name, relation]) => `${name}（${relation}）`).join('、')}`,
    );
  }

  return parts.join('；');
}

function formatRecentEntries(segments: readonly LifeSegmentRecord[]): string {
  const entries = segments
    .flatMap((record) => record.segment.entries)
    .slice(-RECENT_ENTRY_LIMIT);
  return entries.map((entry) => `${entry.age} 岁 · ${entry.text}`).join('；');
}

/**
 * 组装打分 state。
 *
 * 【选项】里的编号列表是**硬性契约**：client.ts 的 criteria 键就是这些序号，
 * 缺了它模型无法把概率映射回选项。
 */
export function buildJevState(input: JevStateInput): string {
  const { world, character, decision } = input;

  const lines: string[] = [];
  lines.push(`《${world.name}》${head(world.description, WORLD_DESC_CHAR_LIMIT)}`);
  lines.push(`【角色】${formatCharacterLine(world, character)}`);

  const status = tail(input.worldStatus, WORLD_STATUS_CHAR_LIMIT);
  if (status !== '') lines.push(`【世界局势】${status}`);
  if (world.worldAttributes && input.worldAttributes) {
    const stage = openLifeRules(world)?.worldProgress;
    const values = world.worldAttributes.map((attribute) => {
      const value = input.worldAttributes?.[attribute.key] ?? attribute.initialValue;
      return `${attribute.label} ${attribute.key === stage?.stageKey ? stage.stageNames[value] ?? value : value}`;
    });
    lines.push(`【世界进展】${values.join('、')}`);
  }

  const summary = tail(input.historySummary, SUMMARY_CHAR_LIMIT);
  if (summary !== '') lines.push(`【经历摘要】${summary}`);

  const recent = formatRecentEntries(input.recentSegments);
  if (recent !== '') lines.push(`【近年经历】${recent}`);

  lines.push(`【岔路】${decision.prompt.trim()}`);
  lines.push(`【分量】${decision.stakes.trim()}`);
  lines.push('【选项】');
  decision.options.forEach((option, index) => lines.push(`${index}. ${option}`));

  return lines.join('\n');
}

/**
 * 打分口径，刻意全局固定。
 *
 * Jev 没有系统提示词可写，这条 instructions 是唯一能表达语义的地方；
 * 它决定了分数是「像他」还是「最优」。校准的一致性依赖这份文本不变，
 * 改一个字都可能让分数分布漂移，请像对待数值参数一样对待它。
 */
export function buildJevInstructions(): string {
  return [
    '这是文字人生模拟器的一个岔路口。',
    '请判断走哪个选项最像「他」：按这个角色当下的处境、性格与已走过的路来推演，',
    '不要选看起来收益最大的——你不是在优化数值，你是在替这个人过日子。',
    '如果几个选项都说得通，就倾向那个最符合他一贯做法的。',
  ].join('');
}

/** 一次给出 JevScoreRequest 需要的全部输入，供界面层直接展开调用 client.score。 */
export function buildJevScoreRequest(input: JevStateInput): {
  state: string;
  instructions: string;
  options: readonly string[];
} {
  return {
    state: buildJevState(input),
    instructions: buildJevInstructions(),
    options: input.decision.options,
  };
}
