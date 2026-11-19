/**
 * UI 的图片（Stride 的 ISpriteProvider）：精灵表的某一帧（SpriteFromSheet，脚本可以改 currentFrame 换图），或一整张贴图
 * （SpriteFromTexture）。元素每帧取一次精灵，换了就重新布局。
 */
import type { SpriteFrame, SpriteSheet } from '../rendering/SpriteSheet';
import type { Texture } from '../rendering/Texture';

export interface SpriteProvider {
  getSprite(): SpriteFrame | undefined;
}

export class SpriteFromSheet implements SpriteProvider {
  sheet: SpriteSheet | null;
  currentFrame: number;

  constructor(sheet: SpriteSheet | null = null, currentFrame = 0) {
    this.sheet = sheet;
    this.currentFrame = currentFrame;
  }

  getSprite(): SpriteFrame | undefined {
    return this.sheet?.frame(this.currentFrame);
  }

  /** 精灵表里名字是 name 的那一帧（Stride 的 SpriteFromSheet.Create）；没有这个名字时报错。 */
  static create(sheet: SpriteSheet, name: string): SpriteFromSheet {
    const index = sheet.indexOf(name);
    if (index < 0) throw new Error(`sprite sheet '${sheet.name}' has no sprite '${name}'`);
    return new SpriteFromSheet(sheet, index);
  }
}

export class SpriteFromTexture implements SpriteProvider {
  readonly #sprite: SpriteFrame;

  constructor(texture: Texture) {
    const { width, height } = texture.data;
    this.#sprite = { name: texture.name, texture, region: [0, 0, width, height], pixelsPerUnit: 100, center: [0, 0], centerFromMiddle: true };
  }

  getSprite(): SpriteFrame {
    return this.#sprite;
  }
}

/** 精灵的像素大小（Stride 的 Sprite.SizeInPixels）。 */
export function spriteSize(sprite: SpriteFrame): readonly [number, number] {
  return [sprite.region[2], sprite.region[3]];
}

/** 精灵有没有九宫格的边框。 */
export function hasBorders(sprite: SpriteFrame): boolean {
  return sprite.borders !== undefined && sprite.borders.some((border) => border !== 0);
}
