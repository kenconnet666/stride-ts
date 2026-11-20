/**
 * 精灵表（Stride 的 SpriteSheet）：一组精灵，每个是某张贴图上的一块区域加上尺寸和原点的设置。Sprite 组件的 sheet 列存它的 id，
 * frame 列选第几个（Stride 的 SpriteFromSheet.CurrentFrame）。和 Texture 一样只是数据。
 */
import type { Branded } from '../data/prop';
import { ResourceTable } from '../engine/ResourceTable';
import type { Texture } from '../graphics/Texture';

export type SpriteSheetId = Branded<number, 'SpriteSheetId'>;

const sheets = new ResourceTable<SpriteSheet>();

/** 精灵表里的一个精灵（Stride 的 Sprite）。 */
export interface SpriteFrame {
  readonly name: string;
  readonly texture: Texture;
  /** 贴图上的区域，像素：x、y（左上角）、宽、高。可以改（GameMenu 按比例缩短血条的精灵），用到它的 UI 元素下一帧重新量。 */
  region: [number, number, number, number];
  /** 区域的几个像素是 1 个单位。 */
  readonly pixelsPerUnit: number;
  /** 精灵的原点（实体的位置）在区域里的像素位置：centerFromMiddle 时从区域中心算，否则从左上角算。 */
  readonly center: readonly [number, number];
  readonly centerFromMiddle: boolean;
  /** 九宫格的边框，像素：左、上、右、下（UI 拉伸图片时四个角不变形）；没有时整张拉伸。 */
  readonly borders?: readonly [number, number, number, number];
}

export class SpriteSheet {
  /** 从 1 开始；Sprite.sheet 存它，0 是不用精灵表。 */
  readonly id: SpriteSheetId;
  readonly name: string;
  readonly sprites: readonly SpriteFrame[];

  constructor(name: string, sprites: readonly SpriteFrame[]) {
    this.name = name;
    this.sprites = sprites;
    this.id = sheets.add(this) as SpriteSheetId;
  }

  /** 第 frame 个精灵；超出范围时循环（负数也是，同 SpriteFromSheet.GetSprite）。空表是 undefined。 */
  frame(frame: number): SpriteFrame | undefined {
    const count = this.sprites.length;
    return count > 0 ? this.sprites[((frame % count) + count) % count] : undefined;
  }

  /** 按名字找精灵（Stride 的 SpriteSheet[name]）。 */
  find(name: string): SpriteFrame | undefined {
    return this.sprites.find((sprite) => sprite.name === name);
  }

  /** 按名字找精灵的下标（Stride 的 FindImageIndex），找不到是 -1。 */
  indexOf(name: string): number {
    return this.sprites.findIndex((sprite) => sprite.name === name);
  }

  /** @internal 组件里存的 id 对应的精灵表。 */
  static byId(id: number): SpriteSheet | undefined {
    return sheets.get(id);
  }
}
