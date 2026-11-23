// 冒烟测试：对着正在运行的页面（开发服务器或 preview，`stride open` 打开的），用调试 CLI 走一遍。
//   pnpm --filter @stride-ts/open-world smoke [-- --hub <中枢名的一部分>]
// 检查：世界 Worlds/Test 加载了，相机附近的格子都在；相机挪到 1.2 公里外，那边的格子加载、原来的卸载；挪回来时格子 props/0_0 里
// 持久的方块（Persistent）还在挪过的地方；方块的碰撞体跟着格子加、去；没有错误日志。
import { startSmoke } from '@stride-ts/devkit/smoke';

const { stride, check, finish } = startSmoke('open-world');

interface WorldReport { world: string | null; loaded: string[]; loading: string[]; loads: number; unloads: number; stats: { wanted: number; ready: number; queued: number; placeholders: number } }

/** 等要的格子都就绪（没有排队、在读的，占位也没了）：机器忙的时候（槽位里几个验证同时跑）格子读得慢，固定等几秒不够；最多等 60 个游戏秒。 */
function settle(): WorldReport {
  let report = stride('call', 'world') as WorldReport;
  for (let i = 0; i < 30 && (report.loading.length > 0 || report.stats.queued > 0 || report.stats.placeholders > 0); i++) {
    stride('wait', '--game', '2');
    report = stride('call', 'world') as WorldReport;
  }
  return report;
}

stride('wait');
const status = stride('status') as { scene: string | null; error: string | null; entities: number };
check('常驻场景跑起来了', status.scene === 'MainScene' && status.error === null, status);
stride('wait', '--game', '2');
const start = settle();
// 物理物体数（原生的计数器）：格子里的方块带静态碰撞体，跟着格子加、去
const bodies = () => stride('eval', `game.native.debugSnapshot().counters['physics.bodies'] ?? 0`) as number;
const startBodies = bodies();
// 相机在 (0, 30, 0)：地面 1 公里内的格子、方块 256 米内的格子（格子边长 256：原点四周的 4 个）
check('世界加载了，相机附近的格子都在', start.world === 'Worlds/Test' && start.loading.length === 0 && start.loaded.includes('ground/0_0') && start.loaded.includes('props/-1_-1') && !start.loaded.includes('props/2_2'), start);

// 格子 props/0_0 里挂了 Persistent 的方块抬高 20 米：格子卸掉再读回来时应该还在那里
const persistentBox = `game.entities.ids().map((id) => game.entities.entity(id)).find((e) => e.get(strideEngine.Persistent))`;
const lifted = stride('eval', `{ const box = ${persistentBox}; box.require(strideEngine.Transform).position.y += 20; box.require(strideEngine.Transform).position.y }`) as number;
stride('eval', `Object.assign(entity('Camera').require(strideEngine.Transform).position, { x: 1200, y: 30, z: 1200 })`);
stride('wait', '--game', '4');
const moved = settle();
const movedBodies = bodies();
check('相机挪走以后那边的格子加载了，原来附近的方块卸载了', moved.loaded.includes('props/4_4') && !moved.loaded.includes('props/0_0') && moved.unloads > start.unloads, { loaded: moved.loaded.filter((key) => key.startsWith('props/')), loads: moved.loads, unloads: moved.unloads });

stride('eval', `Object.assign(entity('Camera').require(strideEngine.Transform).position, { x: 0, y: 30, z: 0 })`);
stride('wait', '--game', '4');
const back = settle();
const backBodies = bodies();
check('碰撞体跟着格子加载、卸载：飞走、飞回来物理物体数和开始时一样，不越积越多', startBodies > 0 && movedBodies > 0 && backBodies === startBodies, { startBodies, movedBodies, backBodies });
const records = stride('call', 'save') as { records: Record<string, { transform?: { position: number[] } }> };
const boxY = stride('eval', `(${persistentBox})?.require(strideEngine.Transform).position.y ?? null`) as number | null;
check('挪回来：格子重新读了，持久的方块还在抬高的地方（存档的记录里有它）', back.loaded.includes('props/0_0') && boxY !== null && Math.abs(boxY - lifted) < 1e-3 && records.records['Worlds/Test/props/0_0#box-0_0-0']?.transform?.position[1] === lifted, { boxY, lifted, records: Object.keys(records.records) });

finish();
