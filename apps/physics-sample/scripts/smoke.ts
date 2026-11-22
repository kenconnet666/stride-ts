// PhysicsSample 的冒烟测试：对着正在运行的页面（开发服务器或 preview，`stride open` 打开的），用调试 CLI 走一遍两个场景的玩法。
//   pnpm --filter @stride-ts/physics-sample smoke [-- --hub <中枢名的一部分>]
// Raycasting：点中箱子，箱子被推起来。VolumeTrigger：角色走进触发器，运动学的箱子变成动态落下；走出来后变回运动学、回到原位。
// Constraints：球窝让球停在离立方体 4 米处；点 Next 按钮依次换完六种约束，焊接让球停在立方体左边 4 米。
// 换场景：点 >> 按钮走一圈回到 Constraints，旧场景的实体、物体都去掉了，物理照常。Raycasting 下方有一行字。
import { PAGE_HELPERS, startSmoke } from '../../../tools/lib/smoke.ts';

const { stride, sleep, check, finish } = startSmoke('physics-sample');

/** 打开某个场景（换页面地址），等到新页面的这个场景跑过几帧。 */
async function openScene(scene: string): Promise<void> {
  stride('eval', `location.href = location.origin + '/?scene=${scene}'`);
  await sleep(1500);
  stride('wait');
  for (let tries = 0; tries < 100; tries++) {
    const { scene: name, frame, sceneFrame } = stride('status') as { scene: string | null; frame: number; sceneFrame: number | null };
    if (name === scene.split('/').at(-1) && sceneFrame !== null && frame - sceneFrame > 5) {
      stride('eval', PAGE_HELPERS);
      return;
    }
    await sleep(100);
  }
  throw new Error(`${scene} did not start`);
}

/** 页面里的表达式：所有带 Body 的实体。 */
const BODIES = 'const g = strideGame; const ids = g.entities.ids().filter((i) => g.entities.hasComponent(i, strideEngine.Body));';

// ---- Raycasting
await openScene('PhysicsSample/Raycasting');
const status = stride('status') as { status: string; error: string | null };
check('Raycasting 在跑', status.status === 'running' && status.error === null, status);
const texts = stride('eval', `strideGame.ui.components.flatMap((c) => [...(c.page?.rootElement?.children ?? [])]).map((e) => e.text ?? e.name)`) as string[];
check('UI：下方的字和两边换场景的按钮', ['Shoot the cubes!', '<<', '>>'].every((text) => texts.includes(text)), texts);
// 第一个箱子在画面上的位置（按主视图投影）：把合成的指针从画布中心移过去点它，等它升高（最多 2 秒游戏时间：CI 的软件 WebGPU
// 上一帧就超过 0.25 秒，物理一帧走的步数有上限）。点和等都在页面里：分成几条 CLI 命令时，单核慢、负载重的机器上命令之间隔得
// 太久。场景刚开头那几帧主视图和箱子还在落定（CI 上第 29 帧点空过一次），没推起来就重新瞄准再点，最多三次
const pushed = stride('eval', `(async () => { ${BODIES}
  const box = g.entities.entity(ids[0]), height = () => box.require(strideEngine.Transform).world[13], c = g.graphicsDevice.canvas;
  const before = height();
  for (let attempt = 1; attempt <= 3; attempt++) {
    const w = box.require(strideEngine.Transform).world, m = g.renderSystem.views[0].viewProjection;
    const x = m[0] * w[12] + m[4] * w[13] + m[8] * w[14] + m[12], y = m[1] * w[12] + m[5] * w[13] + m[9] * w[14] + m[13], h = m[3] * w[12] + m[7] * w[13] + m[11] * w[14] + m[15];
    await click(c.clientWidth / 2 + (x / h) * c.clientWidth / 2, c.clientHeight / 2 - (y / h) * c.clientHeight / 2);
    if (await until(() => height() > before + 0.1, 2)) return { before, after: height(), frames: g.frames, attempt };
  }
  return { before, after: height(), frames: g.frames, attempt: 3 }; })()`) as { before: number; after: number };
check('点中的箱子被推起来', pushed.after > pushed.before + 0.1, pushed);

// ---- VolumeTrigger
await openScene('PhysicsSample/VolumeTrigger');
const state = () => stride('eval', `${BODIES} ({ kinematic: ids.filter((i) => g.entities.entity(i).require(strideEngine.Body).kinematic).length, total: ids.length,
  heights: ids.map((i) => g.entities.entity(i).require(strideEngine.Transform).world[13].toFixed(2)).join() })`) as { kinematic: number; total: number; heights: string };
const start = state();
check('开始时箱子都是运动学的', start.total > 0 && start.kinematic === start.total, start);
// 按住 D 直到箱子都变成动态的、再落一会儿（按游戏时间等）：CI 的软件 WebGPU 上一帧可能超过 0.25 秒，按墙钟按 1.5 秒时角色
// 还没走到触发器
const allKinematic = (value: boolean) => `(async () => { ${BODIES} await until(() => ids.every((i) => g.entities.entity(i).require(strideEngine.Body).kinematic === ${value}), 5); })()`;
stride('key', 'D', '--down');
stride('eval', allKinematic(false));
stride('key', 'D', '--up');
stride('wait', '--game', '0.5');
const inside = state();
check('角色走进触发器：箱子变成动态落下', inside.kinematic === 0 && inside.heights !== start.heights, inside);
stride('key', 'A', '--down');
stride('eval', allKinematic(true));
stride('key', 'A', '--up');
stride('wait', '--game', '0.5');
const after = state();
check('走出来后变回运动学、回到原位', after.kinematic === after.total && after.heights === start.heights, after);

// ---- Constraints
await openScene('PhysicsSample/Constraints');
const separation = () => stride('eval', `const g = strideGame; const at = (name) => g.entities.entity(g.entities.ids().find((i) => g.entities.entity(i).name === name)).require(strideEngine.Transform).position;
  const a = at('cube'), b = at('sphere'); [b.x - a.x, b.y - a.y, b.z - a.z].map((v) => +v.toFixed(2))`) as [number, number, number];
await sleep(1000);
const socket = separation();
check('球窝：球心离立方体中心 4 米', Math.abs(Math.hypot(...socket) - 4) < 0.1, socket);
const shown = () => stride('eval', `uiFind('ConstraintName').text`) as string;
const names = [shown()];
for (let i = 0; i < 5; i++) {
  stride('eval', `uiClick('Next')`);
  names.push(shown());
}
check('点 Next 按钮：六种约束都能换上', names.join() === 'Ball Socket,Hinge,Angular Axis Gear Motor,Slider,Cone Twist,Weld', names);
await sleep(1000);
const weld = separation();
check('焊接：球停在立方体左边 4 米', Math.abs(weld[0] + 4) < 0.1 && Math.abs(weld[1]) < 0.1 && Math.abs(weld[2]) < 0.1, weld);

// ---- 换场景
const sceneStatus = () => stride('status') as { scene: string; entities: number; error: string | null; frame: number; sceneFrame: number | null };
/** 等到换了场景、新场景跑过几帧（软件 WebGPU 上几帧一秒，加载新场景要好几秒：不按墙钟等固定的时间）。 */
async function switchedFrom(from: string): Promise<ReturnType<typeof sceneStatus>> {
  let now = sceneStatus();
  for (let tries = 0; tries < 600 && !(now.scene !== from && now.sceneFrame !== null && now.frame - now.sceneFrame > 5); tries++) {
    await sleep(100);
    now = sceneStatus();
  }
  return now;
}
const startScene = sceneStatus();
const visited: string[] = [];
for (let i = 0; i < 3; i++) {
  const from = sceneStatus().scene;
  stride('eval', `uiClick('>>')`);
  const now = await switchedFrom(from);
  check(`点 >> 按钮：从 ${from} 换到 ${now.scene}`, now.scene !== from && now.error === null, now);
  visited.push(now.scene);
}
const back = sceneStatus();
check('走一圈回到 Constraints，实体数不变', back.scene === startScene.scene && back.entities === startScene.entities && new Set(visited).size === 3, { startScene, back, visited });
await sleep(1000);
const again = separation();
check('回来后球窝照常', Math.abs(Math.hypot(...again) - 4) < 0.1, again);

finish();
