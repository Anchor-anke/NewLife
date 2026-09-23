import type { Metadata } from 'next';
import { NavBar } from '@/components/NavBar';
import { ModelSettingsProvider } from '@/lib/hooks/useModelSettings';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI 人生引擎',
  description: '由大语言模型驱动的文字人生模拟器',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body className="relative min-h-dvh">
        <ModelSettingsProvider>
          <div className="relative z-10 flex min-h-dvh flex-col">
            {/* 悬浮导航：半透明纸底 + 毛玻璃，内容从它底下滚过 */}
            <header className="sticky top-0 z-40 border-b border-ink-800/80 bg-ink-950/80 backdrop-blur-md">
              <NavBar />
            </header>
            <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</main>
          </div>
        </ModelSettingsProvider>
      </body>
    </html>
  );
}
