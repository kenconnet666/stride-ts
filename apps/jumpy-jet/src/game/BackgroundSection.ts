// JumpyJet 的 BackgroundSection：一层视差背景。贴图的区域按速度往左滚，滚到头从 0 再来；区域比屏幕窄的那段由第二个四边形
// 接上（画在第一个的右边）。坐标是 SpriteBatch 的虚拟分辨率（后备缓冲的大小），原点在屏幕中心加 startPosition。
import type { SpriteBatch, SpriteFrame, Texture, Vec2 } from '@stride-ts/engine';

type Rect = [number, number, number, number];

export class BackgroundSection {
  readonly scrollSpeed: number;
  /** 滚动着（游戏开始后；结束时停住）。 */
  isUpdating = true;
  scrollPos = 0;
  readonly #texture: Texture;
  readonly #textureRegion: Readonly<Rect>;
  readonly #screen: Vec2;
  readonly #center: Vec2;
  readonly #firstPosition: Vec2;
  readonly #firstRegion: Rect;
  readonly #firstOrigin: [number, number];
  readonly #secondPosition: [number, number];
  readonly #secondRegion: Rect;
  readonly #secondOrigin: [number, number];

  /** resolution 是虚拟分辨率；startPosition 是相对屏幕中心的偏移。 */
  constructor(sprite: SpriteFrame, resolution: Vec2, scrollSpeed: number, startPosition: Vec2 = [0, 0]) {
    this.#screen = [Math.trunc(resolution[0]), Math.trunc(resolution[1])];
    this.#center = [resolution[0] / 2, resolution[1] / 2];
    this.#firstPosition = startPosition;
    this.#secondPosition = [startPosition[0], startPosition[1]];
    this.scrollSpeed = scrollSpeed;
    this.#texture = sprite.texture;
    this.#textureRegion = [...sprite.region];
    const [x, y, width, height] = this.#textureRegion;
    this.#firstRegion = [x, y, Math.min(width, this.#screen[0]), Math.min(height, this.#screen[1])];
    // 居中
    this.#firstOrigin = [0.5 * this.#firstRegion[2], 0.5 * this.#firstRegion[3]];
    this.#secondRegion = [...this.#firstRegion];
    this.#secondOrigin = [...this.#firstOrigin];
  }

  /** 滚动（isUpdating 时）并画这一层的一两个四边形。 */
  draw(elapsed: number, batch: SpriteBatch): void {
    if (this.isUpdating) {
      if (this.scrollPos >= this.#textureRegion[2]) this.scrollPos = 0;
      this.scrollPos += elapsed * this.scrollSpeed;
      this.#updateQuads();
    }
    this.#drawQuad(batch, this.#firstPosition, this.#firstRegion, this.#firstOrigin);
    if (this.#secondRegion[2] > 0) this.#drawQuad(batch, this.#secondPosition, this.#secondRegion, this.#secondOrigin);
  }

  /** Stride 的 SpriteBatch.Draw(texture, position, source, color, 0, origin, 1)：源区域原样大小，origin 对到 position。 */
  #drawQuad(batch: SpriteBatch, position: Vec2, region: Readonly<Rect>, origin: Vec2): void {
    const x = position[0] + this.#center[0], y = position[1] + this.#center[1];
    batch.draw(this.#texture, [x, y, region[2], region[3]], { source: [...region], origin });
  }

  #updateQuads(): void {
    // 第一个四边形：从滚动的位置到区域的右边
    this.#firstRegion[2] = this.#textureRegion[2] - this.scrollPos;
    this.#firstRegion[0] = this.scrollPos;
    // 第二个：补上屏幕右边剩下的宽度，从区域的左边开始
    const secondWidth = this.scrollPos + this.#screen[0] - this.#textureRegion[2];
    this.#secondRegion[2] = secondWidth;
    this.#secondPosition[0] = (this.#screen[0] - secondWidth) / 2;
    this.#secondOrigin[0] = secondWidth / 2;
  }
}
