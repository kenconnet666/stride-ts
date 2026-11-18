// 把 jolt-native-fork 编好的 stride-native / stride-tools 模块拷进 dist/。
// C++ 源码在那个仓库的 StrideNative/ 里，用 StrideNative/Scripts/build-wasm.ps1 编译。
// STRIDE_NATIVE_DIST 可以改位置；默认假定 fork 在 ~/CLionProjects/jolt-native-fork，和 ~/WebstormProjects 并列。
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageDir, '..', '..');
const source = process.env.STRIDE_NATIVE_DIST
  ?? path.resolve(repoRoot, '..', '..', 'CLionProjects', 'jolt-native-fork', 'StrideNative', 'Build', 'WASM_Release', 'dist');
const target = path.join(packageDir, 'dist');

if (!existsSync(path.join(source, 'stride-native-core.wasm'))) {
  const message = `No stride-native build at ${source}. Build it with StrideNative/Scripts/build-wasm.ps1 in jolt-native-fork, or set STRIDE_NATIVE_DIST.`;
  if (!existsSync(path.join(target, 'stride-native-core.wasm'))) {
    console.error(message);
    process.exit(1);
  }
  console.warn(`${message} Keeping the existing copy in ${target}.`);
  process.exit(0);
}

// 绑定是 TypeScript（.ts，Emscripten 工厂的类型在 .d.mts），Emscripten 产物是 .mjs 加 .wasm
const SHIPPED = /\.(ts|mts|mjs|wasm)$/;
mkdirSync(target, { recursive: true });
const shipped = readdirSync(source).filter((name) => SHIPPED.test(name));
let copied = 0;
for (const name of shipped) {
  const from = path.join(source, name);
  const to = path.join(target, name);
  const fromStat = statSync(from);
  if (existsSync(to)) {
    const toStat = statSync(to);
    // utimes 会把时间取整到毫秒。
    if (toStat.size === fromStat.size && Math.abs(toStat.mtimeMs - fromStat.mtimeMs) < 1) continue;
  }
  copyFileSync(from, to);
  // 保留源文件的时间戳，下次同步可以跳过没变的文件。
  utimesSync(to, fromStat.atime, fromStat.mtime);
  copied++;
}

// fork 删掉或改名的文件（例如以前的 .mjs 包装和 .d.ts）不能留在 dist 里
for (const name of readdirSync(target)) {
  if (SHIPPED.test(name) && !shipped.includes(name)) {
    rmSync(path.join(target, name));
    console.log(`Removed ${name}`);
  }
}

writeFileSync(path.join(target, 'source.json'), JSON.stringify({ source, ...gitState(source) }, null, 2) + '\n');
console.log(copied ? `Copied ${copied} file(s) from ${source}` : 'stride-native is up to date');

/** 产物来自 fork 的哪个提交；`dirty` 表示当时工作区有未提交的改动。 */
function gitState(dir) {
  try {
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
    return { commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain').length > 0 };
  } catch {
    return { commit: null, dirty: null };
  }
}
