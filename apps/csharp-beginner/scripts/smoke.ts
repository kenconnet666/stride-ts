// CSharpBeginner 的冒烟测试：对着正在运行的页面（开发服务器或 preview），用调试 CLI 走一遍。
//   pnpm --filter @stride-ts/csharp-beginner smoke [-- --hub <中枢名的一部分>]
// 检查：在跑；菜单里 15 个教程按钮；每个教程都能加载（标题换了、脚本打印出它的字）；键盘、虚拟按钮转茶壶；克隆出三把剑；
// 代码加载模型后能建、清实体；预制体实例化到自定义的父实体下；时间在走；换一圈教程实体数不变；没有错误日志（finish 检查）。
// 按键用合成的 KeyboardEvent（InputManager 在 window 上听）。
import { PAGE_HELPERS, startSmoke } from '@stride-ts/devkit/smoke';

const { stride, sleep, check, finish } = startSmoke('csharp-beginner');

/** 页面里的帮手：byName(实体名)、byNameAll(实体名)。 */
const HELPERS = `(() => {
  const G = strideGame;
  globalThis.byNameAll = (name) => G.entities.ids().map((i) => G.entities.entity(i)).filter((e) => e.name === name);
  globalThis.byName = (name) => byNameAll(name)[0];
  return 1;
})()`;

/** 教程（按钮上的字）→ 加载后应该打印出来的字。 */
const TUTORIALS: readonly (readonly [string, RegExp])[] = [
  ['Getting the entity', /\S/],
  ['Child entities', /\S/],
  ['Transform position', /local position: X:/],
  ['Properties', /^Integer: /],
  ['Getting a component', /^Ammo count 1: /],
  ['Adding a component', /^Remaining ammo: /],
  ['Delta time', /^Total time: /],
  ['Cloning entities', /MasterSword/],
  ['Removing entities', /Clone 1 is a child/],
  ['Keyboard input', /Hold the 1 key/],
  ['Mouse input', /^Mouse position: /],
  ['Virtual buttons', /^Virtual button 'Forward': 0$/],
  ['Linear Interpolation', /^Lerp value: /],
  ['Loading content from code', /^Model is not loaded$/],
  ['Instantiating prefabs', /PileOfBoxes2 with custom parent/],
];

const load = (label: string) => {
  stride('call', 'tutorial', JSON.stringify(label));
  return stride('eval', `frames(3).then(() => ({ lines: lines(), title: uiElements().find((e) => e.name === 'tutorialTitleTxt')?.text }))`) as { lines: string[]; title: string };
};

stride('eval', 'location.reload()');
await sleep(1500);
stride('wait');
await sleep(1000);
const status = stride('status') as { status: string; error: string | null };
check('在跑', status.status === 'running' && status.error === null, status);
stride('eval', PAGE_HELPERS);
stride('eval', HELPERS);

// 菜单的按钮（和 tutorial 命令）在 TutorialUI 的 start 里才建
const buttons = stride('eval', `(async () => {
  const count = () => uiElements().filter((e) => e instanceof strideEngine.Button && e.isVisible && e.name !== 'BtnTutorialMenu').length;
  for (let i = 0; i < 300 && count() === 0; i++) await frames(1);
  return count();
})()`) as number;
check('菜单里 15 个教程按钮', buttons === 15, buttons);

const count = () => stride('eval', `strideGame.entities.count`) as number;
load('Properties');
const countBefore = count();

const broken: unknown[] = [];
for (const [label, marker] of TUTORIALS) {
  const loaded = load(label);
  if (loaded.title !== label || !loaded.lines.some((line) => marker.test(line))) broken.push({ label, ...loaded });
}
check('15 个教程都能加载：标题换了，脚本打印出它的字', broken.length === 0, broken);

load('Keyboard input');
type Turned = { blue: boolean; yellow: boolean };
const keyboard = stride('eval', `(async () => {
  const blue = rotation('Blue Teapot'), yellow = rotation('Yellow Teapot');
  await hold('Digit1', 10);
  await tap('KeyF');
  const moved = (before, name) => rotation(name).some((v, i) => Math.abs(v - before[i]) > 1e-4);
  return { blue: moved(blue, 'Blue Teapot'), yellow: moved(yellow, 'Yellow Teapot') };
})()`) as Turned;
check('键盘：按住 1 转蓝茶壶，按 F 转黄茶壶', keyboard.blue && keyboard.yellow, keyboard);

load('Virtual buttons');
const virtual = stride('eval', `(async () => {
  const before = rotation('Blue Teapot');
  const seen = await hold('KeyW', 10);
  return { seen: seen.find((l) => l.startsWith('Virtual button')), turned: rotation('Blue Teapot').some((v, i) => Math.abs(v - before[i]) > 1e-4) };
})()`) as { seen: string; turned: boolean };
check("虚拟按钮：按住 W 时 Forward 是 1，蓝茶壶转了", virtual.seen === "Virtual button 'Forward': 1" && virtual.turned, virtual);

load('Cloning entities');
const swords = stride('eval', `byNameAll('MasterSword').length`) as number;
check('克隆实体：MasterSword 加三个克隆', swords === 4, swords);

load('Loading content from code');
type Loading = { loaded: boolean; spawned: string; models: number; cleared: string };
const loading = stride('eval', `(async () => {
  await tap('KeyL');
  for (let i = 0; i < 300 && !lines().includes('Model is loaded'); i++) await frames(1);
  await tap('KeyS');
  const spawned = lines().find((l) => l.startsWith('Spawned'));
  const models = byNameAll('My new entity with a model component').filter((e) => e.has(strideEngine.Model)).length;
  await tap('KeyC');
  return { loaded: lines().includes('Model is loaded'), spawned, models, cleared: lines().find((l) => l.startsWith('Spawned')) };
})()`) as Loading;
check('代码加载：L 加载模型，S 建一个带模型的实体，C 清掉', loading.loaded && loading.spawned === 'Spawned entities count: 1' && loading.models === 1 && loading.cleared === 'Spawned entities count: 0', loading);

load('Instantiating prefabs');
const prefab = stride('eval', `frames(30).then(() => byName('PileOfBoxes2')?.require(strideEngine.Transform).children.length ?? 0)`) as number;
check('预制体：第二份挂在 PileOfBoxes2 下', prefab > 0, prefab);

load('Delta time');
const time = () => Number((stride('eval', `lines().find((l) => l.startsWith('Total time'))`) as string).split(': ')[1]);
const t0 = time();
// 按游戏时间等：CI 的软件 WebGPU 上半秒墙钟可能一帧都没走
stride('eval', 'seconds(0.5).then(() => 1)');
const t1 = time();
check('Delta time：总时间在走', t1 > t0, { t0, t1 });

// 克隆到场景根的实体、预制体的实例、代码建的实体都放进了教程的场景（Entity.scene），换教程时跟着销毁
load('Properties');
const countAfter = count();
check('换了一圈教程，实体数不变', countAfter === countBefore, { countBefore, countAfter });

finish();
