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
    <nav className="mx-auto flex max-w-6xl items-center justify-between gap-6 px-6 py-3">
      <Link
        href="/"
        className="font-narrative text-lg tracking-[0.25em] text-gold-300 transition-colors hover:text-gold-400"
      >
        人生引擎
      </Link>

      <div className="flex items-center gap-1 text-sm">
        {LINKS.map((link) => {
          const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
          return (
            <Link
              key={link.href}
              href={link.href}
              className={`rounded-md px-3 py-1.5 transition-colors ${
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
