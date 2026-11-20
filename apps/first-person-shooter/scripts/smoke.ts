// FirstPersonShooter 的冒烟测试：对着正在运行的页面（开发服务器或 preview，`stride open` 打开的，1280x720），用调试 CLI 玩一遍。
//   pnpm --filter @stride-ts/first-person-shooter smoke [-- --hub <中枢名的一部分>]
// 检查：场景在跑、弹匣一开始是空的；真实点击锁定鼠标，第一枪先换弹、2 秒后 9 发；鼠标转视角（灵敏度同 Stride）；W 往看的方向走；
// 瞄准箱子开枪，箱子被推走、少一发、生成枪口火焰等特效的预制体（粒子生出来，定时移除）；按 R 换弹时手臂播换弹动画（枪跟着骨骼动）；
// Esc 解锁鼠标。
import { startSmoke } from '../../../tools/smoke.ts';

const { stride, sleep, check, finish } = startSmoke('first-person-shooter');

stride('eval', 'location.reload()');
await sleep(1500);
stride('wait');
await sleep(2000);
const status = stride('status') as { status: string; error: string | null; entities: number };
check('场景在跑', status.status === 'running' && status.error === null && status.entities > 300, status);

const BY = `const g = strideGame, E = strideEngine; const all = g.entities.ids().map((i) => g.entities.entity(i)); const by = (n) => all.find((e) => e.name === n);
  const at = (e) => { const w = e.require(E.Transform).world; return [w[12], w[13], w[14]]; };`;
const STATE = `${BY} const r = by('Camera').require(E.Transform).rotation;
  ({ yaw: r.y, pitch: r.x, player: at(by('PlayerCharacter')), bullets: by('BulletCount').get(E.Sprite).frame, locked: g.input.isMousePositionLocked, entities: all.length })`;
interface State { yaw: number; pitch: number; player: number[]; bullets: number; locked: boolean; entities: number }
const state = () => stride('eval', STATE) as State;

check('弹匣一开始是空的（子弹数精灵在第 0 帧）', state().bullets === 0, state());

// 第一次点击：锁定鼠标；弹匣空，这一枪变成换弹
stride('mouse', 'left', '--trusted');
await sleep(300);
check('真实点击锁定鼠标', state().locked, state());
await sleep(2200);
check('第一枪先换弹，2 秒后 9 发', state().bullets === 9, state());

// 鼠标往右 64 像素（画布宽 1280）：偏航 -0.05 × 100 × 0.02355 = -0.118 弧度，四元数 y = sin(-0.059)
stride('mouse', 'move', '64', '0');
await sleep(300);
const turned = state();
check('鼠标转视角（灵敏度同 Stride）', Math.abs(turned.yaw - Math.sin(-0.0589)) < 0.003, turned);
stride('key', 'W', '--hold', '1000');
const walked = state();
const dx = walked.player[0]! - turned.player[0]!, dz = walked.player[2]! - turned.player[2]!;
check('W 往看的方向走（偏右 0.118 弧度）', Math.hypot(dx, dz) > 5 && Math.abs(Math.atan2(dx, -dz) - 0.1178) < 0.05, { dx, dz });

// 站到 BoxA 后面 4 米，转回正前方再往下看 76 像素（俯仰 -0.25 弧度），开一枪
const BOX = `${BY} at(by('BoxA'))`;
stride('eval', `${BY} g.simulation.body(by('PlayerCharacter')).teleport({ x: -1, y: 0.05, z: 17 }, { x: 0, y: 0, z: 0, w: 1 }); 1`);
stride('mouse', 'move', '-64', '76');
await sleep(500);
const box = stride('eval', BOX) as number[];
const before = state();
// 在页面里逐帧看、取最多的实体数：特效可能晚一帧生成，枪口火焰又很快移除，忙的时候隔一次 CLI 调用会错过。同时记下每个特效
// （粒子组件所在实体的名字）最多有多少个活着的粒子。一直看到读完结果再停：开枪的 CLI 命令是个新进程，慢的机器上要将近一秒才点下去，
// 按墙钟时间提前定好的窗口会在开枪之前就结束
stride('eval', `globalThis.mostEntities = 0; globalThis.mostParticles = {}; globalThis.watching = true; (() => { const poll = () => {
  globalThis.mostEntities = Math.max(globalThis.mostEntities, strideGame.entities.ids().length);
  for (const c of strideGame.particles.components) {
    const living = c.particleSystem.emitters.reduce((sum, e) => sum + e.pool.living, 0);
    globalThis.mostParticles[c.entity.name] = Math.max(globalThis.mostParticles[c.entity.name] ?? 0, living);
  }
  if (globalThis.watching) requestAnimationFrame(poll); }; poll(); })(); 1`);
stride('mouse', 'left', '--trusted');
await sleep(700);
const most = stride('eval', 'globalThis.watching = false; globalThis.mostEntities') as number;
check('开枪生成特效的预制体（枪口火焰、弹孔、受击拖尾）', most === before.entities + 3, { before: before.entities, most });
const particles = stride('eval', 'globalThis.mostParticles') as Record<string, number>;
check('特效的粒子生出来了（枪口火焰、弹孔是 SpawnerBurst，受击拖尾是 SpawnerFromDistance）', ['MuzzleFlash', 'BulletImpact', 'DamagedTrail'].every((name) => (particles[name] ?? 0) > 0), particles);
await sleep(450);
const pushed = stride('eval', BOX) as number[];
check('瞄准箱子开枪：箱子被推走，少一发', box[2]! - pushed[2]! > 0.2 && state().bullets === 8, { box, pushed, bullets: state().bullets });
check('枪口火焰、弹孔按时移除（受击拖尾 6 秒）', state().entities === before.entities + 1, { before: before.entities, now: state().entities });

// 换弹：手臂播换弹动画，挂在骨骼上的枪相对相机移动
const GUN = `${BY} const c = at(by('Camera')), m = at(by('Gun')); [m[0] - c[0], m[1] - c[1], m[2] - c[2]]`;
const rest = stride('eval', GUN) as number[];
// 在页面里逐帧看、取最大的位移：隔一次 CLI 调用取一个样，赶上动画的哪一刻要看帧节奏（无头浏览器里不稳）。看到读完结果再停（同上）
stride('eval', `globalThis.gunMoved = 0; globalThis.watching = true; (() => { const rest = ${JSON.stringify(rest)}; const poll = () => {
  const now = eval(${JSON.stringify(GUN)}); globalThis.gunMoved = Math.max(globalThis.gunMoved, Math.hypot(...rest.map((v, i) => v - now[i])));
  if (globalThis.watching) requestAnimationFrame(poll); }; poll(); })(); 1`);
stride('key', 'R');
await sleep(1700);
const moved = stride('eval', 'globalThis.watching = false; globalThis.gunMoved') as number;
check('按 R 换弹：手臂播换弹动画（枪跟着骨骼动）', moved > 0.05, { rest, moved });
await sleep(1700);
check('换弹后 9 发', state().bullets === 9, state());

stride('key', 'Escape');
await sleep(300);
check('Esc 解锁鼠标', !state().locked, state());

finish();
