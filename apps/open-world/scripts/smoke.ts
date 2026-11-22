// 冒烟测试：对着正在运行的页面（开发服务器或 preview，`stride open` 打开的），用调试 CLI 走一遍。
//   pnpm --filter @stride-ts/open-world smoke [-- --hub <中枢名的一部分>]
// 检查：世界 Worlds/Test 加载了，相机附近的格子都在；相机挪到 1.2 公里外，那边的格子加载、原来的卸载；没有错误日志。
import { startSmoke } from '@stride-ts/devkit/smoke';

const { stride, check, finish } = startSmoke('open-world');

interface WorldReport { world: string | null; loaded: string[]; loading: string[]; loads: number; unloads: number }

stride('wait');
const status = stride('status') as { scene: string | null; error: string | null; entities: number };
check('常驻场景跑起来了', status.scene === 'MainScene' && status.error === null, status);
stride('wait', '--game', '2');
const start = stride('call', 'world') as WorldReport;
// 相机在 (0, 30, 0)：地面 1 公里内的格子、方块 256 米内的格子（格子边长 256：原点四周的 4 个）
check('世界加载了，相机附近的格子都在', start.world === 'Worlds/Test' && start.loading.length === 0 && start.loaded.includes('ground/0_0') && start.loaded.includes('props/-1_-1') && !start.loaded.includes('props/2_2'), start);

stride('eval', `Object.assign(entity('Camera').require(strideEngine.Transform).position, { x: 1200, y: 30, z: 1200 })`);
stride('wait', '--game', '4');
const moved = stride('call', 'world') as WorldReport;
check('相机挪走以后那边的格子加载了，原来附近的方块卸载了', moved.loaded.includes('props/4_4') && !moved.loaded.includes('props/0_0') && moved.unloads > start.unloads, { loaded: moved.loaded.filter((key) => key.startsWith('props/')), loads: moved.loads, unloads: moved.unloads });

finish();
