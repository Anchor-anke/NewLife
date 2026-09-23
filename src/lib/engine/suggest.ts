import { z } from 'zod';
import type { ChatMessage, ModelAdapter } from '@/lib/model/adapter';
import { extractJsonObject } from '@/lib/model/json';
import { buildSegmentUserMessage, buildSystemPrompt } from './context';
import type {
  CharacterState,
  DecisionPoint,
  LifeSegmentRecord,
  SegmentContext,
  WorldSetting,
} from './types';

/**
 * AI 辅助决策。
 *
 * 两件事：替玩家从岔路的选项里挑一个，以及替玩家写一个自定义决定。
 *
 * 与段落生成共用同一套上下文（世界法则、角色硬状态、长期摘要、近期年表），
 * 所以 AI 的建议和它接下来要推演的剧情是同一份事实基础，不会出现
 * 「建议你去做一件你已经做过的事」这种脱节。
 *
 * 这一层刻意**不碰任何状态**：它只产出文本，是否采纳完全由玩家决定。
 */

export interface SuggestInput {
  world: WorldSetting;
  character: CharacterState;
  worldStatus: string;
  historySummary: string;
  recentSegments: readonly LifeSegmentRecord[];
  adapter: ModelAdapter;
  signal?: AbortSignal;
}

/** 连续两次都没给出可用的建议时抛出，由界面提示玩家重试。 */
export class SuggestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SuggestError';
  }
}

const zOptionChoice = z.object({
  index: z.coerce.number(),
  reason: z.string().optional(),
});

const zActionDraft = z.object({
  action: z.string().min(1),
  reason: z.string().optional(),
});

function baseContext(input: SuggestInput): SegmentContext {
  return {
    world: input.world,
    worldStatus: input.worldStatus,
    character: input.character,
    historySummary: input.historySummary,
    recentSegments: [...input.recentSegments],
  };
}

function buildMessages(input: SuggestInput, task: string): ChatMessage[] {
  return [
    { role: 'system', content: `${buildSystemPrompt(input.world)}\n\n${task}` },
    { role: 'user', content: buildSegmentUserMessage(baseContext(input)) },
  ];
}

/** 调一次模型并把返回解析成 JSON 对象；失败返回 null，交给调用方决定是否重试。 */
async function askOnce(
  input: SuggestInput,
  messages: ChatMessage[],
): Promise<unknown | null> {
  const { text } = await input.adapter.complete(
    { messages, json: true, temperature: 0.7 },
    input.signal ? { signal: input.signal } : {},
  );
  return extractJsonObject(text);
}

export interface OptionSuggestion {
  index: number;
  reason: string;
}

export interface SuggestDecisionInput extends SuggestInput {
  decision: DecisionPoint;
}

/**
 * 让 AI 从岔路的选项里挑一个。
 *
 * 关键是**不要让它挑「最优解」**：这个模拟器的乐趣在于扮演一个人，
 * 而不是解题。所以提示词里明确要求按角色的处境与性格来选。
 */
export async function suggestOption(input: SuggestDecisionInput): Promise<OptionSuggestion> {
  const options = input.decision.options;
  if (options.length === 0) {
    throw new SuggestError('这个岔路口没有可选的行动');
  }

  const list = options.map((option, index) => `${index}. ${option}`).join('\n');
  const task = `## 你现在的任务

玩家站在一个岔路口前，让你替他决定怎么走。

岔路本身：${input.decision.prompt}
为什么重要：${input.decision.stakes}

以下是可选的行动：

${list}

请选出**最符合这个角色当下的处境、性格与已有一切经历**的那一个。
不要选「看起来收益最大」的——你不是在优化数值，你是在替这个人过日子。
如果几个选项都说得通，就选那个最像「他」会做的。

严格只输出一个 JSON 对象，不要输出 Markdown 围栏或任何解释文字：

{
  "index": 选项序号，从 0 开始的整数,
  "reason": "一句话说明为什么这么选，30 字以内"
}`;

  let lastRaw: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const messages = buildMessages(input, task);
    if (attempt > 0 && lastRaw !== null) {
      messages.push({ role: 'assistant', content: JSON.stringify(lastRaw).slice(0, 1000) });
      messages.push({
        role: 'user',
        content: `你的 index 不合法。它必须是 0 到 ${options.length - 1} 之间的整数。请重新输出 JSON。`,
      });
    }

    const parsed = await askOnce(input, messages);
    lastRaw = parsed;
    const validated = zOptionChoice.safeParse(parsed);
    if (!validated.success) continue;

    const index = Math.round(validated.data.index);
    if (!Number.isInteger(index) || index < 0 || index >= options.length) continue;

    return {
      index,
      reason: (validated.data.reason ?? '').trim() || '按这个角色一贯的做法，他大概会这么选。',
    };
  }

  throw new SuggestError('AI 没能给出可用的选择，可以再试一次');
}

export interface ActionSuggestion {
  action: string;
  reason?: string;
}

/**
 * 让 AI 替玩家写一个决定。
 *
 * 输出刻意要求「一句话、可执行」——写成长篇心理描写的话，
 * 玩家没法在提交前修改，而且会把段落生成带偏。
 */
export async function suggestAction(input: SuggestInput): Promise<ActionSuggestion> {
  const task = `## 你现在的任务

玩家站在一个岔路口前，让你替他写一个接下来要做的决定。

要求：
- **具体、可执行**，是一件真的能发生的事，不要写成心理活动或抒情。
- 一句话，30 字以内。
- 要贴合角色当下的处境与状态，不要凭空给他还没有的东西。
- 不要复述历史，也不要替后面的剧情下结论。

严格只输出一个 JSON 对象，不要输出 Markdown 围栏或任何解释文字：

{
  "action": "一句话的决定",
  "reason": "可选。一句话说明为什么想这么做，30 字以内"
}`;

  const parsed = await askOnce(input, buildMessages(input, task));
  const validated = zActionDraft.safeParse(parsed);
  if (!validated.success) {
    throw new SuggestError('AI 没能写出可用的决定，可以再试一次');
  }

  const action = validated.data.action.trim().slice(0, 120);
  if (action === '') {
    throw new SuggestError('AI 写出来的决定是空的，可以再试一次');
  }

  const reason = (validated.data.reason ?? '').trim();
  return reason === '' ? { action } : { action, reason };
}
