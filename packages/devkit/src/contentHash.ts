/**
 * 内容文件的哈希命名和长期缓存（路线图"十、大世界收尾"的"加载与缓存"，docs/stages.md 第 4 步的网络层）：构建完成后给 `dist/content`
 * 里的每个文件按内容哈希改名（`Valley.scene.json` → `Valley.scene.3fa9c2d1b0e4.json`），清单（原路径 → 带哈希的路径）嵌进页面
 * （`<script type="application/json" id="stride-content-manifest">`，不用多一个请求），引擎的内容管理器读文件时按清单换成带哈希的地址
 * （ContentManager.resolveUrl）。内容变了名字就变，所以带哈希的文件可以放心设成永不过期（`Cache-Control: immutable`），再次打开页面
 * 几乎不发请求：以前几百个内容文件每次都要向服务器验证一遍（304）。
 *
 * 同时写 `_headers`（Netlify、Cloudflare Pages 的格式）：assets 和 content 永不过期，页面本身每次验证；别的托管看它照着配
 * （nginx 的 `location /content/ { add_header Cache-Control "public, max-age=31536000, immutable"; }` 之类）。开发服务器上不做哈希
 * （没有清单，引擎照旧读原路径）。
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'vite';

/** 原路径（相对内容目录，正斜杠）→ 带哈希的路径。 */
export type ContentManifest = Record<string, string>;

/** 哈希取几位十六进制（48 位：几万个文件里碰撞的概率可以忽略）。 */
const HASH_DIGITS = 12;

/** 清单嵌进页面的元素 id（引擎的 ContentManager 按它读）。 */
export const MANIFEST_ELEMENT_ID = 'stride-content-manifest';

/** 给 directory 里的每个文件（不含预压缩的 .br、.gz）按内容哈希改名，返回清单（路径相对 directory）。 */
export async function hashContentFiles(directory: string): Promise<ContentManifest> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const manifest: ContentManifest = {};
  await Promise.all(entries.filter((entry) => entry.isFile() && !/\.(br|gz)$/.test(entry.name)).map(async (entry) => {
    const file = path.join(entry.parentPath, entry.name);
    const hash = createHash('sha256').update(await readFile(file)).digest('hex').slice(0, HASH_DIGITS);
    const extension = path.extname(entry.name);
    const hashed = `${entry.name.slice(0, entry.name.length - extension.length)}.${hash}${extension}`;
    await rename(file, path.join(entry.parentPath, hashed));
    const relative = (name: string) => path.relative(directory, path.join(entry.parentPath, name)).split(path.sep).join('/');
    manifest[relative(entry.name)] = relative(hashed);
  }));
  return manifest;
}

/** 把清单嵌进页面（head 末尾）；已经有的不重复。 */
export function embedManifest(html: string, manifest: ContentManifest): string {
  if (html.includes(`id="${MANIFEST_ELEMENT_ID}"`)) return html;
  // `<` 换成转义：清单里的路径不可能打断 script 元素
  const json = JSON.stringify(manifest).replace(/</g, '\\u003c');
  return html.replace('</head>', `<script type="application/json" id="${MANIFEST_ELEMENT_ID}">${json}</script></head>`);
}

/** `_headers` 的内容（Netlify、Cloudflare Pages）。 */
export const CACHE_HEADERS = `/assets/*
  Cache-Control: public, max-age=31536000, immutable
/content/*
  Cache-Control: public, max-age=31536000, immutable
/*.html
  Cache-Control: no-cache
/
  Cache-Control: no-cache
`;

export function strideContentHash(): Plugin {
  let outDir = '';
  return {
    name: 'stride-content-hash',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      const content = path.join(outDir, 'content');
      const manifest = await hashContentFiles(content).catch(() => undefined);
      if (!manifest || Object.keys(manifest).length === 0) return;
      const pages = (await readdir(outDir)).filter((name) => name.endsWith('.html'));
      await Promise.all(pages.map(async (name) => {
        const file = path.join(outDir, name);
        await writeFile(file, embedManifest(await readFile(file, 'utf8'), manifest));
      }));
      await writeFile(path.join(outDir, '_headers'), CACHE_HEADERS);
    },
  };
}
