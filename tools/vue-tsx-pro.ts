/**
 * 编辑器用的 vue-tsx-pro（`~/IdeaProjects/vue-tsx-pro`，npm 包 `@zerodep-dev/vue-tsx-pro-tsx`、`-ui`）在两种来源之间切换：
 *
 *   node tools/vue-tsx-pro.ts dev            用库的 HEAD 的测试版：在本地跑库的 scripts/dev-release.mjs（打包四个包、挂到滚动的预发行版
 *                                            dev 上、文件名带提交号，不跑测试、不靠 CI），pnpm-workspace.yaml 的 overrides 指向那里的
 *                                            tsx、ui，pnpm install。库要先提交推送
 *   node tools/vue-tsx-pro.ts npm <版本>     去掉那两条 override，编辑器的依赖写成 ^<版本>（npm 上的正式版），pnpm install
 *
 * 用户定：vue-tsx-pro 先发测试版直接用、测试后置，主仓库用测试版（不本地安装覆盖，2026-11-21）；测试版不给每个提交打标签，正式版是
 * 打 v* 标签发 npm，挑测试通过的顺手节点发（2026-11-22）；测试版在本地打包上传、不靠 CI，同原生模块的临时版（2026-11-24）。
 * 库的位置可以用环境变量 VUE_TSX_PRO 改。
 */
import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const library = process.env['VUE_TSX_PRO'] ?? path.join(homedir(), 'IdeaProjects', 'vue-tsx-pro');
const workspace = path.join(root, 'pnpm-workspace.yaml');
const PACKAGES = ['@zerodep-dev/vue-tsx-pro-tsx', '@zerodep-dev/vue-tsx-pro-ui'] as const;
/** 这两条 override 前后的标记行：切回 npm 时整段删掉。 */
const BEGIN = '  # vue-tsx-pro：临时发行版（node tools/vue-tsx-pro.ts dev；正式版发了以后 npm <版本> 换回）';
const END = '  # vue-tsx-pro 临时发行版结束';

function setOverrides(lines: string[]): void {
  const text = readFileSync(workspace, 'utf8');
  const start = text.indexOf(BEGIN), end = text.indexOf(END);
  const without = start >= 0 && end > start ? text.slice(0, start) + text.slice(end + END.length + 1) : text;
  const block = lines.length > 0 ? `${BEGIN}\n${lines.join('\n')}\n${END}\n` : '';
  writeFileSync(workspace, without.replace(/\noverrides:\n/, `\noverrides:\n${block}`));
}

// Windows 上 pnpm 是 .cmd，经 shell 起（参数是固定的词）
const install = () => execSync('pnpm install', { cwd: root, stdio: 'inherit' });

function dev(): void {
  const output = execFileSync('node', ['scripts/dev-release.mjs'], { cwd: library, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const urls = JSON.parse(output.trim().split(/\r?\n/).at(-1)!) as Record<string, string>;
  setOverrides(PACKAGES.map((pkg) => {
    if (!urls[pkg]) throw new Error(`dev-release.mjs printed no url for ${pkg}:\n${output}`);
    return `  '${pkg}': ${urls[pkg]}`;
  }));
  install();
}

function npm(version: string): void {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`version must look like 0.31.0, got '${version}'`);
  setOverrides([]);
  const manifest = path.join(root, 'packages', 'editor', 'package.json');
  let text = readFileSync(manifest, 'utf8');
  for (const pkg of PACKAGES) text = text.replace(new RegExp(`("${pkg}": )"[^"]*"`), `$1"^${version}"`);
  writeFileSync(manifest, text);
  install();
}

const [command, version] = process.argv.slice(2);
if (command === 'dev') dev();
else if (command === 'npm' && version) npm(version);
else {
  console.error('usage: node tools/vue-tsx-pro.ts dev | npm <version>');
  process.exit(2);
}
