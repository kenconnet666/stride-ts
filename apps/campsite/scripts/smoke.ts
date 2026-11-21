// 冒烟测试：对着正在运行的页面（开发服务器或 preview，`stride open` 打开的），用调试 CLI 走一遍。
//   pnpm --filter @stride-ts/campsite smoke [-- --hub <中枢名的一部分>]
// 检查：主场景跑起来了；编辑器里做的资源都用上了——白盒、SDF、多边形烘出的模型有网格，篝火有粒子，噼啪声是合成的；没有错误日志。
import { startSmoke } from '../../../tools/smoke.ts';

const { stride, check, finish } = startSmoke('campsite');

stride('wait');
const status = stride('status') as { scene: string | null; error: string | null; entities: number };
check('主场景跑起来了，有实体', status.scene === 'MainScene' && status.error === null && status.entities > 0, status);

const models = stride('eval', `(async () => {
  const out = {};
  for (const name of ['Cabin', 'Rock', 'FirePit', 'Log', 'Crate', 'Lantern', 'Path']) out[name] = (await strideGame.content.loadModel('Models/' + name)).meshes.length;
  return out;
})()`) as Record<string, number>;
check('白盒、SDF、多边形烘出的模型都有网格（木屋墙和屋顶两个材质）', Object.values(models).every((count) => count > 0) && models['Cabin'] === 2, models);

// 火星一秒 12 个：CI 的软件渲染上开场时游戏时间还很短，等够一秒半再数（CI 上数到过 0 个）
stride('wait', '--game', '1.5');
const fire = stride('call', 'particles', JSON.stringify({ name: 'Campfire' })) as { emitter: string; alive: number }[];
check('篝火的火苗、火星都在放', fire.length === 2 && fire.every((emitter) => emitter.alive > 0), fire.map((emitter) => [emitter.emitter, emitter.alive]));

const crackle = stride('eval', `(async () => (await strideGame.content.loadSound('Sounds/Crackle')).totalLength)()`) as number;
check('噼啪声是合成的（加载时生成，0.02 到 0.5 秒）', crackle > 0.02 && crackle < 0.5, crackle);

finish();
