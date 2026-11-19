// SpriteFonts 的冒烟测试：对着正在运行的页面（开发服务器或 preview，`stride open` 打开的，1280x720），用调试 CLI 走一遍。
//   pnpm --filter @stride-ts/sprite-fonts smoke [-- --hub <中枢名的一部分>]
// 检查：按游戏设置挂上 FontRenderer；背景图和白色的标题画出来了；时间到了自动换屏；空格暂停、点击继续；左右键换屏（暂停时
// 跳过淡入）；八屏截图都画出了字；日文字体只下载了用到的码位块。
import { decodePng } from '../../../packages/cli/src/png.ts';
import { startSmoke } from '../../../tools/smoke.ts';

const { stride, sleep, check, finish } = startSmoke('sprite-fonts');

stride('eval', 'location.reload()');
await sleep(1500);
stride('wait');
await sleep(500);
const status = stride('status') as { status: string; error: string | null };
check('在跑', status.status === 'running' && status.error === null, status);

const RENDERER = 'const r = strideGame.rootRenderer;';
type State = { name: string; screen: number; time: number; playing: boolean };
const state = () => stride('eval', `${RENDERER} ({ name: r.constructor.name, screen: r.currentScreen, time: r.currentTime, playing: r.isPlaying })`) as State;
check('按游戏设置挂上 FontRenderer', state().name === 'FontRenderer', state());

// 截一帧（后备缓冲），数左上角的颜色和白色像素（字）
const pixels = (): { corner: number[]; white: number } => {
  const { png } = stride('call', 'screenshot') as { png: string };
  const { data } = decodePng(Buffer.from(png, 'base64'));
  let white = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i]! > 230 && data[i + 1]! > 230 && data[i + 2]! > 230) white++;
  return { corner: [data[0]!, data[1]!, data[2]!], white };
};
const showScreen = (screen: number, time: number) => stride('eval', `${RENDERER} r.isPlaying = false; r.currentScreen = ${screen}; r.currentTime = ${time}; 1`);

showScreen(0, 2);
await sleep(300);
const intro = pixels();
check('背景图（左上角是暗的，不是清屏的绿）和白字都画出来了', intro.corner.every((c) => c < 40) && intro.white > 2000, intro);

// 每屏都画出了字（动画那屏挑一个转回正、完全不透明的时刻）
const empty: number[] = [];
for (let screen = 0; screen < 8; screen++) {
  showScreen(screen, screen === 7 ? 4 : 2);
  await sleep(250);
  if (pixels().white < 1500) empty.push(screen);
}
check('八屏都画出了字', empty.length === 0, empty);

// 自动换屏：第 0 屏放 3 秒
stride('eval', `${RENDERER} r.isPlaying = true; r.currentScreen = 0; r.currentTime = 2.7; 1`);
await sleep(800);
check('时间到了自动换到下一屏', state().screen === 1, state());

stride('key', 'Space');
await sleep(200);
const paused = state();
await sleep(500);
check('空格暂停：时间不走', !paused.playing && Math.abs(state().time - paused.time) < 1e-6, { paused, now: state() });
stride('mouse', 'left');
await sleep(200);
check('点击继续', state().playing, state());

stride('key', 'Space');
await sleep(200);
const before = state().screen;
stride('key', 'Right');
await sleep(200);
const right = state();
check('暂停时右键换到下一屏，跳过淡入', right.screen === (before + 1) % 8 && right.time === 1, { before, right });
stride('key', 'Left');
stride('key', 'Left');
await sleep(200);
check('左键往回换（循环）', state().screen === (before + 7) % 8, { before, now: state() });

const blocks = stride('eval', `performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('JapaneseFont.') && n.endsWith('.glyphs')).length`) as number;
check('日文字体只下载了用到的块（384 块里的十几块）', blocks > 0 && blocks < 30, blocks);

finish();
