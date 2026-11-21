/**
 * 原生模块 @stride-ts/native（Jolt 的 fork 里的 `StrideNative/JS`）用哪个 GitHub Release：
 *
 *   node tools/native.ts dev                 把 fork 里刚编好、打好的包（build-wasm.ps1 -SkipTests）发成临时的预发行版
 *                                            （release-native.ps1 -Dev，标签 native-dev-<提交>；fork 要先提交推送），override 指过去，
 *                                            pnpm install：原生的改动马上在这边用上，CI 也装得到；测试和正式版攒一批再做
 *   node tools/native.ts release <版本>      override 换成正式版 native-v<版本> 的地址，pnpm install
 *
 * 用户 2026-11-21 定：wasm 先编译直接用、测试后置，主仓库用临时发行版。fork 的位置可以用环境变量 JOLT_FORK 改。
 */
import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const fork = process.env['JOLT_FORK'] ?? 'C:/code/JoltPhysics';
const workspace = path.join(root, 'pnpm-workspace.yaml');
const OVERRIDE = /^( {2}'@stride-ts\/native': ).*$/m;
const RELEASES = 'https://github.com/kenconnet666/JoltPhysics/releases/download';

function setOverride(target: string): void {
  const text = readFileSync(workspace, 'utf8');
  if (!OVERRIDE.test(text)) throw new Error(`no '@stride-ts/native' override in ${workspace}`);
  writeFileSync(workspace, text.replace(OVERRIDE, `$1${target}`));
  // 参数是固定的词：Windows 上 pnpm 是 .cmd，经 shell 起
  execSync('pnpm install', { cwd: root, stdio: 'inherit' });
  console.log(`@stride-ts/native → ${target}`);
}

function dev(): void {
  const script = path.join(fork, 'StrideNative', 'Scripts', 'release-native.ps1');
  const output = execFileSync('pwsh', ['-NoProfile', '-File', script, '-Dev'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const url = output.trim().split(/\r?\n/).at(-1)!;
  if (!url.startsWith(`${RELEASES}/native-dev-`)) throw new Error(`release-native.ps1 -Dev printed no download url:\n${output}`);
  setOverride(url);
}

function release(version: string): void {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`version must look like 0.43.0, got '${version}'`);
  setOverride(`${RELEASES}/native-v${version}/stride-ts-native-${version}.tgz`);
}

const [command, version] = process.argv.slice(2);
if (command === 'dev') dev();
else if (command === 'release' && version) release(version);
else {
  console.error('usage: node tools/native.ts dev | release <version>');
  process.exit(2);
}
