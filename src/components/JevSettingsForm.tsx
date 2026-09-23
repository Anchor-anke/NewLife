'use client';

import { useEffect, useState } from 'react';
import { Badge, Button, Field, Panel, Spinner, TextInput } from '@/components/ui';
import { createJevClient } from '@/lib/jev/client';
import {
  DEFAULT_JEV_SETTINGS,
  clearJevApiKey,
  loadJevApiKey,
  loadJevSettings,
  saveJevApiKey,
  saveJevSettings,
  toJevConfig,
  type JevSettings,
} from '@/lib/jev/settings';
import { hintFor, toModelError } from '@/lib/model/errors';

type TestState =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'ok'; latencyMs: number }
  | { status: 'error'; message: string; hint: string; detail?: string };

/**
 * Jev 推演的设置面板。
 *
 * 这是一个**可选**增强：不配置时决策卡完全没有这一层，因此面板的一切
 * 都以「不填就当没这项功能」为前提，不做强制校验。
 */
export function JevSettingsForm() {
  const [draft, setDraft] = useState<JevSettings>(DEFAULT_JEV_SETTINGS);
  const [draftKey, setDraftKey] = useState('');
  const [revealKey, setRevealKey] = useState(false);
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState<TestState>({ status: 'idle' });

  // 存储本身不是响应式的，挂载后读一次即可
  useEffect(() => {
    setDraft(loadJevSettings());
    setDraftKey(loadJevApiKey());
  }, []);

  function patch(changes: Partial<JevSettings>) {
    setDraft((current) => ({ ...current, ...changes }));
    setSaved(false);
    setTest({ status: 'idle' });
  }

  function handleSave() {
    saveJevSettings(draft);
    saveJevApiKey(draftKey);
    setSaved(true);
  }

  async function handleTest() {
    setTest({ status: 'testing' });
    const client = createJevClient(toJevConfig(draft, draftKey));
    const startedAt = Date.now();
    try {
      await client.score({ state: '连接自检', options: ['继续', '停下'] });
      setTest({ status: 'ok', latencyMs: Date.now() - startedAt });
    } catch (error) {
      const modelError = toModelError(error);
      setTest({
        status: 'error',
        message: modelError.message,
        hint: hintFor(modelError.kind),
        ...(modelError.detail ? { detail: modelError.detail } : {}),
      });
    }
  }

  function handleClear() {
    clearJevApiKey();
    setDraftKey('');
    setSaved(false);
    setTest({ status: 'idle' });
  }

  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          Jev 推演
          <Badge>可选</Badge>
        </span>
      }
      description="配置后，决策卡会自动为每个选项推演「这个角色有多可能这么做」。不配置则完全不显示，不影响其他任何功能。"
    >
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Field
            label="接口地址"
            htmlFor="jevBaseUrl"
            hint="官方端点不允许浏览器直连（CORS 白名单），本应用是纯浏览器架构、填它会报「无法连接」。可用：本地 openjev 实现、或任何你自建的带 CORS 的转发网关；本地开发可填模拟服务地址。"
          >
            <TextInput
              id="jevBaseUrl"
              value={draft.baseUrl}
              onChange={(event) => patch({ baseUrl: event.target.value })}
              placeholder="http://127.0.0.1:8787"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
        </div>

        <Field label="模型" htmlFor="jevModel" hint="jev-latest 会跟随官方的版本指针。">
          <TextInput
            id="jevModel"
            value={draft.model}
            onChange={(event) => patch({ model: event.target.value })}
            placeholder="jev-latest"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>

        <Field
          label="API Key"
          htmlFor="jevApiKey"
          hint="存储策略与上方主 Key 相同：默认仅当前会话有效，勾选「记住 API Key 到本机」后才会写入本机。"
        >
          <div className="flex gap-2">
            <TextInput
              id="jevApiKey"
              type={revealKey ? 'text' : 'password'}
              value={draftKey}
              onChange={(event) => {
                setDraftKey(event.target.value);
                setSaved(false);
                setTest({ status: 'idle' });
              }}
              placeholder="sk-..."
              autoComplete="off"
              spellCheck={false}
            />
            <Button type="button" onClick={() => setRevealKey((value) => !value)}>
              {revealKey ? '隐藏' : '显示'}
            </Button>
          </div>
        </Field>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-ink-800 pt-5">
        <Button variant="primary" onClick={handleSave}>
          保存推演配置
        </Button>
        <Button onClick={() => void handleTest()} disabled={test.status === 'testing'}>
          {test.status === 'testing' ? <Spinner /> : null}
          测试推演
        </Button>
        <Button variant="danger" onClick={handleClear} disabled={draftKey === ''}>
          清除推演密钥
        </Button>
        {saved && <span className="text-sm text-jade-400">已保存</span>}
      </div>

      {test.status === 'ok' && (
        <p className="mt-4 rounded-md border border-jade-500/40 bg-jade-900/40 px-4 py-3 text-sm text-jade-300">
          推演通道正常，往返耗时约 {test.latencyMs} ms。
        </p>
      )}

      {test.status === 'error' && (
        <div className="mt-4 space-y-2 rounded-md border border-cinnabar-500/40 bg-cinnabar-900/30 px-4 py-3 text-sm">
          <p className="text-cinnabar-300">推演通道不通：{test.message}</p>
          <p className="leading-relaxed text-ink-300">{test.hint}</p>
          {test.detail && <p className="font-mono text-xs break-all text-ink-500">{test.detail}</p>}
        </div>
      )}
    </Panel>
  );
}
