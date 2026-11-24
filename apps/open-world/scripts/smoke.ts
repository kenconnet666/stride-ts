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

// ---- 小镇（世界模拟底座的验收，scripts/build-town-life.ts 用 MCP 搭的）：Valley 东路边的车、长椅、行人，开车、撞人、被撞倒再爬起来、
// 坐长椅、按日程回家 ----
stride('eval', `location.search = '?world=Worlds/Valley&drive'`);
stride('wait');
stride('wait', '--game', '4');
const E = 'strideEngine';
const people = `[...Array(14).keys()].map((i) => entity('Pedestrian ' + i))`;
const town = stride('eval', `({ people: ${people}.filter((e) => e.get(${E}.CrowdAgent)).length, car: !!entity('PlayerCar').get(${E}.VehicleDriver) })`) as { people: number; car: boolean };
const objects = stride('call', 'smartobjects') as { objects: number; slots: number; claimed: number };
check('小镇：14 个行人（人群、状态树）、能开的车、3 张长椅（6 个座位）都在', town.people === 14 && town.car && objects.objects === 3 && objects.slots === 6, { town, objects });

const positions = () => stride('eval', `${people}.map((e) => [...e.get(${E}.Transform).world.slice(12, 15)])`) as number[][];
const before = positions();
stride('wait', '--game', '8');
const after = positions();
const walked = before.reduce((sum, p, i) => sum + Math.hypot(after[i]![0]! - p[0]!, after[i]![2]! - p[2]!), 0) / before.length;
check('白天（10 点）行人在逛：8 秒里平均挪了 1 米以上', walked > 1, { walked });

const carPosition = () => stride('eval', `[...entity('PlayerCar').get(${E}.Transform).world.slice(12, 15)]`) as number[];
const parked = carPosition();
stride('key', 'KeyW', '--hold', '3000');
const driven = carPosition();
const drove = Math.hypot(driven[0]! - parked[0]!, driven[2]! - parked[2]!);
check('按住 W 3 秒，车开出去 8 米以上', drove > 8, { drove });

// 撞人：Pedestrian 0 挪到车头前 14 米（先停下它的状态树和人群，挪完重新进人群），再踩油门撞过去
stride('wait', '--game', '3');
stride('eval', `{ const w = entity('PlayerCar').get(${E}.Transform).world; const p = entity('Pedestrian 0'); p.require(${E}.StateTreeRunner).enabled = false;
  const agent = p.require(${E}.CrowdAgent); agent.enabled = false; const x = w[12] - w[8] * 14, z = w[14] - w[10] * 14;
  p.require(${E}.Transform).position = [x, game.terrain.heightAt(x, z), z]; agent.stop(); agent.enabled = true; }`);
stride('wait', '--game', '1');
stride('key', 'KeyW', '--hold', '3500');
const hit = stride('eval', `{ const k = entity('Pedestrian 0').require(${E}.Knockdown); ({ down: k.down, knockdowns: k.knockdowns }) }`) as { down: boolean; knockdowns: number };
check('车撞到人：人倒下了（布娃娃）', hit.knockdowns >= 1, hit);
stride('wait', '--game', '7');
const up = stride('eval', `{ const p = entity('Pedestrian 0'); ({ down: p.require(${E}.Knockdown).down, crowd: p.require(${E}.CrowdAgent).enabled }) }`) as { down: boolean; crowd: boolean };
check('倒地 5 秒以后爬起来、回到人群里', !up.down && up.crowd, up);
stride('eval', `entity('Pedestrian 0').require(${E}.StateTreeRunner).enabled = true`);

// 坐长椅：状态树里 4 成的机会找 25 米内空着的长椅坐一会儿；等到有人占了座位（最多 60 个游戏秒）
let claimed = 0;
for (let i = 0; i < 30 && claimed === 0; i++) {
  stride('wait', '--game', '2');
  claimed = (stride('call', 'smartobjects') as { claimed: number }).claimed;
}
check('有人去坐长椅（占了座位）', claimed > 0, { claimed });

// 日程：拨到晚上 9 点，行人的状态树都换到 Night（回家）
stride('eval', `game.clock.set({ hours: 21 })`);
stride('wait', '--game', '2');
const trees = stride('call', 'statetree') as { trees: { entity: string; path: string[] }[] };
const night = trees.trees.filter((tree) => tree.entity.startsWith('Pedestrian ') && tree.path[0] === 'Night').length;
check('晚上 9 点：行人的状态树换到 Night（走回家）', night >= 13, { night, paths: trees.trees.map((tree) => tree.path.join('/')) });

// 预算的基线是测试世界的：回到默认的地址再收尾
stride('eval', `location.search = ''`);
stride('wait');
stride('wait', '--game', '3');
finish();
