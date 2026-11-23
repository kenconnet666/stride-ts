import { describe, expect, test } from 'vitest';
import type { ProductFile } from '../../src/content/formats/productFormat';
import type { ShelfFile } from '../../src/content/formats/shelfFormat';
import { shelfModel } from '../../src/modeling/shelf';
import { svgShapes, type VectorShape } from '../../src/modeling/svgShapes';

/** 点 (px, py) 处向 +X 打射线，数二次曲线带符号的穿越次数（绕数）。 */
function winding(curves: readonly number[], px: number, py: number): number {
  let total = 0;
  for (let c = 0; c < curves.length; c += 6) {
    const [x0, y0, cx, cy, x1, y1] = curves.slice(c, c + 6) as [number, number, number, number, number, number];
    // y(t) = (y0 - 2cy + y1) t² + 2(cy - y0) t + y0 - py
    const a = y0 - 2 * cy + y1, b = 2 * (cy - y0), k = y0 - py;
    const roots: number[] = [];
    if (Math.abs(a) < 1e-12) {
      if (Math.abs(b) > 1e-12) roots.push(-k / b);
    } else {
      const d = b * b - 4 * a * k;
      if (d >= 0) roots.push((-b - Math.sqrt(d)) / (2 * a), (-b + Math.sqrt(d)) / (2 * a));
    }
    for (const t of roots) {
      if (t < 0 || t >= 1) continue;
      const u = 1 - t, x = u * u * x0 + 2 * u * t * cx + t * t * x1;
      if (x <= px) continue;
      const dy = 2 * a * t + b;
      total += dy > 0 ? 1 : dy < 0 ? -1 : 0;
    }
  }
  return total;
}

/** 形状盖不盖住这个点（按它的规则和裁剪）。 */
function covers(shape: VectorShape, x: number, y: number): boolean {
  if (shape.clip && (x < shape.clip[0] || x > shape.clip[2] || y < shape.clip[1] || y > shape.clip[3])) return false;
  const w = winding(shape.curves, x, y);
  return shape.evenOdd ? w % 2 !== 0 : w !== 0;
}

describe('SVG 拆成填充形状', () => {
  test('方块、圆、颜色和不透明度（g 的 opacity 往下乘），曲线首尾相接', () => {
    const { viewBox, shapes } = svgShapes('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect x="10" y="10" width="30" height="20" fill="#ff0000"/><g opacity="0.5"><circle cx="70" cy="25" r="10" fill="#00f" opacity="0.5"/></g></svg>');
    expect(viewBox).toEqual([0, 0, 100, 50]);
    expect(shapes.length).toBe(2);
    expect(shapes[0]!.color).toEqual([1, 0, 0, 1]);
    expect(shapes[1]!.color[3]).toBeCloseTo(0.25);
    expect(covers(shapes[0]!, 20, 20)).toBe(true);
    expect(covers(shapes[0]!, 45, 20)).toBe(false);
    expect(covers(shapes[1]!, 70, 25)).toBe(true);
    expect(covers(shapes[1]!, 79, 25)).toBe(true);
    expect(covers(shapes[1]!, 81, 25)).toBe(false);
    for (const shape of shapes) {
      const c = shape.curves;
      for (let i = 6; i < c.length; i += 6) expect([c[i], c[i + 1]]).toEqual([c[i - 2], c[i - 1]]);
    }
  });

  test('描边换成轮廓：只描边的圆是一圈，中间空；圆头的线两头多出半个线宽', () => {
    const { shapes } = svgShapes('<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="30" fill="none" stroke="#000" stroke-width="4"/><path d="M10 90L90 90" stroke="#000" stroke-width="6" stroke-linecap="round"/></svg>');
    expect(shapes.length).toBe(2);
    const [ring, line] = shapes as [VectorShape, VectorShape];
    expect(covers(ring, 50, 50)).toBe(false);
    expect(covers(ring, 80, 50)).toBe(true);
    expect(covers(ring, 50, 21)).toBe(true);
    expect(covers(ring, 50, 15)).toBe(false);
    expect(covers(line, 50, 90)).toBe(true);
    expect(covers(line, 8, 90)).toBe(true);
    expect(covers(line, 5, 90)).toBe(false);
  });

  test('路径：相对命令、三次曲线、弧；evenodd 的洞', () => {
    const { shapes } = svgShapes('<svg viewBox="0 0 100 100"><path d="M10 10h80v80h-80zM30 30L70 30L70 70L30 70Z" fill-rule="evenodd" fill="#000"/><path d="M10 50C10 10 90 10 90 50A40 40 0 0 1 10 50Z" fill="#fff"/></svg>');
    const [frame, blob] = shapes as [VectorShape, VectorShape];
    expect(frame.evenOdd).toBe(true);
    expect(covers(frame, 20, 20)).toBe(true);
    expect(covers(frame, 50, 50)).toBe(false);
    expect(covers(blob, 50, 40)).toBe(true);
    expect(covers(blob, 50, 85)).toBe(true);
    expect(covers(blob, 50, 95)).toBe(false);
  });

  test('嵌套的 svg：viewBox 拉伸到视口、按视口裁剪；变换 rotate', () => {
    const { shapes } = svgShapes('<svg viewBox="0 0 200 100"><svg x="100" y="0" width="100" height="50" viewBox="0 0 10 10" preserveAspectRatio="none"><rect x="-5" y="0" width="20" height="5" fill="#0f0"/></svg><rect x="0" y="40" width="40" height="10" transform="rotate(90 20 45)" fill="#000"/></svg>');
    const [nested, turned] = shapes as [VectorShape, VectorShape];
    expect(nested.clip).toEqual([100, 0, 200, 50]);
    expect(covers(nested, 150, 20)).toBe(true);
    expect(covers(nested, 150, 30)).toBe(false);
    // 拉伸以后的矩形是 [50, 250] × [0, 25]，被视口裁到 [100, 200]
    expect(covers(nested, 90, 10)).toBe(false);
    expect(covers(turned, 20, 30)).toBe(true);
    expect(covers(turned, 5, 45)).toBe(false);
  });

  test('渐变取色标的平均色', () => {
    const { shapes } = svgShapes('<svg viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0" stop-color="#000000"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/></svg>');
    expect(shapes[0]!.color.map((v) => Math.round(v * 100) / 100)).toEqual([0.5, 0.5, 0.5, 0.5]);
  });

  test('真的货架图集整张能拆开：每个形状都有曲线，几百上千个形状', () => {
    const products = new Map<string, ProductFile>([
      ['P/Water', { name: 'Water', shape: 'bottle', size: [0.065, 0.21, 0], text: '水', seed: 1 }],
      ['P/Box', { name: 'Box', shape: 'box', size: [0.19, 0.28, 0.07], text: '饼干', seed: 3 }],
      ['P/Jar', { name: 'Jar', shape: 'jar', size: [0.07, 0.1, 0], surface: 'glass', seed: 4 }],
    ]);
    const shelf: ShelfFile = { name: 'S', sides: 2, length: 2, height: 1.6, depth: 0.4, levels: [0.15, 0.5, 0.85, 1.2], stock: { products: [...products.keys()], variants: 3 }, seed: 7 };
    const model = shelfModel(shelf, { products, font: () => undefined });
    const { viewBox, shapes } = svgShapes(model.colorSvg, 'shelf');
    expect(viewBox[2]).toBe(model.atlasPixels);
    expect(shapes.length).toBeGreaterThan(100);
    for (const shape of shapes) expect(shape.curves.length).toBeGreaterThan(0);
  });
});
