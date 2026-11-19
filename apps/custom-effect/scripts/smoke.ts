// CustomEffect 的冒烟测试：对着正在运行的页面（开发服务器或 preview），用调试 CLI 看一遍。
//   pnpm --filter @stride-ts/custom-effect smoke [-- --hub <中枢名的一部分>]
// 检查：按游戏设置挂上 CustomEffectRenderer；背景（不是清屏的绿）、红色的标志、白字都画出来了；波纹在动（隔半秒截两张，
// 画面不一样）；暂停时画面不变；没有错误日志（finish 检查）。
import { decodePng, diffImages } from '../../../packages/cli/src/png.ts';
import { startSmoke } from '../../../tools/smoke.ts';

const { stride, sleep, check, finish } = startSmoke('custom-effect');

stride('eval', 'location.reload()');
await sleep(1500);
stride('wait');
await sleep(500);
const status = stride('status') as { status: string; error: string | null };
check('在跑', status.status === 'running' && status.error === null, status);
const renderer = stride('eval', 'strideGame.rootRenderer.constructor.name');
check('按游戏设置挂上 CustomEffectRenderer', renderer === 'CustomEffectRenderer', renderer);

const shot = () => decodePng(Buffer.from((stride('call', 'screenshot') as { png: string }).png, 'base64'));
const first = shot();
let red = 0;
let white = 0;
for (let i = 0; i < first.data.length; i += 4) {
  const [r, g, b] = [first.data[i]!, first.data[i + 1]!, first.data[i + 2]!];
  if (r > 200 && g < 90 && b < 130) red++;
  if (r > 230 && g > 230 && b > 230) white++;
}
const corner = [first.data[0]!, first.data[1]!, first.data[2]!];
const pixels = first.width * first.height;
check('背景、红色的标志和白字都画出来了', corner.every((c) => c < 40) && red > pixels * 0.05 && white > pixels * 0.03, { corner, red, white, pixels });

await sleep(500);
const moved = diffImages(first, shot());
check('波纹在动（隔半秒的两张画面不一样）', moved.over['8']! > 1000, moved.over);

stride('pause');
await sleep(200);
const paused = shot();
await sleep(300);
const still = diffImages(paused, shot());
stride('resume');
check('暂停时画面不变', still.over['8'] === 0, still.over);

finish();
