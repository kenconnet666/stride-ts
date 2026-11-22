/**
 * apps/* 共用的 Vite 配置：
 * - 跨源隔离的响应头（原生模块的内存是 SharedArrayBuffer），开发服务器和 preview 都加；
 * - Emscripten 的模块按 import.meta.url 找 .wasm 和自己的 worker，不能被预打包（optimizeDeps.exclude）；
 * - 调试中枢（@stride-ts/cli 的 strideDebug）：游戏打开 debug 后连上来，`stride` 命令就能查看和操作它；
 * - 编辑器（@stride-ts/editor 的 strideEditor，只在开发服务器上）：界面在 `/__stride/editor/`；资源数据库、保存接口，按内容目录生成
 *   `src/assets.gen.ts`；依赖的资源包（@stride-ts/assets）开发时由编辑器后端、构建前由 strideAssetPackages 同步进内容目录；
 * - 构建后给 dist 里每个压得小的文件旁边写 .br 和 .gz（precompress）。静态服务器打开预压缩文件的支持
 *   （nginx 的 brotli_static/gzip_static、Caddy 的 precompressed 等）就直接发它们，不依赖托管平台在线压缩。
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';
import { strideDebug } from '@stride-ts/cli/vite';
import { strideAssetPackages, strideEditor } from '@stride-ts/editor/vite';
import { defineConfig, mergeConfig, type Plugin, type UserConfig } from 'vite';

const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

/** port 是开发服务器的端口，preview 用 port + 1；extra 合并进去（比如多页面的 build.rollupOptions.input）。 */
export function strideApp(port: number, extra: UserConfig = {}): UserConfig {
  return mergeConfig(defineConfig({
    server: { port, strictPort: true, headers: crossOriginIsolation },
    preview: { port: port + 1, strictPort: true, headers: crossOriginIsolation },
    worker: { format: 'es' },
    optimizeDeps: { exclude: ['@stride-ts/native'] },
    build: { target: 'es2024' },
    plugins: [strideDebug(), strideEditor(), strideAssetPackages(), precompress()],
  }), extra);
}

/** 小于它的文件不压缩：省下的字节不值一个额外的文件。 */
const MIN_BYTES = 1024;
/** 压缩后至少要小这么多才写（KTX2 已经是 zstd，PNG、JPEG 本来就压过）。 */
const MAX_RATIO = 0.9;

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/** 构建完成后给 outDir 里的文件写 .br（最高质量）和 .gz（level 9）；压不小的跳过。 */
function precompress(): Plugin {
  let outDir = '';
  return {
    name: 'stride-precompress',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      const files = (await readdir(outDir, { recursive: true, withFileTypes: true }))
        .filter((entry) => entry.isFile() && !/\.(br|gz)$/.test(entry.name))
        .map((entry) => path.join(entry.parentPath, entry.name));
      let raw = 0, compressed = 0;
      await Promise.all(files.map(async (file) => {
        const data = await readFile(file);
        raw += data.byteLength;
        if (data.byteLength < MIN_BYTES) {
          compressed += data.byteLength;
          return;
        }
        const [br, gz] = await Promise.all([
          brotli(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.byteLength } }),
          gzipAsync(data, { level: 9 }),
        ]);
        const writes: Promise<void>[] = [];
        if (br.byteLength < data.byteLength * MAX_RATIO) writes.push(writeFile(`${file}.br`, br));
        if (gz.byteLength < data.byteLength * MAX_RATIO) writes.push(writeFile(`${file}.gz`, gz));
        await Promise.all(writes);
        compressed += writes.length > 0 ? br.byteLength : data.byteLength;
      }));
      const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(2);
      this.info(`precompressed ${files.length} files: ${mb(raw)} MB -> ${mb(compressed)} MB with brotli`);
    },
  };
}
