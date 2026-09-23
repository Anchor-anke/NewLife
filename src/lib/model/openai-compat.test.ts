import { describe, expect, it } from 'vitest';
import type { ModelConfig } from './adapter';
import { ModelError, hintFor } from './errors';
import { extractJsonObject } from './json';
import { createOpenAICompatAdapter } from './openai-compat';

const BASE_CONFIG: ModelConfig = {
  baseUrl: 'https://example.com/v1/',
  apiKey: 'sk-test',
  model: 'test-model',
  provider: '示例',
};

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function makeFetch(
  handler: (request: CapturedRequest, index: number) => Response,
): { fetchImpl: typeof fetch; captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = [];

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request: CapturedRequest = {
      url: String(input),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    captured.push(request);
    return handler(request, captured.length - 1);
  }) as typeof fetch;

  return { fetchImpl, captured };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function completion(content: string): Response {
  return jsonResponse({ choices: [{ message: { content } }] });
}

describe('extractJsonObject', () => {
  it('解析裸 JSON', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it('解析被代码围栏包住的 JSON', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('从夹带解释文字的返回里提取 JSON', () => {
    expect(extractJsonObject('好的，这是结果：\n{"a":1}\n希望有帮助。')).toEqual({ a: 1 });
  });

  it('无法解析时返回 null', () => {
    expect(extractJsonObject('抱歉，我做不到。')).toBeNull();
    expect(extractJsonObject('')).toBeNull();
    expect(extractJsonObject('[1,2,3]')).toBeNull();
  });
});

describe('createOpenAICompatAdapter', () => {
  it('拼接端点并带上鉴权头', async () => {
    const { fetchImpl, captured } = makeFetch(() => completion('{"ok":true}'));
    const adapter = createOpenAICompatAdapter(BASE_CONFIG, { fetchImpl });

    const result = await adapter.complete({
      messages: [{ role: 'user', content: 'hi' }],
      json: true,
    });

    expect(result.text).toBe('{"ok":true}');
    expect(captured[0]?.url).toBe('https://example.com/v1/chat/completions');
    expect(captured[0]?.headers['Authorization']).toBe('Bearer sk-test');
    expect(captured[0]?.body['response_format']).toEqual({ type: 'json_object' });
    expect(captured[0]?.body['model']).toBe('test-model');
  });

  it('baseUrl 已含 /chat/completions 时不重复拼接', async () => {
    const { fetchImpl, captured } = makeFetch(() => completion('{}'));
    const adapter = createOpenAICompatAdapter(
      { ...BASE_CONFIG, baseUrl: 'https://example.com/v1/chat/completions' },
      { fetchImpl },
    );
    await adapter.complete({ messages: [{ role: 'user', content: 'hi' }] });

    expect(captured[0]?.url).toBe('https://example.com/v1/chat/completions');
  });

  it('端点不认 response_format 时自动降级重试并记住结论', async () => {
    const { fetchImpl, captured } = makeFetch((request) => {
      if (request.body['response_format']) {
        return jsonResponse({ error: { message: 'Unsupported parameter: response_format' } }, 400);
      }
      return completion('{"ok":true}');
    });
    const adapter = createOpenAICompatAdapter(BASE_CONFIG, { fetchImpl });

    const first = await adapter.complete({
      messages: [{ role: 'user', content: 'hi' }],
      json: true,
    });
    expect(first.text).toBe('{"ok":true}');
    expect(captured).toHaveLength(2);
    expect(captured[1]?.body['response_format']).toBeUndefined();

    // 第二次调用不应再带 response_format
    await adapter.complete({ messages: [{ role: 'user', content: 'again' }], json: true });
    expect(captured).toHaveLength(3);
    expect(captured[2]?.body['response_format']).toBeUndefined();
  });

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [404, 'model-not-found'],
    [429, 'rate-limit'],
    [500, 'server'],
    [400, 'bad-request'],
  ])('把 HTTP %i 归类为 %s', async (status, kind) => {
    const { fetchImpl } = makeFetch(() => jsonResponse({ error: { message: 'boom' } }, status));
    const adapter = createOpenAICompatAdapter(BASE_CONFIG, { fetchImpl });

    const error = await adapter
      .complete({ messages: [{ role: 'user', content: 'hi' }] })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).kind).toBe(kind);
    expect((error as ModelError).status).toBe(status);
  });

  it('网络失败归类为 network，提示跨域可能', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const adapter = createOpenAICompatAdapter(BASE_CONFIG, { fetchImpl });

    const error = (await adapter
      .complete({ messages: [{ role: 'user', content: 'hi' }] })
      .catch((caught: unknown) => caught)) as ModelError;

    expect(error.kind).toBe('network');
  });

  it('返回空内容归类为 bad-response', async () => {
    const { fetchImpl } = makeFetch(() => completion('   '));
    const adapter = createOpenAICompatAdapter(BASE_CONFIG, { fetchImpl });

    const error = (await adapter
      .complete({ messages: [{ role: 'user', content: 'hi' }] })
      .catch((caught: unknown) => caught)) as ModelError;

    expect(error.kind).toBe('bad-response');
  });

  it('ping 只验证链路：不带 response_format，也不把输出上限压到极限', async () => {
    const { fetchImpl, captured } = makeFetch(() => completion('你好'));
    const adapter = createOpenAICompatAdapter(BASE_CONFIG, { fetchImpl });

    await adapter.ping();

    expect(captured[0]?.body['response_format']).toBeUndefined();
    // 这里曾经设成 1，结果推理模型把预算全花在内部思考上、返回空内容，
    // 一份完全正常的配置被误判成「模型返回了空内容」。
    expect(Number(captured[0]?.body['max_tokens'])).toBeGreaterThan(1);
  });

  it('ping 容忍空内容：只要链路通就算连接正常', async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }),
    );
    const adapter = createOpenAICompatAdapter(BASE_CONFIG, { fetchImpl });

    await expect(adapter.ping()).resolves.toMatchObject({ latencyMs: expect.any(Number) });
  });

  it('输出被长度上限截断时报「截断」，而不是笼统的「空响应」', async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }),
    );
    const adapter = createOpenAICompatAdapter(BASE_CONFIG, { fetchImpl });

    const error = (await adapter
      .complete({ messages: [{ role: 'user', content: 'hi' }] })
      .catch((caught: unknown) => caught)) as ModelError;

    expect(error.kind).toBe('truncated');
    // 玩家看到的必须是「怎么修」，而不是一个英文异常名
    expect(hintFor(error.kind)).toContain('输出上限');
  });

  it('配置里的输出上限会写进请求，请求级设置优先', async () => {
    const { fetchImpl, captured } = makeFetch(() => completion('{}'));
    const adapter = createOpenAICompatAdapter({ ...BASE_CONFIG, maxTokens: 4000 }, { fetchImpl });

    await adapter.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(captured[0]?.body['max_tokens']).toBe(4000);

    await adapter.complete({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 512 });
    expect(captured[1]?.body['max_tokens']).toBe(512);
  });

  it('输出上限为 0 时不发送该参数，完全交给供应商默认值', async () => {
    const { fetchImpl, captured } = makeFetch(() => completion('{}'));
    const adapter = createOpenAICompatAdapter({ ...BASE_CONFIG, maxTokens: 0 }, { fetchImpl });

    await adapter.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(captured[0]?.body['max_tokens']).toBeUndefined();
  });

  it('额外请求头会合并进请求', async () => {
    const { fetchImpl, captured } = makeFetch(() => completion('{}'));
    const adapter = createOpenAICompatAdapter(
      { ...BASE_CONFIG, extraHeaders: { 'X-Custom': 'yes' } },
      { fetchImpl },
    );
    await adapter.complete({ messages: [{ role: 'user', content: 'hi' }] });

    expect(captured[0]?.headers['X-Custom']).toBe('yes');
  });
});
