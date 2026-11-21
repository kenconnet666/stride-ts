/**
 * 编辑器用的 vue-tsx-pro（`~/IdeaProjects/vue-tsx-pro`，npm 包 `@zerodep-dev/vue-tsx-pro-tsx`、`-ui`）在两种来源之间切换：
 *
 *   node tools/vue-tsx-pro.ts local          在 vue-tsx-pro 里打包 tsx、ui（pnpm pack，会先构建），放进 vendor/vue-tsx-pro/，
 *                                            pnpm-workspace.yaml 的 overrides 指过去，pnpm install：库里的改动当场在编辑器里见效
 *   node tools/vue-tsx-pro.ts npm <版本>     去掉那两条 override，编辑器的依赖写成 ^<版本>，pnpm install（推送前：CI 装不到本地的包）
 *
 * tgz 放在仓库里面（vendor/ 不进仓库）：路径不带 `..`，pnpm 建的目录名 JetBrains 解析得了类型。库的位置可以用环境变量
 * VUE_TSX_PRO 改。流程见 CLAUDE.md 的约定（用户 2026-11-21：本地打包本地安装来快速迭代，同时照常发版）。
 */
import { execSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const library = process.env['VUE_TSX_PRO'] ?? path.join(homedir(), 'IdeaProjects', 'vue-tsx-pro');
const vendor = path.join(root, 'vendor', 'vue-tsx-pro');
const workspace = path.join(root, 'pnpm-workspace.yaml');
const PACKAGES = { tsx: '@zerodep-dev/vue-tsx-pro-tsx', ui: '@zerodep-dev/vue-tsx-pro-ui' } as const;
/** 这两条 override 前后的标记行：切回 npm 时整段删掉。 */
const BEGIN = '  # vue-tsx-pro：本地打的包（node tools/vue-tsx-pro.ts local；推送前 npm <版本> 换回）';
const END = '  # vue-tsx-pro 本地包结束';

// 参数都是自己拼的路径和固定的词（没有空格、引号），拼成一行交给 shell：Windows 上 pnpm 是 .cmd，不经 shell 起不来
const pnpm = (args: string[], cwd: string) => execSync(`pnpm ${args.map((a) => JSON.stringify(a)).join(' ')}`, { cwd, stdio: 'inherit' });

function setOverrides(lines: string[]): void {
  const text = readFileSync(workspace, 'utf8');
  const start = text.indexOf(BEGIN), end = text.indexOf(END);
  const without = start >= 0 && end > start ? text.slice(0, start) + text.slice(end + END.length + 1) : text;
  const block = lines.length > 0 ? `${BEGIN}\n${lines.join('\n')}\n${END}\n` : '';
  writeFileSync(workspace, without.replace(/\noverrides:\n/, `\noverrides:\n${block}`));
}

function local(): void {
  rmSync(vendor, { recursive: true, force: true });
  mkdirSync(vendor, { recursive: true });
  for (const name of Object.keys(PACKAGES)) pnpm(['pack', '--pack-destination', vendor], path.join(library, 'packages', name));
  const files = readdirSync(vendor);
  const lines = Object.entries(PACKAGES).map(([name, pkg]) => {
    const file = files.find((f) => f.startsWith(`zerodep-dev-vue-tsx-pro-${name}-`));
    if (!file) throw new Error(`no packed ${pkg} in ${vendor}`);
    return `  '${pkg}': file:vendor/vue-tsx-pro/${file}`;
  });
  setOverrides(lines);
  pnpm(['install'], root);
}

function npm(version: string): void {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`version must look like 0.31.0, got '${version}'`);
  setOverrides([]);
  const manifest = path.join(root, 'packages', 'editor', 'package.json');
  let text = readFileSync(manifest, 'utf8');
  for (const pkg of Object.values(PACKAGES)) text = text.replace(new RegExp(`("${pkg}": )"[^"]*"`), `$1"^${version}"`);
  writeFileSync(manifest, text);
  pnpm(['install'], root);
}

const [command, version] = process.argv.slice(2);
if (command === 'local') local();
else if (command === 'npm' && version) npm(version);
else {
  console.error('usage: node tools/vue-tsx-pro.ts local | npm <version>');
  process.exit(2);
}
