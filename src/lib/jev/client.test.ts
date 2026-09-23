import { describe, expect, it } from 'vitest';
import { ModelError } from '@/lib/model/errors';
import { createJevClient, resolveSystemOneEndpoint } from './client';

const BASE_CONFIG = {
  baseUrl: 'https://api.typesafe.ai',
  apiKey: 'jev-test',
};

const OPTIONS = ['跟他走', '婉拒', '追问他的来历'] as const;

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

/** 按概率表生成一份合法的 choice 响应；choice 字段缺省取 argmax。 */
function choiceAnswer(
  probabilities: Record<string, number>,
  overrides: { choice?: string; confidence?: number } = {},
): unknown {
  const entries = Object.entries(probabilities);
  const choice =
    overrides.choice ?? entries.reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0];
  return {
    type: 'choice',
    choice,
    probabilities,
    confidence: overrides.confidence ?? 0.8,
  };
}

function choiceResponse(answer: unknown, withUsage = true): Response {
  return jsonResponse({
    model: 'jev-1.13.0',
    answers: { options: answer },
    ...(withUsage ? { usage: { input_tokens: 300, output_tokens: 10 } } : {}),
  });
}

async function scoreWith(
  fetchImpl: typeof fetch,
): Promise<{ result: Awaited<ReturnType<ReturnType<typeof createJevClient>['score']>> | null; error: unknown }> {
  const client = createJevClient(BASE_CONFIG, { fetchImpl });
  try {
    return {
      result: await client.score({
        state: '0. 跟他走\n1. 婉拒\n2. 追问他的来历',
        instructions: '按角色处境推演',
        options: OPTIONS,
      }),
      error: null,
    };
  } catch (caught) {
    return { result: null, error: caught };
  }
}

describe('resolveSystemOneEndpoint', () => {
  it('根地址补全 /v1/systemone', () => {
    expect(resolveSystemOneEndpoint('https://api.typesafe.ai')).toBe(
      'https://api.typesafe.ai/v1/systemone',
    );
  });

  it('末尾斜杠被归一化', () => {
    expect(resolveSystemOneEndpoint('https://api.typesafe.ai/')).toBe(
      'https://api.typesafe.ai/v1/systemone',
    );
  });

  it('已带 /v1 时只补 /systemone', () => {
    expect(resolveSystemOneEndpoint('https://api.typesafe.ai/v1')).toBe(
      'https://api.typesafe.ai/v1/systemone',
    );
  });

  it('完整端点原样使用', () => {
    expect(resolveSystemOneEndpoint('http://127.0.0.1:8787/v1/systemone')).toBe(
      'http://127.0.0.1:8787/v1/systemone',
    );
  });
});

describe('createJevClient', () => {
  it('拼接端点、带鉴权头，criteria 用序号键且不携带选项原文', async () => {
    const { fetchImpl, captured } = makeFetch(() => choiceResponse(choiceAnswer({ '0': 1, '1': 0, '2': 0 })));
    const client = createJevClient(BASE_CONFIG, { fetchImpl });

    await client.score({
      state: { age: 27, realm: '筑基' },
      instructions: '按角色处境推演',
      options: OPTIONS,
    });

    expect(captured[0]?.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(captured[0]?.headers['Authorization']).toBe('Bearer jev-test');
    expect(captured[0]?.body['model']).toBe('jev-latest');
    expect(captured[0]?.body['state']).toEqual({ age: 27, realm: '筑基' });
    expect(captured[0]?.body['questions']).toEqual({
      options: {
        type: 'choice',
        instructions: '按角色处境推演',
        criteria: { '0': null, '1': null, '2': null },
      },
    });
  });

  it('没给 instructions 时请求里不带这个字段；给了 model 时用给定的', async () => {
    const { fetchImpl, captured } = makeFetch(() => choiceResponse(choiceAnswer({ '0': 1, '1': 0, '2': 0 })));
    const client = createJevClient({ ...BASE_CONFIG, model: ' jev-1.13 ' }, { fetchImpl });

    await client.score({ state: 's', options: OPTIONS });

    const question = (captured[0]?.body['questions'] as Record<string, unknown>)['options'] as
      | Record<string, unknown>
      | undefined;
    expect(question?.['instructions']).toBeUndefined();
    expect(captured[0]?.body['model']).toBe('jev-1.13');
  });

  it('概率按序号键对齐回选项顺序，usage 换成驼峰', async () => {
    const { fetchImpl } = makeFetch(() => choiceResponse(choiceAnswer({ '0': 0.25, '1': 0.5, '2': 0.25 })));

    const { result } = await scoreWith(fetchImpl);

    expect(result?.model).toBe('jev-1.13.0');
    expect(result?.scores).toEqual([
      { index: 0, option: '跟他走', probability: 0.25 },
      { index: 1, option: '婉拒', probability: 0.5 },
      { index: 2, option: '追问他的来历', probability: 0.25 },
    ]);
    expect(result?.topIndex).toBe(1);
    expect(result?.confidence).toBe(0.8);
    expect(result?.usage).toEqual({ inputTokens: 300, outputTokens: 10 });
  });

  it('choice 字段与 argmax 分歧时以概率为准', async () => {
    const { fetchImpl } = makeFetch(() =>
      choiceResponse(choiceAnswer({ '0': 0.6, '1': 0.3, '2': 0.1 }, { choice: '1' })),
    );

    const { result, error } = await scoreWith(fetchImpl);

    expect(error).toBeNull();
    expect(result?.topIndex).toBe(0);
  });

  it('响应缺 usage 时不报错，usage 为 undefined', async () => {
    const { fetchImpl } = makeFetch(() => choiceResponse(choiceAnswer({ '0': 1, '1': 0, '2': 0 }), false));

    const { result, error } = await scoreWith(fetchImpl);

    expect(error).toBeNull();
    expect(result?.usage).toBeUndefined();
  });

  it('AI Gateway 风格响应：驼峰 usage 与多余字段（providerMetadata）都容忍', async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse({
        model: 'typesafe-ai/jev',
        answers: { options: choiceAnswer({ '0': 0.2, '1': 0.65, '2': 0.15 }) },
        usage: { inputTokens: 287, outputTokens: 31 },
        providerMetadata: { typesafe: { confidence: { options: 0.8 } } },
      }),
    );

    const { result, error } = await scoreWith(fetchImpl);

    expect(error).toBeNull();
    expect(result?.usage).toEqual({ inputTokens: 287, outputTokens: 31 });
    expect(result?.topIndex).toBe(1);
  });

  it('某个选项的概率缺失时报 bad-response', async () => {
    const { fetchImpl } = makeFetch(() => choiceResponse(choiceAnswer({ '0': 0.5, '2': 0.5 })));

    const { error } = await scoreWith(fetchImpl);

    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).kind).toBe('bad-response');
    expect((error as ModelError).detail).toContain('选项 1');
  });

  it('概率越出 [0,1] 时报 bad-response', async () => {
    const { fetchImpl } = makeFetch(() => choiceResponse(choiceAnswer({ '0': 1.2, '1': 0, '2': 0 })));

    const { error } = await scoreWith(fetchImpl);

    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).kind).toBe('bad-response');
  });

  it('choice 指向不存在的键时报 bad-response', async () => {
    const { fetchImpl } = makeFetch(() =>
      choiceResponse(choiceAnswer({ '0': 1, '1': 0, '2': 0 }, { choice: '9' })),
    );

    const { error } = await scoreWith(fetchImpl);

    expect((error as ModelError).kind).toBe('bad-response');
  });

  it('answers 里没有目标问题时报 bad-response', async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse({ model: 'jev-1.13.0', answers: { other: choiceAnswer({ '0': 1, '1': 0, '2': 0 }) } }),
    );

    const { error } = await scoreWith(fetchImpl);

    expect((error as ModelError).kind).toBe('bad-response');
  });

  it('响应不是合法 JSON 时报 bad-response', async () => {
    const fetchImpl = (async () =>
      new Response('<html>gateway error</html>', { status: 200 })) as unknown as typeof fetch;

    const { error } = await scoreWith(fetchImpl);

    expect((error as ModelError).kind).toBe('bad-response');
  });

  it.each([
    [401, 'auth'],
    [429, 'rate-limit'],
    [500, 'server'],
    // 529 是官方文档列出的「过载」状态码，应落到 server 一类
    [529, 'server'],
    [400, 'bad-request'],
  ])('把 HTTP %i 归类为 %s', async (status, kind) => {
    const { fetchImpl } = makeFetch(() => jsonResponse({ error: { message: 'boom' } }, status));

    const { error } = await scoreWith(fetchImpl);

    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).kind).toBe(kind);
    expect((error as ModelError).status).toBe(status);
  });

  it('官方错误体（detail.message）被人话化进 detail', async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse(
        {
          detail: {
            error_type: 'authentication_error',
            message: 'Cannot authenticate with the server.',
          },
        },
        401,
      ),
    );

    const { error } = await scoreWith(fetchImpl);

    expect((error as ModelError).kind).toBe('auth');
    expect((error as ModelError).detail).toContain('Cannot authenticate');
  });

  it('网络失败归类为 network', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;

    const { error } = await scoreWith(fetchImpl);

    expect((error as ModelError).kind).toBe('network');
  });

  it('中止归类为 aborted', async () => {
    const fetchImpl = (async () => {
      throw new DOMException('Aborted', 'AbortError');
    }) as unknown as typeof fetch;

    const { error } = await scoreWith(fetchImpl);

    expect((error as ModelError).kind).toBe('aborted');
  });

  it('选项为空时报 bad-request，且请求根本不发出', async () => {
    const { fetchImpl, captured } = makeFetch(() => choiceResponse(choiceAnswer({})));
    const client = createJevClient(BASE_CONFIG, { fetchImpl });

    const error = await client
      .score({ state: 's', options: [] })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).kind).toBe('bad-request');
    expect(captured).toHaveLength(0);
  });
});
