// JumpyJet 的冒烟测试：对着正在运行的页面（开发服务器或 preview，`stride open` 打开的），用调试 CLI 走一遍。
//   pnpm --filter @stride-ts/jumpy-jet smoke [-- --hub <中枢名的一部分>]
// 检查：主菜单的按钮钉在画面的 (0.5, 0.7)；点它开始，计分页面出来，管子往左移（管子上的运动学刚体跟着管子组走）；把一组管子
// 挪到飞机身上，飞机进了管子之间的触发器加一分；不按空格飞机落到地上，结束页面出来、分数清零、背景停住；点 Retry 重新开始；
// 没有错误日志（finish 检查）。点击用合成的指针事件，按画布的比例算坐标。
import { PAGE_HELPERS, startSmoke } from '../../../tools/lib/smoke.ts';

const { stride, sleep, check, finish } = startSmoke('jumpy-jet');

/** 页面里的帮手：jjClick(x, y)（画布的比例）、jjRoot()（UI 页面的根）、jjScore()、jjEntities(name)。 */
const HELPERS = `(() => {
  const canvas = document.querySelector('canvas');
  // 这里的坐标是画布的 0..1
  const at = (type, x, y, target) => pointerAt(type, x * canvas.clientWidth, y * canvas.clientHeight, target);
  globalThis.jjClick = async (x, y) => { at('pointermove', x, y); await frame(); at('pointerdown', x, y); await frame(); await frame(); at('pointerup', x, y, window); await frames(3); };
  globalThis.jjRoot = () => strideGame.ui.components[0].page.rootElement;
  globalThis.jjScore = () => { const root = jjRoot(); return root.constructor.name === 'Canvas' ? [...root.children][0].content.text : null; };
  globalThis.jjEntities = (name) => strideGame.entities.ids().map((id) => strideGame.entities.entity(id)).filter((e) => e.name === name);
  return 1;
})()`;

stride('eval', 'location.reload()');
await sleep(1500);
stride('wait');
await sleep(500);
const status = stride('status') as { status: string; error: string | null };
check('在跑', status.status === 'running' && status.error === null, status);
stride('eval', PAGE_HELPERS);
stride('eval', HELPERS);

type Menu = { root: string; button: number[]; resolution: { x: number; y: number } };
const menu = stride('eval', `(() => {
  const root = jjRoot();
  const button = [...root.content.children].find((e) => e.constructor.name === 'Button');
  return { root: root.constructor.name, button: [...button.worldPosition].slice(0, 2), resolution: strideGame.ui.components[0].resolution };
})()`) as Menu;
const { x: width, y: height } = menu.resolution;
check('主菜单：模态层里的按钮中心钉在 (0.5, 0.7)（SetCanvasRelativePosition 改用相对位置）',
  menu.root === 'ModalElement' && Math.abs(menu.button[0]! - 0.5 * width) < 1 && Math.abs(menu.button[1]! - 0.7 * height) < 1, menu);

const x = (name: string) => stride('eval', `jjEntities('${name}').map((e) => e.require(strideEngine.Transform).position.x)`) as number[];

// 开始后的一段放在页面里一次跑完（CLI 一条命令要几百毫秒，飞机早落地了）：开始时飞机往上飞再落下，0.5 秒内碰不到东西
// （第一组管子从 x = 4 出发，还没到飞机那里）；然后把最左边的一组管子挪到飞机身上：触发器（组里本地 x = 1）罩住飞机，
// 管子在它左边，上下的缺口罩住飞机
type Play = { started: string | null; before: number[]; after: number[]; pipeLocal: number[]; playing: string; scored: string | null };
const play = stride('eval', `(async () => {
  const sets = () => jjEntities('PipeSetRoot').map((e) => e.require(strideEngine.Transform).position);
  const before = sets().map((p) => p.x);
  await jjClick(0.5, 0.7);
  const started = jjScore();
  await new Promise((r) => setTimeout(r, 500));
  const after = sets().map((p) => p.x);
  const pipeLocal = jjEntities('Pipe').map((e) => e.require(strideEngine.Transform).position.x);
  const playing = jjRoot().constructor.name;
  const plane = jjEntities('Character')[0].require(strideEngine.Transform).position;
  const first = sets().sort((a, b) => a.x - b.x)[0];
  // 每帧重新钉到飞机身上，加了分就停：慢的机器（CI 的软件 WebGPU）上一帧追好几步物理，钉一次的话几帧里管子已经移开、
  // 飞机落下撞上管子，结束页面替掉了计分页面
  for (let i = 0; i < 30 && jjScore() !== 'Score :  1'; i++) {
    first.x = plane.x - 1; first.y = plane.y;
    await frames(1);
  }
  return { started, before, after, pipeLocal, playing, scored: jjScore() };
})()`) as Play;
check('点"Touch to Start"：计分页面', play.started === 'Score :  0', play.started);
check('管子组往左移', play.after.every((value, i) => value < play.before[i]! - 1), play);
check('管子的本地位置不变（运动学刚体跟着管子组走，物理不把它拉回去）', play.pipeLocal.every((value) => Math.abs(value) < 1e-3), play.pipeLocal);
check('还在玩（没撞上）', play.playing === 'Canvas', play.playing);
check('飞进管子之间的触发器：加一分', play.scored === 'Score :  1', play.scored);

// 不按空格：落到地上结束
await sleep(3000);
type Over = { root: string; buttons: number; scrolling: boolean };
const over = stride('eval', `({ root: jjRoot().constructor.name, buttons: [...jjRoot().content.children].length, scrolling: strideGame.rootRenderer.isScrolling })`) as Over;
check('落到地上：结束页面（Menu、Retry），背景停住', over.root === 'ModalElement' && over.buttons === 2 && over.scrolling === false, over);
const stopped = x('PipeSetRoot');
await sleep(300);
check('管子停住', JSON.stringify(x('PipeSetRoot')) === JSON.stringify(stopped), stopped);

stride('eval', 'jjClick(0.3, 0.7).then(() => 1)');
type Retry = { score: string | null; plane: number; scrolling: boolean };
const retry = stride('eval', `({ score: jjScore(), plane: jjEntities('Character')[0].require(strideEngine.Transform).position.y, scrolling: strideGame.rootRenderer.isScrolling })`) as Retry;
// 重新开始后飞机以起始速度往上走了几帧
check('点 Retry：分数清零，飞机回到起点重新开始，背景接着滚', retry.score === 'Score :  0' && retry.plane > 0 && retry.plane < 2 && retry.scrolling, retry);

finish();
