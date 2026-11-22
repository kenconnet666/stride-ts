/**
 * 招牌的生成（`.sign.json`，格式见 content/formats/signFormat.ts）：外框是一个盒子，字面是贴在正面（和背面）的一片，字是字体
 * 轮廓的路径画进图集；灯箱的字面整块发光（字和底都亮，同真的灯箱），挂牌不发光。走 ProductBatch，同货架出一个模型、图集和材质。
 */
import type { SignFile } from '../content/formats/signFormat.ts';
import { textPath } from './product.ts';
import { ProductBatch, type Cell, type MergedProducts } from './productBatch.ts';
import type { TextFont } from './textOutline.ts';

/** 字面比外框往里缩多少（米）、往外凸多少（贴在框的面上，不和框打架）。 */
const INSET = 0.02, PROUD = 0.002;

/** 生成招牌；font 是读好的字体（没有时字面只有底色）。 */
export function signModel(file: SignFile, font: TextFont | undefined, where = file.name): MergedProducts {
  const [w, h, d] = file.size;
  if (!(w > 0 && h > 0 && d > 0)) throw new Error(`${where}: size needs a width, height and depth greater than 0`);
  const lightbox = (file.style ?? 'lightbox') === 'lightbox';
  const background = file.colors?.background ?? '#2f9e44', ink = file.colors?.text ?? '#ffffff';
  const faceW = Math.max(0.01, w - 2 * INSET), faceH = Math.max(0.01, h - 2 * INSET);
  const batch = new ProductBatch({ products: new Map(), font: () => undefined }, where, [], {
    solids: [{ color: file.colors?.frame ?? '#c8c9cc', roughness: 0.35, metalness: 0.7 }],
    cells: [{
      size: [faceW * 1000, faceH * 1000], color: background, roughness: 0.3, metalness: 0, ...(lightbox ? { emissive: file.brightness ?? 3 } : {}),
      draw: ([x, y, cw, ch]: Cell) => (font ? textPath(font, file.text, x + cw / 2, y + ch / 2, cw * 0.86, ch * 0.72, ink) : undefined),
    }],
  });
  batch.box([-w / 2, -h / 2, -d / 2], [w / 2, h / 2, d / 2], 0);
  const face = (side: 1 | -1) => {
    const z = side * (d / 2 + PROUD), x = (faceW / 2) * side, y = faceH / 2;
    // 从这一面看：左下、右下、右上、左上（背面那一面的 x 反过来）
    batch.quad([[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]], [0, 0, side], 0);
  };
  face(1);
  if (file.doubleSided) face(-1);
  return batch.finish();
}
