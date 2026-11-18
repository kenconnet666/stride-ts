// BepuSample 的冒烟测试：对着正在运行的页面（开发服务器或 preview，`stride open` 打开的），用调试 CLI 走一遍。
//   pnpm --filter @stride-ts/bepu-sample smoke [-- --hub <中枢名的一部分>]
// 检查：Colliders 场景在跑、刚体在落；相机控制器（W 前进）；小键盘 * 暂停仿真；换到 Material Properties 后旧场景的实体都去掉了。
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

const colliders = stride('eval', 'strideGame.entities.count') as number;
stride('call', 'scene', '"Material"');
await sleep(2000);
const lines = (stride('call', 'debug-text') as { text: string }[]).map((line) => line.text);
check('换到 Material Properties：说明文字换了，实体数变了', lines.some((text) => text.includes('materials properties')) && stride('eval', 'strideGame.entities.count') !== colliders, lines);

finish();
