'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/new', label: '开始新的一生' },
  { href: '/saves', label: '存档' },
  { href: '/settings', label: '模型设置' },
] as const;

export function NavBar() {
  const pathname = usePathname();

  return (
    <nav className="mx-auto flex max-w-6xl flex-col items-start gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:px-6">
      <Link
        href="/"
        className="shrink-0 whitespace-nowrap font-narrative text-lg tracking-[0.25em] text-gold-300 transition-colors hover:text-gold-400"
      >
        人生引擎
      </Link>

      <div className="flex w-full flex-wrap items-center gap-1 text-sm sm:w-auto">
        {LINKS.map((link) => {
          const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
          return (
            <Link
              key={link.href}
              href={link.href}
              aria-current={active ? 'page' : undefined}
              className={`whitespace-nowrap rounded-md px-3 py-1.5 transition-colors ${
                active
                  ? 'bg-ink-800 text-ink-100'
                  : 'text-ink-400 hover:bg-ink-800/60 hover:text-ink-100'
              }`}
            >
              {link.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
