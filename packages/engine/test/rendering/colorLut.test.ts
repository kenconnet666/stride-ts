import { describe, expect, test } from 'vitest';
import { parseCubeLut } from '../../src/rendering/postfx/ColorLut';
import { assetReferences } from '../../src/content/references';

/** 边长 n 的恒等表的 .cube 文本（红最快）。 */
function identityCube(n: number, header = ''): string {
  const rows: string[] = [];
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) rows.push(`${r / (n - 1)} ${g / (n - 1)} ${b / (n - 1)}`);
  return `${header}LUT_3D_SIZE ${n}\n${rows.join('\n')}\n`;
}

describe('调色的查找表（.cube）', () => {
  test('解析：注释、TITLE、定义域，红变得最快', () => {
    const lut = parseCubeLut(identityCube(3, '# Resolve 导出\nTITLE "Identity"\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n'), 'Grading/Identity');
    expect(lut.size).toBe(3);
    expect(lut.domainMax).toEqual([1, 1, 1]);
    // 第 1 个是 (0.5, 0, 0)，第 3 个是 (0, 0.5, 0)，第 9 个是 (0, 0, 0.5)
    expect([...lut.rgba.slice(4, 8)]).toEqual([0.5, 0, 0, 1]);
    expect([...lut.rgba.slice(12, 16)]).toEqual([0, 0.5, 0, 1]);
    expect([...lut.rgba.slice(36, 40)]).toEqual([0, 0, 0.5, 1]);
  });

  test('个数不对、一维表、数据在大小之前都报错，带行号', () => {
    expect(() => parseCubeLut('LUT_3D_SIZE 2\n0 0 0\n', 'a')).toThrow(/expected 2³ = 8 table entries, got 1/);
    expect(() => parseCubeLut('LUT_1D_SIZE 16\n', 'a')).toThrow(/1D LUTs are not supported/);
    expect(() => parseCubeLut('0 0 0\n', 'a')).toThrow(/a:1: table data before LUT_3D_SIZE/);
    expect(() => parseCubeLut('LUT_3D_SIZE 2\n0 0 x\n', 'a')).toThrow(/a:2: expected three numbers/);
  });

  test('场景的调色引用的查找表算场景的引用（移动、改名时改写）', () => {
    const scene = { name: 'S', entities: [], compositor: { postEffects: { colorGrading: { lut: 'Grading/Film' } } } };
    expect(assetReferences('scene', 'S', scene)).toEqual([{ kind: 'lut', path: 'Grading/Film' }]);
  });
});
