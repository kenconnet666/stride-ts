/** 调试命令：截图和出片：截图、解码图片、离线渲染、烘序列帧。 */
import { textOf } from '../../data/text.ts';
import { ParticleSystemComponent } from '../../particles/ParticleSystemComponent';
import type { Game } from '../../engine/Game';
import type { Debug } from '../Debug';
import { type Args, entityArg, pngBase64 } from './shared.ts';

const MATERIAL_EXPORT_HELP = 'Export the outputs of a material\'s node graph (base color, normal, roughness, ...) as pngs evaluated on the 0..1 UV square, '
  + 'saved in the content folder through the editor backend. args: material (content path), graph (optional: a node graph to use instead of the saved one), '
  + 'size (pixels, default 1024), outputs (default all linked ones), path (content path prefix, default <material>_; files are <path><output>). '
  + 'Colors are sRGB, the normal is tangent space mapped to 0..1, the rest grayscale.';

const RENDER_HELP = 'Offline render (fixed time step, sub-frame antialiasing and motion blur) to an MP4 (H.264 + AAC) or a PNG sequence, saved in the project\'s exports folder. '
  + 'args: name (default "render"), preset (landscape1080 | vertical1080 | square1080 | landscape4k), width, height, fps, '
  + 'timeline (entity with a TimelinePlayer, or a timeline name: restarted from 0, seconds defaults to its length), seconds, samples (sub-frames per frame, default 8), '
  + 'shutter (0..1 of the frame interval, default 0.5), format (mp4 | png), bitrate, audio (default true), pathTracing (diffuse indirect light path traced per pixel, accumulated over the sub-frames; default false). In the editor it renders in a hidden play-mode page.';
const BAKE_HELP = 'Bake a particle system into a flipbook atlas (columns x rows frames over some seconds, orthographic camera, alpha from a black and a white pass), '
  + 'saved as a png in the content folder through the editor backend. args: entity, columns (default 4), rows (default 4), size (pixels per frame, default 256), '
  + 'seconds (default 2), start (seconds simulated before the first frame), view (front | side | top), path (content path, default Textures/<entity>Flipbook). '
  + 'Returns the atlas layout and a particleSystem file that plays it back with one particle.';
async function screenshot(debug: Debug, game: Game, exact: boolean): Promise<unknown> {
  const canvas = game.graphicsDevice.canvas;
  // 逐像素比对（和桌面 Stride、和以前的截图）时那一帧不加输出的抖动：抖动是每个像素 ±半个色阶的噪声，平均差会多零点几
  const toneMap = game.graphicsCompositor.postEffects.toneMap;
  const dither = toneMap.dither;
  if (exact) toneMap.dither = false;
  // 画完的同一个任务里拿画布内容（WebGPU 画布的当前纹理在呈现之后就失效）
  const image = await debug.afterNextDraw(() => createImageBitmap(canvas)).finally(() => {
    toneMap.dither = dither;
  });
  const offscreen = new OffscreenCanvas(image.width, image.height);
  offscreen.getContext('2d')!.drawImage(image, 0, 0);
  image.close();
  return { width: offscreen.width, height: offscreen.height, frame: game.frames, png: await pngBase64(offscreen) };
}
/**
 * 借浏览器解一张图（JPEG、WebP、AVIF、PNG……，CLI 那边只会解 PNG）：按 width × height 铺满（等比放大、居中裁掉多出来的），
 * 返回 PNG 的 base64。照片比对（`stride shot --photo`）用。
 */
async function decodeImage(args: Args): Promise<unknown> {
  const data = textOf(args['data']);
  const width = Number(args['width']), height = Number(args['height']);
  if (!data || !(width > 0 && height > 0)) throw new Error('decode-image: data (base64) and a positive width and height are required');
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  const image = await createImageBitmap(new Blob([bytes]));
  const scale = Math.max(width / image.width, height / image.height);
  const offscreen = new OffscreenCanvas(width, height);
  const context = offscreen.getContext('2d')!;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, (width - image.width * scale) / 2, (height - image.height * scale) / 2, image.width * scale, image.height * scale);
  const original = { width: image.width, height: image.height };
  image.close();
  return { original, width, height, png: await pngBase64(offscreen) };
}

export function registerCaptureCommands(debug: Debug, game: Game): void {
  debug.command('screenshot', 'PNG of the next drawn frame (back buffer only, no page UI), as base64. args: exact (true: that frame without the output dither, for pixel comparisons).', (args) => screenshot(debug, game, args['exact'] === true));
  debug.command('decode-image', 'Decode an image with the browser (JPEG, WebP, AVIF, PNG) and scale it to cover width x height (centered crop). Used by stride shot --photo. args: data (base64 of the file), width, height. Returns the PNG as base64 and the original size.', (args) => decodeImage(args));
  debug.command('render', RENDER_HELP, async (args) => (await import('../../offline/renderCommand')).renderCommand(game, args));
  debug.command('bake', BAKE_HELP, async (args) => {
    const component = entityArg(game, args).get(ParticleSystemComponent);
    if (!component) throw new Error('bake: the entity has no particle system');
    return (await import('../../offline/FlipbookBaker')).bakeCommand(game, component, args);
  });
  debug.command('material-export', MATERIAL_EXPORT_HELP, async (args) => (await import('../../offline/MaterialGraphExport')).materialExportCommand(game, args));
}
