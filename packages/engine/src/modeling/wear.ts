/**
 * 用旧了的样子（按种子，矢量）：印刷面上的手印、擦痕（商品的标签、招牌的字面），刷漆、不锈钢的面上掉漆的边角、擦痕、底下发脏
 * （器具的主色、招牌的外框）。都是画进图集的 SVG，没有新的贴图通道。
 */
import { hash32, seededRandom } from '../data/hash.ts';
import type { AtlasCell, Cell } from './productBatch.ts';
import { shadeColor, svgNumber } from './svg.ts';

/**
 * 印刷面旧了（W × H，毫米，amount 0..1）：整面一层很淡的褪色，几块手印似的灰，上下边上几道擦痕（只画颜色，不挡透光）。
 */
export function printWear([W, H]: readonly [number, number], amount: number, random: () => number): string {
  const shapes = [`<rect width="${svgNumber(W)}" height="${svgNumber(H)}" fill="#ffffff" opacity="${svgNumber(amount * (0.02 + random() * 0.05))}"/>`];
  const smudges = Math.round(amount * (1 + random() * 4));
  for (let i = 0; i < smudges; i++) {
    const cx = random() * W, cy = random() * H, r = Math.min(W, H) * (0.04 + random() * 0.08);
    shapes.push(`<ellipse cx="${svgNumber(cx)}" cy="${svgNumber(cy)}" rx="${svgNumber(r * 1.3)}" ry="${svgNumber(r)}" fill="#4a4036" opacity="${svgNumber(amount * (0.05 + random() * 0.08))}"/>`);
  }
  const scuffs = Math.round(amount * (2 + random() * 6));
  for (let i = 0; i < scuffs; i++) {
    const x = random() * W, y = random() < 0.5 ? random() * H * 0.15 : H * (0.85 + random() * 0.15), length = W * (0.01 + random() * 0.04);
    shapes.push(`<rect x="${svgNumber(x)}" y="${svgNumber(y)}" width="${svgNumber(length)}" height="${svgNumber(0.3 + random() * 0.4)}" fill="#ffffff" opacity="${svgNumber(amount * (0.25 + random() * 0.3))}" transform="rotate(${Math.round((random() - 0.5) * 30)} ${svgNumber(x)} ${svgNumber(y)})"/>`);
  }
  return `<g>${shapes.join('')}</g>`;
}

/** 旧漆格的边长（像素）：盒子的每个面都铺满整格，拉长了也看不出（掉漆、擦痕本来就不规则）。 */
const PAINT_CELL = 512;

/**
 * 用旧了的漆面（或不锈钢）一格，给 ProductBatch.textureSolid 替掉一个纯色：底色 color，深浅不匀的几大块，边上掉的漆（漆面露出
 * 底下的灰色金属，不锈钢是更暗的划伤），细的划痕，靠底的一截发脏、几道鞋踢、车撞的黑印。格子的上沿对着竖直的面的底
 * （texturedBox 的 v 顺着 y 往上，图集里 y 朝下）。amount 0..1，seed 定位置。
 */
export function wornPaintCell(color: string, { roughness, metalness, amount, seed }: { readonly roughness: number; readonly metalness: number; readonly amount: number; readonly seed: number }): AtlasCell {
  return {
    size: [PAINT_CELL, PAINT_CELL], color, roughness, metalness,
    draw: ([x, y, w, h]: Cell) => {
      const random = seededRandom(hash32(seed, 4001)), n = svgNumber, shapes: string[] = [];
      const metal = metalness > 0.5;
      // 深浅不匀
      for (let i = 0; i < 6; i++) {
        const r = w * (0.15 + random() * 0.2);
        shapes.push(`<ellipse cx="${n(x + random() * w)}" cy="${n(y + random() * h)}" rx="${n(r * 1.4)}" ry="${n(r)}" fill="${shadeColor(color, 0.9 + random() * 0.18)}" opacity="${n(0.3 * amount)}"/>`);
      }
      // 靠底的一截发脏：几层越往上越淡的条（不用渐变，图集里同一个 id 会撞）
      for (let i = 0; i < 4; i++) shapes.push(`<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h * (0.06 + i * 0.06))}" fill="#3a332c" opacity="${n(0.08 * amount)}"/>`);
      // 黑印：靠底的短而粗的一道道
      for (let i = 0, marks = Math.round(10 * amount); i < marks; i++) {
        const mx = x + random() * w, my = y + random() * h * 0.3, length = w * (0.03 + random() * 0.08);
        shapes.push(`<path d="M${n(mx)} ${n(my)}l${n(length)} ${n((random() - 0.5) * length * 0.3)}" stroke="#1e1c1a" stroke-width="${n(w * (0.004 + random() * 0.008))}" stroke-linecap="round" opacity="${n(0.25 + random() * 0.25)}"/>`);
      }
      // 掉漆：贴着四条边的小块
      const chip = metal ? shadeColor(color, 0.62) : '#8d9096';
      for (let i = 0, chips = Math.round(40 * amount); i < chips; i++) {
        const side = Math.floor(random() * 4), t = random(), depth = random() * w * 0.02;
        const [cx, cy] = side === 0 ? [x + t * w, y + depth] : side === 1 ? [x + t * w, y + h - depth] : side === 2 ? [x + depth, y + t * h] : [x + w - depth, y + t * h];
        const r = w * (0.003 + random() * 0.01);
        shapes.push(`<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(r * (1 + random()))}" ry="${n(r)}" transform="rotate(${Math.round(random() * 180)} ${n(cx)} ${n(cy)})" fill="${chip}" opacity="${n(0.6 + random() * 0.3)}"/>`);
      }
      // 划痕：细的直线，亮的多、暗的少
      for (let i = 0, scratches = Math.round(16 * amount); i < scratches; i++) {
        const sx = x + random() * w, sy = y + random() * h, length = w * (0.04 + random() * 0.16), angle = random() * Math.PI;
        shapes.push(`<path d="M${n(sx)} ${n(sy)}l${n(Math.cos(angle) * length)} ${n(Math.sin(angle) * length)}" stroke="${random() < 0.7 ? '#ffffff' : '#000000'}" stroke-width="${n(0.6 + random())}" opacity="${n(0.12 + random() * 0.15)}"/>`);
      }
      return `<g>${shapes.join('')}</g>`;
    },
  };
}
