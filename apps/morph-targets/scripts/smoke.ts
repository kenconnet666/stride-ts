// MorphTargets 的冒烟测试：对着正在运行的页面（开发服务器或 preview），用调试 CLI 走一遍。
//   pnpm --filter @stride-ts/morph-targets smoke [-- --hub <中枢名的一部分>]
// 检查：在跑；三个模型带形变目标；开始时三个剪辑都在播（权重在变）；面板画出来；Pause/Play；选立方体后滑条换成它的目标，
// 拖滑条到头权重是 2、剪辑停掉；Reset 归零；甜甜圈切到 FBX（模型换了、权重和时间留着）；F1 隐藏面板；没有错误日志（finish 检查）。
// 点击、拖动用合成的指针事件，按元素的位置算坐标（UI 的虚拟分辨率宽 1920，同 Stride 的样例）。
import { PAGE_HELPERS, startSmoke } from '../../../tools/lib/smoke.ts';

const { stride, sleep, check, finish } = startSmoke('morph-targets');

/** 页面里的帮手：uiButton(字)、uiSliders()、uiClickElement(元素)、uiDrag(元素, 从 0 到 1 的位置)、byName(实体名)、morphs(实体名)。 */
const HELPERS = `(() => {
  const canvas = document.querySelector('canvas'), at = pointerAt;
  const E = strideEngine;
  const all = (element, out = []) => { out.push(element); for (const child of element.visualChildren) all(child, out); return out; };
  const elements = () => strideGame.ui.components.flatMap((c) => (c.page?.rootElement ? all(c.page.rootElement) : []));
  const point = (x, y) => { const s = canvas.clientWidth / 1920; return [x * s, y * s]; };
  globalThis.uiButton = (text) => elements().find((e) => e instanceof E.Button && e.find(E.TextBlock)?.text === text);
  globalThis.uiSliders = () => elements().filter((e) => e instanceof E.Slider);
  globalThis.uiClickElement = async (element) => {
    const [x, y] = point(...element.worldPosition);
    at('pointermove', x, y); await frame(); at('pointerdown', x, y); await frame(); await frame(); at('pointerup', x, y, window); await frames(3);
  };
  globalThis.uiDrag = async (slider, to) => {
    const [cx, cy] = slider.worldPosition, w = slider.renderSize[0];
    const [x0, y] = point(cx, cy), [x1] = point(cx - w / 2 + w * to, cy);
    at('pointermove', x0, y); await frame(); at('pointerdown', x0, y); await frame();
    for (let i = 1; i <= 4; i++) { at('pointermove', x0 + ((x1 - x0) * i) / 4, y); await frame(); }
    at('pointerup', x1, y, window); await frames(3);
  };
  globalThis.byName = (name) => strideGame.entities.entity(strideGame.entities.ids().find((i) => strideGame.entities.entity(i).name === name));
  globalThis.morphs = (name) => strideGame.animation.morphs(byName(name));
  return 1;
})()`;

stride('eval', 'location.reload()');
await sleep(1500);
stride('wait');
await sleep(1000);
const status = stride('status') as { status: string; error: string | null };
check('在跑', status.status === 'running' && status.error === null, status);
stride('eval', PAGE_HELPERS);
stride('eval', HELPERS);

const names = stride('eval', `['Donut', 'Cube', 'Icosphere'].map((n) => morphs(n)?.morphTargetNames.join())`) as string[];
check('三个模型带形变目标', names[0] === 'Bigger,Thicker,Wider,Flatter' && names[1] === 'Taller,Twisted,Tapered,Rounded' && names[2] === 'Squashed,Stretched,Bumpy,Pear', names);

// 按游戏时间等：CI 的软件 WebGPU 上一帧要几百毫秒，墙钟的 0.6 秒可能一帧都没走
const [first, second] = stride('eval', `(async () => { const w = () => ['Donut', 'Cube', 'Icosphere'].map((n) => [...morphs(n).weights]); const first = w(); await seconds(0.6); return [first, w()]; })()`) as [number[][], number[][]];
const moved = first.map((w, m) => w.some((value, i) => Math.abs(value - second[m]![i]!) > 1e-3));
check('开始时三个剪辑都在播（权重在变）', moved.every(Boolean), { first, second });

const panel = stride('eval', `({ heading: !!uiButton('Cube'), sliders: uiSliders().length })`) as { heading: boolean; sliders: number };
check('面板画出来了（选模型的按钮、四个权重滑条加时间轴）', panel.heading && panel.sliders === 5, panel);

type Playing = { factor: number; label: string };
const playing = (label: string) => stride('eval', `(async () => { await uiClickElement(uiButton('${label}')); const p = byName('Donut').get(strideEngine.AnimationComponent).playingAnimations[0]; return { factor: p.timeFactor, label: uiButton('Play') ? 'Play' : 'Pause' }; })()`) as Playing;
const paused = playing('Pause');
const resumed = playing('Play');
check('Pause 停住甜甜圈的剪辑，Play 接着播', paused.factor === 0 && paused.label === 'Play' && resumed.factor === 1 && resumed.label === 'Pause', { paused, resumed });

type Cube = { names: string[]; taller: number; playing: number };
const cube = stride('eval', `(async () => {
  await uiClickElement(uiButton('Cube'));
  const labels = uiSliders().slice(0, 4).map((s) => s.parent.parent.visualChildren[0].text);
  await uiDrag(uiSliders()[0], 1);
  const m = morphs('Cube');
  return { names: labels, taller: m.getMorphWeight(m.findMorphTarget('Taller')), playing: byName('Cube').get(strideEngine.AnimationComponent).playingAnimations.length };
})()`) as Cube;
check('选立方体：滑条换成它的目标；拖 Taller 到头权重是 2，剪辑停掉', cube.names.join() === 'Taller,Twisted,Tapered,Rounded' && Math.abs(cube.taller - 2) < 0.01 && cube.playing === 0, cube);

const reset = stride('eval', `uiClickElement(uiButton('Reset')).then(() => [...morphs('Cube').weights])`) as number[];
check('Reset：权重归零', reset.every((w) => w === 0), reset);

type Source = { before: number; after: number; names: string; meshes: string };
const source = stride('eval', `(async () => {
  await uiClickElement(uiButton('Donut'));
  const anim = () => byName('Donut').get(strideEngine.AnimationComponent).playingAnimations[0];
  await uiClickElement(uiButton('Pause'));
  const before = anim().currentTime;
  await uiClickElement(uiButton('FBX'));
  const mesh = strideEngine.Mesh.byId?.(byName('Donut').get(strideEngine.Model).mesh)?.name ?? '';
  return { before, after: anim()?.currentTime ?? -1, names: morphs('Donut').morphTargetNames.join(), meshes: mesh };
})()`) as Source;
check('甜甜圈切到 FBX：模型换了，目标和剪辑的时间留着', source.meshes.includes('fbx') && source.names.split(',').sort().join() === 'Bigger,Flatter,Thicker,Wider' && Math.abs(source.after - source.before) < 1e-3, source);

const page = () => stride('eval', `byName('MorphTargetsController').get(strideEngine.UIComponent).enabled`) as boolean;
stride('eval', `tap('F1').then(() => 1)`);
const hidden = !page();
stride('eval', `tap('F1').then(() => 1)`);
check('F1 隐藏、再按显示面板', hidden && page(), { hidden });

finish();
