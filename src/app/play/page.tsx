import { Suspense } from 'react';
import { Spinner } from '@/components/ui';
import { PlayClient } from './PlayClient';

export const metadata = { title: '对局 · AI 人生引擎' };

/**
 * 这一页刻意保持为服务端组件，只负责套一层 Suspense。
 *
 * `PlayClient` 内部要用 `useSearchParams` 读取存档 id，而 `useSearchParams`
 * 在静态渲染下必须被 Suspense 边界包住，否则构建会报 missing-suspense-with-csr-bailout。
 */
export default function PlayPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center gap-2 text-sm text-ink-500">
          <Spinner />
          正在载入…
        </div>
      }
    >
      <PlayClient />
    </Suspense>
  );
}
