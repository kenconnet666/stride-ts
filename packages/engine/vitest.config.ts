import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 测试槽里几个验证并行、占满 CPU 时，合成音效、扫描代理网格这类算几秒的测试会超过默认的 5 秒；单独跑只要 2 秒左右
    testTimeout: 30_000,
  },
});
