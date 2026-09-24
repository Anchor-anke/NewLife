import type { ChatMessage, ModelAdapter, RepairFeedback } from '@/lib/model/adapter';
import { extractJsonObject } from '@/lib/model/json';
import { buildRepairMessage, buildSegmentUserMessage, buildSystemPrompt } from './context';
import { planStop, type StopPlan } from './decision';
import { normalizeSegment } from './normalize';
import { resolveSegment, type ResolveSegmentResult, type Rng } from './resolve';
import { parseSegmentProposal } from './schema';
import type {
  CharacterState,
  LifeSegment,
  LifeSegmentRecord,
  ModelMeta,
  SegmentContext,
  WorldSetting,
} from './types';

/**
 * 段落控制器。
 *
 * 完整管线：算强制停车 → 组装上下文 → 调用模型 → 结构校验（失败则回灌错误重试）
 * → 数值规整 → 规则结算（含决策门槛）。这一层不碰持久化，也不碰界面，
 * 因此可以用假适配器完整测试。
 *
 * 与重构前唯一的顺序差别是**强制停车判定提到了调用之前**：这个结论既要写进
 * 提示词（要求模型本段必须给决策点），又要参与后置门槛，必须在同一次调用里
 * 只算一遍，因此在这里算出后一路传给结算层。
 */

/** 结构校验失败后允许的重试次数。初次请求 + 2 次重试 = 最多 3 次调用。 */
export const MAX_REPAIR_ATTEMPTS = 2;

/**
 * 段落推进的阶段。
 *
 * 因为 `json_object` 模式下不适合做流式预览（流出来的是 JSON 片段，渲染很丑），
 * 界面改用阶段提示来告诉玩家「现在进行到哪一步」，避免长时间无反馈。
 */
export type SegmentStage = 'generating' | 'validating' | 'resolving';

/** 回灌给模型的原始返回会被截断，避免把上下文撑爆。 */
const FEEDBACK_RAW_LIMIT = 4000;

/** 重试若干次后仍然不符合结构约定时抛出，由界面提示玩家重试。 */
export class SegmentGenerationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      issues.length > 0
        ? `模型连续 ${MAX_REPAIR_ATTEMPTS + 1} 次返回的内容都不符合约定结构：${issues.join('；')}`
        : '模型返回的内容不符合约定结构',
    );
    this.name = 'SegmentGenerationError';
    this.issues = issues;
  }
}

export interface RunSegmentInput {
  world: WorldSetting;
  character: CharacterState;
  worldStatus: string;
  worldAttributes?: Record<string, number>;
  historySummary: string;
  recentSegments: readonly LifeSegmentRecord[];
  /** 玩家在上一处岔路口的决定。世界自行运转时不传。 */
  playerAction?: string;
  segmentId: number;
  /** 上一次真正停车的段号，0 表示还没停过 */
  lastDecisionSegmentId: number;
  adapter: ModelAdapter;
  /** 注入以便测试可复现 */
  rng?: Rng;
  signal?: AbortSignal;
  /** 阶段回调，供界面展示「生成中 / 校验中 / 结算中」 */
  onStage?: (stage: SegmentStage) => void;
}

export interface RunSegmentOutput {
  /** 已结算的段落（含经门槛采纳的决策点），可直接持久化 */
  proposal: LifeSegment;
  /** 程序结算结果 */
  resolution: ResolveSegmentResult;
  /** 调用前算出的强制停车计划，便于界面与调试解释「这次为什么停车」 */
  stopPlan: StopPlan;
  /** 规整与结算过程中产生的全部警告 */
  warnings: string[];
  modelMeta: ModelMeta;
}

export function buildSegmentContext(input: RunSegmentInput, stopPlan: StopPlan): SegmentContext {
  const context: SegmentContext = {
    world: input.world,
    worldStatus: input.worldStatus,
    ...(input.worldAttributes ? { worldAttributes: input.worldAttributes } : {}),
    character: input.character,
    historySummary: input.historySummary,
    recentSegments: [...input.recentSegments],
  };
  if (input.playerAction !== undefined) context.playerAction = input.playerAction;
  if (stopPlan.stop && stopPlan.cause) context.mustStop = stopPlan.cause;
  return context;
}

export async function runSegment(input: RunSegmentInput): Promise<RunSegmentOutput> {
  const { world, adapter } = input;

  const stopPlan = planStop({
    world,
    character: input.character,
    segmentId: input.segmentId,
    lastDecisionSegmentId: input.lastDecisionSegmentId,
  });

  const systemPrompt = buildSystemPrompt(world);
  const userMessage = buildSegmentUserMessage(buildSegmentContext(input, stopPlan));

  let feedback: RepairFeedback | undefined;
  let lastIssues: string[] = [];
  let totalLatencyMs = 0;
  let retries = 0;

  for (let attempt = 0; attempt <= MAX_REPAIR_ATTEMPTS; attempt += 1) {
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];

    if (feedback) {
      messages.push({
        role: 'assistant',
        content: feedback.previousRaw.slice(0, FEEDBACK_RAW_LIMIT),
      });
      messages.push({ role: 'user', content: buildRepairMessage(feedback.issues) });
    }

    input.onStage?.('generating');
    const { text, latencyMs } = await adapter.complete(
      { messages, json: true },
      input.signal ? { signal: input.signal } : {},
    );
    totalLatencyMs += latencyMs;

    input.onStage?.('validating');
    const raw = extractJsonObject(text);
    if (raw === null) {
      lastIssues = ['返回内容不是合法的 JSON 对象，请只输出 JSON'];
      feedback = { previousRaw: text, issues: lastIssues };
      retries = attempt + 1;
      continue;
    }

    // 结构校验带上「本段是否必须给决策点」：程序判定必须停车时，提示词里已经
    // 明确要求过，模型漏掉它属于没遵守契约，先走回灌重试而不是让它悄悄溜过去。
    //
    // **但最后一次尝试要放宽**：模型要是三次都不给，报错把整局卡死，
    // 比「这一段没有岔路」糟糕得多。此时照常结算并记一条警告，
    // 下一段的 planStop 依然会要求决策点（lastDecisionSegmentId 没有推进），
    // 所以缺失是自愈的、有界的。
    const isLastAttempt = attempt >= MAX_REPAIR_ATTEMPTS;
    const parsed = parseSegmentProposal(raw, {
      requireDecision: stopPlan.stop && !isLastAttempt,
    });
    if (!parsed.ok) {
      lastIssues = parsed.issues;
      feedback = { previousRaw: text, issues: lastIssues };
      retries = attempt + 1;
      continue;
    }

    // 结构过关之后才做数值规整与结算——能修的问题不该浪费一次模型调用。
    input.onStage?.('resolving');
    const { proposal, warnings: normalizeWarnings } = normalizeSegment(
      parsed.proposal,
      world,
      input.character,
    );

    const resolution = resolveSegment({
      world,
      character: input.character,
      worldStatus: input.worldStatus,
      ...(input.worldAttributes ? { worldAttributes: input.worldAttributes } : {}),
      proposal,
      segmentId: input.segmentId,
      lastDecisionSegmentId: input.lastDecisionSegmentId,
      stopPlan,
      ...(input.rng ? { rng: input.rng } : {}),
    });

    const warnings = [...normalizeWarnings, ...resolution.warnings];

    return {
      proposal: resolution.segment,
      resolution: { ...resolution, warnings },
      stopPlan,
      warnings,
      modelMeta: {
        provider: adapter.provider,
        model: adapter.model,
        latencyMs: totalLatencyMs,
        retries,
      },
    };
  }

  throw new SegmentGenerationError(lastIssues);
}
