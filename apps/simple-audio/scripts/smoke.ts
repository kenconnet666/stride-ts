// SimpleAudio 的冒烟测试：对着正在运行的页面（开发服务器或 preview，`stride open` 打开的），用调试 CLI 走一遍。
//   pnpm --filter @stride-ts/simple-audio smoke [-- --hub <中枢名的一部分>]
// Chrome 要带 `--autoplay-policy=no-user-gesture-required`（regress.ps1 带了）：合成的点击不算用户操作，不然声音不出。
// 检查：UI 画出来了；背景音乐在循环放、真的有声音（AnalyserNode 量主音量的输出）；点一下重放音效、两个波形图回到中间变成
// 不透明，之后往两边移开、渐隐；音效放完变回停止；没有错误日志（finish 检查）。
import { decodePng } from '../../../packages/cli/src/png.ts';
import { startSmoke } from '../../../tools/smoke.ts';

const { stride, sleep, check, finish } = startSmoke('simple-audio');

/** 页面里的帮手：uiClick(x, y, after)、sounds()（两个实例的状态）、loudness()（主音量输出的均方根）、waves()（波形图的位置和不透明度）。 */
const HELPERS = `(() => {
  const canvas = document.querySelector('canvas');
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const at = (type, x, y, target = canvas) => {
    const r = canvas.getBoundingClientRect();
    const init = { clientX: r.left + x, clientY: r.top + y, pointerId: 1, pointerType: 'mouse', bubbles: true, button: 0 };
    target.dispatchEvent(new PointerEvent(type, init));
  };
  // 按下后两帧（脚本这时已经处理了按下）记下 after() 的结果，再松开
  globalThis.uiClick = async (x, y, after = () => null) => { at('pointerdown', x, y); await frame(); await frame(); const seen = after(); at('pointerup', x, y, window); await frame(); return seen; };
  const script = () => { const type = strideGame.registry.scriptsNamed('SoundScript')[0]; return [...strideGame.rootScene.entities.values()].map((e) => e.get(type)).find(Boolean); };
  globalThis.sounds = () => { const s = script(); return { context: strideGame.audio.context.state, music: s.music.playState, musicAt: s.music.position, effect: s.effect.playState }; };
  const analyser = strideGame.audio.context.createAnalyser();
  analyser.fftSize = 2048;
  strideGame.audio.output.connect(analyser);
  globalThis.loudness = async () => {
    let peak = 0;
    const data = new Float32Array(analyser.fftSize);
    for (let i = 0; i < 20; i++) {
      await frame();
      analyser.getFloatTimeDomainData(data);
      peak = Math.max(peak, Math.sqrt(data.reduce((sum, v) => sum + v * v, 0) / data.length));
    }
    return peak;
  };
  globalThis.waves = () => ['LeftWave', 'RightWave'].map((name) => { const e = strideGame.ui.components[0].page.rootElement.findName(name); return [e.canvasRelativePosition[0], e.opacity]; });
  return 1;
})()`;

stride('eval', 'location.reload()');
await sleep(1500);
stride('wait');
await sleep(1500);
const status = stride('status') as { status: string; error: string | null };
check('在跑', status.status === 'running' && status.error === null, status);
stride('eval', HELPERS);

const { png } = stride('call', 'screenshot') as { png: string };
const { data } = decodePng(Buffer.from(png, 'base64'));
let white = 0;
for (let i = 0; i < data.length; i += 4) if (data[i]! > 230 && data[i + 1]! > 230 && data[i + 2]! > 230) white++;
check('UI 画出来了（DJ 和文字）', white > 20000, white);

type Sounds = { context: string; music: string; musicAt: number; effect: string };
const s0 = stride('eval', 'sounds()') as Sounds;
await sleep(1000);
const s1 = stride('eval', 'sounds()') as Sounds;
check('背景音乐在循环放', s0.context === 'running' && s1.music === 'playing' && s1.musicAt > s0.musicAt, { s0, s1 });
const loud = stride('eval', 'loudness()') as number;
check('真的有声音（主音量的输出不是静音）', loud > 0.001, loud);

const clicked = stride('eval', 'uiClick(640, 360, () => ({ sounds: sounds(), waves: waves() }))') as { sounds: Sounds; waves: [number, number][] };
check('点一下：音效在放，两个波形图回到中间、不透明', clicked.sounds.effect === 'playing' && clicked.waves.every(([, opacity]) => opacity > 0.5), clicked);
await sleep(1500);
const later = stride('eval', 'waves()') as [number, number][];
check('之后波形图往两边移开、渐隐', later[0]![0] < clicked.waves[0]![0] && later[1]![0] > clicked.waves[1]![0] && later.every(([, opacity]) => opacity < 0.05), { clicked: clicked.waves, later });
await sleep(1500);
const done = stride('eval', 'sounds()') as Sounds;
check('音效放完变回停止，音乐接着放', done.effect === 'stopped' && done.music === 'playing', done);

finish();
