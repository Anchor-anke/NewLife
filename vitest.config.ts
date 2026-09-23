import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // 构建产物（.next / out）动辄上千个文件，默认会被 vite 的文件扫描吞进去，
  // 让 `npm test` 从几百毫秒退化到几十秒。这里显式排除。
  server: {
    watch: {
      ignored: ['**/.next/**', '**/out/**', '**/coverage/**'],
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/out/**'],
    setupFiles: ['./src/test/setup.ts'],
  },
});
