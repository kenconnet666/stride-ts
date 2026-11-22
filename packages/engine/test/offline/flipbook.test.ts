import { describe, expect, test } from 'vitest';
import { composeFlipbook, flipbookComponent } from '../../src/offline/FlipbookBaker';

/** 一个像素在黑底、白底上画出来的样子（线性 RGBA）。 */
const pixel = (black: number[], white: number[]) => composeFlipbook(new Float32Array([...black, 1]), new Float32Array([...white, 1]));

describe('序列帧烘焙：黑底白底合成', () => {
  test('半透明的红色（普通混合）：透明度和颜色都还原', () => {
    // 预乘的红 0.5 覆盖一半：黑底上 (0.5, 0, 0)，白底上再加 (1 - 0.5)
    const { rgba, intensity } = pixel([0.5, 0, 0], [1, 0.5, 0.5]);
    expect(intensity).toBe(1);
    expect([...rgba]).toEqual([255, 0, 0, 128]);
  });

  test('加法混合的光（透明度是 0）：存成透明度等于亮度的白色，预乘回去还是那么亮', () => {
    const { rgba } = pixel([0.3, 0.3, 0.3], [1.3, 1.3, 1.3]);
    expect(rgba[3]).toBe(Math.round(0.3 * 255));
    expect([rgba[0], rgba[1], rgba[2]]).toEqual([255, 255, 255]);
  });

  test('超过 1 的亮度整张除掉，intensity 记下来', () => {
    const { rgba, intensity } = composeFlipbook(new Float32Array([4, 2, 0, 1, 1, 1, 1, 1]), new Float32Array([5, 3, 1, 1, 2, 2, 2, 1]));
    expect(intensity).toBe(4);
    // 第一个像素：B' = (1, 0.5, 0)，a = 1
    expect(rgba[3]).toBe(255);
    expect(rgba[0]).toBe(255);
    // 第二个像素：B' = 0.25 的灰，加法的，a = 0.25、颜色是白
    expect(rgba[7]).toBe(Math.round(0.25 * 255));
  });

  test('什么都没画的地方是全 0', () => {
    expect([...pixel([0, 0, 0], [1, 1, 1]).rgba]).toEqual([0, 0, 0, 0]);
  });

  test('放序列帧的组件：翻页的 UV、一个粒子、颜色乘回亮度', () => {
    const component = flipbookComponent({ columns: 4, rows: 2, frames: 8, seconds: 2, frameWorldSize: 3, center: [0, 1.5, 0], intensity: 2.5 }, 'Textures/Fx');
    expect(component['color']).toEqual([2.5, 2.5, 2.5, 1]);
    const emitter = (component['particleSystem'] as { emitters: Record<string, unknown>[] }).emitters[0]!;
    expect(emitter['particleLifetime']).toEqual([2, 2]);
    expect((emitter['material'] as Record<string, unknown>)['uvBuilder']).toMatchObject({ xDivisions: 4, yDivisions: 2, animationSpeed: 8 });
    expect((emitter['material'] as { computeColor: unknown }).computeColor).toMatchObject({ texture: { texture: 'Textures/Fx', encoding: 'png' } });
  });
});
