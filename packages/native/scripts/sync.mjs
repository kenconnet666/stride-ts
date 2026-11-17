// Copies the built stride-native / stride-tools modules from jolt-native-fork into dist/.
// The C++ sources live in that repository (StrideNative/); build them there with
// StrideNative/Scripts/build-wasm.ps1. STRIDE_NATIVE_DIST overrides the default location, which
// assumes the fork is checked out at ~/CLionProjects/jolt-native-fork next to ~/WebstormProjects.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
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

mkdirSync(target, { recursive: true });
let copied = 0;
for (const name of readdirSync(source)) {
  if (!/\.(mjs|wasm|d\.ts)$/.test(name)) continue;
  const from = path.join(source, name);
  const to = path.join(target, name);
  const fromStat = statSync(from);
  if (existsSync(to)) {
    const toStat = statSync(to);
    // utimes rounds to whole milliseconds.
    if (toStat.size === fromStat.size && Math.abs(toStat.mtimeMs - fromStat.mtimeMs) < 1) continue;
  }
  copyFileSync(from, to);
  // Keep the source timestamp so the next sync can skip unchanged files.
  utimesSync(to, fromStat.atime, fromStat.mtime);
  copied++;
}

writeFileSync(path.join(target, 'source.json'), JSON.stringify({ source, ...gitState(source) }, null, 2) + '\n');
console.log(copied ? `Copied ${copied} file(s) from ${source}` : 'stride-native is up to date');

/** Which fork commit the build came from; `dirty` means the working tree had uncommitted changes. */
function gitState(dir) {
  try {
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
    return { commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain').length > 0 };
  } catch {
    return { commit: null, dirty: null };
  }
}
