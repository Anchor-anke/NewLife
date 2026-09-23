import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_JEV_SETTINGS,
  clearJevApiKey,
  isJevConfigured,
  loadJevApiKey,
  loadJevSettings,
  saveJevApiKey,
  saveJevSettings,
  toJevConfig,
} from './settings';

/**
 * Jev 配置持久化。
 *
 * 重点钉两件事：密钥的存放层级（默认会话、勾选主开关才落本机），
 * 以及损坏数据必须回退到默认值而不是让页面崩掉。
 */

const MODEL_SETTINGS_KEY = 'newlife:model-settings';

function makeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => {
      map.clear();
    },
    key: () => null,
  };
}

beforeEach(() => {
  vi.stubGlobal('window', { localStorage: makeStorage(), sessionStorage: makeStorage() });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadJevSettings / saveJevSettings', () => {
  it('未保存时返回默认值', () => {
    expect(loadJevSettings()).toEqual(DEFAULT_JEV_SETTINGS);
  });

  it('保存后原样读回', () => {
    saveJevSettings({ baseUrl: 'http://127.0.0.1:8787', model: 'jev-1.13' });
    expect(loadJevSettings()).toEqual({ baseUrl: 'http://127.0.0.1:8787', model: 'jev-1.13' });
  });

  it('损坏的存储内容回退到默认值，而不是抛错', () => {
    window.localStorage.setItem('newlife:jev-settings', '{not json');
    expect(loadJevSettings()).toEqual(DEFAULT_JEV_SETTINGS);
  });

  it('空字符串字段回退到默认值', () => {
    saveJevSettings({ baseUrl: '   ', model: '' });
    const loaded = loadJevSettings();
    expect(loaded.baseUrl).toBe(DEFAULT_JEV_SETTINGS.baseUrl);
    expect(loaded.model).toBe(DEFAULT_JEV_SETTINGS.model);
  });

  it('旧版本存下的官方地址在读取时视为未配置（浏览器直连必被 CORS 拒）', () => {
    window.localStorage.setItem(
      'newlife:jev-settings',
      JSON.stringify({ baseUrl: 'https://api.typesafe.ai', model: 'jev-latest' }),
    );
    expect(loadJevSettings().baseUrl).toBe('');
  });
});

describe('Jev API Key 的存放层级', () => {
  it('默认只写会话存储，不落本机', () => {
    saveJevApiKey('sk-jev-1');

    expect(loadJevApiKey()).toBe('sk-jev-1');
    expect(window.localStorage.getItem('newlife:jev-api-key')).toBeNull();
    expect(window.sessionStorage.getItem('newlife:jev-api-key')).toBe('sk-jev-1');
  });

  it('主设置勾选「记住到本机」后，Jev Key 才跟着落本机', () => {
    window.localStorage.setItem(
      MODEL_SETTINGS_KEY,
      JSON.stringify({ persistApiKey: true }),
    );
    saveJevApiKey('sk-jev-2');

    expect(window.localStorage.getItem('newlife:jev-api-key')).toBe('sk-jev-2');
  });

  it('会话里的新值优先于本机的旧值', () => {
    window.localStorage.setItem('newlife:jev-api-key', 'sk-old');
    window.sessionStorage.setItem('newlife:jev-api-key', 'sk-new');

    expect(loadJevApiKey()).toBe('sk-new');
  });

  it('清除时两处一起清', () => {
    window.localStorage.setItem(
      MODEL_SETTINGS_KEY,
      JSON.stringify({ persistApiKey: true }),
    );
    saveJevApiKey('sk-jev-3');
    clearJevApiKey();

    expect(loadJevApiKey()).toBe('');
    expect(window.localStorage.getItem('newlife:jev-api-key')).toBeNull();
  });
});

describe('isJevConfigured / toJevConfig', () => {
  it('缺 Key 或缺地址都算未配置', () => {
    const settings = { baseUrl: 'https://api.typesafe.ai', model: 'jev-latest' };
    expect(isJevConfigured(settings, '')).toBe(false);
    expect(isJevConfigured({ ...settings, baseUrl: ' ' }, 'sk-1')).toBe(false);
    expect(isJevConfigured(settings, 'sk-1')).toBe(true);
  });

  it('toJevConfig 映射出客户端配置', () => {
    expect(toJevConfig({ baseUrl: 'http://x', model: 'jev-1.13' }, 'sk-9')).toEqual({
      baseUrl: 'http://x',
      apiKey: 'sk-9',
      model: 'jev-1.13',
    });
  });
});
