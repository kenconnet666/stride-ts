import { defineConfig } from 'vite';

// The native module's memory is a SharedArrayBuffer, which needs a cross-origin isolated page.
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  server: { port: 5180, strictPort: true, headers: crossOriginIsolation },
  preview: { port: 5181, strictPort: true, headers: crossOriginIsolation },
  worker: { format: 'es' },
  build: { target: 'es2024' },
});
