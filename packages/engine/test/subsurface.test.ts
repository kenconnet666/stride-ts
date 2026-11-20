import { describe, expect, test, vi } from 'vitest';
import { Material, SKIN_SUBSURFACE_SCATTERING } from '../src/rendering/Material';
import { KERNEL_LENGTH, MAX_SUBSURFACE_MATERIALS, scatteringKernel, SubsurfaceMaterials } from '../src/rendering/SubsurfaceScattering';

describe('次表面散射', () => {
  test('散射核：第 0 个是中心，各通道的权重加起来是 1，偏移左右对称，红光散得最远', () => {
    const { strength, falloff } = SKIN_SUBSURFACE_SCATTERING;
    const kernel = scatteringKernel(KERNEL_LENGTH, strength, falloff);
    expect(kernel.length).toBe(KERNEL_LENGTH * 4);
    expect(kernel[3]).toBeCloseTo(0, 6);
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let i = 0; i < KERNEL_LENGTH; i++) sum += kernel[i * 4 + c]!;
      expect(sum).toBeCloseTo(1, 5);
      // 留在中心的至少是没散出去的那部分（1 - strength）
      expect(kernel[c]!).toBeGreaterThanOrEqual(1 - strength[c]! - 1e-6);
    }
    const offsets = Array.from({ length: KERNEL_LENGTH - 1 }, (_, i) => kernel[(i + 1) * 4 + 3]!).sort((a, b) => a - b);
    for (let i = 0; i < offsets.length; i++) expect(offsets[i]!).toBeCloseTo(-offsets[offsets.length - 1 - i]!, 6);
    // 最外面的采样上红光的权重比蓝光大（皮肤的 falloff 红光最大）
    const outer = Array.from({ length: KERNEL_LENGTH }, (_, i) => i).sort((a, b) => Math.abs(kernel[b * 4 + 3]!) - Math.abs(kernel[a * 4 + 3]!))[0]!;
    expect(kernel[outer * 4]! / strength[0]).toBeGreaterThan(kernel[outer * 4 + 2]! / strength[2]);
  });

  test('槽位：每种散射材质一个，材质改了重新生成核，去掉散射就让出槽位，满了的不散射', () => {
    const materials = new SubsurfaceMaterials();
    const skin = new Material('skin', { subsurfaceScattering: {} });
    const plain = new Material('plain');
    expect(materials.slotOf(plain)).toBe(0);
    const slot = materials.slotOf(skin);
    expect(slot).toBe(1);
    expect(materials.widths[slot]).toBeCloseTo(SKIN_SUBSURFACE_SCATTERING.width);
    materials.dirty = false;
    expect(materials.slotOf(skin)).toBe(1);
    expect(materials.dirty).toBe(false);

    skin.setSubsurfaceScattering({ width: 0.05 });
    expect(materials.slotOf(skin)).toBe(1);
    expect(materials.dirty).toBe(true);
    expect(materials.widths[1]).toBeCloseTo(0.05);

    skin.setSubsurfaceScattering(undefined);
    expect(materials.slotOf(skin)).toBe(0);
    expect(materials.count).toBe(0);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const many = Array.from({ length: MAX_SUBSURFACE_MATERIALS + 1 }, (_, i) => new Material(`skin ${i}`, { subsurfaceScattering: {} }));
    const slots = many.map((material) => materials.slotOf(material));
    expect(new Set(slots.slice(0, MAX_SUBSURFACE_MATERIALS)).size).toBe(MAX_SUBSURFACE_MATERIALS);
    expect(slots.at(-1)).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
