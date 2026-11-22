import { describe, expect, test } from 'vitest';
import type { ProductFile, ProductShape } from '../../src/content/formats/productFormat';
import { labelPixels, productDesign, productLabelSvg, productMaterial, productMesh } from '../../src/modeling/product';

const bottle: ProductFile = { name: 'Water', shape: 'bottle', size: [0.065, 0.21, 0], text: '矿泉水', seed: 3 };
const sizes: Readonly<Record<ProductShape, readonly [number, number, number]>> = {
  box: [0.2, 0.3, 0.06], bottle: [0.065, 0.21, 0], can: [0.066, 0.12, 0], jar: [0.09, 0.11, 0], tub: [0.1, 0.08, 0], pouch: [0.16, 0.22, 0.05],
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
    expect(max[0]! - min[0]!).toBeCloseTo(size[0], 2);
    if (shape === 'box' || shape === 'pouch') expect(max[2]! - min[2]!).toBeCloseTo(size[2], 2);
    else expect(max[2]! - min[2]!).toBeCloseTo(size[0], 2);
    expect(worstNormal).toBeLessThan(1e-5);
    expect(uvOutside).toBe(0);
    expect(mesh.labelSize[0]).toBeGreaterThan(0);
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
