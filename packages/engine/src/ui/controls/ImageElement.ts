/**
 * 图片（Stride 的 ImageElement）和按拉伸方式算图片大小（ImageSizeHelper）。
 */
import { UIElement, type Color, type Vec2 } from '../UIElement';
import { hasBorders, spriteSize, type SpriteProvider } from '../sprites';
import type { SpriteFrame } from '../../rendering/SpriteSheet';

/** 图片怎么填满给它的空间：不缩放、等比放进去、等比铺满（会裁掉）、布局时等比排列时拉满、拉满。 */
export type StretchType = 'none' | 'uniform' | 'uniformToFill' | 'fillOnStretch' | 'fill';
/** 只放大、只缩小，还是都可以。 */
export type StretchDirection = 'both' | 'downOnly' | 'upOnly';

const WHITE: Color = [1, 1, 1, 1];

/** 图片在 available 里的大小（Stride 的 ImageSizeHelper.CalculateImageSizeFromAvailable）；量的时候不小于九宫格的边框。 */
export function imageSize(sprite: SpriteFrame | undefined, available: Vec2, stretchType: StretchType, stretchDirection: StretchDirection, isMeasuring: boolean): Vec2 {
  if (!sprite) return [0, 0];
  const ideal = spriteSize(sprite);
  if (ideal[0] <= 0 || ideal[1] <= 0) return [0, 0];
  if (!Number.isFinite(available[0]) && !Number.isFinite(available[1])) return [ideal[0], ideal[1]];

  const scale: Vec2 = [available[0] / ideal[0], available[1] / ideal[1]];
  if (!Number.isFinite(scale[0])) scale[0] = scale[1];
  if (!Number.isFinite(scale[1])) scale[1] = scale[0];
  switch (stretchType) {
    case 'none':
      scale[0] = scale[1] = 1;
      break;
    case 'uniform':
      scale[0] = scale[1] = Math.min(scale[0], scale[1]);
      break;
    case 'uniformToFill':
      scale[0] = scale[1] = Math.max(scale[0], scale[1]);
      break;
    case 'fillOnStretch':
      if (isMeasuring) scale[0] = scale[1] = Math.min(scale[0], scale[1]);
      break;
    case 'fill':
      break;
  }
  if (stretchDirection === 'downOnly') {
    scale[0] = Math.min(scale[0], 1);
    scale[1] = Math.min(scale[1], 1);
  } else if (stretchDirection === 'upOnly') {
    scale[0] = Math.max(1, scale[0]);
    scale[1] = Math.max(1, scale[1]);
  }
  const size: Vec2 = [ideal[0] * scale[0], ideal[1] * scale[1]];
  if (!isMeasuring || !hasBorders(sprite)) return size;
  const [left, top, right, bottom] = sprite.borders!;
  return [Math.max(size[0], left + right), Math.max(size[1], top + bottom)];
}

export class ImageElement extends UIElement {
  #source: SpriteProvider | null = null;
  #sprite: SpriteFrame | undefined;
  #spriteSize: readonly [number, number] = [0, 0];
  #stretchType: StretchType = 'uniform';
  #stretchDirection: StretchDirection = 'both';
  #rotation = 0;
  /** 乘在图片上的颜色（sRGB）。 */
  color: Color = WHITE;

  get source(): SpriteProvider | null { return this.#source; }
  set source(value: SpriteProvider | null) {
    if (value === this.#source) return;
    this.#source = value;
    this.#onSpriteChanged(value?.getSprite());
  }

  /** 现在画的精灵。 */
  get sprite(): SpriteFrame | undefined { return this.#sprite; }

  get stretchType(): StretchType { return this.#stretchType; }
  set stretchType(value: StretchType) { this.#stretchType = value; this.invalidateMeasure(); }
  get stretchDirection(): StretchDirection { return this.#stretchDirection; }
  set stretchDirection(value: StretchDirection) { this.#stretchDirection = value; this.invalidateMeasure(); }

  /** 绕中心转的角度，弧度。 */
  get rotation(): number { return this.#rotation; }
  set rotation(value: number) {
    if (Math.abs(this.#rotation - value) <= 1e-6) return;
    this.#rotation = value;
    const cos = Math.cos(value), sin = Math.sin(value);
    this.localMatrix = value === 0 ? [1, 0, 0, 1, 0, 0] : [cos, sin, -sin, cos, 0, 0];
  }

  protected override measureOverride(available: Vec2): Vec2 {
    return imageSize(this.#sprite, available, this.#stretchType, this.#stretchDirection, true);
  }

  protected override arrangeOverride(finalSize: Vec2): Vec2 {
    return imageSize(this.#sprite, finalSize, this.#stretchType, this.#stretchDirection, false);
  }

  /** 精灵换了（精灵表换帧）或者大小变了（脚本改了区域）都重新量。 */
  protected override onUpdate(): void {
    const sprite = this.#source?.getSprite();
    if (sprite !== this.#sprite || (sprite && (sprite.region[2] !== this.#spriteSize[0] || sprite.region[3] !== this.#spriteSize[1]))) this.#onSpriteChanged(sprite);
  }

  #onSpriteChanged(sprite: SpriteFrame | undefined): void {
    this.#sprite = sprite;
    this.#spriteSize = sprite ? spriteSize(sprite) : [0, 0];
    this.invalidateMeasure();
  }
}
