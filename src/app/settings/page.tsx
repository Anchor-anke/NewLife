import { SettingsForm } from '@/components/SettingsForm';

export const metadata = { title: '模型设置 · AI 人生引擎' };

export default function SettingsPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="space-y-2">
        <h1 className="font-narrative text-2xl tracking-widest text-ink-100">模型设置</h1>
        <p className="text-sm leading-relaxed text-ink-400">
          本模拟器采用 BYOK（Bring Your Own Key）：剧情推演由你自己配置的模型完成，
          应用本身不提供额度，也不经手你的密钥。
        </p>
      </header>
      <SettingsForm />
    </div>
  );
}
