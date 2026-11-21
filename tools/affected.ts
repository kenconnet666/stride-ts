// 按改动挑要跑的冒烟样例（分层测试的第 2 层；全量交给 CI）：和 base（默认 origin/main）比，加上工作区里没提交的改动，改了哪些
// 文件就跑覆盖它们的样例。只改了文档的不跑；认不出的改动跑一组代表样例。打印逗号分隔的样例名（regress.ps1 -Changed 用）。
// 加 --editor 时打印要跑编辑器验收（tools/editor-accept）的样例：改了编辑器、场景的加载和格式、验收工具时是 EDITOR_APPS，不然是空的。
//   node tools/affected.ts [base] [--editor]
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apps = new Set(readdirSync(path.join(root, 'apps'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name));

/** 覆盖面广的几个：3D 网格和阴影（TPP）、物理（bepu-sample）、粒子、2D 精灵、全屏 UI。 */
const REPRESENTATIVE = ['platformer', 'bepu-sample', 'particles-sample', 'platformer2d', 'game-menu'];

/** 引擎的模块 → 用得最多的样例（顺序是先匹配先用）。 */
const AREAS: readonly (readonly [RegExp, readonly string[]])[] = [
  // 游戏的启动、帧循环、游戏设置：代表样例加上靠游戏设置里自己的根渲染器画的两个（没有场景）
  [/^packages\/engine\/src\/engine\/Game\.ts$/, [...REPRESENTATIVE, 'custom-effect', 'sprite-fonts']],
  [/^packages\/engine\/src\/physics\/(NavigationSystem|RecastNavigation)/, ['csharp-intermediate', 'topdown-rpg']],
  [/^packages\/engine\/src\/physics\//, ['physics-sample', 'bepu-sample', 'platformer', 'first-person-shooter', 'topdown-rpg']],
  [/^packages\/engine\/src\/(animation|engine\/transform)/, ['animated-model', 'morph-targets', 'platformer', 'first-person-shooter']],
  [/^packages\/engine\/src\/ui\//, ['game-menu', 'ui-element-link', 'ui-particles', 'sprite-fonts', 'jumpy-jet']],
  [/^packages\/engine\/src\/input\//, ['platformer', 'platformer2d', 'csharp-intermediate', 'game-menu', 'first-person-shooter']],
  [/^packages\/engine\/src\/particles\//, ['particles-sample', 'ui-particles', 'first-person-shooter']],
  [/^packages\/engine\/src\/audio\//, ['simple-audio', 'platformer2d', 'csharp-intermediate']],
  [/^packages\/engine\/src\/rendering\/text\//, ['sprite-fonts', 'game-menu', 'csharp-beginner']],
  [/^packages\/engine\/src\/rendering\/(Sprite|SpriteSheet)/, ['platformer2d', 'jumpy-jet', 'space-escape', 'sprite-fonts']],
  [/^packages\/engine\/src\/(rendering|graphics)\//, ['platformer', 'bepu-sample', 'material-shader', 'custom-effect', 'particles-sample', 'platformer2d']],
  [/^packages\/engine\/src\/editor\/|^packages\/editor\//, ['platformer', 'topdown-rpg']],
];

/** 改了这些要跑编辑器验收：编辑器（前端、后端、引擎里的那一半）、场景和资源的加载、格式和字段描述、验收工具本身。 */
const EDITOR = /^(packages\/editor\/src\/|packages\/engine\/src\/(editor|content)\/|tools\/editor-accept\/)/;
/** 编辑器验收跑的样例：导入的 Stride 场景（TPP，组件最全）和用编辑器自己搭的（白盒、SDF、多边形、粒子、贴图层）。 */
const EDITOR_APPS = ['platformer', 'greybox'];

/** 不影响任何样例的。 */
const IGNORED = /^(docs\/|.*\.md$|\.github\/|tools\/(budgets\.json|stride-capture\/|debug-bridge\/|measure\.ps1|verify\.ps1|import-all\.ps1|affected\.ts|content-key\.ts)|packages\/[^/]+\/test\/|apps\/[^/]+\/scripts\/import\.ts$)/;

const args = process.argv.slice(2);
const editor = args.includes('--editor');
const base = args.find((arg) => !arg.startsWith('--')) ?? 'origin/main';
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
const changed = new Set([...git('diff', '--name-only', `${base}...HEAD`), ...git('diff', '--name-only', 'HEAD')]);

if (editor) {
  console.log([...changed].some((file) => EDITOR.test(file)) ? EDITOR_APPS.filter((name) => apps.has(name)).join(',') : '');
  process.exit(0);
}

const selected = new Set<string>();
for (const file of changed) {
  if (IGNORED.test(file)) continue;
  const app = /^apps\/([^/]+)\//.exec(file)?.[1];
  if (app && apps.has(app)) {
    selected.add(app);
    continue;
  }
  const area = AREAS.find(([pattern]) => pattern.test(file));
  for (const name of area ? area[1] : REPRESENTATIVE) if (apps.has(name)) selected.add(name);
}
console.log([...selected].sort().join(','));
