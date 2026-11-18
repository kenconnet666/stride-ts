// Platformer2D 的冒烟测试：对着正在运行的页面（开发服务器或 preview，`stride open` 打开的），用调试 CLI 玩一遍。
//   pnpm --filter @stride-ts/platformer2d smoke [-- --hub <中枢名的一部分>]
// 检查：场景在跑、精灵表的帧在换（待机、金币）；按住 D 往右跑（跑步的帧）、A 转身往左（实体绕 Y 转 180°）；W 起跳（跳的帧）；
// 走到右下角的金币上：精灵马上隐藏，3 秒后金币实体移除。
import { startSmoke } from '../../../tools/smoke.ts';

const { stride, sleep, check, finish } = startSmoke('platformer2d');

stride('eval', 'location.reload()');
await sleep(1500);
stride('wait');
await sleep(1000);
const status = stride('status') as { status: string; error: string | null; entities: number };
check('场景在跑', status.status === 'running' && status.error === null && status.entities === 70, status);

/** 页面里的表达式：玩家的 x、y、绕 Y 的朝向（四元数的 y）、精灵的帧、是否着地。 */
const PLAYER = `const g = strideGame; const e = g.entities.entity(g.entities.ids().find((i) => g.entities.entity(i).name === 'Player'));
  const t = e.require(strideEngine.Transform); [t.position.x, t.position.y, t.rotation.y, e.require(strideEngine.Sprite).frame, e.require(strideEngine.Character).grounded]`;
const COINS = `const g = strideGame; const coins = g.entities.ids().map((i) => g.entities.entity(i)).filter((e) => e.name === 'Coin');
  [coins.length, coins.filter((e) => e.require(strideEngine.Sprite).enabled).length, coins.map((e) => e.require(strideEngine.Sprite).frame).join()]`;
type Player = [number, number, number, number, boolean];

const idleFrames = new Set<number>();
for (let i = 0; i < 6; i++) {
  idleFrames.add((stride('eval', PLAYER) as Player)[3]);
  await sleep(220);
}
check('待机时在 0-3 帧之间换', idleFrames.size > 1 && [...idleFrames].every((f) => f >= 0 && f < 4), [...idleFrames]);
const coinFrames = (stride('eval', COINS) as [number, number, string])[2];
await sleep(150);
check('金币在转（帧在换）', (stride('eval', COINS) as [number, number, string])[2] !== coinFrames, coinFrames);

const start = stride('eval', PLAYER) as Player;
stride('key', 'D', '--down');
await sleep(800);
const running = stride('eval', PLAYER) as Player;
stride('key', 'D', '--up');
check('按住 D 往右跑，放跑步的帧', running[0] > start[0] + 2 && running[3] >= 4 && running[3] < 20 && Math.abs(running[2]) < 1e-3, { start, running });

stride('key', 'A', '--hold', '400');
await sleep(200);
const turned = stride('eval', PLAYER) as Player;
check('A 转身往左：绕 Y 转 180°', Math.abs(Math.abs(turned[2]) - 1) < 1e-3 && turned[0] < running[0], turned);

stride('key', 'W');
await sleep(250);
const jumping = stride('eval', PLAYER) as Player;
check('W 起跳，放跳的帧', !jumping[4] && jumping[1] > start[1] + 0.5 && jumping[3] >= 21, jumping);
await sleep(1200);

// 右下角 (13, -6.5) 的金币：往右走过去
const [coins] = stride('eval', COINS) as [number, number, string];
stride('key', 'D', '--down');
await sleep(3200);
stride('key', 'D', '--up');
const collected = stride('eval', COINS) as [number, number, string];
check('碰到金币：精灵马上隐藏', collected[0] === coins && collected[1] === coins - 1, { coins, collected });
await sleep(3300);
check('3 秒后金币实体移除', (stride('eval', COINS) as [number, number, string])[0] === coins - 1, stride('eval', COINS));

finish();
