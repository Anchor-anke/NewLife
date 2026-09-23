import { z } from 'zod';
import { ModelError, kindFromStatus, toModelError } from '@/lib/model/errors';

/**
 * Jev（TypeSafe System One）打分客户端。
 *
 * Jev 是「决策专用」模型：不做自回归生成，单次前向并行算出整个选项集上的
 * 概率分布。它和段落生成用的 LLM（`lib/model/adapter.ts`）是两类东西：
 * - LLM：慢、贵、会写理由，负责「剧情」；
 * - Jev：快（约 70~500ms）、只按输入 token 计费、只出概率，负责「打分」。
 *
 * 协议契约见 https://docs.typesafe.ai/api.md ：
 *   POST {base}/v1/systemone，Bearer 鉴权
 *   请求  { state, model, questions: { <key>: { type, instructions?, criteria } } }
 *   响应  { model, answers: { <key>: { type, choice, probabilities, confidence } }, usage }
 *
 * 与 suggest 层一样，它只产出建议：分数给界面做展示，绝不碰状态、不参与结算。
 */

export interface JevConfig {
  /**
   * 形如 `https://api.typesafe.ai`。带 `/v1` 后缀或填完整端点也能识别，
   * 和 `resolveChatEndpoint` 对 `/chat/completions` 的宽容度保持一致。
   */
  baseUrl: string;
  apiKey: string;
  /** 缺省用 `jev-latest`，跟随官方的版本指针 */
  model?: string;
}

export interface JevDeps {
  /** 注入以便测试；默认用全局 fetch */
  fetchImpl?: typeof fetch;
}

export interface JevScoreRequest {
  /**
   * 喂给模型的状态。字符串或结构化对象都收（协议本身支持）。
   *
   * 隐含契约：criteria 的键是**选项序号**（见下），state 必须让模型能把
   * 序号映射回选项——也就是要有一份 `0. xxx / 1. xxx` 的编号列表。
   * 组装 state 是调用方（`state.ts`）的职责，这里不代劳。
   */
  state: string | Record<string, unknown>;
  /** 打分的口径，例如「按这个角色的处境与性格来推演」 */
  instructions?: string;
  /** 选项列表。顺序即返回 scores 的顺序。 */
  options: readonly string[];
}

export interface JevOptionScore {
  index: number;
  option: string;
  probability: number;
}

export interface JevScoreResult {
  model: string;
  /** 与请求 options 同序 */
  scores: JevOptionScore[];
  /** probabilities 的 argmax。不采用响应里的 choice 字段做判定（见 score 内注释） */
  topIndex: number;
  confidence: number;
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * usage 的两种写法都要认：官方直连是 snake_case（`input_tokens`），
 * Vercel AI Gateway 的 /v1/evaluate 是驼峰（`inputTokens`）。
 */
const zUsage = z.object({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
});

const zSystemOneResponse = z.object({
  model: z.string(),
  answers: z.record(z.string(), z.record(z.string(), z.unknown())),
  usage: zUsage.optional(),
});

const zChoiceAnswer = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number(),
});

/** 拼接 System One 端点。兼容根地址、带 `/v1`、以及完整端点三种写法。 */
export function resolveSystemOneEndpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (base.endsWith('/systemone')) return base;
  if (base.endsWith('/v1')) return `${base}/systemone`;
  return `${base}/v1/systemone`;
}

/**
 * 读上游错误里的人话片段。
 *
 * 官方端点的错误体实测是 `{ detail: { error_type, message } }`；
 * 兼容网关常见的 `{ error: { message } }` 写法。两者都没有时由调用方
 * 回退到原始响应片段。
 */
function readErrorDetail(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const record = payload as Record<string, unknown>;

  for (const key of ['detail', 'error']) {
    const nested = record[key];
    if (typeof nested === 'object' && nested !== null) {
      const message = (nested as { message?: unknown }).message;
      if (typeof message === 'string' && message !== '') return message.slice(0, 300);
    }
  }
  return undefined;
}

/** 单个概率缺失、非有限数或越出 [0,1] 都按坏响应处理：softmax 的输出不该出现这些。 */
function invalidProbabilityError(index: number, raw: unknown): ModelError {
  return new ModelError({
    kind: 'bad-response',
    message: 'Jev 返回的选项概率缺失或非法',
    detail: `选项 ${index} 的概率为 ${JSON.stringify(raw)}`,
  });
}

export function createJevClient(config: JevConfig, deps: JevDeps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const endpoint = resolveSystemOneEndpoint(config.baseUrl);
  const model = config.model?.trim() || 'jev-latest';

  async function post(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw toModelError(error);
    }

    const text = await response.text();
    let payload: unknown;
    try {
      payload = text === '' ? {} : JSON.parse(text);
    } catch {
      payload = { raw: text.slice(0, 500) };
    }

    if (!response.ok) {
      throw new ModelError({
        kind: kindFromStatus(response.status),
        message: `Jev 服务返回 ${response.status}`,
        status: response.status,
        detail: readErrorDetail(payload) ?? text.slice(0, 300),
      });
    }

    return payload;
  }

  async function score(
    request: JevScoreRequest,
    options?: { signal?: AbortSignal },
  ): Promise<JevScoreResult> {
    if (request.options.length === 0) {
      throw new ModelError({ kind: 'bad-request', message: '没有可打分的选项' });
    }

    // criteria 的键用序号而不是选项原文：文案来自模型、可能出现重复（两个一模一样的
    // 选项会让 JSON 键互相覆盖），序号键天然无冲突、且与返回 scores 的对齐是平凡的。
    const criteria = Object.fromEntries(request.options.map((_, index) => [String(index), null]));

    const payload = await post(
      {
        state: request.state,
        model,
        questions: {
          options: {
            type: 'choice',
            ...(request.instructions !== undefined ? { instructions: request.instructions } : {}),
            criteria,
          },
        },
      },
      options?.signal,
    );

    const parsed = zSystemOneResponse.safeParse(payload);
    if (!parsed.success) {
      throw new ModelError({
        kind: 'bad-response',
        message: 'Jev 返回的结构无法解析',
        detail: parsed.error.message.slice(0, 300),
      });
    }

    const answer = zChoiceAnswer.safeParse(parsed.data.answers['options']);
    if (!answer.success) {
      throw new ModelError({
        kind: 'bad-response',
        message: 'Jev 没有返回可用的 choice 结果',
        detail: answer.error.message.slice(0, 300),
      });
    }

    const { probabilities } = answer.data;
    if (!Object.prototype.hasOwnProperty.call(probabilities, answer.data.choice)) {
      throw new ModelError({
        kind: 'bad-response',
        message: 'Jev 返回的选定项不在选项集里',
        detail: `choice = ${JSON.stringify(answer.data.choice)}`,
      });
    }

    const scores: JevOptionScore[] = request.options.map((option, index) => {
      const probability = probabilities[String(index)];
      if (probability === undefined || !Number.isFinite(probability) ||
          probability < 0 || probability > 1) {
        throw invalidProbabilityError(index, probability);
      }
      return { index, option, probability };
    });

    // topIndex 从概率里取 argmax，而不直接信 choice 字段：概率才是这个模型
    // 的本体输出，choice 只是它的可读摘要。两者分歧时以概率为准。
    let topIndex = 0;
    let topProbability = -1;
    for (const entry of scores) {
      if (entry.probability > topProbability) {
        topProbability = entry.probability;
        topIndex = entry.index;
      }
    }

    const usage = parsed.data.usage;
    const inputTokens = usage?.input_tokens ?? usage?.inputTokens;
    const outputTokens = usage?.output_tokens ?? usage?.outputTokens;
    return {
      model: parsed.data.model,
      scores,
      topIndex,
      confidence: answer.data.confidence,
      ...(inputTokens !== undefined && outputTokens !== undefined
        ? { usage: { inputTokens, outputTokens } }
        : {}),
    };
  }

  return { score };
}
