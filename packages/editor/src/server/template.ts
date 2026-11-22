/**
 * 新建工程（`stride-editor new <目录>`）：在仓库的 apps/ 下建一个能跑的空游戏，编辑器直接打开它接着搭。
 *
 * - 工程：package.json、vite.config.ts（仓库的 tools/lib/vite-app.ts：跨源隔离、调试中枢、编辑器）、index.html、src/main.ts（入口，
 *   开发时热重载）、src/game/<名字>Game.ts（加载 MainScene），端口取仓库里各个应用用过的最大端口 + 2。
 * - 冒烟测试 scripts/smoke.ts（tools/regress.ps1、CI 都跑它）：主场景跑起来、有实体、没有错误日志。游戏搭起来以后往里加检查。
 * - 场景 public/content/MainScene.scene.json：相机、投阴影的太阳、物理天空（太阳跟着它）、地面（JSON 写的平面模型、
 *   一个材质、静态的盒子碰撞体）。空场景里什么都看不见，搭东西也没有参照，所以带上这几样（同 Stride 新建工程的默认场景）。
 * - 这个工程的内容是手搭的、要提交：仓库的 .gitignore 忽略 apps/星号/public/content/（导入的内容），给它加一行例外。
 */
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface NewProjectOptions {
  /** 开发服务器的端口；不给时取仓库里各应用用过的最大端口 + 2（preview 用 + 1）。 */
  readonly port?: number;
}

export interface NewProjectResult {
  readonly root: string;
  readonly port: number;
  readonly files: readonly string[];
}

/** 在 root 建工程（root 不能已经存在，要在仓库的 apps/ 下面）。 */
export async function createProject(root: string, { port }: NewProjectOptions = {}): Promise<NewProjectResult> {
  const repo = await findRepository(root);
  if (path.dirname(root) !== path.join(repo, 'apps')) throw new Error(`stride-editor new: the project must be a folder right under ${path.join(repo, 'apps')}, got ${root}`);
  if (await exists(root)) throw new Error(`stride-editor new: ${root} already exists`);
  const folder = path.basename(root);
  if (!/^[a-z][a-z0-9-]*$/.test(folder)) throw new Error(`stride-editor new: the folder name must be lowercase letters, digits and dashes (it is the package name), got '${folder}'`);
  const name = folder.split('-').map((part) => part[0]!.toUpperCase() + part.slice(1)).join('');
  const devPort = port ?? (await usedPorts(repo)).reduce((max, used) => Math.max(max, used), 5180) + 2;
  const nativeVersion = (JSON.parse(await readFile(path.join(repo, 'packages', 'engine', 'package.json'), 'utf8')) as { dependencies: Record<string, string> }).dependencies['@stride-ts/native'];

  const files: Record<string, string> = {
    'package.json': json({
      name: `@stride-ts/${folder}`,
      private: true,
      license: 'MIT',
      type: 'module',
      scripts: { smoke: 'node scripts/smoke.ts', dev: 'vite', build: 'vite build', preview: 'vite preview', typecheck: 'tsc -p . --incremental --tsBuildInfoFile node_modules/.cache/typecheck.tsbuildinfo' },
      dependencies: { '@stride-ts/engine': 'workspace:*', '@stride-ts/native': nativeVersion },
      devDependencies: { vite: '^8.3.8' },
    }),
    'vite.config.ts': `import { strideApp } from '../../tools/lib/vite-app.ts';\n\nexport default strideApp(${devPort});\n`,
    // 每个样例各查各的类型（根上的 pnpm typecheck 挨个跑）
    'tsconfig.json': json({ extends: '../../tsconfig.base.json', include: ['src', 'scripts', 'vite.config.ts'] }),
    'index.html': indexHtml(name),
    'src/main.ts': mainTs(name),
    'scripts/smoke.ts': smokeTs(folder),
    [`src/game/${name}Game.ts`]: gameTs(name),
    'public/content/MainScene.scene.json': json(mainScene()),
    'public/content/Models/Ground.model': json({ format: 1, procedural: { type: 'plane', size: [1000, 1000], uvScale: [500, 500] }, materials: ['Materials/Ground'] }),
    'public/content/Materials/Ground.material.json': json({ name: 'Ground', baseColor: [0.16, 0.22, 0.12, 1], metalness: 0, roughness: 0.9 }),
  };
  for (const [file, content] of Object.entries(files)) {
    const absolute = path.join(root, file);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  await allowContent(repo, folder);
  return { root, port: devPort, files: Object.keys(files) };
}

/** 往上找 pnpm-workspace.yaml 所在的目录（仓库根）。 */
async function findRepository(from: string): Promise<string> {
  for (let dir = path.dirname(from); ; dir = path.dirname(dir)) {
    if (await exists(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    if (path.dirname(dir) === dir) throw new Error(`stride-editor new: ${from} is not inside the stride-ts repository (no pnpm-workspace.yaml above it)`);
  }
}

/** 仓库里各应用的 vite.config.ts 里 strideApp(端口) 的端口。 */
async function usedPorts(repo: string): Promise<number[]> {
  const apps = path.join(repo, 'apps');
  const ports: number[] = [];
  for (const entry of await readdir(apps, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const config = await readFile(path.join(apps, entry.name, 'vite.config.ts'), 'utf8').catch(() => '');
    const match = /strideApp\((\d+)/.exec(config);
    if (match) ports.push(Number(match[1]));
  }
  return ports;
}

/** .gitignore 里导入的内容那一行后面加上这个工程的例外（已经有了就不加）。 */
async function allowContent(repo: string, folder: string): Promise<void> {
  const file = path.join(repo, '.gitignore');
  const text = await readFile(file, 'utf8');
  const line = `!/apps/${folder}/public/content/`;
  if (text.split(/\r?\n/).includes(line)) return;
  const ignored = '/apps/*/public/content/';
  const lines = text.split(/\r?\n/);
  const at = lines.indexOf(ignored);
  if (at < 0) throw new Error(`stride-editor new: ${file} has no '${ignored}' line to add the exception after`);
  // 例外们放在同一行注释下面
  const comment = '# 手搭的工程，内容要提交';
  if (lines[at + 1] === comment) lines.splice(at + 2, 0, line);
  else lines.splice(at + 1, 0, comment, line);
  await writeFile(file, lines.join('\n'));
}

function mainScene(): object {
  const id = () => crypto.randomUUID();
  const sun = id();
  const transform = (position: readonly number[], rotation: readonly number[] = [0, 0, 0, 1]) => ({ parent: null, position, rotation, scale: [1, 1, 1] });
  // 太阳从斜上方照下来：先绕 Y 转 -30°、再绕 X 转 -50°（四元数 q = qY · qX）
  const halfX = (-50 * Math.PI) / 360, halfY = (-30 * Math.PI) / 360;
  const sunRotation = [Math.cos(halfY) * Math.sin(halfX), Math.sin(halfY) * Math.cos(halfX), -Math.sin(halfY) * Math.sin(halfX), Math.cos(halfY) * Math.cos(halfX)].map((v) => +v.toFixed(6));
  // 相机在 (0, 4, 10)，往下看 12°（地平线在画面上方三分之一处）。地面 1000 米见方：小了的话边缘和地平线之间露出一条物理天空的地表。物理天空按太阳的强度算亮度，太阳 8 时天是蓝的（3 时像傍晚）
  const tilt = (-12 * Math.PI) / 360;
  return {
    name: 'MainScene',
    compositor: { clearColor: [0.1, 0.1, 0.12, 1], postEffects: { brightFilter: true, bloom: true, lightStreak: false, lensFlare: false, toneMap: true, antialiasing: true, antialiasingMode: 'temporal' }, transparent: true },
    entities: [
      { id: id(), name: 'Camera', ...transform([0, 4, 10], [+Math.sin(tilt).toFixed(6), 0, 0, +Math.cos(tilt).toFixed(6)]), components: { camera: { verticalFieldOfView: 45, nearClipPlane: 0.1, farClipPlane: 1000 } } },
      { id: sun, name: 'Sun', ...transform([0, 10, 0], sunRotation), components: { light: { type: 'directional', color: [1, 0.98, 0.94], intensity: 8, shadow: { size: 'large', filter: 'pcf5x5', cascadeCount: 'four', depthBias: 0.0015, normalOffsetScale: 10, stabilization: 'projectionSnapping', pssmFactor: 0.5, depthRange: 'automatic', minDistance: 0, maxDistance: 60, blendCascades: true } } } },
      { id: id(), name: 'Sky', ...transform([0, 0, 0]), components: { skyAtmosphere: { sun } } },
      { id: id(), name: 'Ground', ...transform([0, 0, 0]), components: { model: { model: 'Models/Ground', materials: [] }, static: { shapes: [{ type: 'box', size: [1000, 1, 1000], position: [0, -0.5, 0], rotation: [0, 0, 0, 1], mass: 1 }], layer: 0, friction: 0.5 } } },
    ],
  };
}

function indexHtml(name: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${name}</title>
    <link rel="icon" href="data:," />
    <style>
      html, body { margin: 0; height: 100%; background: #000; overflow: hidden; }
      canvas { display: block; width: 100%; height: 100%; }
      #stats {
        position: fixed; top: 8px; left: 8px; margin: 0; padding: 6px 8px;
        font: 12px/1.4 ui-monospace, monospace; color: #e8e8e8; background: rgb(0 0 0 / 0.5);
        white-space: pre;
      }
    </style>
  </head>
  <body>
    <canvas id="game"></canvas>
    <pre id="stats">starting...</pre>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`;
}

function mainTs(name: string): string {
  return `/// <reference types="vite/client" />
// 入口只负责启动，游戏内容在 game/ 里，开发时可以热重载。场景在 public/content，用编辑器（开发服务器上的 /__stride/editor/）搭。
import * as engine from '@stride-ts/engine';
import { Game } from '@stride-ts/engine';
import { physics } from '@stride-ts/native/physics';
import { texture } from '@stride-ts/native/texture';
import { ${name}Game } from './game/${name}Game';

// 调试用：控制台和 stride eval 可以拿到引擎的类型
(globalThis as { strideEngine?: typeof engine }).strideEngine = engine;

const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
const stats = document.querySelector<HTMLElement>('#stats')!;
const modules = import.meta.glob('./game/**/*.ts', { eager: true });

const { game, created } = Game.hotEntry(import.meta.hot, modules, ${name}Game);
if (created) {
  game.run(canvas, { modules, stats, debugNative: import.meta.env.DEV, debug: import.meta.env.DEV || undefined, nativeFeatures: [physics, texture] }).catch((error: unknown) => {
    stats.textContent = \`failed: \${error instanceof Error ? error.message : String(error)}\`;
  });
}
`;
}

function smokeTs(folder: string): string {
  return `// 冒烟测试：对着正在运行的页面（开发服务器或 preview，\`stride open\` 打开的），用调试 CLI 走一遍。
//   pnpm --filter @stride-ts/${folder} smoke [-- --hub <中枢名的一部分>]
// 检查：主场景跑起来了、有实体；没有错误日志（finish 检查）。游戏搭起来以后在这里加玩法的检查。
import { startSmoke } from '../../../tools/lib/smoke.ts';

const { stride, check, finish } = startSmoke('${folder}');

stride('wait');
const status = stride('status') as { scene: string | null; error: string | null; entities: number };
check('主场景跑起来了，有实体', status.scene === 'MainScene' && status.error === null && status.entities > 0, status);

finish();
`;
}

function gameTs(name: string): string {
  return `// 游戏：加载主场景。场景里的脚本按登记的名字对上 game/ 里的 TS 脚本。
import { Game } from '@stride-ts/engine';

export class ${name}Game extends Game {
  protected override async loadContent(): Promise<void> {
    await this.setRootScene('MainScene');
  }
}
`;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 1)}\n`;
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(() => true, () => false);
}
