/**
 * 把 game.debugText 的文字画到画面最上面（Stride 的 FastTextRenderer）：8x16 像素的等宽位图字体，按真实像素摆，
 * `\n` 换行，可显示的 ASCII 以外的字画成空格。
 *
 * 和 Stride 不同：Stride 的每个字以给的位置为中心（四边形从 x - 4、y - 8 开始），整段字偏向左上半个字；这里按左上角摆。
 */
import type { Game } from '../games/Game';
import { SpriteBatch } from '../rendering/text/SpriteBatch';
import { Texture } from '../rendering/Texture';
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
    if (lines.length === 0) return;
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
    for (const { text, position, color = game.debugText.color } of lines) {
      const srgb = [linearToSrgb(color[0]), linearToSrgb(color[1]), linearToSrgb(color[2]), color[3]] as const;
      let x = position[0], y = position[1];
      for (const character of text) {
        if (character === '\n' || character === '\r') {
          x = position[0];
          y += DEBUG_GLYPH_HEIGHT;
          continue;
        }
        const code = character.charCodeAt(0);
        const c = code < 32 || code > 126 ? 32 : code;
        const quad = { origin: [x, y] as const, axisX: [DEBUG_GLYPH_WIDTH, 0] as const, axisY: [0, DEBUG_GLYPH_HEIGHT] as const };
        batch.drawQuad(texture, quad, [(c % COLUMNS) * u, (Math.floor(c / COLUMNS) % ROWS) * v, u, v], srgb);
        x += DEBUG_GLYPH_WIDTH;
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
