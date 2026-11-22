/**
 * 序列帧烘焙（S2，照 Niagara 的 Flipbook Baker）：把一个粒子系统的一段时间画成一张图集（columns × rows 格，从左到右、从上到下是
 * 时间的先后），烘好的图集用一个粒子、一个翻页的 UV（uvBuilderFlipbook）就能放出同样的效果，代价是一张贴图加一个四边形。
 *
 * 做法：
 * - 照着场景里的粒子系统另建一份（同样的文件和贴图），种子固定（两遍模拟一模一样），放在原点，固定步长在 CPU 上模拟，不进
 *   场景、不影响正在跑的那一份；粒子的材质不受光照，用不着场景，直接用粒子渲染器画。
 * - 先模拟一遍量范围：整段时间里粒子占的地方，按相机的方向投到画面上，取正方形（格子是正方形）再留一点边；
 * - 再模拟一遍，到每一帧的时刻用正交相机画进图集的那一格（视口）：黑底、白底各画一遍（rgba16float），读回来按两张的差
 *   算出透明度（composeFlipbook）——黑底上是预乘的颜色 B，白底上是 B + (1 - A)，A = 1 - (白 - 黑)。
 * - 亮度：粒子不受光照，叠起来的加法粒子常常远超过 1（HDR），截到 1 放出来就比原来暗一大截。所以整张除以最亮的分量
 *   （intensity，至少 1）再存，放的时候粒子系统组件的颜色乘回去（flipbookComponent 的 color）。
 * - 加法混合的粒子（A 是 0、B 不是 0）也存得下：存的透明度取 a = max(A, B' 的最大分量)（B' = B / intensity）、颜色是 B' / a，
 *   贴图采样后预乘回去正好是 B'；只有混着加法的地方透明度偏大一点（会挡住后面一点）。
 * - 存成 sRGB 的 png（不预乘）。
 *
 * 和 Niagara 不同：只烘颜色加透明度（没有法线、自发光、速度这些别的图）；相机只有前、侧、顶三个方向。
 */
import { Matrix } from '../data/Matrix';
import { saveImage } from '../editor/backendApi';
import { encodePng } from './png';
import type { Game } from '../engine/Game';
import type { ParticleModuleFile } from '../content/formats/format';
import { ParticleRenderer } from '../particles/ParticleRenderer';
import { ParticleSystemComponent } from '../particles/ParticleSystemComponent';
import type { Vec3 } from '../particles/math';
import { DEPTH_FORMAT } from '../rendering/ForwardRenderer';
import { RenderView } from '../rendering/RenderSystem';

export type FlipbookView = 'front' | 'side' | 'top';

export interface FlipbookOptions {
  /** 图集几列、几行；帧数是两个相乘。 */
  readonly columns: number;
  readonly rows: number;
  /** 每一格的边长（像素）。 */
  readonly frameSize: number;
  /** 烘多长一段（秒）。 */
  readonly seconds: number;
  /** 从第几秒开始（先模拟这么久再烘第一帧：循环的特效跳过开头还没铺开的那段）。 */
  readonly start?: number | undefined;
  /** 相机从哪边看：front 从 +Z 往 -Z、side 从 +X 往 -X、top 从上往下。 */
  readonly view?: FlipbookView | undefined;
}

export interface BakedFlipbook {
  /** 图集：sRGB 的 RGBA（不预乘），一行紧挨一行。 */
  readonly rgba: Uint8Array<ArrayBuffer>;
  readonly width: number;
  readonly height: number;
  readonly columns: number;
  readonly rows: number;
  readonly frames: number;
  readonly seconds: number;
  /** 一格对应世界里多大（米，正方形的边长）。 */
  readonly frameWorldSize: number;
  /** 一格的中心相对粒子系统原点的位置（放烘好的序列帧时粒子摆在这）。 */
  readonly center: Vec3;
  /** 存的颜色除过的亮度（≥ 1）：放的时候颜色乘回去。 */
  readonly intensity: number;
}

/** 模拟的步长（秒）。 */
const STEP = 1 / 60;
const COLOR_FORMAT: GPUTextureFormat = 'rgba16float';

/** 相机的三个轴（右、上、朝向相机的后方）。 */
const AXES: Readonly<Record<FlipbookView, { readonly right: Vec3; readonly up: Vec3; readonly back: Vec3 }>> = {
  front: { right: [1, 0, 0], up: [0, 1, 0], back: [0, 0, 1] },
  side: { right: [0, 0, -1], up: [0, 1, 0], back: [1, 0, 0] },
  top: { right: [1, 0, 0], up: [0, 0, -1], back: [0, 1, 0] },
};

/**
 * 黑底、白底两遍（线性的 RGBA，每像素 4 个数）合成存盘用的图集：算透明度、按最亮的分量缩到 0..1、除掉预乘、编成 sRGB。
 * 返回 RGBA 字节和缩的倍数（intensity）。
 */
export function composeFlipbook(black: Float32Array, white: Float32Array): { rgba: Uint8Array<ArrayBuffer>; intensity: number } {
  const pixels = black.length / 4;
  let brightest = 0;
  for (let i = 0; i < black.length; i++) if ((i & 3) !== 3 && black[i]! > brightest) brightest = black[i]!;
  const intensity = Math.max(1, brightest);
  const rgba = new Uint8Array(pixels * 4);
  for (let p = 0; p < pixels; p++) {
    const o = p * 4;
    const r = Math.max(0, black[o]!) / intensity, g = Math.max(0, black[o + 1]!) / intensity, b = Math.max(0, black[o + 2]!) / intensity;
    const coverage = 1 - ((white[o]! - black[o]!) + (white[o + 1]! - black[o + 1]!) + (white[o + 2]! - black[o + 2]!)) / 3;
    const alpha = Math.min(1, Math.max(coverage, r, g, b, 0));
    if (alpha <= 1 / 512) continue;
    rgba[o] = toSrgbByte(r / alpha);
    rgba[o + 1] = toSrgbByte(g / alpha);
    rgba[o + 2] = toSrgbByte(b / alpha);
    rgba[o + 3] = Math.round(alpha * 255);
  }
  return { rgba, intensity };
}

function toSrgbByte(linear: number): number {
  const c = Math.min(1, Math.max(0, linear));
  return Math.round((c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055) * 255);
}

/** 烘 source 的粒子系统（场景里的那个不受影响）。 */
export async function bakeFlipbook(game: Game, source: ParticleSystemComponent, options: FlipbookOptions): Promise<BakedFlipbook> {
  const columns = checkCount(options.columns, 'columns'), rows = checkCount(options.rows, 'rows');
  const frameSize = checkCount(options.frameSize, 'frameSize');
  if (!(options.seconds > 0)) throw new Error(`bakeFlipbook: seconds must be > 0, got ${options.seconds}`);
  const start = Math.max(0, options.start ?? 0);
  const frames = columns * rows;
  const times = Array.from({ length: frames }, (_, i) => start + (i * options.seconds) / frames);
  const axes = AXES[options.view ?? 'front'];

  const framing = measure(copyOf(source), times, axes);
  if (!framing) throw new Error('bakeFlipbook: the particle system has no particles during that time');

  const device = game.graphicsDevice.device;
  const width = columns * frameSize, height = rows * frameSize;
  const target = (label: string, format: GPUTextureFormat, usage: number) => device.createTexture({ label, size: [width, height], format, usage });
  const black = target('Flipbook black', COLOR_FORMAT, GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC);
  const white = target('Flipbook white', COLOR_FORMAT, GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC);
  const depth = target('Flipbook depth', DEPTH_FORMAT, GPUTextureUsage.RENDER_ATTACHMENT);
  const renderer = new ParticleRenderer(device, game.renderSystem.resources);
  try {
    const copy = copyOf(source);
    const view = cameraView(framing, axes, frameSize);
    let time = 0;
    for (let i = 0; i < frames; i++) {
      time = simulate(copy, time, times[i]!);
      // 每次画都单独提交：粒子渲染器的顶点、常量缓冲是 writeBuffer 写的，同一个命令里画两次，前一次的就被覆盖了
      for (const [texture, clear] of [[black, 0], [white, 1]] as const) {
        const encoder = device.createCommandEncoder({ label: 'Flipbook frame' });
        const pass = encoder.beginRenderPass({
          label: 'Flipbook frame',
          colorAttachments: [{ view: texture.createView(), loadOp: i === 0 ? 'clear' : 'load', clearValue: [clear, clear, clear, clear], storeOp: 'store' }],
          depthStencilAttachment: { view: depth.createView(), depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'discard' },
        });
        // 第一帧整张清一次底色，之后只画自己那一格
        pass.setViewport((i % columns) * frameSize, Math.floor(i / columns) * frameSize, frameSize, frameSize, 0, 1);
        renderer.draw(pass, view, [copy], COLOR_FORMAT, DEPTH_FORMAT, time);
        pass.end();
        device.queue.submit([encoder.finish()]);
      }
    }
    const { rgba, intensity } = composeFlipbook(await readFloats(device, black), await readFloats(device, white));
    return { rgba, width, height, columns, rows, frames, seconds: options.seconds, frameWorldSize: framing.size, center: framing.center, intensity };
  } finally {
    renderer.destroy();
    for (const texture of [black, white, depth]) texture.destroy();
  }
}

/**
 * 放烘好的序列帧的粒子系统组件（文件，同场景文件里的 particleSystem 组件）：一个发射器、每 seconds 秒生成一个粒子、活 seconds 秒，
 * 摆在格子中心、大小是一格对应的世界大小，按寿命从第一帧翻到最后一帧；组件的颜色是烘的时候除掉的亮度。texture 是图集在内容
 * 目录里的路径。
 */
export function flipbookComponent(bake: Pick<BakedFlipbook, 'columns' | 'rows' | 'frames' | 'seconds' | 'frameWorldSize' | 'center' | 'intensity'>, texture: string): ParticleModuleFile {
  const intensity = Math.round(bake.intensity * 1000) / 1000;
  return { particleSystem: flipbookParticleSystem(bake, texture), color: [intensity, intensity, intensity, 1] };
}

function flipbookParticleSystem(bake: Pick<BakedFlipbook, 'columns' | 'rows' | 'frames' | 'seconds' | 'frameWorldSize' | 'center'>, texture: string): ParticleModuleFile {
  const center = bake.center.map((c) => Math.round(c * 1000) / 1000);
  const size = Math.round(bake.frameWorldSize * 1000) / 1000;
  return {
    settings: {},
    emitters: [{
      emitterName: 'Flipbook',
      particleLifetime: [bake.seconds, bake.seconds],
      shapeBuilder: { $type: 'shapeBuilderBillboard' },
      material: {
        $type: 'particleMaterialComputeColor',
        computeColor: { $type: 'computeTextureColor', texture: { texture, encoding: 'png' } },
        uvBuilder: { $type: 'uvBuilderFlipbook', xDivisions: bake.columns, yDivisions: bake.rows, startingFrame: 0, animationSpeed: bake.frames },
        alphaAdditive: 0,
      },
      spawners: [{ $type: 'spawnerPerSecond', spawnCount: 1 / bake.seconds, loopCondition: 'looping' }],
      initializers: [
        { $type: 'initialSizeSeed', randomSize: [size, size] },
        { $type: 'initialPositionSeed', positionMin: center, positionMax: center },
      ],
      updaters: [],
    }],
  };
}

function checkCount(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 4096) throw new Error(`bakeFlipbook: ${name} must be an integer from 1 to 4096, got ${value}`);
  return value;
}

/** 照着 source 另建一份：同样的文件和贴图，放在原点，种子固定（每一份模拟出来一样）。 */
function copyOf(source: ParticleSystemComponent): ParticleSystemComponent {
  const copy = new ParticleSystemComponent();
  copy.cloneFrom(source);
  copy.color = [...source.color];
  const system = copy.particleSystem;
  system.translation = [0, 0, 0];
  system.rotation = [0, 0, 0, 1];
  system.uniformScale = 1;
  for (const emitter of system.emitters) {
    emitter.randomSeedMethod = 'fixed';
    emitter.simulation = 'cpu';
  }
  return copy;
}

/** 按固定步长从 from 模拟到 to（秒），返回到了的时刻。 */
function simulate(component: ParticleSystemComponent, from: number, to: number): number {
  let time = from;
  while (time + STEP / 2 < to) {
    const dt = Math.min(STEP, to - time);
    component.particleSystem.update(dt * component.speed);
    time += dt;
  }
  return time;
}

interface Framing {
  /** 画面中心（世界坐标）。 */
  readonly center: Vec3;
  /** 正方形画面的边长（米）。 */
  readonly size: number;
  /** 沿视线方向的范围（相机放在它前面）。 */
  readonly depth: number;
}

/** 模拟一遍，量出每一帧时粒子占的范围的并集，换成相机看到的正方形画面。 */
function measure(component: ParticleSystemComponent, times: readonly number[], axes: (typeof AXES)[FlipbookView]): Framing | undefined {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let time = 0;
  for (const at of times) {
    time = simulate(component, time, at);
    const bounds = component.particleSystem.particleBounds();
    if (!bounds) continue;
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, bounds[0][k]!);
      max[k] = Math.max(max[k]!, bounds[1][k]!);
    }
  }
  if (min[0] === Infinity) return undefined;
  const center = min.map((m, k) => (m + max[k]!) / 2) as Vec3;
  const half = max.map((m, k) => (m - min[k]!) / 2);
  // 盒子在一个轴上的投影的半长
  const extent = (axis: Vec3) => axis.reduce((sum, a, k) => sum + Math.abs(a) * half[k]!, 0);
  // 留 5% 的边，太小的（只有一个点）至少 1 厘米
  const size = Math.max(2 * Math.max(extent(axes.right), extent(axes.up)) * 1.05, 0.01);
  return { center, size, depth: extent(axes.back) };
}

/** 正交相机：从 back 方向看向画面中心，正好框住 size × size。 */
function cameraView(framing: Framing, axes: (typeof AXES)[FlipbookView], pixels: number): RenderView {
  const view = new RenderView();
  const distance = framing.depth + 1;
  const eye = framing.center.map((c, k) => c + axes.back[k]! * distance);
  Matrix.lookAtRH(view.view, eye, framing.center, axes.up);
  view.nearClipPlane = 0.01;
  view.farClipPlane = distance + framing.depth + 1;
  Matrix.orthoRH(view.projection, framing.size, framing.size, view.nearClipPlane, view.farClipPlane, true);
  view.width = view.height = pixels;
  view.update();
  return view;
}

/** 读回一张 rgba16float 的图，换成 Float32Array（每像素 4 个数）。 */
async function readFloats(device: GPUDevice, texture: GPUTexture): Promise<Float32Array> {
  const { width, height } = texture;
  const bytesPerRow = Math.ceil((width * 8) / 256) * 256;
  const readback = device.createBuffer({ label: 'Flipbook readback', size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = device.createCommandEncoder({ label: 'Flipbook readback' });
    encoder.copyTextureToBuffer({ texture }, { buffer: readback, bytesPerRow }, { width, height });
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const halves = new Uint16Array(readback.getMappedRange());
    const out = new Float32Array(width * height * 4);
    const rowHalves = bytesPerRow / 2;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width * 4; x++) out[y * width * 4 + x] = halfToFloat(halves[y * rowHalves + x]!);
    }
    readback.unmap();
    return out;
  } finally {
    readback.destroy();
  }
}

/** IEEE 半精度浮点数（16 位）换成数。 */
function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1, exponent = (h >> 10) & 0x1f, fraction = h & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 31) return fraction ? NaN : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

export interface BakeResult extends Omit<BakedFlipbook, 'rgba'> {
  /** 图集存在内容目录的哪（不带扩展名）。 */
  readonly path: string;
  readonly bytes: number;
  /** 放这张序列帧的粒子系统组件（场景文件里的 particleSystem 组件照抄就行）。 */
  readonly component: ParticleModuleFile;
  /** 烘焙花了多久（秒）。 */
  readonly elapsed: number;
}

/**
 * 调试命令 `bake`（MCP 的 game_command、编辑器粒子窗口的"烘成序列帧"）：烘 entity 的粒子系统，经编辑器后端把图集存进内容
 * 目录。编辑状态的页面里就能烘（自己模拟，不要游戏跑起来）。
 */
export async function bakeCommand(game: Game, component: ParticleSystemComponent, args: Readonly<Record<string, unknown>>): Promise<BakeResult> {
  const count = (name: string, fallback: number) => (args[name] === undefined ? fallback : Number(args[name]));
  const view = args['view'] ?? 'front';
  if (view !== 'front' && view !== 'side' && view !== 'top') throw new Error(`view must be front, side or top, got '${String(view)}'`);
  const started = performance.now();
  const { rgba, ...bake } = await bakeFlipbook(game, component, {
    columns: count('columns', 4), rows: count('rows', 4), frameSize: count('size', 256),
    seconds: count('seconds', 2), start: count('start', 0), view,
  });
  const path = typeof args['path'] === 'string' && args['path'] !== '' ? args['path'] : `Textures/${component.entity.name || 'Particles'}Flipbook`;
  const png = await encodePng(rgba, bake.width, bake.height);
  await saveImage(path, png);
  return { ...bake, path, bytes: png.length, component: flipbookComponent(bake, path), elapsed: (performance.now() - started) / 1000 };
}
