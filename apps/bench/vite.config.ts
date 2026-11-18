import { defineConfig } from 'vite';

// 原生模块的内存是 SharedArrayBuffer，页面必须是跨源隔离的。
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  server: { port: 5182, strictPort: true, headers: crossOriginIsolation },
  preview: { port: 5183, strictPort: true, headers: crossOriginIsolation },
  worker: { format: 'es' },
  // Emscripten 的模块按 import.meta.url 找 .wasm 和自己的 worker，预打包会把它挪到 .vite/deps，那层关系就断了
  optimizeDeps: { exclude: ['@stride-ts/native'] },
  build: { target: 'es2024', rollupOptions: { input: ['index.html', 'gc.html'] } },
});
