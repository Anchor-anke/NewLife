import {
  normalizeBaseUrl,
  resolveChatEndpoint,
  type CallOptions,
  type ChatRequest,
  type ModelAdapter,
  type ModelConfig,
  type ModelTextResult,
} from './adapter';
import { ModelError, kindFromStatus, toModelError } from './errors';

/**
 * OpenAI 兼容协议实现。
 *
 * 兼容面上的差异比想象中多，这里处理了最常踩的一个坑：
 * 部分端点不支持 `response_format: json_object`，会在 400 里抱怨这个参数。
 * 首次遇到时自动去掉该参数重试，并记住结论，后续请求不再带它。
 *
 * 注意：返回文本到 JSON 的解析不在这里，而在 `json.ts`——那是引擎层的职责。
 */

export interface OpenAICompatDeps {
  /** 注入以便测试；默认用全局 fetch */
  fetchImpl?: typeof fetch;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string;
  }>;
  error?: { message?: string; type?: string; code?: string };
}

interface PostResult {
  content: string;
  finishReason: string | undefined;
}

function readErrorDetail(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const error = (payload as ChatCompletionResponse).error;
  if (error?.message) return error.message.slice(0, 300);
  return undefined;
}

/**
 * 把「空内容」转成可操作的错误。
 *
 * 截断与格式错误必须分开报：`finish_reason: length` 说明模型被输出上限卡住了，
 * 玩家要做的是调大上限；而真正的空响应通常意味着端点不支持结构化输出。
 * 两者混在一起报，玩家只能靠猜。
 */
function emptyContentError(result: PostResult): ModelError {
  if (result.finishReason === 'length') {
    return new ModelError({
      kind: 'truncated',
      message: '模型输出被长度上限截断',
      detail: 'finish_reason: length',
    });
  }
  return new ModelError({
    kind: 'bad-response',
    message: '模型返回了空内容',
    ...(result.finishReason ? { detail: `finish_reason: ${result.finishReason}` } : {}),
  });
}

export function createOpenAICompatAdapter(
  config: ModelConfig,
  deps: OpenAICompatDeps = {},
): ModelAdapter {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const endpoint = resolveChatEndpoint(config.baseUrl);
  const provider = config.provider?.trim() || hostOf(config.baseUrl) || '自定义';

  // 一旦发现端点不支持 response_format，就永久降级（同一会话内）
  let jsonModeSupported = config.jsonMode !== false;

  async function post(body: Record<string, unknown>, signal?: AbortSignal): Promise<PostResult> {
    const startedAt = Date.now();

    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
          ...config.extraHeaders,
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
      const detail = readErrorDetail(payload);
      const looksLikeJsonModeComplaint =
        jsonModeSupported &&
        response.status === 400 &&
        /response_format|json_object|json mode/i.test(detail ?? text);

      throw new ModelError({
        kind: looksLikeJsonModeComplaint ? 'bad-request' : kindFromStatus(response.status),
        message: `模型服务返回 ${response.status}`,
        status: response.status,
        detail,
      });
    }

    // 空内容不在这里抛错：连接自检只需要确认链路通，
    // 不该因为模型没来得及开口就把一份好配置判成故障。由调用方决定是否容忍。
    const completion = payload as ChatCompletionResponse;
    const choice = completion.choices?.[0];

    void startedAt;
    return {
      content: typeof choice?.message?.content === 'string' ? choice.message.content : '',
      finishReason: choice?.finish_reason,
    };
  }

  async function complete(request: ChatRequest, options?: CallOptions): Promise<ModelTextResult> {
    const body: Record<string, unknown> = {
      model: config.model,
      messages: request.messages,
      temperature: request.temperature ?? config.temperature ?? 0.85,
    };

    // 请求级优先，其次用设置里的全局上限。
    // 不设这个参数时，部分供应商会用很小的默认值，一段的输出写到一半就被截断。
    const maxTokens = request.maxTokens ?? config.maxTokens;
    if (maxTokens !== undefined && maxTokens > 0) body['max_tokens'] = maxTokens;
    if (request.json && jsonModeSupported) body['response_format'] = { type: 'json_object' };

    const startedAt = Date.now();
    const accept = (result: PostResult): ModelTextResult => {
      if (result.content.trim() === '') throw emptyContentError(result);
      return { text: result.content, latencyMs: Date.now() - startedAt };
    };

    try {
      return accept(await post(body, options?.signal));
    } catch (error) {
      const modelError = toModelError(error);

      // 端点不认 response_format：降级后重试一次，并记住这个结论
      const detail = modelError.detail ?? '';
      if (
        request.json &&
        jsonModeSupported &&
        modelError.status === 400 &&
        /response_format|json_object|json mode/i.test(detail)
      ) {
        jsonModeSupported = false;
        delete body['response_format'];
        return accept(await post(body, options?.signal));
      }

      throw modelError;
    }
  }

  return {
    provider,
    model: config.model,
    complete,
    async ping(options?: CallOptions) {
      const startedAt = Date.now();

      // 自检只验证「连得上、鉴权通过、返回结构正确」，**不要求模型真的产出内容**。
      //
      // 这里曾经把 max_tokens 压到 1 来省成本，结果是：很多模型（尤其推理模型）
      // 会把预算花在内部思考上，返回空内容 + finish_reason: length，
      // 于是一份完全正常的配置被误判成「模型返回了空内容」。别再这么写。
      await post(
        {
          model: config.model,
          messages: [{ role: 'user', content: '你好' }],
          max_tokens: 16,
        },
        options?.signal,
      );

      return { latencyMs: Date.now() - startedAt };
    },
  };
}

function hostOf(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  if (normalized === '') return '';
  try {
    return new URL(normalized).host;
  } catch {
    return normalized;
  }
}
