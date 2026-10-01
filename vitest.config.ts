import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    // 主进程 / 用例门面测试跑 node；渲染层交互测试在文件头用 @vitest-environment happy-dom 覆盖。
    environment: 'node',
    setupFiles: ['tests/renderer/support/animation-environment.ts'],
    pool: 'threads',
    include: ['tests/**/*.test.{ts,tsx}'],
    testTimeout: 15000,
  },
});
