import { SaveList } from '@/components/SaveList';

export const metadata = { title: '存档 · AI 人生引擎' };

export default function SavesPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header className="space-y-2">
        <h1 className="font-narrative text-2xl tracking-widest text-ink-100">存档</h1>
        <p className="text-sm leading-relaxed text-ink-400">
          所有存档都保存在本机浏览器中，不会上传。导入的存档总是新建一份，不会覆盖已有的。
        </p>
      </header>
      <SaveList />
    </div>
  );
}
