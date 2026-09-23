import { CharacterCreator } from '@/components/CharacterCreator';

export const metadata = { title: '创建角色 · AI 人生引擎' };

export default function NewGamePage() {
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header className="space-y-2">
        <h1 className="font-narrative text-2xl tracking-widest text-ink-100">开始新的一生</h1>
        <p className="text-sm leading-relaxed text-ink-400">
          先定世界观与资质。这两项决定了你一生的天花板——之后能走多远，就看你怎么用掉有限的寿元。
        </p>
      </header>
      <CharacterCreator />
    </div>
  );
}
