// ThirdPersonPlatformer 的冒烟测试：对着正在运行的页面（开发服务器或 preview，`stride open` 打开的），用调试 CLI 走一遍样例的玩法。
//   pnpm --filter @stride-ts/platformer smoke [-- --hub <中枢名的一部分>]
// 每次先重新加载页面。检查：游戏在跑、场景画出来了；角色落在地上站住；按住 W 往前跑、骨骼跟着动，松开后停下；
// 空格跳起来再落回地面；点选认得出角色；没有错误日志（finish 检查）。镜头要锁定鼠标才转，合成事件锁不了，不在这里测。
import { PAGE_HELPERS, startSmoke } from '../../../tools/smoke.ts';

const { stride, sleep, check, finish } = startSmoke('platformer');

/** 页面里的帮手：player()（带 PlayerController 的实体）、playerAt()（它的世界位置）、poseChange(n)（n 帧里蒙皮矩阵变了多少）。 */
const HELPERS = `(() => {
  const E = strideEngine, G = strideGame;
  const all = () => G.entities.ids().map((i) => G.entities.entity(i));
  globalThis.player = () => { const type = G.registry.scriptsNamed('PlayerController')[0]; return all().find((e) => e.get(type)); };
  globalThis.playerAt = () => { const w = player().require(E.Transform).world; return [w[12], w[13], w[14]]; };
  // 蒙皮矩阵在 n 帧里一共变了多少（角色的动画由脚本自己的混合树给，没有"正在播放"的列表可看）
  globalThis.poseChange = async (n) => {
    const snapshot = () => { const out = []; G.animation.forEachPalette((_, m) => out.push(...m)); return out; };
    let total = 0, last = snapshot();
    for (let i = 0; i < n; i++) { await frame(); const now = snapshot(); total += now.reduce((sum, v, k) => sum + Math.abs(v - last[k]), 0); last = now; }
    return total;
  };
  return 1;
})()`;

// 从刚加载的状态开始（页面要在前台：后台标签页的帧循环会停）
stride('eval', 'location.reload()');
await sleep(1500);
stride('wait');
const status = stride('status') as { status: string; error: string | null };
check('游戏在跑', status.status === 'running' && status.error === null, status);
stride('eval', PAGE_HELPERS);
stride('eval', HELPERS);

const drawn = stride('eval', `(() => { const mesh = strideGame.renderSystem.features.find((f) => f instanceof strideEngine.MeshRenderFeature);
  return { entities: strideGame.entities.count, instances: mesh.instanceCount, drawn: mesh.drawnInstances, draws: mesh.drawCalls }; })()`) as { entities: number; instances: number; drawn: number; draws: number };
check('场景画出来了', drawn.entities > 50 && drawn.drawn > 20 && drawn.draws > 0, drawn);

// 角色出生在半空，落到地上以后高度不再变
type Point = [number, number, number];
const rest = stride('eval', `seconds(1.5).then(async () => { const a = playerAt(); await seconds(0.33); return [a, playerAt()]; })`) as [Point, Point];
check('角色落在地上站住', Math.abs(rest[1][1] - rest[0][1]) < 0.01 && rest[1][1] > -1, rest);

// 点选（GPU 上画编号再读回）：角色在画面中间偏下，点到的是蒙皮的模型；最上面一行是天空，什么都点不到
const picked = stride('eval', `(async () => { const c = strideGame.graphicsDevice.canvas;
  const name = async (x, y) => (await strideGame.pick(c.clientWidth * x, c.clientHeight * y))?.name ?? null;
  return [await name(0.5, 0.6), await name(0.5, 0.005), await name(0.15, 0.9)]; })()`) as (string | null)[];
check('点选：角色、天空、地面', picked[0] === 'MannequinModel' && picked[1] === null && typeof picked[2] === 'string' && picked[2] !== 'MannequinModel', picked);

// 按住 W：往前跑，走跑的动画在播（权重加起来是 1）；松开后停下
const run = stride('eval', `(async () => {
  const before = playerAt();
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
  await seconds(0.67);
  // 跑和站着各看 20 帧的骨骼变化，比的是两者之比，帧率不影响
  const running = await poseChange(20);
  const during = playerAt();
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
  await seconds(1);
  const stopped = playerAt();
  const idle = await poseChange(20);
  return { before, during, running, idle, stopped, after: playerAt() };
})()`) as { before: Point; during: Point; running: number; idle: number; stopped: Point; after: Point };
const moved = Math.hypot(run.during[0] - run.before[0], run.during[2] - run.before[2]);
check('按住 W 往前跑', moved > 2, { moved, ...run });
check('跑步的动画在播：骨骼动得比站着时多', run.running > 0 && run.running > run.idle * 2, { running: run.running, idle: run.idle });
check('松开后停下', Math.hypot(run.after[0] - run.stopped[0], run.after[2] - run.stopped[2]) < 0.02, run);

// 空格：跳起来，再落回原来的高度
const jump = stride('eval', `(async () => {
  const ground = playerAt()[1];
  let top = ground;
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
  await frames(2);
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' }));
  const end = strideGame.updateTime.total + 2;
  while (strideGame.updateTime.total < end) { await frame(); top = Math.max(top, playerAt()[1]); }
  return { ground, top, landed: playerAt()[1] };
})()`) as { ground: number; top: number; landed: number };
check('空格跳起来', jump.top - jump.ground > 0.5, jump);
check('落回地面', Math.abs(jump.landed - jump.ground) < 0.05, jump);

finish();
