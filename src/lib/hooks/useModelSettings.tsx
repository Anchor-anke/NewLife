'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { ModelAdapter } from '@/lib/model/adapter';
import { createOpenAICompatAdapter } from '@/lib/model/openai-compat';
import {
  DEFAULT_SETTINGS,
  clearApiKey as clearStoredApiKey,
  isConfigured,
  loadApiKey,
  loadSettings,
  saveSettings,
  toModelConfig,
  type ModelSettings,
} from '@/lib/storage/settings';

/**
 * 模型配置的全局上下文。
 *
 * 配置存在 localStorage / sessionStorage 里，本身不是响应式的，所以用一层
 * Context 把它变成组件可订阅的状态。首次读取放在 `useEffect` 里执行，
 * 避免服务端渲染时读不到存储导致水合不一致。
 */

export interface ModelSettingsContextValue {
  settings: ModelSettings;
  apiKey: string;
  /** 是否已完成首次读取。未完成时不要渲染依赖配置的界面。 */
  ready: boolean;
  configured: boolean;
  /** 配置不完整时为 null，调用方据此引导玩家去设置页 */
  adapter: ModelAdapter | null;
  update: (settings: ModelSettings, apiKey: string) => void;
  forgetApiKey: () => void;
}

const ModelSettingsContext = createContext<ModelSettingsContextValue | null>(null);

export function ModelSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<ModelSettings>(DEFAULT_SETTINGS);
  const [apiKey, setApiKey] = useState('');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setSettings(loadSettings());
    setApiKey(loadApiKey());
    setReady(true);
  }, []);

  const update = useCallback((next: ModelSettings, nextApiKey: string) => {
    saveSettings(next, nextApiKey);
    setSettings(next);
    setApiKey(nextApiKey);
  }, []);

  const forgetApiKey = useCallback(() => {
    clearStoredApiKey();
    setApiKey('');
  }, []);

  const configured = isConfigured(settings, apiKey);

  const adapter = useMemo(
    () => (configured ? createOpenAICompatAdapter(toModelConfig(settings, apiKey)) : null),
    [configured, settings, apiKey],
  );

  const value = useMemo<ModelSettingsContextValue>(
    () => ({ settings, apiKey, ready, configured, adapter, update, forgetApiKey }),
    [settings, apiKey, ready, configured, adapter, update, forgetApiKey],
  );

  return <ModelSettingsContext.Provider value={value}>{children}</ModelSettingsContext.Provider>;
}

export function useModelSettings(): ModelSettingsContextValue {
  const context = useContext(ModelSettingsContext);
  if (!context) {
    throw new Error('useModelSettings 必须在 ModelSettingsProvider 内部使用');
  }
  return context;
}
