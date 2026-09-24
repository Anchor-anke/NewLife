import {
  type CharacterState,
  type EpilogueInput,
  type LifeEntry,
  type LifeSegmentRecord,
  type SegmentContext,
  type SummaryInput,
  type WorldSetting,
} from './types';
import { TIME_UNIT_LABELS, attributeLabel, tierName } from './labels';
import { timeAdvanceHint } from './pacing';
import type { StopPlan } from './decision';
import { openLifeRules, visibleAttributes } from './ruleset';

/**
 * 上下文组装。
 *
 * 拼装顺序刻意如此（越靠近生成点的信息，模型越重视）：
 *   固定世界规则 → 长期摘要 → 近期年表 → 当前世界局势 → 角色硬状态 → 玩家决定
 *
 * 角色硬状态紧挨着玩家决定，是为了让模型在动笔前最后看到的数字就是「现在几岁、
 * 还剩多少寿元、修为差多少」，从而把寿元的紧迫感写进叙事里。
 *
 * 年表重构后这里还有一条**成本纪律**：近期历史只喂条目，不喂 detail。
 * 条目是一句话，detail 是完整叙事——把历史里的 detail 全带上，等于每一段都在
 * 重发过去几十段的散文，省下来的 token 又全花回去了。只有 milestone 的 detail
 * 会带上，因为那才是后面剧情真正依赖的因果。
 */

/** 提示词里出现的属性展示顺序：主属性在前。 */
function orderedAttributes(world: WorldSetting) {
  return [...visibleAttributes(world)].sort((a, b) => Number(b.primary ?? false) - Number(a.primary ?? false));
}

function formatCharacterState(world: WorldSetting, character: CharacterState): string {
  const open = openLifeRules(world);
  if (open) {
    const lines = [`- 姓名：${character.name}`, `- 年龄：${character.age} 岁`];
    for (const definition of orderedAttributes(world)) {
      lines.push(`- ${definition.label}：${character.attributes[definition.key] ?? definition.initialValue}${definition.unit ?? ''}`);
    }
    if (character.traits.length > 0) lines.push(`- 特质：${character.traits.join('、')}`);
    if (character.inventory.length > 0) lines.push(`- 持有：${character.inventory.join('、')}`);
    const relationships = Object.entries(character.relationships);
    if (relationships.length > 0) {
      lines.push(`- 关系：${relationships.map(([name, relation]) => `${name}（${relation}）`).join('、')}`);
    }
    return lines.join('\n');
  }
  const { realmKey, cultivationKey, cultivationMax, lifespanByRealm } = world.mechanics;
  const realm = character.attributes[realmKey] ?? 0;
  const lifespan = lifespanByRealm[realm] ?? Number.POSITIVE_INFINITY;
  const remaining = lifespan - character.age;

  const lines: string[] = [];
  lines.push(`- 姓名：${character.name}`);
  lines.push(
    `- 年龄：${character.age} 岁（当前阶位「${tierName(world, realm)}」，寿元上限 ${
      Number.isFinite(lifespan) ? `${lifespan} 岁` : '无上限'
    }，${
      Number.isFinite(remaining) ? `尚余约 ${Math.max(0, Math.round(remaining))} 年` : '寿元绵长'
    }）`,
  );

  for (const definition of orderedAttributes(world)) {
    const value = character.attributes[definition.key] ?? definition.initialValue;
    if (definition.key === cultivationKey) {
      lines.push(`- ${definition.label}：${value} / ${cultivationMax}（满则可冲击下一阶位）`);
    } else if (definition.key === realmKey) {
      continue;
    } else {
      lines.push(`- ${definition.label}：${value}${definition.unit ?? ''}`);
    }
  }

  if (character.traits.length > 0) lines.push(`- 特质：${character.traits.join('、')}`);
  if (character.inventory.length > 0) lines.push(`- 持有：${character.inventory.join('、')}`);

  const relationships = Object.entries(character.relationships);
  if (relationships.length > 0) {
    lines.push(
      `- 关系：${relationships.map(([name, relation]) => `${name}（${relation}）`).join('、')}`,
    );
  }

  return lines.join('\n');
}

/** 单条条目在提示词里的写法。只有 milestone 才带 detail，见文件头部的成本纪律。 */
function formatEntry(entry: LifeEntry): string {
  const line = `${entry.age} 岁 · [${entry.kind}] ${entry.text}`;
  if (entry.kind !== 'milestone' || !entry.detail) return line;
  return `${line}\n  ${entry.detail}`;
}

/**
 * 近期年表。
 *
 * 刻意只给条目与 milestone 的 detail：这一段的目的是让模型知道
 * 「发生过什么、走到哪了」，而不是让它重读一遍自己写过的散文。
 */
function formatRecentSegments(world: WorldSetting, segments: readonly LifeSegmentRecord[]): string {
  if (segments.length === 0) return '（尚无历史，这是故事的开端。）';

  const unit = TIME_UNIT_LABELS[world.timeUnit];

  return segments
    .map((record) => {
      const from = record.characterBefore.age;
      const to = record.resolvedCharacter.age;
      if (openLifeRules(world)) {
        const action = record.playerAction === undefined ? '世界自行运转' : `玩家的决定：${record.playerAction}`;
        const entries = record.segment.entries.map((entry) => `  ${formatEntry(entry)}`).join('\n');
        return `【第 ${record.segmentId} 段】${from} → ${to} 岁（历时 ${record.segment.timeAdvance} ${unit}；${action}）\n${entries}`;
      }
      const realmKey = world.mechanics.realmKey;
      const fromRealm = record.characterBefore.attributes[realmKey] ?? 0;
      const toRealm = record.resolvedCharacter.attributes[realmKey] ?? 0;
      const settledTier = `${attributeLabel(world, realmKey)}：${tierName(world, fromRealm)} → ${tierName(world, toRealm)}`;
      const header =
        record.playerAction === undefined
          ? `【第 ${record.segmentId} 段】${from} → ${to} 岁（历时 ${record.segment.timeAdvance} ${unit}，世界自行运转；系统结算 ${settledTier}）`
          : `【第 ${record.segmentId} 段】${from} → ${to} 岁（历时 ${record.segment.timeAdvance} ${unit}；系统结算 ${settledTier}）\n玩家的决定：${record.playerAction}`;

      const entries = record.segment.entries.map((entry) => `  ${formatEntry(entry)}`).join('\n');
      return `${header}\n${entries}`;
    })
    .join('\n\n');
}

function outputContractOpen(world: WorldSetting, character: CharacterState): string {
  const open = openLifeRules(world);
  if (!open) throw new Error('只有开放人生世界可使用此输出契约');
  const [minYears, maxYears] = timeAdvanceHint(world, 0);
  const writable = visibleAttributes(world).map((attribute) => `"${attribute.key}"（${attribute.label}）`).join('、');
  const careerLabel = attributeLabel(world, open.careerKey);
  const healthLabel = attributeLabel(world, open.healthKey);
  const worldWritable = (world.worldAttributes ?? [])
    .filter((attribute) => attribute.key !== open.worldProgress?.stageKey)
    .map((attribute) => `"${attribute.key}"（${attribute.label}）`).join('、');
  const worldField = worldWritable ? `\n  "worldDeltas": { "${open.worldProgress?.progressKey ?? world.worldAttributes?.[0]?.key ?? 'resource'}": 0 },` : '';
  const worldInstruction = worldWritable
    ? `\n- 世界变化只用这些键：${worldWritable}。${open.worldProgress ? '殖民地阶段由程序依据建设进度判定，绝不能直接写入 stage；' : ''}世界进展与人物健康分开。`
    : '';
  const rankInstruction = open.earnedRank
    ? `\n- 「${attributeLabel(world, open.earnedRank.key)}」最多变化一级，且本段必须有完成委托或正式评定的 milestone 条目作为依据。只描写依据，不预告程序最终评定结果。`
    : '';
  const custom = open.custom;
  const customInstruction = custom ? `\n- 程序每年自动调整世界资源：${Object.entries(custom.annualWorldDeltas).map(([key, delta]) => `${world.worldAttributes?.find((attribute) => attribute.key === key)?.label ?? key} ${delta}`).join('、')}。这些自动变化不要再写进 worldDeltas。\n- 目标「${custom.objective.reason}」由程序在 ${custom.objective.scope === 'world' ? '世界' : '人物'}属性 ${custom.objective.key} 达到 ${custom.objective.threshold} 时判定。\n- 失败「${custom.failure.reason}」由程序在世界属性 ${custom.failure.key} 降到 ${custom.failure.threshold} 时判定。\n- ${custom.aging ? '人物会自然衰老。' : '人物不会仅因年龄增长而衰老，但仍会受伤或死亡。'}不要提前在故事中宣告目标完成或失败。` : '';
  return `严格只输出一个 JSON 对象，不要输出 Markdown 或解释。结构如下：
{
  "entries": [{ "age": ${character.age + 1}, "kind": "event", "text": "具体发生的一件事", "detail": "可选，仅重大事件展开" }],
  "timeAdvance": ${minYears},
  "attributeDeltas": { "${open.careerKey}": 0 },${worldField}
  "worldStatusUpdate": "可选。世界局势确有变化时给出",
  "decision": { "prompt": "发生了什么", "stakes": "这个选择的代价", "options": ["行动一", "行动二"] },
  "endingProposal": { "type": "completion", "reason": "可选。人生确有收束时给出" }
}
字段规则：
- 给出 4~12 条按年龄先后排列的具体事件，覆盖 ${minYears}~${maxYears} 年。年龄只能在 ${character.age}~${character.age + maxYears} 岁之间，条目正文一般为 15~40 字。
- kind 只用 event、relationship、fortune、setback、milestone；不要使用 cultivation。
- 属性变化只用这些键：${writable}。${careerLabel}、${healthLabel}、资源与关系各自变化；不要写自动阶位突破或等级寿命。
- 属性变化是整段的相对增量，单项一般不超过 ±10。${healthLabel}和${careerLabel}不能仅凭年龄自动增加；年龄衰退由程序单独结算。
- 人物的职业或任务进度不是世界阶段，不能用人物属性代替世界变化。${worldInstruction}${rankInstruction}${customInstruction}
- 决策只在不可轻易反悔的利益、关系、健康或人生目标冲突时提出，给 2~4 个不同选项。日常小事不要停车。
- 不要在文字中预告程序尚未确认的死亡、目标完成或最终状态。结束提议由程序核准。
- worldStatusUpdate、traitOps、inventoryOps、relationshipOps 没有变化时可省略。`;
}

/** 描述输出的 JSON 结构。字段说明要具体，否则模型很容易漏字段。 */
function outputContract(world: WorldSetting, realm: number, character: CharacterState): string {
  if (openLifeRules(world)) return outputContractOpen(world, character);
  const { cultivationKey, realmKey } = world.mechanics;
  const writable = world.attributes
    .filter((attribute) => attribute.key !== cultivationKey && attribute.key !== realmKey)
    .map((attribute) => `"${attribute.key}"`)
    .join('、');
  const unit = TIME_UNIT_LABELS[world.timeUnit];
  const cultivationLabel = attributeLabel(world, cultivationKey);
  const realmLabel = attributeLabel(world, realmKey);
  const [minYears, maxYears] = timeAdvanceHint(world, realm);
  const startAge = character.age;
  const endAge = character.age + maxYears;

  return `严格只输出一个 JSON 对象，不要输出 Markdown 代码围栏、不要输出任何解释文字。结构如下：

{
  "entries": [
    { "age": ${startAge + 1}, "kind": "relationship", "text": "周砚托人捎来一封信，说家里添了个儿子，取名念山" },
    { "age": ${startAge + 2}, "kind": "setback", "text": "你试着再往前走一步，差了一线，此后半年都没能静下心" },
    { "age": ${startAge + 3}, "kind": "milestone", "text": "你试着迈过困住自己多年的门槛", "detail": "100~200 字的完整叙事，只有重要条目才给" }
  ],
  "timeAdvance": 本段覆盖的${unit}数，整数，${minYears}~${maxYears} 之间,
  "attributeDeltas": { 属性键: 变化量 },
  "worldStatusUpdate": "可选。当前世界局势的一句话概括，只有局势真的变化时才给出",
  "decision": {
    "prompt": "1~3 句话，说清现在发生了什么",
    "stakes": "1 句话，让玩家明白这次选择的分量",
    "options": ["选项一", "选项二", "选项三"]
  },
  "traitOps": [{ "op": "add", "value": "新获得的特质" }],
  "inventoryOps": [{ "op": "add", "value": "获得的物品" }],
  "relationshipOps": [{ "op": "set", "target": "人物名", "value": "关系描述" }],
  "endingProposal": { "type": "death", "reason": "结局原因" }
}

字段规则：
- "entries" 给 4~12 条，按时间先后排列，铺满本段覆盖的这些年。这是本段的主产物。
- "kind" 只能取这六个值：cultivation（修行积累）/ event（世事）/ relationship（人际）/ fortune（际遇）/ setback（挫折）/ milestone（重大转折）。
- "text" 写**一到两句话**，一般 15~40 字。要能被一眼扫过，但**不要写成电报**：
  「周砚捎信，得一子，唤作念山」这种把一句话压成主谓宾摘要的写法是**不合格**的，
  改成「周砚托人捎来一封信，说家里添了个儿子，取名念山」——同样只占一行，
  但有人、有语气、有一点温度。省掉的是细节，不是句子本身。
- 再比如「与师父决裂」是摘要，而「你把师父留下的剑放在山门口，没有回头」才是发生过的事。
  条目不需要展开成完整叙事，但每一行都要有具体的质地：人名、物件、地点、一个动作。
- 连续 3 条以上同 kind 的条目会被判为流水账并退回重写，请把不同类型的事情交替铺开。
- "age" 必须落在 ${startAge}~${endAge} 岁之间，且随时间递增。
- "detail" 只在真正重要时才给：尝试突破、重大际遇、亲密关系的变化、濒死、重要的失去。其余条目一律不给 detail。
- 玩家当前的${realmLabel}与${cultivationLabel}由系统结算。不要在 text、detail、decision 或 worldStatusUpdate 中预判玩家突破成功或失败，也不要宣称玩家已升至某个新阶位；可以描写尝试、瓶颈、征兆和代价。实际结果由系统结算后写入年表。
- "decision" 只在剧情走到**会改变长期走向的岔路**时才给（拜师、迁徙、结仇、托付、放弃）。日常的取舍不算岔路，不要给。给的时候必须带 2~4 个互不相同的选项。
- "attributeDeltas" 只允许使用这些键：${writable}。不要写入 "${cultivationKey}"（${cultivationLabel}）或 "${realmKey}"（${realmLabel}）——它们由系统结算。
- 属性变化量是**相对增量**，不是新值。变化幅度要克制，单段一般不超过 ±10。
- "timeAdvance" 必须与条目覆盖的时间一致：${minYears}~${maxYears} ${unit}。
- "endingProposal" 只在剧情真的走到尽头时才给出。系统会独立校验，不会照单全收。
- "worldStatusUpdate"、"traitOps"、"inventoryOps"、"relationshipOps" 没有变化时可以省略或给空数组。`;
}

/** 程序判定本段必须停车时，追加的强制指令。 */
function mustStopInstruction(stopPlan: StopPlan): string {
  if (!stopPlan.stop) return '';

  const reason =
    stopPlan.cause === 'near-end'
      ? '角色已经进入当前阶位的寿元末段，该给他一次收束这一生的机会'
      : stopPlan.cause === 'life-turn'
        ? '人物已接近人生末段或健康危急，应给玩家一次重要选择的机会'
      : '已经很久没有让玩家介入了，参与感会消失';

  return `\n\n## 本段的硬性要求\n${reason}。因此**本段结束时必须给出一个 decision**，而且必须是一个真正会改变长期走向的岔路，不要用「继续修炼还是下山」这类日常取舍充数。`;
}

export function buildSystemPrompt(world: WorldSetting): string {
  const rules = world.rules.map((rule, index) => `${index + 1}. ${rule}`).join('\n');
  const attributeDocs = orderedAttributes(world)
    .map((attribute) => {
      const range =
        attribute.min !== undefined && attribute.max !== undefined
          ? `取值范围 ${attribute.min}~${attribute.max}`
          : attribute.min !== undefined
            ? `不低于 ${attribute.min}`
            : '无固定范围';
      return `- ${attribute.label}（${attribute.key}）：${range}`;
    })
    .join('\n');

  if (openLifeRules(world)) {
    const custom = openLifeRules(world)?.custom;
    const worldAttributes = (world.worldAttributes ?? [])
      .map((attribute) => `- ${attribute.label}（${attribute.key}）：世界状态，不属于人物；范围 ${attribute.min ?? 0}~${attribute.max ?? 100}`).join('\n');
    return `你是文字人生模拟器《${world.name}》的叙事引擎。

${world.description}

## 固定世界法则
${rules}

## 属性说明
${attributeDocs}
${worldAttributes ? `\n## 世界属性\n${worldAttributes}\n` : ''}
${custom ? `\n## 程序规则\n- 每年自动资源变化：${Object.entries(custom.annualWorldDeltas).map(([key, delta]) => `${key} ${delta}`).join('、')}。\n- 达成目标：${custom.objective.key} ${custom.objective.operator === 'gte' ? '达到' : '降到'} ${custom.objective.threshold}。\n- 目标失败：${custom.failure.key} 降到 ${custom.failure.threshold}。\n- ${custom.aging ? '人物自然衰老。' : '人物不会因年龄自然衰老。'}\n` : ''}

## 你的职责
1. 依据既有事实和这个世界的法则推进人生，写出一段岁月中的具体事件与人物关系。
2. 玩家行动只是尝试，结果须符合现有资源、健康、关系和世界法则。
3. 人物的目标、资源、健康和关系各自演变。没有自动阶位突破，也不因地位提升而延长寿命。
4. 重要决定有代价；不要把“成功”简化为收入或社会阶层上升。
5. 条目写具体的人、地点、物件与动作；重要事件才给完整 detail。
6. 只使用列出的属性键，按 JSON 契约输出。`;
  }

  return `你是文字人生模拟器《${world.name}》的叙事引擎。

${world.description}

## 固定世界法则
${rules}

## 时间单位
时间以「${TIME_UNIT_LABELS[world.timeUnit]}」为单位推进。你每次产出的不是「一段剧情」，
而是**一段被压缩过的岁月**：从当前年龄往下推进若干年，把这些年里真正发生的事
写成若干条条目。随着角色成长，一次推进跨越的时间会越来越长，这是正常的。

## 属性说明
${attributeDocs}

## 你的职责
1. 依据世界法则、既有事实与角色能力，推进时间，产出这一段的条目流。
2. 玩家的决定是**尝试**，不代表必然成功，也不能凌驾于世界法则之上。
3. 条目必须与属性变化一致：写下了什么，就给出对应的数值变化。阶位与进度除外，它们由系统结算，不能预写成功、失败或最终阶位。
4. 时间是稀缺资源。角色寿元有限，请让岁月的流逝有分量，而不是轻描淡写。
5. 绝大多数年份是平淡的。**只有真正重要的事才配展开成完整叙事**——
   尝试突破、重大际遇、亲密关系的变化、濒死、重要的失去。其余写成条目。
6. 但**简短不等于压缩**。条目是一行，不是一行摘要：写人、写动作、写具体的物件与地点，
   而不是把一件事提炼成主谓宾。同样占一行，「他把剑留在山门口」远胜过「与师父决裂」。
7. 只使用上面列出的属性键，不要发明新属性。
8. 仅输出约定的 JSON 结构。`;
}

export function buildSegmentUserMessage(context: SegmentContext): string {
  const { world, character } = context;
  const realm = character.attributes[world.mechanics.realmKey] ?? 0;

  const sections: string[] = [];

  if (context.historySummary.trim() !== '') {
    sections.push(`## 长期摘要\n${context.historySummary.trim()}`);
  }

  sections.push(`## 近期年表\n${formatRecentSegments(world, context.recentSegments)}`);

  sections.push(
    `## 当前世界局势\n${context.worldStatus.trim() === '' ? '（尚未展开，可在本段确立。）' : context.worldStatus.trim()}`,
  );
  if (world.worldAttributes && context.worldAttributes) {
    const stage = openLifeRules(world)?.worldProgress;
    sections.push(`## 当前世界状态\n${world.worldAttributes.map((attribute) => {
      const value = context.worldAttributes?.[attribute.key] ?? attribute.initialValue;
      return `- ${attribute.label}：${attribute.key === stage?.stageKey ? `${stage.stageNames[value] ?? value}（${value}）` : value}`;
    }).join('\n')}`);
  }

  sections.push(`## 角色当前状态\n${formatCharacterState(world, character)}`);
  sections.push(openLifeRules(world)
    ? '## 事实优先级\n人物年龄、属性和关系只以「角色当前状态」为准。旧摘要若有冲突，以当前状态为准；不得预判程序结局。'
    : '## 事实优先级\n角色当前阶位与进度只以「角色当前状态」为准。长期摘要和旧条目若有不同说法，不要沿用；本段也不要预判系统结算结果。');

  sections.push(
    context.playerAction === undefined
      ? '## 玩家决定\n（没有介入，世界自行运转。请让这些年自然流淌，不要替玩家做重大决定。）'
      : `## 玩家在岔路口的决定\n${context.playerAction}`,
  );

  sections.push(`## 输出要求\n${outputContract(world, realm, character)}`);

  if (context.mustStop) {
    sections.push(mustStopInstruction({ stop: true, cause: context.mustStop }).trim());
  }

  return sections.join('\n\n');
}

/** 结构校验失败时回灌给模型的修正指令。 */
export function buildRepairMessage(issues: readonly string[]): string {
  return `你上一次的输出不符合约定结构，问题如下：

${issues.map((issue) => `- ${issue}`).join('\n')}

请重新输出**完整**的 JSON 对象，修正以上全部问题。只输出 JSON，不要解释。`;
}

// ────────────────────────────────────────────────────────────
// 摘要与人生总结
// ────────────────────────────────────────────────────────────

export function buildSummarySystemPrompt(world: WorldSetting): string {
  return `你在为《${world.name}》这部文字人生模拟器维护一份「长期记忆」。

你的任务是把旧摘要与新增段落压缩成一份新的摘要，供后续叙事参考。

要求：
1. 保留关键人物、承诺、因果链、未完成的恩怨与重大世界事件。
2. 保留角色的目标、执念与处境变化。
3. 丢弃日常琐事与重复描写。
4. 用紧凑的陈述句，不要分点罗列，不要标题，不要 Markdown。
5. 直接输出摘要正文，不要任何前后缀说明。
6. 总长度控制在 600 字以内。`;
}

export function buildSummaryUserMessage(input: SummaryInput): string {
  const previous = input.previousSummary.trim();
  const segments = input.segments
    .map((record) => {
      const head = `【第 ${record.segmentId} 段 · ${record.characterBefore.age}→${record.resolvedCharacter.age} 岁】`;
      const action =
        record.playerAction === undefined ? '' : `玩家决定：${record.playerAction}\n`;
      // 摘要本身就是要压缩，因此只喂条目与 milestone 的 detail
      const entries = record.segment.entries.map((entry) => `  ${formatEntry(entry)}`).join('\n');
      return `${head}\n${action}${entries}`;
    })
    .join('\n\n');
  const latestWorld = input.segments.at(-1)?.resolvedWorldAttributes;
  const worldState = latestWorld && input.world.worldAttributes
    ? `\n\n## 当前世界进展\n${input.world.worldAttributes.map((attribute) => `${attribute.label}：${latestWorld[attribute.key] ?? attribute.initialValue}`).join('、')}`
    : '';

  return `## 已有摘要
${previous === '' ? '（暂无，这是第一次生成摘要。）' : previous}

## 需要并入摘要的新段落
${segments}

## 角色当前状态
${formatCharacterState(input.world, input.character)}${worldState}

请输出合并后的新摘要。`;
}

export function buildEpilogueSystemPrompt(world: WorldSetting): string {
  return `你在为《${world.name}》这部文字人生模拟器撰写「生平总结」，也就是角色一生落幕时的盖棺之论。

要求：
1. 用第二人称「你」，语气沉静克制，不要煽情。
2. 回顾这一生的关键转折：起步时的处境、得到过什么、失去过什么、最终走到了哪里。
3. 必须与给定的事实一致，不得虚构未发生过的重要事件。
4. 结尾落在结局本身，不要写成祝福语或续作预告。
5. 400~700 字，直接输出正文，不要标题，不要 Markdown。`;
}

export function buildEpilogueUserMessage(input: EpilogueInput): string {
  const { world, ending } = input;
  const realm = input.character.attributes[world.mechanics.realmKey] ?? 0;

  const milestones = input.segments
    .flatMap((record) => record.segment.entries)
    .filter((entry) => entry.kind === 'milestone' || entry.detail !== undefined)
    .slice(-16)
    .map((entry) => `${entry.age} 岁 · ${entry.text}${entry.detail ? `——${entry.detail}` : ''}`)
    .join('\n');

  const finalState = openLifeRules(world)
    ? `- 最终${attributeLabel(world, world.ruleset!.careerKey)}：${input.character.attributes[world.ruleset!.careerKey] ?? 0}`
    : `- 终局阶位：${tierName(world, realm)}`;
  const latestWorld = input.segments.at(-1)?.resolvedWorldAttributes;
  const worldProgress = world.ruleset?.worldProgress;
  const finalWorldState = latestWorld && world.worldAttributes
    ? `\n- 世界进展：${world.worldAttributes.map((attribute) => {
        const value = latestWorld[attribute.key] ?? attribute.initialValue;
        return `${attribute.label} ${attribute.key === worldProgress?.stageKey ? worldProgress.stageNames[value] ?? value : value}`;
      }).join('、')}`
    : '';

  return `## 结局
类型：${ending.type === 'death' ? '死亡' : ending.type === 'failure' ? '目标失败' : openLifeRules(world) ? '目标完成或人生收束' : '圆满'}
原因：${ending.reason}
${ending.narrative}

## 最终状态
${formatCharacterState(world, input.character)}

## 一生轨迹
${finalState}${finalWorldState}
- 总段落数：${input.stats.totalSegments}
- ${ending.type === 'death' ? '享年' : '结束时年龄'}：${input.character.age} 岁

## 历史摘要
${input.historySummary.trim() === '' ? '（无摘要。）' : input.historySummary.trim()}

## 一生中的大事
${milestones === '' ? '（没有留下条目。）' : milestones}

请撰写这一生的生平总结。`;
}
