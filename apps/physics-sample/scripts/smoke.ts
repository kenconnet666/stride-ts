// PhysicsSample 的冒烟测试：对着正在运行的页面（开发服务器或 preview，`stride open` 打开的），用调试 CLI 走一遍两个场景的玩法。
//   pnpm --filter @stride-ts/physics-sample smoke [-- --hub <中枢名的一部分>]
// Raycasting：点中箱子，箱子被推起来。VolumeTrigger：角色走进触发器，运动学的箱子变成动态落下；走出来后变回运动学、回到原位。
// Constraints：球窝让球停在离立方体 4 米处；依次换完六种约束（调试命令 next 代替 UI 按钮），焊接让球停在立方体左边 4 米。
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.resolve(app, '..', '..', 'packages', 'cli', 'src', 'cli.ts');
const hubIndex = process.argv.indexOf('--hub');
const hub = hubIndex >= 0 ? process.argv[hubIndex + 1]! : 'physics-sample';

function stride(...args: string[]): unknown {
  return JSON.parse(execFileSync(process.execPath, [cli, ...args, '--hub', hub], { encoding: 'utf8' }));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let failed = 0;
function check(name: string, ok: boolean, detail: unknown): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
}

/** 打开某个场景（换页面地址，等游戏跑起来）。 */
async function openScene(scene: string): Promise<void> {
  stride('eval', `location.href = location.origin + '/?scene=${scene}'`);
  await sleep(1500);
  stride('wait');
}

/** 页面里的表达式：所有带 Body 的实体。 */
const BODIES = 'const g = strideGame; const ids = g.entities.ids().filter((i) => g.entities.hasComponent(i, strideEngine.Body));';

// ---- Raycasting
await openScene('PhysicsSample/Raycasting');
const status = stride('status') as { status: string; error: string | null };
check('Raycasting 在跑', status.status === 'running' && status.error === null, status);
// 第一个箱子在画面上的位置（按主视图投影），把合成的指针从画布中心移过去点它
const target = stride('eval', `${BODIES} const w = g.entities.entity(ids[0]).require(strideEngine.Transform).world;
  const m = g.renderSystem.views[0].viewProjection; const c = g.graphicsDevice.canvas;
  const x = m[0] * w[12] + m[4] * w[13] + m[8] * w[14] + m[12], y = m[1] * w[12] + m[5] * w[13] + m[9] * w[14] + m[13], h = m[3] * w[12] + m[7] * w[13] + m[11] * w[14] + m[15];
  ({ id: ids[0], dx: (x / h) * c.clientWidth / 2, dy: (-y / h) * c.clientHeight / 2 })`) as { id: number; dx: number; dy: number };
const heightOf = (id: number) => stride('eval', `strideGame.entities.entity(${id}).require(strideEngine.Transform).world[13]`) as number;
const before = heightOf(target.id);
stride('mouse', 'move', String(Math.round(target.dx)), String(Math.round(target.dy)));
stride('mouse', 'left');
await sleep(250);
check('点中的箱子被推起来', heightOf(target.id) > before + 0.1, { before, after: heightOf(target.id) });

// ---- VolumeTrigger
await openScene('PhysicsSample/VolumeTrigger');
const state = () => stride('eval', `${BODIES} ({ kinematic: ids.filter((i) => g.entities.entity(i).require(strideEngine.Body).kinematic).length, total: ids.length,
  heights: ids.map((i) => g.entities.entity(i).require(strideEngine.Transform).world[13].toFixed(2)).join() })`) as { kinematic: number; total: number; heights: string };
const start = state();
check('开始时箱子都是运动学的', start.total > 0 && start.kinematic === start.total, start);
stride('key', 'D', '--hold', '1500');
await sleep(800);
const inside = state();
check('角色走进触发器：箱子变成动态落下', inside.kinematic === 0 && inside.heights !== start.heights, inside);
stride('key', 'A', '--hold', '1500');
await sleep(500);
const after = state();
check('走出来后变回运动学、回到原位', after.kinematic === after.total && after.heights === start.heights, after);

// ---- Constraints
await openScene('PhysicsSample/Constraints');
const separation = () => stride('eval', `const g = strideGame; const at = (name) => g.entities.entity(g.entities.ids().find((i) => g.entities.entity(i).name === name)).require(strideEngine.Transform).position;
  const a = at('cube'), b = at('sphere'); [b.x - a.x, b.y - a.y, b.z - a.z].map((v) => +v.toFixed(2))`) as [number, number, number];
await sleep(1000);
const socket = separation();
check('球窝：球心离立方体中心 4 米', Math.abs(Math.hypot(...socket) - 4) < 0.1, socket);
const names = [stride('call', 'constraint')];
for (let i = 0; i < 5; i++) names.push(stride('call', 'next'));
check('六种约束都能换上', names.join() === 'Ball Socket,Hinge,Angular Axis Gear Motor,Slider,Cone Twist,Weld', names);
await sleep(1000);
const weld = separation();
check('焊接：球停在立方体左边 4 米', Math.abs(weld[0] + 4) < 0.1 && Math.abs(weld[1]) < 0.1 && Math.abs(weld[2]) < 0.1, weld);

const logs = execFileSync(process.execPath, [cli, 'logs', '--hub', hub], { encoding: 'utf8' });
check('没有错误日志', !/\berror\b/i.test(logs), logs.split('\n').filter((line) => /\berror\b/i.test(line)));
process.exit(failed > 0 ? 1 : 0);
