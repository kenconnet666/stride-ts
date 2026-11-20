// Platformer2D 的冒烟测试：对着正在运行的页面（开发服务器或 preview，`stride open` 打开的），用调试 CLI 玩一遍。
//   pnpm --filter @stride-ts/platformer2d smoke [-- --hub <中枢名的一部分>]
// 检查：场景在跑、精灵表的帧在换（待机、金币）；W 起跳（跳的帧）；按住 D 往右跑（跑步的帧）、A 转身往左（实体绕 Y 转 180°）；
// 走到右下角的金币上：精灵马上隐藏、音效响起，3 秒后金币实体移除。
import { PAGE_HELPERS, startSmoke } from '../../../tools/smoke.ts';

const { stride, sleep, check, finish } = startSmoke('platformer2d');

stride('eval', 'location.reload()');
await sleep(1500);
stride('wait');
await sleep(1000);
const status = stride('status') as { status: string; error: string | null; entities: number };
check('场景在跑', status.status === 'running' && status.error === null && status.entities === 70, status);

// 页面里的 player2d()：玩家的 x、y、绕 Y 的朝向（四元数的 y）、精灵的帧、是否着地
stride('eval', PAGE_HELPERS);
stride('eval', `globalThis.player2d = () => { const g = strideGame; const e = g.entities.entity(g.entities.ids().find((i) => g.entities.entity(i).name === 'Player'));
  const t = e.require(strideEngine.Transform); return [t.position.x, t.position.y, t.rotation.y, e.require(strideEngine.Sprite).frame, e.require(strideEngine.Character).grounded]; }; 1`);
const PLAYER = 'player2d()';
const COINS = `const g = strideGame; const coins = g.entities.ids().map((i) => g.entities.entity(i)).filter((e) => e.name === 'Coin');
  [coins.length, coins.filter((e) => e.require(strideEngine.Sprite).enabled).length, coins.map((e) => e.require(strideEngine.Sprite).frame).join()]`;
type Player = [number, number, number, number, boolean];

// 等待都按游戏时间和状态（tools/smoke.ts 的 seconds、until、holdFor）：CI 的软件 WebGPU 上一帧要几百毫秒
const idleFrames = new Set<number>(stride('eval', `(async () => { const seen = []; for (let i = 0; i < 6; i++) { seen.push(player2d()[3]); await seconds(0.22); } return seen; })()`) as number[]);
check('待机时在 0-3 帧之间换', idleFrames.size > 1 && [...idleFrames].every((f) => f >= 0 && f < 4), [...idleFrames]);
const coinFrames = stride('eval', `(async () => { const frames = () => (0, eval)(${JSON.stringify(COINS)})[2]; const before = frames(); await seconds(0.15); return [before, frames()]; })()`) as [string, string];
check('金币在转（帧在换）', coinFrames[1] !== coinFrames[0], coinFrames);

// 点选精灵（编号缓冲）：角色所在的像素点到角色，它正上方的天空什么都点不到
const picked = stride('eval', `(async () => {
  const g = strideGame, all = g.entities.ids().map((i) => g.entities.entity(i));
  const player = all.find((e) => e.name === 'Player'), camera = all.find((e) => e.has(strideEngine.Camera));
  const at = strideEngine.worldToScreen(g, camera, player.require(strideEngine.Transform).position);
  const c = g.graphicsDevice.canvas;
  const name = async (x, y) => (await g.pick(c.clientWidth * x, c.clientHeight * y))?.name ?? null;
  return [await name(at.x, at.y), await name(at.x, at.y - 0.12)];
})()`) as (string | null)[];
check('点选：精灵点得到，空处点不到', picked[0] === 'Player' && picked[1] === null, picked);

// 先在出生的地方跳（头顶是空的）：跑完再跳时停在哪里随帧率变，可能停在平台下面，头一碰就落下来（regress 里帧率高时就这样）
const start = stride('eval', PLAYER) as Player;
// 起跳后等它离地半米、精灵换到跳的帧（最多 1.5 秒游戏时间；高帧率下离地那一帧精灵可能还没换），再等落地站稳
const jumping = stride('eval', `tap('KeyW').then(() => until(() => { const p = player2d(); return p[1] > ${start[1] + 0.5} && p[3] >= 21; }, 1.5)).then(player2d)`) as Player;
check('W 起跳，放跳的帧', !jumping[4] && jumping[1] > start[1] + 0.5 && jumping[3] >= 21, jumping);
stride('eval', `until(() => player2d()[4], 3).then(() => seconds(0.3)).then(() => 1)`);

// 按多久都在页面里按游戏时间算（holdFor）：CLI 的每条命令是一个新进程，单核慢的机器上松开会晚到将近一秒，多跑出去一大截
const running = stride('eval', `holdFor('KeyD', 0.8, player2d)`) as Player;
check('按住 D 往右跑，放跑步的帧', running[0] > start[0] + 2 && running[3] >= 4 && running[3] < 20 && Math.abs(running[2]) < 1e-3, { start, running });

// 按住 A 直到往左走了（最多 2 秒游戏时间）：刚才往右跑的速度要先减下来，慢的机器上 0.4 秒只有两三帧
const turned = stride('eval', `(async () => {
  const before = player2d();
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA' }));
  await until(() => player2d()[0] < before[0] - 0.05, 2);
  const after = player2d();
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyA' }));
  await frames(2);
  return [before, after];
})()`) as [Player, Player];
check('A 转身往左：绕 Y 转 180°', Math.abs(Math.abs(turned[1][2]) - 1) < 1e-3 && turned[1][0] < turned[0][0], turned);

// 右下角 (13, -6.5) 的金币：往右走过去
const [coins] = stride('eval', COINS) as [number, number, string];
// 按住 D 到拿到金币为止（最多 5 秒游戏时间）：跑多久才到随起点变，按固定时长跑的话拿到得早时金币 3 秒后就移除了，音效也跟着没了
const collected = stride('eval', `(async () => {
  const coins = () => (0, eval)(${JSON.stringify(COINS)});
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD' }));
  await until(() => coins()[1] < ${coins}, 5);
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyD' }));
  return coins();
})()`) as [number, number, string];
check('碰到金币：精灵马上隐藏', collected[0] === coins && collected[1] === coins - 1, { coins, collected });
const sounds = stride('eval', `const type = strideGame.registry.scriptsNamed('CollectCoin')[0];
  [...strideGame.rootScene.entities.values()].map((e) => e.get(type)?.sfxInstance?.playState).filter(Boolean)`) as string[];
check('拿到的那个金币放了音效', sounds.length === 1 && (sounds[0] === 'playing' || sounds[0] === 'stopped'), sounds);
stride('eval', `until(() => (0, eval)(${JSON.stringify(COINS)})[0] === ${coins - 1}, 5).then(() => 1)`);
check('3 秒后金币实体移除', (stride('eval', COINS) as [number, number, string])[0] === coins - 1, stride('eval', COINS));

finish();
