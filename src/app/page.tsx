import Link from 'next/link';
import { SetupNotice } from '@/components/SetupNotice';
import { Badge, Panel } from '@/components/ui';
import { WORLDS } from '@/lib/worlds';
import { openLifeRules, visibleAttributes } from '@/lib/engine/ruleset';

const STEPS = [
  {
    title: '选择世界观',
    body: '每个世界有自己的固定法则、专属属性与时间尺度。规则一旦定下，谁都不能改写。',
  },
  {
    title: '创建角色',
    body: '设定人物的起点与成长背景。不同世界会关注不同的能力、关系和目标。',
  },
  {
    title: '推演一生',
    body: '模型推进一段岁月并给出条目，程序按当前世界的规则结算。重要岔路由你决定，结局来自已经发生的事。',
  },
];

export default function HomePage() {
  return (
    <div className="space-y-10">
      <SetupNotice />

      <section className="space-y-5 pt-6 text-center">
        <p className="text-xs tracking-[0.4em] text-ink-500 uppercase">AI Life Engine</p>
        <h1 className="font-narrative text-4xl leading-tight tracking-[0.15em] text-ink-100 sm:text-5xl">
          人生引擎
        </h1>
        <p className="mx-auto max-w-2xl text-base leading-relaxed text-ink-300">
          一个由大语言模型驱动的文字人生模拟器。
          <br className="hidden sm:block" />
          模型负责提出剧情，程序负责结算与存档——世界会自己往前走，你只在岔路口出手。
        </p>

        <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
          <Link
            href="/new"
            className="rounded-md border border-jade-600 bg-jade-600 px-6 py-2.5 text-sm text-white transition-colors hover:border-jade-500 hover:bg-jade-500"
          >
            开始新的一生
          </Link>
          <Link
            href="/saves"
            className="rounded-md border border-ink-600 bg-ink-800 px-6 py-2.5 text-sm text-ink-100 transition-colors hover:border-ink-500 hover:bg-ink-700"
          >
            继续已有的存档
          </Link>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        {STEPS.map((step, index) => (
          <Panel key={step.title}>
            <div className="mb-2 flex items-center gap-2">
              <span className="font-narrative text-gold-400/80">
                {String(index + 1).padStart(2, '0')}
              </span>
              <h3 className="text-ink-100">{step.title}</h3>
            </div>
            <p className="text-sm leading-relaxed text-ink-400">{step.body}</p>
          </Panel>
        ))}
      </section>

      <section className="space-y-4">
        <h2 className="font-narrative text-lg tracking-widest text-gold-300">内置世界</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {WORLDS.map((world) => (
            <Panel key={world.id} title={world.name} description={world.description}>
              <div className="flex flex-wrap gap-2">
                <Badge tone="jade">
                  时间单位：
                  {world.timeUnit === 'year' ? '年' : world.timeUnit === 'month' ? '月' : '日'}
                </Badge>
                <Badge>{visibleAttributes(world).length} 项属性</Badge>
                <Badge>{world.talents.length} 种天赋</Badge>
                <Badge tone="gold">{openLifeRules(world) ? '开放人生' : '阶位成长'}</Badge>
              </div>
            </Panel>
          ))}
        </div>
      </section>

      <footer className="border-t border-ink-800 pt-6 text-xs leading-relaxed text-ink-500">
        <p>
          存档保存在本机浏览器中（IndexedDB）。清理浏览器数据会一并清掉存档，
          建议在存档页定期导出备份。模型调用直接由浏览器发往你配置的服务商，
          不经过任何第三方服务器。
        </p>
      </footer>
    </div>
  );
}
