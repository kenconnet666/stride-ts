/**
 * 把 game.debugText 的文字画到画面最上面（Stride 的 FastTextRenderer）：8x16 的等宽位图字体，`\n` 换行，可显示的 ASCII
 * 以外的字画成空格。位置按 DebugText.toCanvas 换到画布上；字放大整数倍（位图字体放大非整数倍会糊），倍数取画布的像素比乘
 * DebugText.scale 往下取整。
 *
 * 和 Stride 不同：Stride 的每个字以给的位置为中心（四边形从 x - 4、y - 8 开始），整段字偏向左上半个字；这里按左上角摆。
 */
import type { Game } from '../engine/Game';
import { SpriteBatch } from '../rendering/text/SpriteBatch';
import { Texture } from '../graphics/Texture';
import { DEBUG_FONT_PNG, DEBUG_GLYPH_HEIGHT, DEBUG_GLYPH_WIDTH } from './debugFont';

const COLUMNS = 32;
const ROWS = 4;

/** 线性的分量转成 sRGB（SpriteBatch 的颜色按 sRGB 给）。 */
function linearToSrgb(value: number): number {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
}

export class DebugTextRenderer {
  #texture: Texture | undefined;
  #loading: Promise<void> | undefined;
  #batch: SpriteBatch | undefined;

  /** @internal 每帧画完 UI 之后。字体图第一次用到时解码，解码好之前不画。 */
  draw(game: Game): void {
    const lines = game.debugText.lines;
    if (!game.debugText.visible || lines.length === 0) return;
    const texture = this.#texture;
    if (!texture) {
      this.#loading ??= this.#load(game);
      return;
    }
    const device = game.graphicsDevice;
    const { width, height } = device.canvas;
    const batch = (this.#batch ??= new SpriteBatch(device.device, game.renderSystem.resources));
    const pass = device.frameEncoder.beginRenderPass({ label: 'DebugText', colorAttachments: [{ view: device.currentBackBufferView(), loadOp: 'load', storeOp: 'store' }] });
    batch.virtualResolution = undefined;
    batch.begin(pass, width, height, device.backBufferViewFormat);
    const u = 1 / COLUMNS, v = 1 / ROWS;
    // 画布的一个 CSS 像素是几个真实像素（画布的分辨率封顶时比 devicePixelRatio 小）
    const pixelRatio = width / Math.max(1, device.canvas.clientWidth);
    // 往下取整：字不比按比例放大的宽，挨着摆的两段字不会叠在一起
    const zoom = Math.max(1, Math.floor(pixelRatio * game.debugText.scale + 1e-3));
    const glyphWidth = DEBUG_GLYPH_WIDTH * zoom, glyphHeight = DEBUG_GLYPH_HEIGHT * zoom;
    for (const { text, position, color = game.debugText.color } of lines) {
      const srgb = [linearToSrgb(color[0]), linearToSrgb(color[1]), linearToSrgb(color[2]), color[3]] as const;
      const [left, top] = game.debugText.toCanvas(position).map((value) => Math.round(value * pixelRatio)) as [number, number];
      let x = left, y = top;
      for (const character of text) {
        if (character === '\n' || character === '\r') {
          x = left;
          y += glyphHeight;
          continue;
        }
        const code = character.charCodeAt(0);
        const c = code < 32 || code > 126 ? 32 : code;
        const quad = { origin: [x, y] as const, axisX: [glyphWidth, 0] as const, axisY: [0, glyphHeight] as const };
        batch.drawQuad(texture, quad, [(c % COLUMNS) * u, (Math.floor(c / COLUMNS) % ROWS) * v, u, v], srgb);
        x += glyphWidth;
      }
    }
    batch.end();
    pass.end();
  }

  async #load(game: Game): Promise<void> {
    const decode = game.content.imageDecoder;
    if (!decode) return;
    const bytes = Uint8Array.from(atob(DEBUG_FONT_PNG), (c) => c.charCodeAt(0));
    this.#texture = new Texture('StrideDebugSpriteFont', await decode(bytes, { encoding: 'png', srgb: true }));
  }

  destroy(): void {
    this.#batch?.destroy();
    this.#batch = undefined;
  }
}
