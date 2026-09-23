/**
 * 模型适配层。
 *
 * 首期只实现 OpenAI 兼容的 `/chat/completions`，但接口刻意与供应商解耦：
 * 将来若要切到服务端代理，只需换一个 `baseUrl`（指向自己的 `/api/proxy`）
 * 或换一个 `ModelAdapter` 实现，引擎层与界面层都不用动。
 */

export interface ModelConfig {
  /** 形如 `https://api.deepseek.com/v1`，末尾斜杠会被自动处理 */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 仅用于展示与存档记录 */
  provider?: string;
  /** 额外请求头，用于网关鉴权或供应商特有开关 */
  extraHeaders?: Record<string, string>;
  /**
   * 是否要求供应商返回严格 JSON（`response_format: json_object`）。
   * 少数端点不支持该参数，关掉后仍能工作，只是需要模型自己遵守格式。
   */
  jsonMode?: boolean;
  temperature?: number;
  /**
   * 单次输出上限（token）。
   *
   * **强烈建议设置**：不少供应商的默认值偏小，而一段的输出（若干条目 +
   * 少量详情，再加上 JSON 结构开销）很容易超出它。失败形态是
   * 「空内容 + `finish_reason: length`」，从界面上完全看不出是被截断。
   * 留空则完全不发送该参数。
   */
  maxTokens?: number;
}

/** 结构校验失败后回灌给模型的修正材料。 */
export interface RepairFeedback {
  /** 上一次的原始返回，原样回灌让模型看到自己错在哪 */
  previousRaw: string;
  /** 精简后的校验问题列表 */
  issues: string[];
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  /** 要求供应商返回严格 JSON（`response_format: json_object`） */
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
}

export interface ModelTextResult {
  text: string;
  latencyMs: number;
}

export interface CallOptions {
  signal?: AbortSignal;
}

/**
 * 模型适配器。只负责「把消息发出去、把文本收回来」，
 * 不理解世界观、不组装提示词、不解析业务结构——那些属于引擎层。
 */
export interface ModelAdapter {
  readonly provider: string;
  readonly model: string;
  complete(request: ChatRequest, options?: CallOptions): Promise<ModelTextResult>;
  /** 最小请求，用于设置页的连通性自检 */
  ping(options?: CallOptions): Promise<{ latencyMs: number }>;
}

// ────────────────────────────────────────────────────────────
// 供应商预设
// ────────────────────────────────────────────────────────────

export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  /** 建议的默认模型名。模型名会随供应商迭代而变化，请以供应商文档为准。 */
  defaultModel: string;
  /** 模型名候选，仅作为输入提示 */
  modelSuggestions: string[];
  note?: string;
}

/**
 * 预设只收录确认走 OpenAI 兼容协议、且允许浏览器直连的端点。
 * 其余供应商请用「自定义」填兼容网关地址。
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    modelSuggestions: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    modelSuggestions: ['gpt-4o-mini', 'gpt-4o'],
  },
  {
    id: 'moonshot',
    label: 'Moonshot (Kimi)',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-32k',
    modelSuggestions: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-flash',
    modelSuggestions: ['glm-4-flash', 'glm-4-plus', 'glm-4-air'],
  },
  {
    id: 'dashscope',
    label: '阿里云百炼（兼容模式）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    modelSuggestions: ['qwen-plus', 'qwen-max', 'qwen-turbo'],
  },
  {
    id: 'siliconflow',
    label: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'Qwen/Qwen2.5-72B-Instruct',
    modelSuggestions: ['Qwen/Qwen2.5-72B-Instruct', 'deepseek-ai/DeepSeek-V3'],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4o-mini',
    modelSuggestions: ['openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet'],
    note: '聚合网关，一个 Key 可用多家模型。',
  },
  {
    id: 'custom',
    label: '自定义（OpenAI 兼容）',
    baseUrl: '',
    defaultModel: '',
    modelSuggestions: [],
    note: '填入任何 OpenAI 兼容端点的地址，例如自建网关或服务端代理。',
  },
];

export function getPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === id);
}

/** 去掉末尾斜杠，得到干净的 baseUrl。 */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

/** 拼接出 chat completions 端点。若 baseUrl 已含 `/chat/completions` 则原样使用。 */
export function resolveChatEndpoint(baseUrl: string): string {
  const base = normalizeBaseUrl(baseUrl);
  if (base.endsWith('/chat/completions')) return base;
  return `${base}/chat/completions`;
}
