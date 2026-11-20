// 冒烟测试：对着正在运行的页面（开发服务器或 preview，`stride open` 打开的），用调试 CLI 走一遍。
//   pnpm --filter @stride-ts/collect-dodge smoke [-- --hub <中枢名的一部分>]
// 检查：主场景跑起来了；按 W 玩家朝前走；吃金币加分、金币消失；被障碍撞到回到出生点；金币吃完门升起来；走进终点赢了。
// 金币和终点用瞬移过去（障碍来回走，走过去撞不撞到看时机）；撞障碍是把障碍挪到玩家身上。没有错误日志（finish 检查）。
import { PAGE_HELPERS, startSmoke } from '../../../tools/smoke.ts';

const { stride, check, finish } = startSmoke('collect-dodge');

stride('eval', 'location.reload()');
stride('wait');
const status = stride('status') as { scene: string | null; error: string | null; entities: number };
check('主场景跑起来了，有实体', status.scene === 'MainScene' && status.error === null && status.entities > 0, status);
stride('eval', PAGE_HELPERS);
// 页面里的帮手：规则的状态（rules 命令）、实体的世界位置、把玩家瞬移到某处
stride('eval', `(() => {
  const g = strideGame;
  globalThis.rules = () => g.debug.run('rules');
  globalThis.worldAt = (name) => { const w = entity(name).get(strideEngine.Transform).world; return [w[12], w[13], w[14]]; };
  globalThis.teleportPlayer = (x, y, z) => g.simulation.body(entity('Player')).teleport({ x, y, z }, { x: 0, y: 0, z: 0, w: 1 });
  return 1;
})()`);

const start = stride('eval', `(async () => { await seconds(0.5); return rules(); })()`) as { total: number; collected: number };
check('开局：关卡里 5 个金币，一个没吃', start.total === 5 && start.collected === 0, start);

const walked = stride('eval', `(async () => { const before = worldAt('Player'); await holdFor('KeyW', 0.5); return [before[2], worldAt('Player')[2]]; })()`) as [number, number];
check('按 W 玩家朝前（-Z，相机看的方向）走', walked[1] < walked[0] - 1, walked);

const coin = stride('eval', `(async () => {
  const [x, , z] = worldAt('Coin1');
  teleportPlayer(x, 1, z);
  const state = await until(() => rules().collected === 1 && rules(), 3);
  await seconds(0.2);
  return [state, named('Coin1').length];
})()`) as [{ collected: number } | false, number];
check('走进金币：加一分，金币消失', coin[0] !== false && coin[1] === 0, coin);

const hit = stride('eval', `(async () => {
  teleportPlayer(0, 1, 2);
  await seconds(0.3);
  const before = rules().hits;
  // 把一个障碍挪到玩家身上（运动学物体按变换跟过去）
  const obstacle = entity('Obstacle1').get(strideEngine.Transform);
  obstacle.position = { x: 0, y: 0.75, z: 2 };
  const state = await until(() => rules().hits > before && rules(), 3);
  await seconds(0.2);
  return [state, worldAt('Player')];
})()`) as [{ hits: number } | false, number[]];
check('被障碍撞到：记一次，玩家回到出生点', hit[0] !== false && Math.abs(hit[1][2]! - 6) < 1, hit);

const opened = stride('eval', `(async () => {
  for (const name of ['Coin2', 'Coin3', 'Coin4', 'Coin5']) {
    const [x, , z] = worldAt(name);
    teleportPlayer(x, 1, z);
    await until(() => named(name).length === 0, 3);
  }
  const closed = worldAt('Door')[1];
  await seconds(2);
  return [rules(), closed, worldAt('Door')[1]];
})()`) as [{ collected: number }, number, number];
check('金币吃完：门升起来', opened[0].collected === 5 && opened[2] > opened[1] + 2.5, opened);

const won = stride('eval', `(async () => {
  teleportPlayer(0, 1, -16);
  await seconds(0.3);
  await holdFor('KeyW', 1.5);
  return rules();
})()`) as { won: boolean };
check('走过门进终点：赢了', won.won === true, won);

finish();
