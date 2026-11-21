/**
 * 原生模块 @stride-ts/native（Jolt 的 fork 里的 `StrideNative/JS`）在两种来源之间切换：
 *
 *   node tools/native.ts local               把 fork 里刚编好、打好的包（build-wasm.ps1 -SkipTests 出的
 *                                            `StrideNative/JS/stride-ts-native-<版本>.tgz`）拷进 vendor/native/，override 指过去，
 *                                            pnpm install：原生的改动马上在这边用上，测试和发版放后面
 *   node tools/native.ts release <版本>      override 换回 GitHub Release 的地址（推送前：CI 装不到本地的包），pnpm install
 *
 * 和 tools/vue-tsx-pro.ts 一样，tgz 放在仓库里面（vendor/ 不进仓库）：路径不带 `..`，JetBrains 解析得了类型。fork 的位置可以用
 * 环境变量 JOLT_FORK 改。流程见 CLAUDE.md 的约定（用户 2026-11-21：wasm 先编译直接用，测试后置）。
 */
import { execSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const fork = process.env['JOLT_FORK'] ?? 'C:/code/JoltPhysics';
const packageDir = path.join(fork, 'StrideNative', 'JS');
const vendor = path.join(root, 'vendor', 'native');
const workspace = path.join(root, 'pnpm-workspace.yaml');
const OVERRIDE = /^( {2}'@stride-ts\/native': ).*$/m;
const RELEASES = 'https://github.com/kenconnet666/JoltPhysics/releases/download';

function setOverride(target: string): void {
  const text = readFileSync(workspace, 'utf8');
  if (!OVERRIDE.test(text)) throw new Error(`no '@stride-ts/native' override in ${workspace}`);
  writeFileSync(workspace, text.replace(OVERRIDE, `$1${target}`));
  // 参数是固定的词：Windows 上 pnpm 是 .cmd，经 shell 起
  execSync('pnpm install', { cwd: root, stdio: 'inherit' });
}

function local(): void {
  const { version } = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as { version: string };
  const file = `stride-ts-native-${version}.tgz`;
  if (!readdirSync(packageDir).includes(file)) throw new Error(`no ${file} in ${packageDir}: build it first (pwsh StrideNative/Scripts/build-wasm.ps1 -SkipTests in the fork)`);
  rmSync(vendor, { recursive: true, force: true });
  mkdirSync(vendor, { recursive: true });
  copyFileSync(path.join(packageDir, file), path.join(vendor, file));
  setOverride(`file:vendor/native/${file}`);
}

function release(version: string): void {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`version must look like 0.43.0, got '${version}'`);
  setOverride(`${RELEASES}/native-v${version}/stride-ts-native-${version}.tgz`);
}

const [command, version] = process.argv.slice(2);
if (command === 'local') local();
else if (command === 'release' && version) release(version);
else {
  console.error('usage: node tools/native.ts local | release <version>');
  process.exit(2);
}
