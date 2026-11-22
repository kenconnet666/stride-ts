import { describe, expect, test } from 'vitest';
import type { SignFile } from '../../src/content/formats/signFormat';
import { floorStickerSvg, signModel } from '../../src/modeling/sign';

const sign: SignFile = { name: 'Entrance', text: '超市入口', font: 'F', size: [1.2, 0.3, 0.08] };

describe('招牌', () => {
  test('灯箱：外框加正面的字面，字面发光；挂牌不发光', () => {
    const lightbox = signModel(sign, undefined);
    // 盒子 6 个面、字面 1 片：每片 4 个顶点
    expect(lightbox.vertices.length / 8).toBe(28);
    expect(lightbox.emissive).toBe(3);
    expect(lightbox.emissiveSvg).toBeDefined();
    const panel = signModel({ ...sign, style: 'panel' }, undefined);
    expect(panel.emissive).toBe(0);
    expect(panel.emissiveSvg).toBeUndefined();
  });

  test('两面：背面也有字面、朝 -Z；尺寸不对时报错', () => {
    const both = signModel({ ...sign, doubleSided: true }, undefined);
    expect(both.vertices.length / 8).toBe(32);
    const normals = [];
    for (let i = both.vertices.length - 32; i < both.vertices.length; i += 8) normals.push(both.vertices[i + 5]);
    expect(normals).toEqual([-1, -1, -1, -1]);
    expect(() => signModel({ ...sign, size: [0, 0.3, 0.08] }, undefined)).toThrow(/size/);
  });

  test('地贴：透明底的 SVG（毫米），圆角方块、圆标、箭头；磨损时有遮罩；尺寸不对时报错', () => {
    const base: SignFile = { name: 'Floor', style: 'floor', text: '', font: 'F', size: [0.5, 0.9, 0] };
    const rect = floorStickerSvg(base, undefined);
    expect(rect).toContain('viewBox="0 0 500 900"');
    expect(rect).toContain('<rect x=');
    expect(rect).not.toContain('mask');
    expect(floorStickerSvg({ ...base, shape: 'round' }, undefined)).toContain('<circle');
    const arrow = floorStickerSvg({ ...base, shape: 'arrow', colors: { background: '#2f9e44' } }, undefined);
    expect(arrow).toMatch(/<path d="M250 \d/);
    expect(arrow).toContain('#2f9e44');
    const worn = floorStickerSvg({ ...base, wear: 0.5, seed: 3 }, undefined);
    expect(worn).toContain('<mask id="wear">');
    expect(worn).toBe(floorStickerSvg({ ...base, wear: 0.5, seed: 3 }, undefined));
    expect(() => floorStickerSvg({ ...base, size: [0, 1, 0] }, undefined)).toThrow(/width and a length/);
  });
});
