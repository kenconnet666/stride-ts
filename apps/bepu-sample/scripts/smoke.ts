// BepuSample 的冒烟测试：对着正在运行的页面（开发服务器或 preview，`stride open` 打开的），用调试 CLI 走一遍。
//   pnpm --filter @stride-ts/bepu-sample smoke [-- --hub <中枢名的一部分>]
// 检查：Colliders 场景在跑；相机控制器（W 前进）；小键盘 * 暂停仿真；T 扔出预制体；重力枪抓起箱子；换到 Material Properties 后
// 旧场景的实体都去掉了；Constraint 的马达和铰链、Ropes 的绳子、Cube Mixer 的聚光灯；Cube Fountain 的生成器按物理时间生成预制体。
import { startSmoke } from '../../../tools/smoke.ts';

const { stride, sleep, check, finish } = startSmoke('bepu-sample');

stride('eval', `location.href = location.origin + '/?scene=Colliders'`);
await sleep(1500);
stride('wait');
await sleep(1500);
const status = stride('status') as { status: string; error: string | null; entities: number };
check('Colliders 在跑', status.status === 'running' && status.error === null && status.entities > 20, status);

/** 页面里的表达式：相机实体的位置。 */
const CAMERA = `const g = strideGame; const id = g.entities.ids().find((i) => g.entities.entity(i).has(strideEngine.Camera));
  const p = g.entities.entity(id).require(strideEngine.Transform).position; [p.x, p.y, p.z]`;
const before = stride('eval', CAMERA) as number[];
stride('key', 'W', '--hold', '500');
await sleep(800);
const after = stride('eval', CAMERA) as number[];
check('W 让相机往前（-Z）走', after[2]! < before[2]! - 2, { before, after });

const BODIES = `const g = strideGame; g.entities.ids().filter((i) => g.entities.hasComponent(i, strideEngine.Body))
  .map((i) => g.entities.entity(i).require(strideEngine.Transform).position.y.toFixed(3)).join()`;
stride('key', 'Multiply');
await sleep(200);
const frozen = stride('eval', BODIES);
await sleep(500);
check('小键盘 * 停住仿真', stride('eval', 'strideGame.simulation.enabled') === false && stride('eval', BODIES) === frozen, frozen);
stride('key', 'Multiply');

// 投掷：T 扔出一个预制体（带刚体的方块）
const BODY_COUNT = `const g = strideGame; g.entities.ids().filter((i) => g.entities.hasComponent(i, strideEngine.Body)).length`;
const bodies = stride('eval', BODY_COUNT) as number;
stride('key', 'T');
await sleep(300);
check('T 扔出一个预制体', stride('eval', BODY_COUNT) === bodies + 1, { bodies, after: stride('eval', BODY_COUNT) });

// 重力枪用的相机实体（子场景里带相机控制器的那个；主场景的相机实体也叫 Camera，不能按名字找）
const GUN = `const scripts = strideGame.entities.entity(strideGame.entities.ids().find((i) => strideGame.entities.entity(i).name === 'DefaultScripts')).scripts;
  const GUN_CAMERA = [...scripts.values()].find((s) => s.constructor.name === 'GravityGunComponent').cameraEntity;`;
// 重力枪：相机控制器的实体放到最靠前（+Z）的静止箱子正后方 2 米（中间不会挡着别的物体）、朝 -Z 看，按住左键抓住它，再把相机抬高 3 米，箱子跟着上去
const GRAB = `const g = strideGame; const T = strideEngine.Transform;
  const cubes = g.entities.ids().filter((i) => g.entities.hasComponent(i, strideEngine.Body) && g.entities.entity(i).name === 'BepuCube' && g.entities.entity(i).require(T).world[13] < 1);
  const body = cubes.reduce((best, i) => (g.entities.entity(i).require(T).world[14] > g.entities.entity(best).require(T).world[14] ? i : best));
  const p = g.entities.entity(body).require(T).world; const camera = g.entities.entity(GUN_CAMERA).require(T);
  camera.position = { x: p[12], y: p[13], z: p[14] + 2 }; camera.rotation = { x: 0, y: 0, z: 0, w: 1 }; body`;
const grabbed = stride('eval', GUN + GRAB) as number;
const heightOf = () => stride('eval', `strideGame.entities.entity(${grabbed}).require(strideEngine.Transform).world[13]`) as number;
await sleep(300);
const resting = heightOf();
stride('mouse', 'left', '--down');
await sleep(300);
stride('eval', GUN + `const c = strideGame.entities.entity(GUN_CAMERA).require(strideEngine.Transform); c.position = { x: c.position.x, y: c.position.y + 3, z: c.position.z }`);
await sleep(1000);
const lifted = heightOf();
stride('mouse', 'left', '--up');
check('重力枪抓住箱子，跟着相机抬高 3 米', Math.abs(lifted - resting - 3) < 0.5, { resting, lifted });

const colliders = stride('eval', 'strideGame.entities.count') as number;
stride('call', 'scene', '"Material"');
await sleep(2000);
const lines = (stride('call', 'debug-text') as { text: string }[]).map((line) => line.text);
check('换到 Material Properties：说明文字换了，实体数变了', lines.some((text) => text.includes('materials properties')) && stride('eval', 'strideGame.entities.count') !== colliders, lines);

// Constraint：搅拌叶片（Blade，约束组件挂在 Mixer 实体上）由单体角马达带着绕 Y 每秒转 10 弧度，铰链挂在底座上
stride('call', 'scene', '"Constraint"');
await sleep(2500);
const mixer = stride('eval', `const g = strideGame; const id = g.entities.ids().find((i) => g.entities.entity(i).name === 'Blade');
  const w = g.simulation.body(id).angularVelocity; [w.x, w.y, w.z].map((v) => +v.toFixed(2))`) as number[];
check('Constraint：搅拌机按马达绕 Y 转', Math.abs(mixer[1]! - 10) < 1 && Math.abs(mixer[0]!) < 0.5, mixer);

// Ropes：每根绳子铺出一串带刚体的节，挂在两头的物体上不会掉到地上
stride('call', 'scene', '"Ropes"');
await sleep(2500);
const rope = stride('eval', `const g = strideGame; const ids = g.entities.ids().filter((i) => g.entities.hasComponent(i, strideEngine.Body) && g.entities.entity(i).name.includes('Rope'));
  ({ count: ids.length, lowest: Math.min(...ids.map((i) => g.entities.entity(i).require(strideEngine.Transform).world[13])) })`) as { count: number; lowest: number };
check('Ropes：绳子的节都在，挂着不掉', rope.count > 10 && rope.lowest > 0.2, rope);

// Cube Mixer：三盏聚光灯（红、绿、蓝）
stride('call', 'scene', '"Mixer"');
await sleep(2500);
const spots = stride('eval', `const l = strideGame.renderSystem.lighting; l.locals.slice(0, l.localCount).map((light) => [light.spot, +light.color.r.toFixed(0), +light.color.g.toFixed(0), +light.color.b.toFixed(0)].join())`) as string[];
check('Cube Mixer：三盏聚光灯', spots.length === 3 && spots.every((light) => light.startsWith('true')), spots);

stride('call', 'scene', '"Fountain"');
await sleep(3000);
const spawned = stride('eval', BODY_COUNT) as number;
check('Cube Fountain 生成预制体', spawned > 50, spawned);

finish();
