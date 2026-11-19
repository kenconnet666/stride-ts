// GameMenu 的冒烟测试：对着正在运行的页面（开发服务器或 preview，`stride open` 打开的），用调试 CLI 走一遍。
//   pnpm --filter @stride-ts/game-menu smoke [-- --hub <中枢名的一部分>]
// 检查：启动页画出来，点一下进主菜单；欢迎弹窗里改名字（影子输入框）、确认；升级生命；打开选飞船的弹窗，滚轮滚动列表，
// 锁着的飞船不能选，选一艘；UI 占着的点击脚本看不到；血条在涨；没有错误日志（finish 检查）。
// 点击用合成的指针事件，按元素的位置算坐标（窗口和设备像素比都不影响）。
import { decodePng } from '../../../packages/cli/src/png.ts';
import { startSmoke } from '../../../tools/smoke.ts';

const { stride, sleep, check, finish } = startSmoke('game-menu');

/** 页面里的帮手：uiFind(名字)、uiClick(x, y)（画布里的 CSS 像素）、uiClickElement(名字)。 */
const HELPERS = `(() => {
  const canvas = document.querySelector('canvas');
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const at = (type, x, y, target = canvas) => {
    const r = canvas.getBoundingClientRect();
    const init = { clientX: r.left + x, clientY: r.top + y, pointerId: 1, pointerType: 'mouse', bubbles: true, button: 0 };
    target.dispatchEvent(new PointerEvent(type, init));
    const mouse = { pointermove: 'mousemove', pointerdown: 'mousedown', pointerup: 'mouseup' }[type];
    if (mouse) (type === 'pointerdown' ? canvas : window).dispatchEvent(new MouseEvent(mouse, init));
  };
  globalThis.uiFrames = async (n) => { for (let i = 0; i < n; i++) await frame(); };
  globalThis.uiClick = async (x, y) => { at('pointermove', x, y); await frame(); at('pointerdown', x, y); await frame(); await frame(); at('pointerup', x, y, window); await frame(); await frame(); };
  globalThis.uiFind = (name) => { for (const c of strideGame.ui.components) { const e = c.page?.rootElement?.findName(name); if (e) return e; } return null; };
  globalThis.uiPoint = (element) => { const s = canvas.clientWidth / canvas.width; return [element.worldPosition[0] * s, element.worldPosition[1] * s]; };
  globalThis.uiClickElement = async (name) => { const e = uiFind(name); if (!e) throw new Error('no element ' + name); await uiClick(...uiPoint(e)); };
  return 1;
})()`;

stride('eval', 'location.reload()');
await sleep(1500);
stride('wait');
await sleep(500);
const status = stride('status') as { status: string; error: string | null };
check('在跑', status.status === 'running' && status.error === null, status);
stride('eval', HELPERS);

const scene = () => stride('eval', 'strideGame.rootScene?.name') as string;
check('开始是启动页', scene() === 'SplashScene', scene());

// 启动页：背景图和白字（"Stride Samples"、"Touch Screen to Start"）
const { png } = stride('call', 'screenshot') as { png: string };
const { data } = decodePng(Buffer.from(png, 'base64'));
let white = 0;
for (let i = 0; i < data.length; i += 4) if (data[i]! > 230 && data[i + 1]! > 230 && data[i + 2]! > 230) white++;
check('启动页的 UI 画出来了（白字）', white > 3000, white);

stride('eval', 'uiClick(100, 300).then(() => 1)');
await sleep(1500);
check('点一下进主菜单', scene() === 'MainScene', scene());
stride('eval', HELPERS);
stride('eval', 'uiFrames(5).then(() => 1)');

const welcome = () => stride('eval', `uiFind('WelcomePopup')?.visibility`) as string;
check('欢迎弹窗打开着', welcome() === 'visible', welcome());

type Editing = { focused: string | null; keyboard: string | null; tag: string };
const editing = stride('eval', `uiClickElement('nameEditText').then(() => ({ focused: strideGame.ui.focusedElement?.name ?? null, keyboard: strideGame.input.captureOwner('keyboard')?.constructor.name ?? null, tag: document.activeElement.tagName }))`) as Editing;
check('点名字的输入框：开始编辑，UI 占着键盘，影子输入框拿到焦点', editing.focused === 'nameEditText' && editing.keyboard === 'UISystem' && (editing.tag === 'TEXTAREA' || editing.tag === 'INPUT'), editing);
const typed = stride('eval', `(async () => { const input = document.activeElement; input.value = 'Ada Lovelace'; input.dispatchEvent(new Event('input')); await uiFrames(2); return uiFind('nameEditText').text; })()`) as string;
check('在影子输入框里打字，输入框的文字跟着变', typed === 'Ada Lovelace', typed);
const validated = stride('eval', `uiClickElement('validateButton').then(() => uiFrames(2)).then(() => ({ name: uiFind('nameTextBlock').text, focused: strideGame.ui.focusedElement?.name ?? null, keyboard: strideGame.input.captureOwner('keyboard')?.constructor.name ?? null }))`) as { name: string; focused: string | null; keyboard: string | null };
check('确认：名字换了，弹窗关了，键盘放开了', validated.name === 'Ada Lovelace' && welcome() === 'collapsed' && validated.focused === null && validated.keyboard === null, { ...validated, welcome: welcome() });

type Counters = { money: string; bonus: string; life: string };
const counters = () => stride('eval', `({ money: uiFind('moneyCounter').text, bonus: uiFind('bonusCounter').text, life: uiFind('lifeCounter').text })`) as Counters;
const before = counters();
stride('eval', `uiClickElement('lifeStatusButton').then(() => 1)`);
const after = counters();
check('升级生命：生命加一，金币、奖励各花一个', before.life === 'x3' && after.life === 'x4' && after.money === '029' && after.bonus === '029', { before, after });

type Ships = { popup: string; locked: boolean[] };
const ships = stride('eval', `uiClickElement('currentShipButton').then(() => uiFrames(2)).then(() => ({ popup: uiFind('ShipSelectPopup').visibility, locked: [...uiFind('contentStackPanel').children].map((p) => !p.find(strideEngine.ButtonBase, 'shipButton').isEnabled) }))`) as Ships;
check('点当前的飞船打开选飞船的弹窗；每三艘锁一艘', ships.popup === 'visible' && JSON.stringify(ships.locked) === JSON.stringify([false, false, true, false, false, true, false]), ships);

const scrolled = stride('eval', `(async () => {
  const canvas = document.querySelector('canvas'); const r = canvas.getBoundingClientRect();
  const [x, y] = uiPoint(uiFind('contentScrollView'));
  window.dispatchEvent(new MouseEvent('mousemove', { clientX: r.left + x, clientY: r.top + y }));
  await uiFrames(2);
  canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, deltaMode: 0, clientX: r.left + x, clientY: r.top + y }));
  await uiFrames(3);
  return uiFind('contentStackPanel').scrollPosition;
})()`) as number;
check('滚轮滚动飞船列表', scrolled > 0.3, scrolled);

type Picked = { before: number; after: number; popup: string };
const picked = stride('eval', `(async () => {
  const image = uiFind('currentShipImage').source;
  const before = image.currentFrame;
  const panel = [...uiFind('contentStackPanel').children][1];
  await uiClick(...uiPoint(panel.find(strideEngine.ButtonBase, 'shipButton')));
  return { before, after: image.currentFrame, popup: uiFind('ShipSelectPopup').visibility };
})()`) as Picked;
check('选第二艘（绿色）：当前飞船换了，弹窗关了', picked.after !== picked.before && picked.popup === 'collapsed', picked);

type Clicks = { button: string; background: string; masked: boolean };
const clicks = stride('eval', `(async () => {
  const line = () => strideGame.debugText.lines[2]?.text;
  await uiClickElement('powerStatusButton'); await uiFrames(1);
  const button = line();
  await uiClick(5, 500); await uiFrames(1);
  return { button, background: line(), masked: strideGame.input.maskCapturedInput };
})()`) as Clicks;
check('UI 占着的点击脚本看不到，点在空白处才算（InputCaptureMonitor）', clicks.masked && clicks.button.startsWith('Left clicks: 0') && clicks.background.startsWith('Left clicks: 1'), clicks);

const gauge = () => stride('eval', `uiFind('lifebarGauge').sprite.region[2]`) as number;
const g0 = gauge();
await sleep(1500);
const g1 = gauge();
check('血条在涨', g1 > g0, { g0, g1 });

finish();
