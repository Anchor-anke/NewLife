import 'client-only';
import type { JevConfig } from './client';
import { loadSettings } from '@/lib/storage/settings';

/**
 * Jev 配置的本地持久化（BYOK），语义与 `storage/settings.ts` 一致：
 * - 地址与模型名放 `localStorage`；
 * - API Key 默认只放 `sessionStorage`，关闭标签页即失效。
 *
 * 与主 Key 唯一的差别：这里**不设独立的「记住到本机」开关**，而是跟随主设置的
 * `persistApiKey`。两个语义完全相同的复选框只会让人困惑——玩家信任哪台设备，
 * 对两把 Key 是同一个决定。
 */

const SETTINGS_KEY = 'newlife:jev-settings';
const API_KEY_KEY = 'newlife:jev-api-key';

export interface JevSettings {
  baseUrl: string;
  model: string;
}

/**
 * 默认 baseUrl 刻意是**空**。
 *
 * 官方端点（api.typesafe.ai）有 CORS 白名单、拒绝浏览器直连——纯前端 BYOK
 * 架构下填它必然报「无法连接」。所以默认即「未启用」，要开推演就明确填一个
 * 真正可用的通道：本地 openjev、或自建的带 CORS 转发网关。
 */
export const DEFAULT_JEV_SETTINGS: JevSettings = {
  baseUrl: '',
  model: 'jev-latest',
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

/**
 * 官方端点的地址。它有 CORS 白名单、拒绝浏览器直连，在纯浏览器架构下
 * 是**已知不可用**的值——旧版本的默认值可能已经存进过本机，读回时视为未填。
 */
const OFFICIAL_BASE_URL = 'https://api.typesafe.ai';

function coerceSettings(raw: unknown): JevSettings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_JEV_SETTINGS };
  const record = raw as Record<string, unknown>;

  function coerceBaseUrl(value: unknown): string {
    if (typeof value !== 'string') return DEFAULT_JEV_SETTINGS.baseUrl;
    const trimmed = value.trim();
    if (trimmed === '' || trimmed === OFFICIAL_BASE_URL) return DEFAULT_JEV_SETTINGS.baseUrl;
    return trimmed;
  }

  return {
    baseUrl: coerceBaseUrl(record['baseUrl']),
    model:
      typeof record['model'] === 'string' && record['model'].trim() !== ''
        ? record['model']
        : DEFAULT_JEV_SETTINGS.model,
  };
}

export function loadJevSettings(): JevSettings {
  const raw = readLocal(SETTINGS_KEY);
  if (raw === null) return { ...DEFAULT_JEV_SETTINGS };
  try {
    return coerceSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_JEV_SETTINGS };
  }
}

export function saveJevSettings(settings: JevSettings): void {
  writeLocal(SETTINGS_KEY, JSON.stringify(settings));
}

/** 先会话后本机：会话里刚保存的优先级更高，与主 Key 的读取顺序一致。 */
export function loadJevApiKey(): string {
  return readSession(API_KEY_KEY) ?? readLocal(API_KEY_KEY) ?? '';
}

export function saveJevApiKey(apiKey: string): void {
  writeSession(API_KEY_KEY, apiKey);
  if (loadSettings().persistApiKey) writeLocal(API_KEY_KEY, apiKey);
  else removeLocal(API_KEY_KEY);
}

export function clearJevApiKey(): void {
  removeSession(API_KEY_KEY);
  removeLocal(API_KEY_KEY);
}

/** 是否已具备发起打分请求的最低配置。 */
export function isJevConfigured(settings: JevSettings, apiKey: string): boolean {
  return settings.baseUrl.trim() !== '' && apiKey.trim() !== '';
}

export function toJevConfig(settings: JevSettings, apiKey: string): JevConfig {
  return { baseUrl: settings.baseUrl, apiKey, model: settings.model };
}
