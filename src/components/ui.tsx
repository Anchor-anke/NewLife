import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';

/**
 * 极简 UI 套件。
 *
 * 刻意不引入 shadcn/ui：这个项目的界面是高度定制的（叙事流、选项卡、属性条、
 * 结局页），通用组件库能复用的部分很少，反而要背上一整套配置与依赖。
 * 这里只保留真正会重复使用的几个原子组件。
 */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  // 主按钮用实心强调色 + 白字。浅色主题下不能用「深底浅字」那套，
  // 必须显式指定 text-white，否则会继承 ink-100 变成深字压深底。
  primary: 'border-jade-600 bg-jade-600 text-white hover:bg-jade-500 hover:border-jade-500',
  secondary: 'border-ink-600 bg-ink-800 text-ink-100 hover:bg-ink-700 hover:border-ink-500',
  ghost: 'border-transparent bg-transparent text-ink-300 hover:bg-ink-800 hover:text-ink-100',
  danger:
    'border-cinnabar-500/50 bg-transparent text-cinnabar-300 hover:bg-cinnabar-900/60 hover:border-cinnabar-500',
};

export function Button({
  variant = 'secondary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      {...props}
      className={`inline-flex cursor-pointer items-center justify-center gap-2 rounded-md border px-4 py-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${BUTTON_VARIANTS[variant]} ${className}`}
    />
  );
}

export function Panel({
  title,
  description,
  children,
  className = '',
  actions,
}: {
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  actions?: ReactNode;
}) {
  return (
    <section
      className={`rounded-lg border border-ink-700 bg-ink-900 p-5 shadow-[0_1px_2px_rgba(16,24,40,0.05)] ${className}`}
    >
      {(title || actions) && (
        <header className="mb-4 flex items-start justify-between gap-4">
          <div>
            {title && (
              <h2 className="font-narrative text-lg tracking-wide text-gold-300">{title}</h2>
            )}
            {description && <p className="mt-1 text-sm text-ink-400">{description}</p>}
          </div>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm text-ink-200">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs leading-relaxed text-ink-400">{hint}</p>}
    </div>
  );
}

const CONTROL_CLASS =
  'w-full rounded-md border border-ink-600 bg-ink-950/70 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-500 transition-colors focus:border-jade-500 focus:outline-none';

export function TextInput({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${CONTROL_CLASS} ${className}`} />;
}

export function TextArea({ className = '', ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${CONTROL_CLASS} resize-y leading-relaxed ${className}`} />;
}

export function Select({
  className = '',
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={`${CONTROL_CLASS} cursor-pointer ${className}`}>
      {children}
    </select>
  );
}

type BadgeTone = 'neutral' | 'jade' | 'gold' | 'danger';

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'border-ink-600 bg-ink-800/70 text-ink-300',
  jade: 'border-jade-500/40 bg-jade-900/60 text-jade-300',
  gold: 'border-gold-500/40 bg-gold-900/50 text-gold-300',
  danger: 'border-cinnabar-500/40 bg-cinnabar-900/50 text-cinnabar-300',
};

export function Badge({
  tone = 'neutral',
  children,
  className = '',
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center rounded border px-2 py-0.5 text-xs tracking-wide ${BADGE_TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/** 属性条。用于展示修为进度与各项数值。 */
export function StatBar({
  label,
  value,
  max,
  min = 0,
  suffix = '',
  tone = 'jade',
  hint,
}: {
  label: string;
  value: number;
  max?: number;
  min?: number;
  suffix?: string;
  tone?: 'jade' | 'gold' | 'plain';
  hint?: string;
}) {
  const ratio =
    max !== undefined && max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0;

  const fill =
    tone === 'gold' ? 'bg-gold-500' : tone === 'plain' ? 'bg-ink-500' : 'bg-jade-500';

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-ink-300">{label}</span>
        <span className="font-narrative tabular-nums text-ink-100">
          {value}
          {max !== undefined && <span className="text-ink-500"> / {max}</span>}
          {suffix}
        </span>
      </div>
      {max !== undefined && (
        <div className="h-1 overflow-hidden rounded-full bg-ink-800">
          <div
            className={`h-full rounded-full transition-[width] duration-500 ${fill}`}
            style={{ width: `${ratio * 100}%` }}
          />
        </div>
      )}
      {hint && <p className="text-xs text-ink-500">{hint}</p>}
    </div>
  );
}

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-block size-3.5 animate-spin rounded-full border-2 border-ink-500 border-t-jade-400 ${className}`}
      aria-hidden
    />
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-ink-700 px-4 py-8 text-center text-sm text-ink-500">
      {children}
    </div>
  );
}
