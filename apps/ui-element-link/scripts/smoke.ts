// UIElementLink 的冒烟测试：对着正在运行的页面（开发服务器或 preview，`stride open` 打开的），用调试 CLI 走一遍。
//   pnpm --filter @stride-ts/ui-element-link smoke [-- --hub <中枢名的一部分>]
// 三个场景（全屏的 UI、倾斜的 UI、面向相机的 UI）轮一圈：UI 画出来了；FollowingEntity 跟着按钮 "ElementName"（世界矩阵 =
// 元素在世界里的矩阵 × 本地变换）；骑士在跑；点角上的按钮不换场景，点跟着走的按钮换下一个；没有错误日志（finish 检查）。
// 点击用合成的指针事件，放在 3D 里的 UI 按元素在世界里的位置投影到画面上算坐标。
import { decodePng } from '../../../packages/cli/src/png.ts';
import { PAGE_HELPERS, startSmoke } from '../../../tools/lib/smoke.ts';

const { stride, sleep, check, finish } = startSmoke('ui-element-link');

/**
 * 页面里的帮手：uiPoint(名字)（元素中心在画布上的 CSS 像素）、cornerPoint()（在画面里的
 * 第一个角上的按钮）、followGap()、runningAnimations()。
 */
const HELPERS = `(() => {
  const canvas = document.querySelector('canvas');
  const { Matrix, Transform, UISystem } = strideEngine;
  const named = (name) => strideGame.entities.entity(strideGame.entities.ids().find((i) => strideGame.entities.entity(i).name === name));
  const find = (name) => {
    for (const component of strideGame.ui.components) {
      const element = component.page?.rootElement?.findName(name);
      if (element) return { component, element };
    }
    throw new Error('no element ' + name);
  };
  const pointOf = (component, element) => {
    if (component.isFullScreen) {
      const virtual = UISystem.virtualResolution(component, [canvas.width, canvas.height]);
      return [element.worldPosition[0] * canvas.clientWidth / virtual[0], element.worldPosition[1] * canvas.clientHeight / virtual[1]];
    }
    const m = new Float32Array(16);
    strideGame.ui.elementWorldMatrix(m, component, element);
    const [x, y] = Matrix.transformPoint(strideGame.graphicsCompositor.mainView.viewProjection, m[12], m[13], m[14]);
    return [(x + 1) / 2 * canvas.clientWidth, (1 - y) / 2 * canvas.clientHeight];
  };
  globalThis.uiPoint = (name) => { const { component, element } = find(name); return pointOf(component, element); };
  globalThis.cornerPoint = () => {
    const { component } = find('ElementName');
    const corners = [...component.page.rootElement.children].filter((child) => child.name !== 'ElementName');
    return corners.map((corner) => pointOf(component, corner)).find(([x, y]) => x > 0 && y > 0 && x < canvas.clientWidth && y < canvas.clientHeight);
  };
  // FollowingEntity 的世界位置和 元素在世界里的矩阵 × 本地变换 差多远（暂停时两边是同一帧的布局）
  globalThis.followGap = () => {
    const { component, element } = find('ElementName');
    const follower = named('FollowingEntity').require(Transform);
    const expected = Matrix.multiply(new Float32Array(16), (() => { const m = new Float32Array(16); strideGame.ui.elementWorldMatrix(m, component, element); return m; })(), follower.localMatrix());
    return Math.hypot(follower.world[12] - expected[12], follower.world[13] - expected[13], follower.world[14] - expected[14]);
  };
  globalThis.runningAnimations = () => named('Running Knight').get(strideEngine.AnimationComponent)?.playingAnimations.length ?? 0;
  return 1;
})()`;

stride('eval', `location.search = '?scene=fullscreen'`);
await sleep(1500);
stride('wait');
await sleep(500);
const status = stride('status') as { status: string; error: string | null };
check('在跑', status.status === 'running' && status.error === null, status);

const scene = () => stride('eval', 'strideGame.rootScene?.name') as string;

/** 画面上橙色（按钮的边）的像素数。 */
function orangePixels(): number {
  const { png } = stride('call', 'screenshot') as { png: string };
  const { data } = decodePng(Buffer.from(png, 'base64'));
  let count = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i]! > 180 && data[i + 1]! > 70 && data[i + 1]! < 170 && data[i + 2]! < 60) count++;
  return count;
}

/** 当前场景：UI 画出来了，跟着走，骑士在跑，角上的按钮不换场景，点跟着走的按钮换到 next。 */
async function visit(name: string, next: string): Promise<void> {
  stride('eval', PAGE_HELPERS);
  stride('eval', HELPERS);
  check(`${name}：场景对`, scene() === name, scene());
  const orange = orangePixels();
  check(`${name}：UI 画出来了`, orange > 500, orange);
  stride('pause');
  stride('step', '2');
  const gap = stride('eval', 'followGap()') as number;
  stride('resume');
  // 全屏的 UI 按像素放，其他的按世界单位
  check(`${name}：FollowingEntity 跟着按钮`, gap < (name === 'FullScreen' ? 0.5 : 0.005), gap);
  const running = stride('eval', 'runningAnimations()') as number;
  check(`${name}：骑士在跑`, running === 1, running);
  const smoke = stride('eval', 'strideGame.particles.components.reduce((sum, c) => sum + c.particleSystem.livingParticles, 0)') as number;
  check(`${name}：烟的粒子在冒`, smoke > 0, smoke);
  stride('eval', 'click(...cornerPoint()).then(() => 1)');
  await sleep(300);
  check(`${name}：点角上的按钮不换场景`, scene() === name, scene());
  stride('eval', `click(...uiPoint('ElementName')).then(() => 1)`);
  await sleep(1500);
  check(`${name}：点跟着走的按钮换到 ${next}`, scene() === next, scene());
}

await visit('FullScreen', 'TiltedScreen');
await visit('TiltedScreen', 'BillboardedScreen');
await visit('BillboardedScreen', 'FullScreen');

finish();
