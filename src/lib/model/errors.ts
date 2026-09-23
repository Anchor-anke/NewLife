/**
 * 模型调用的错误分类。
 *
 * 纯前端 BYOK 意味着失败原因五花八门，而且大多不是「代码 bug」而是「配置问题」。
 * 因此这里把错误归成有限几类，每类都给出**可操作的下一步**——玩家看到的应该是
 * 「怎么修」，而不是一个英文异常名。
 */

export type ModelErrorKind =
  | 'network'
  | 'auth'
  | 'rate-limit'
  | 'model-not-found'
  | 'bad-request'
  | 'server'
  | 'timeout'
  | 'aborted'
  | 'bad-response'
  | 'truncated'
  | 'unknown';

export interface ModelErrorOptions {
  kind: ModelErrorKind;
  message: string;
  status?: number;
  /** 供应商返回的原始错误片段，截断后用于排查 */
  detail?: string;
  cause?: unknown;
}

export class ModelError extends Error {
  readonly kind: ModelErrorKind;
  readonly status: number | undefined;
  readonly detail: string | undefined;

  constructor(options: ModelErrorOptions) {
    super(options.message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ModelError';
    this.kind = options.kind;
    this.status = options.status;
    this.detail = options.detail;
  }
}

/** 面向玩家的处置建议。 */
const HINTS: Record<ModelErrorKind, string> = {
  network:
    '请求根本没发出去，通常是跨域（CORS）被浏览器拦下，也可能是网络不通。请先在设置页点「测试连接」确认；若确认是跨域问题，换一个允许浏览器直连的供应商，或改用兼容网关的地址。',
  auth: '密钥无效或没有该模型的权限。请到设置页检查 API Key 是否填错、是否已过期、是否与该供应商匹配。',
  'rate-limit': '请求过于频繁或额度用尽。稍等片刻再试；如果持续出现，请检查账户余额与限流策略。',
  'model-not-found': '模型名不存在。请到设置页核对模型名，注意大小写与供应商前缀。',
  'bad-request':
    '请求被供应商拒绝。常见原因是模型名不对，或该端点不支持结构化输出（response_format）。可以在设置页把「结构化输出」关掉再试。',
  server: '供应商服务端出错。这通常是临时的，稍后重试；若持续失败请换供应商。',
  timeout: '请求超时。长文本生成可能较慢，可以重试；若频繁超时，换一个更快的模型。',
  aborted: '请求已取消。',
  'bad-response':
    '供应商返回的内容无法解析。可能是不支持结构化输出，或返回被截断。可以重试，或在设置页关掉「结构化输出」。',
  truncated:
    '模型这次没能把话说完——响应被输出长度上限截断了（供应商返回 finish_reason: length）。请到设置页把「单次输出上限」调大；如果你用的是推理模型（reasoner / o1 一类），它会把大量 token 花在思考上，建议直接调到 8000 以上。',
  unknown: '发生了未预期的错误，请重试。若持续失败，请到设置页重新测试连接。',
};

export function hintFor(kind: ModelErrorKind): string {
  return HINTS[kind];
}

/** 把 HTTP 状态码归到错误类别。 */
export function kindFromStatus(status: number): ModelErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'model-not-found';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 429) return 'rate-limit';
  if (status >= 500) return 'server';
  if (status >= 400) return 'bad-request';
  return 'unknown';
}

/** 把任意抛出物收敛成 ModelError，便于上层统一处理。 */
export function toModelError(error: unknown): ModelError {
  if (error instanceof ModelError) return error;

  if (error instanceof DOMException && error.name === 'AbortError') {
    return new ModelError({ kind: 'aborted', message: '请求已取消', cause: error });
  }

  if (error instanceof TypeError) {
    // fetch 在跨域被拦或网络不可达时都会抛 TypeError
    return new ModelError({
      kind: 'network',
      message: '无法连接到模型服务',
      detail: error.message,
      cause: error,
    });
  }

  if (error instanceof Error) {
    return new ModelError({ kind: 'unknown', message: error.message, cause: error });
  }

  return new ModelError({ kind: 'unknown', message: String(error) });
}
