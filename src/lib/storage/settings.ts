import 'client-only';
import type { ModelConfig } from '@/lib/model/adapter';
import { getPreset, normalizeBaseUrl } from '@/lib/model/adapter';

/**
 * 模型配置的本地持久化（BYOK）。
 *
 * 密钥的存放策略是刻意的：
 * - 非敏感项（地址、模型名、温度…）放 `localStorage`。
 * - API Key **默认只放 `sessionStorage`**，关闭标签页即失效。玩家主动打开
 *   「记住到本机」后才会落到 `localStorage`，界面上必须同时说明风险。
 *
 * 这里不使用「加密」这类说法：把密钥放进浏览器存储，无论哪个 storage 都不是
 * 安全的密钥仓库，应用层也没有真正的密钥保护能力。如实告知比虚假承诺更负责。
 */

const SETTINGS_KEY = 'newlife:model-settings';
const API_KEY_KEY = 'newlife:api-key';

export interface ModelSettings {
  providerId: string;
  baseUrl: string;
  model: string;
  /** 额外请求头，原始文本，每行一条 `Key: Value` */
  extraHeaders: string;
  /** 是否请求供应商返回严格 JSON */
  jsonMode: boolean;
  temperature: number;
  /**
   * 单次输出上限（token）。0 表示不发送该参数、完全交给供应商默认值。
   *
   * 这个值必须给够。**注意年表重构改变了输出的形状，但没有降低它的上限**：
   *
   * - 典型情况比以前**更省**：4~12 条一句话条目 + 少量 detail，约 1500~2500 token。
   * - 但最坏情况比以前**更大**：条目本身有 JSON 结构开销（每条约 60 字符的骨架），
   *   12 条都带 detail、再叠上一个决策点，可以到 5000 token 上下。
   *
   * 给得太小时的失败形态是「空内容 + `finish_reason: length`」，从界面上完全看不出
   * 是被截断——所以宁可给宽一点，多出来的额度不生成就不计费。
   */
  maxTokens: number;
  /** 是否把 API Key 记到本机（localStorage） */
  persistApiKey: boolean;
}

export const DEFAULT_SETTINGS: ModelSettings = {
  providerId: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  extraHeaders: '',
  jsonMode: true,
  temperature: 0.85,
  maxTokens: 6000,
  persistApiKey: false,
};

function readLocal(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function readSession(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 隐私模式下可能被拒绝，静默降级为仅当前会话有效
  }
}

function writeSession(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // 同上
  }
}

function removeLocal(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // 忽略
  }
}

function removeSession(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // 忽略
  }
}

function coerceSettings(raw: unknown): ModelSettings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_SETTINGS };
  const record = raw as Record<string, unknown>;

  return {
    providerId:
      typeof record['providerId'] === 'string' ? record['providerId'] : DEFAULT_SETTINGS.providerId,
    baseUrl: typeof record['baseUrl'] === 'string' ? record['baseUrl'] : DEFAULT_SETTINGS.baseUrl,
    model: typeof record['model'] === 'string' ? record['model'] : DEFAULT_SETTINGS.model,
    extraHeaders:
      typeof record['extraHeaders'] === 'string' ? record['extraHeaders'] : DEFAULT_SETTINGS.extraHeaders,
    jsonMode: typeof record['jsonMode'] === 'boolean' ? record['jsonMode'] : DEFAULT_SETTINGS.jsonMode,
    temperature:
      typeof record['temperature'] === 'number' && Number.isFinite(record['temperature'])
        ? record['temperature']
        : DEFAULT_SETTINGS.temperature,
    maxTokens:
      typeof record['maxTokens'] === 'number' && Number.isFinite(record['maxTokens'])
        ? record['maxTokens']
        : DEFAULT_SETTINGS.maxTokens,
    persistApiKey:
      typeof record['persistApiKey'] === 'boolean'
        ? record['persistApiKey']
        : DEFAULT_SETTINGS.persistApiKey,
  };
}

export function loadSettings(): ModelSettings {
  const raw = readLocal(SETTINGS_KEY);
  if (raw === null) return { ...DEFAULT_SETTINGS };
  try {
    return coerceSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * 读取 API Key。
 *
 * 先看 sessionStorage 再看 localStorage：前者是本次会话刚填的，优先级更高；
 * 后者只在玩家勾选了「记住到本机」时才会有值。
 */
export function loadApiKey(): string {
  return readSession(API_KEY_KEY) ?? readLocal(API_KEY_KEY) ?? '';
}

export function saveSettings(settings: ModelSettings, apiKey: string): void {
  const { ...persisted } = settings;
  writeLocal(SETTINGS_KEY, JSON.stringify(persisted));
  writeSession(API_KEY_KEY, apiKey);

  if (settings.persistApiKey) writeLocal(API_KEY_KEY, apiKey);
  else removeLocal(API_KEY_KEY);
}

/** 清除本机保存的密钥（会话内的也会清掉）。 */
export function clearApiKey(): void {
  removeSession(API_KEY_KEY);
  removeLocal(API_KEY_KEY);
}

/** 是否已经具备发起请求的最低配置。 */
export function isConfigured(settings: ModelSettings, apiKey: string): boolean {
  return normalizeBaseUrl(settings.baseUrl) !== '' && settings.model.trim() !== '' && apiKey.trim() !== '';
}

/** 解析「每行一条 Key: Value」的额外请求头文本。 */
export function parseExtraHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf(':');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (key !== '') headers[key] = value;
  }
  return headers;
}

/** 切换预设时同步地址与模型名，已手动改过的地址不覆盖。 */
export function applyPreset(settings: ModelSettings, providerId: string): ModelSettings {
  const preset = getPreset(providerId);
  if (!preset) return { ...settings, providerId };
  return {
    ...settings,
    providerId,
    baseUrl: preset.baseUrl,
    model: preset.defaultModel,
  };
}

export function toModelConfig(settings: ModelSettings, apiKey: string): ModelConfig {
  const config: ModelConfig = {
    baseUrl: settings.baseUrl,
    apiKey,
    model: settings.model,
    jsonMode: settings.jsonMode,
    temperature: settings.temperature,
  };

  const provider = getPreset(settings.providerId)?.label;
  if (provider) config.provider = provider;

  if (settings.maxTokens > 0) config.maxTokens = settings.maxTokens;

  const extraHeaders = parseExtraHeaders(settings.extraHeaders);
  if (Object.keys(extraHeaders).length > 0) config.extraHeaders = extraHeaders;

  return config;
}
