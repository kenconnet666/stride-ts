import { describe, expect, test } from 'vitest';
import type { SdfFile } from '../../src/content/formats/assetFormat';
import { Quaternion, Vector3 } from '../../src/data/vectors';
import { addSdfShape, applySdfChange, deleteSdfShape, scaleSdfShape, sdfShapeBox } from '../../src/editor/viewport/tools/sdfShapes';

const file: SdfFile = {
  name: 'Toy', materials: [],
  shapes: [
    { kind: 'box', operation: 'add', position: [0, 0.5, 0], size: [1, 1, 1], cornerRadius: 0.1 },
    { kind: 'cylinder', operation: 'subtract', position: [0, 1, 0], height: 0.4, radius: 0.2 },
  ],
};
const identity = [0, 0, 0, 1] as const;

describe('视口里编辑 SDF 的纯函数', () => {
  test('包围盒：圆柱是半径、半高；胶囊、两头是球的圆锥把两头的球算进去；六棱柱按中心到角', () => {
    expect(sdfShapeBox(file.shapes[1]!).half).toEqual([0.2, 0.2, 0.2]);
    expect(sdfShapeBox({ kind: 'capsule', operation: 'add', position: [0, 0, 0], height: 1, radius: 0.2 }).half).toEqual([0.2, 0.7, 0.2]);
    expect(sdfShapeBox({ kind: 'roundCone', operation: 'add', position: [0, 0, 0], height: 1, bottomRadius: 0.3, topRadius: 0.1 }).half).toEqual([0.3, 0.8, 0.3]);
    expect(sdfShapeBox({ kind: 'hexPrism', operation: 'add', position: [0, 0, 0], height: 1, radius: 1 }).half[0]).toBeCloseTo(1.1547);
  });

  test('缩放按形状自己的轴：方块按轴改边长（圆角不超过最短边的一半）；圆柱 Y 改高、横向改半径；球按变得最多的那个轴', () => {
    expect(scaleSdfShape(file.shapes[0]!, [2, 0.1, 1])).toMatchObject({ size: [2, 0.1, 1], cornerRadius: 0.05 });
    expect(scaleSdfShape(file.shapes[1]!, [1, 2, 1])).toMatchObject({ height: 0.8, radius: 0.2 });
    expect(scaleSdfShape(file.shapes[1]!, [1, 1, 1.5])).toMatchObject({ height: 0.4, radius: 0.3 });
    expect(scaleSdfShape({ kind: 'sphere', operation: 'add', position: [0, 0, 0], radius: 1 }, [1, 0.5, 1.2])).toMatchObject({ radius: 0.5 });
    // 两头是球的圆锥：半径差要小于高，高缩得太多时两个半径跟着收
    const cone = scaleSdfShape({ kind: 'roundCone', operation: 'add', position: [0, 0, 0], height: 1, bottomRadius: 0.4, topRadius: 0.1 }, [1, 0.2, 1]);
    expect(cone.kind === 'roundCone' && Math.abs(cone.bottomRadius - cone.topRadius) < cone.height).toBe(true);
  });

  test('操纵器的平移、旋转按实体的旋转和缩放换进模型本地', () => {
    // 实体绕 Y 转了 90°、放大一倍：世界里往 +X 挪 2 米，本地是往 +Z 挪 1 米
    const entity = new Quaternion().setYawPitchRoll(Math.PI / 2, 0, 0);
    const toLocal = entity.clone().invert();
    const moved = applySdfChange(file, 1, { type: 'translate', delta: new Vector3(2, 0, 0) }, [toLocal.x, toLocal.y, toLocal.z, toLocal.w], 2);
    expect(moved.shapes[1]!.position).toEqual([0, 1, 1]);
    expect(moved.shapes[0]).toBe(file.shapes[0]);
    // 世界里绕 Y 转 90°（实体自己也绕 Y）：本地也是绕 Y 转 90°
    const turned = applySdfChange(file, 0, { type: 'rotate', rotation: new Quaternion().setYawPitchRoll(Math.PI / 2, 0, 0) }, [toLocal.x, toLocal.y, toLocal.z, toLocal.w], 1);
    const r = turned.shapes[0]!.rotation!;
    expect(Math.abs(r[1])).toBeCloseTo(Math.SQRT1_2, 5);
    expect(applySdfChange(file, 1, { type: 'scale', factor: new Vector3(1, 2, 1) }, identity, 1).shapes[1]).toMatchObject({ height: 0.8 });
  });

  test('加一个形状放在选中的旁边、同一个材质槽；删到只剩一个时报错', () => {
    const { sdf, index } = addSdfShape(file, 'cone', 0);
    expect(index).toBe(2);
    expect(sdf.shapes[2]).toMatchObject({ kind: 'cone', operation: 'add', position: [0.8, 0.5, 0] });
    expect(addSdfShape(file, 'sphere').sdf.shapes[2]!.position).toEqual([0, 0, 0]);
    // 接连在同一个旁边加：不叠在一起
    expect(addSdfShape(sdf, 'sphere', 0).sdf.shapes[3]!.position[0]).toBeGreaterThan(0.8);
    expect(deleteSdfShape(file, 0).shapes).toHaveLength(1);
    expect(() => deleteSdfShape(deleteSdfShape(file, 0), 0)).toThrow(/at least one shape/);
  });
});
