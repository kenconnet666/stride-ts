import { describe, expect, test } from 'vitest';
import type { ProductFile, ProductShape } from '../../src/content/formats/productFormat';
import { isProduce, labelPixels, productDesign, productLabelSvg, productMaterial, productMesh } from '../../src/modeling/product';

const bottle: ProductFile = { name: 'Water', shape: 'bottle', size: [0.065, 0.21, 0], text: '矿泉水', seed: 3 };
const sizes: Readonly<Record<ProductShape, readonly [number, number, number]>> = {
  box: [0.2, 0.3, 0.06], bottle: [0.065, 0.21, 0], can: [0.066, 0.12, 0], jar: [0.09, 0.11, 0], tub: [0.1, 0.08, 0], pouch: [0.16, 0.22, 0.05],
  round: [0.08, 0.07, 0], onion: [0.08, 0.085, 0], garlic: [0.055, 0.05, 0], nut: [0.035, 0.034, 0], tuber: [0.11, 0.06, 0.07],
  bowl: [0.2, 0.08, 0], plate: [0.26, 0.035, 0.2],
};

/** 网格的包围盒和每个顶点：位置、法线、UV。 */
function inspect(vertices: Float32Array) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let worstNormal = 0, uvOutside = 0;
  for (let i = 0; i < vertices.length; i += 8) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, vertices[i + k]!);
      max[k] = Math.max(max[k]!, vertices[i + k]!);
    }
    worstNormal = Math.max(worstNormal, Math.abs(Math.hypot(vertices[i + 3]!, vertices[i + 4]!, vertices[i + 5]!) - 1));
    if (vertices[i + 6]! < -1e-6 || vertices[i + 6]! > 1 + 1e-6 || vertices[i + 7]! < -1e-6 || vertices[i + 7]! > 1 + 1e-6) uvOutside++;
  }
  return { min, max, worstNormal, uvOutside };
}

describe('商品包装', () => {
  test.each(Object.keys(sizes) as ProductShape[])('%s：尺寸对得上，法线是单位长，UV 在 0..1 里，原点在底面中心', (shape) => {
    const size = sizes[shape];
    const mesh = productMesh({ name: shape, shape, size });
    expect(mesh.indices.length).toBeGreaterThan(0);
    expect(mesh.indices.length % 3).toBe(0);
    const { min, max, worstNormal, uvOutside } = inspect(mesh.vertices);
    expect(min[1]).toBeCloseTo(0, 5);
    expect(max[1]).toBeCloseTo(size[1], 5);
    const depth = shape === 'box' || shape === 'pouch' || ((isProduce(shape) || shape === 'plate') && size[2] > 0) ? size[2] : size[0];
    if (isProduce(shape)) {
      // 果蔬有起伏（土豆疙疙瘩瘩、蒜一瓣瓣）：尺寸差在 15% 以内
      expect(Math.abs(max[0]! - min[0]! - size[0]) / size[0]).toBeLessThan(0.15);
      expect(Math.abs(max[2]! - min[2]! - depth) / depth).toBeLessThan(0.15);
    } else {
      expect(max[0]! - min[0]!).toBeCloseTo(size[0], 2);
      expect(max[2]! - min[2]!).toBeCloseTo(depth, 2);
    }
    expect(worstNormal).toBeLessThan(1e-5);
    expect(uvOutside).toBe(0);
    expect(mesh.labelSize[0]).toBeGreaterThan(0);
  });

  test('碗：盛了菜多一块菜面，边上低于口沿、中间鼓起；贴图有青花和菜那块；方盘按宽深压成圆角方形', () => {
    const empty = productMesh({ name: 'Bowl', shape: 'bowl', size: [0.2, 0.08, 0] });
    const file: ProductFile = { name: 'Pork', shape: 'bowl', size: [0.2, 0.08, 0], food: { color: '#8a3a1c', accent: '#2f8a2f', level: 0.6, mound: 0.25, pieces: 'chunks' }, seed: 4 };
    const full = productMesh(file);
    expect(full.vertices.length).toBeGreaterThan(empty.vertices.length);
    // 菜面的顶点在碗的那些后面：中心那个最高（口沿以上、鼓起不到一个碗高），边上那圈在口沿以下
    const food = full.vertices.subarray(empty.vertices.length);
    const center = food[1]!;
    expect(center).toBeGreaterThan(0.06);
    expect(center).toBeLessThan(0.08 + 0.25 * 0.08 + 0.02);
    const ring = food.subarray(food.length - 8 * 20);
    for (let i = 0; i < ring.length; i += 8) expect(ring[i + 1]!).toBeLessThan(0.08);
    // 贴图下面接了一块菜面（高比空碗的多一个口径）
    expect(full.labelSize[1]).toBeCloseTo(empty.labelSize[1] + 200, 0);
    const svg = productLabelSvg(file, full.labelSize, undefined);
    expect(svg).toContain('#23408e');
    expect(svg).toContain('#8a3a1c');
    expect(productDesign(file).surface).toBe('ceramic');
    expect(productDesign({ name: 'Plate', shape: 'plate', size: [0.26, 0.035, 0.2] }).pattern).toBe('plain');
  });

  test('旋转体的法线朝外：侧面的法线和从轴出来的方向同向', () => {
    const { vertices } = productMesh({ name: 'Can', shape: 'can', size: [0.066, 0.12, 0] });
    for (let i = 0; i < vertices.length; i += 8) {
      const x = vertices[i]!, z = vertices[i + 2]!, radial = Math.hypot(x, z);
      if (radial < 0.03) continue;
      expect(x * vertices[i + 3]! + z * vertices[i + 5]!).toBeGreaterThanOrEqual(-1e-6);
    }
  });

  test('没写的按种子挑；同一个文件同一个变体每次一样，换变体是另一个牌子；写了的不变', () => {
    expect(productDesign(bottle)).toEqual(productDesign(bottle));
    const brands = new Set(Array.from({ length: 8 }, (_, k) => productDesign(bottle, k).brand));
    expect(brands.size).toBeGreaterThan(4);
    const fixed: ProductFile = { ...bottle, brand: '海天', colors: { background: '#ffffff' }, pattern: 'band' };
    for (let k = 0; k < 4; k++) {
      const design = productDesign(fixed, k);
      expect(design.brand).toBe('海天');
      expect(design.colors.background).toBe('#ffffff');
      expect(design.pattern).toBe('band');
    }
    expect(productDesign(bottle).surface).toBe('plastic');
    expect(productDesign({ ...bottle, shape: 'can' }).surface).toBe('metal');
  });

  test('标签的 SVG：毫米做单位、宽高同展开的大小，盖子那一段是盖子的颜色；没有字体时不画字', () => {
    const mesh = productMesh(bottle);
    const svg = productLabelSvg({ ...bottle, colors: { cap: '#123456' } }, mesh.labelSize, undefined);
    expect(svg).toContain(`viewBox="0 0 ${Math.round(mesh.labelSize[0] * 10) / 10} ${Math.round(mesh.labelSize[1] * 10) / 10}"`);
    expect(svg).toContain('fill="#123456"');
    expect(svg).not.toContain('fill-rule');
  });

  test('材质：标签贴图按比例栅格化，材料定粗糙度和金属度', () => {
    expect(labelPixels([204, 260])).toEqual([400, 512]);
    const material = productMaterial({ ...bottle, shape: 'can' }, 'Products/Cola', [512, 256]);
    expect(material.baseColorTexture).toMatchObject({ texture: 'Products/Cola', encoding: 'svg', size: [512, 256] });
    expect(material.metalness).toBeGreaterThan(0);
  });

  test('尺寸不对时报错', () => {
    expect(() => productMesh({ name: 'Bad', shape: 'box', size: [0.1, 0.2, 0] })).toThrow(/depth/);
    expect(() => productMesh({ name: 'Bad', shape: 'can', size: [0, 0.2, 0] })).toThrow(/width/);
  });
});
