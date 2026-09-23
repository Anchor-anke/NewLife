'use client';

import { useEffect, useState } from 'react';
import { Badge, Button, Field, Panel, Select, Spinner, TextArea, TextInput } from '@/components/ui';
import { JevSettingsForm } from '@/components/JevSettingsForm';
import { useModelSettings } from '@/lib/hooks/useModelSettings';
import { PROVIDER_PRESETS, getPreset } from '@/lib/model/adapter';
import { hintFor, toModelError } from '@/lib/model/errors';
import { createOpenAICompatAdapter } from '@/lib/model/openai-compat';
import { applyPreset, parseExtraHeaders, type ModelSettings } from '@/lib/storage/settings';

type TestState =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'ok'; latencyMs: number }
  | { status: 'error'; message: string; hint: string; detail?: string };

export function SettingsForm() {
  const { settings, apiKey, ready, update, forgetApiKey } = useModelSettings();

  const [draft, setDraft] = useState<ModelSettings>(settings);
  const [draftKey, setDraftKey] = useState(apiKey);
  const [revealKey, setRevealKey] = useState(false);
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState<TestState>({ status: 'idle' });

  // 上下文首次读取完成后，把已保存的配置同步进表单（只做一次）
  const [synced, setSynced] = useState(false);
  useEffect(() => {
    if (!ready || synced) return;
    setDraft(settings);
    setDraftKey(apiKey);
    setSynced(true);
  }, [ready, synced, settings, apiKey]);

  const preset = getPreset(draft.providerId);
  const headerCount = Object.keys(parseExtraHeaders(draft.extraHeaders)).length;

  function patch(changes: Partial<ModelSettings>) {
    setDraft((current) => ({ ...current, ...changes }));
    setSaved(false);
    setTest({ status: 'idle' });
  }

  function handleProviderChange(providerId: string) {
    setDraft((current) => applyPreset(current, providerId));
    setSaved(false);
    setTest({ status: 'idle' });
  }

  function handleSave() {
    update(draft, draftKey);
    setSaved(true);
  }

  async function handleTest() {
    setTest({ status: 'testing' });
    const adapter = createOpenAICompatAdapter({
      baseUrl: draft.baseUrl,
      apiKey: draftKey,
      model: draft.model,
      jsonMode: draft.jsonMode,
      temperature: draft.temperature,
      ...(preset ? { provider: preset.label } : {}),
      ...(headerCount > 0 ? { extraHeaders: parseExtraHeaders(draft.extraHeaders) } : {}),
    });

    try {
      const { latencyMs } = await adapter.ping();
      setTest({ status: 'ok', latencyMs });
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

  return (
    <div className="space-y-6">
      <Panel
        title="模型接口"
        description="这个模拟器由你自己的模型驱动。配置只保存在本机浏览器，不会上传到任何服务器。"
      >
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="服务商" htmlFor="provider" hint={preset?.note}>
            <Select
              id="provider"
              value={draft.providerId}
              onChange={(event) => handleProviderChange(event.target.value)}
            >
              {PROVIDER_PRESETS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="模型名"
            htmlFor="model"
            hint={
              preset && preset.modelSuggestions.length > 0
                ? `常见取值：${preset.modelSuggestions.join('、')}。模型名会随服务商迭代而变化，请以官方文档为准。`
                : '请填入服务商文档中的模型名。'
            }
          >
            <TextInput
              id="model"
              value={draft.model}
              onChange={(event) => patch({ model: event.target.value })}
              placeholder="例如 deepseek-chat"
              autoComplete="off"
            />
          </Field>

          <div className="sm:col-span-2">
            <Field
              label="接口地址"
              htmlFor="baseUrl"
              hint="任何 OpenAI 兼容端点都可以。若将来改用自建网关或服务端代理，把这里指向它即可。"
            >
              <TextInput
                id="baseUrl"
                value={draft.baseUrl}
                onChange={(event) => patch({ baseUrl: event.target.value })}
                placeholder="https://api.example.com/v1"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
          </div>

          <div className="sm:col-span-2">
            <Field
              label="API Key"
              htmlFor="apiKey"
              hint="默认只保存在当前标签页的会话存储中，关闭标签页即失效。"
            >
              <div className="flex gap-2">
                <TextInput
                  id="apiKey"
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

          <div className="sm:col-span-2">
            <Field
              label={
                <span className="flex items-center gap-2">
                  额外请求头
                  <Badge>{headerCount > 0 ? `${headerCount} 条` : '可选'}</Badge>
                </span>
              }
              hint="每行一条，格式为 Key: Value。用于网关鉴权，或服务商要求的特殊开关。"
            >
              <TextArea
                rows={3}
                value={draft.extraHeaders}
                onChange={(event) => patch({ extraHeaders: event.target.value })}
                placeholder={'X-Api-Version: 2024-01-01'}
                spellCheck={false}
              />
            </Field>
          </div>

          <Field label="温度" htmlFor="temperature" hint="越高越天马行空。叙事类任务建议 0.7~1.0。">
            <div className="flex items-center gap-3">
              <input
                id="temperature"
                type="range"
                min={0}
                max={1.5}
                step={0.05}
                value={draft.temperature}
                onChange={(event) => patch({ temperature: Number(event.target.value) })}
                className="h-1 flex-1 cursor-pointer accent-[var(--color-jade-500)]"
              />
              <span className="w-10 text-right text-sm tabular-nums text-ink-200">
                {draft.temperature.toFixed(2)}
              </span>
            </div>
          </Field>

          <Field
            label="单次输出上限"
            htmlFor="maxTokens"
            hint="单位 token，0 表示不发送该参数、交给供应商默认值。一段的输出是若干条目加少量详情，一般 2000 上下；若模型爱给详情、或你开了「让 AI 连续推进」，建议 6000 以上。生成自定义世界时输出更长，若被截断请调到 8000 以上；推理模型（reasoner / o1 一类）的思考也占额度，同样要调大。"
          >
            <TextInput
              id="maxTokens"
              type="number"
              min={0}
              max={32000}
              step={500}
              value={String(draft.maxTokens)}
              onChange={(event) => patch({ maxTokens: Math.max(0, Number(event.target.value) || 0) })}
            />
          </Field>

          <Field
            label="结构化输出"
            htmlFor="jsonMode"
            hint="要求服务商返回严格 JSON。若接口报错提到 response_format，可以在这里关掉。"
          >
            <label htmlFor="jsonMode" className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                id="jsonMode"
                type="checkbox"
                checked={draft.jsonMode}
                onChange={(event) => patch({ jsonMode: event.target.checked })}
                className="size-4 accent-[var(--color-jade-500)]"
              />
              <span className="text-ink-300">{draft.jsonMode ? '已开启' : '已关闭'}</span>
            </label>
          </Field>
        </div>

        <div className="mt-6 space-y-3 border-t border-ink-800 pt-5">
          <label className="flex cursor-pointer items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={draft.persistApiKey}
              onChange={(event) => patch({ persistApiKey: event.target.checked })}
              className="mt-0.5 size-4 accent-[var(--color-jade-500)]"
            />
            <span>
              <span className="text-ink-200">记住 API Key 到本机</span>
              <span className="mt-1 block text-xs leading-relaxed text-ink-400">
                勾选后密钥会写进浏览器的 localStorage，关掉标签页也不会失效，方便长期游玩。
                但浏览器存储不是安全的密钥仓库——任何能访问这台电脑的人、或在这个页面运行的
                第三方脚本，都可能读到它。请只在自己的设备上勾选。
              </span>
            </span>
          </label>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-ink-800 pt-5">
          <Button variant="primary" onClick={handleSave}>
            保存配置
          </Button>
          <Button onClick={handleTest} disabled={test.status === 'testing'}>
            {test.status === 'testing' ? <Spinner /> : null}
            测试连接
          </Button>
          <Button variant="danger" onClick={forgetApiKey} disabled={draftKey === ''}>
            清除密钥
          </Button>
          {saved && <span className="text-sm text-jade-400">已保存</span>}
        </div>

        {test.status === 'ok' && (
          <p className="mt-4 rounded-md border border-jade-500/40 bg-jade-900/40 px-4 py-3 text-sm text-jade-300">
            连接正常，往返耗时约 {test.latencyMs} ms。
          </p>
        )}

        {test.status === 'error' && (
          <div className="mt-4 space-y-2 rounded-md border border-cinnabar-500/40 bg-cinnabar-900/30 px-4 py-3 text-sm">
            <p className="text-cinnabar-300">连接失败：{test.message}</p>
            <p className="leading-relaxed text-ink-300">{test.hint}</p>
            {test.detail && (
              <p className="font-mono text-xs break-all text-ink-500">{test.detail}</p>
            )}
          </div>
        )}
      </Panel>

      <JevSettingsForm />

      <Panel title="关于密钥安全">
        <ul className="space-y-2 text-sm leading-relaxed text-ink-400">
          <li>
            · 模型请求由浏览器直接发往你填写的接口地址，不经过本应用之外的任何服务器。
          </li>
          <li>
            · 不勾选「记住到本机」时，密钥只存在于当前标签页的会话存储，关闭即失效。
          </li>
          <li>
            · 无论存在哪里，浏览器存储都不是安全的密钥仓库，本应用也没有能力对密钥做应用层加密。
          </li>
          <li>· 建议为这个用途单独申请一把 Key，并设置消费上限，避免主 Key 泄露。</li>
          <li>
            · 部分服务商不允许浏览器直连（跨域被拦）。若「测试连接」报网络错误，
            换一家服务商，或把接口地址指向你自己的兼容网关。
          </li>
        </ul>
      </Panel>
    </div>
  );
}
