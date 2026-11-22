import { describe, expect, test } from 'vitest';
import { withLastValue } from '../../src/debug/commands';
import { unscaledShape } from '../../src/physics/Collider';

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => () => Promise<unknown>;
const run = (code: string) => new AsyncFunction(withLastValue(code, (body) => new AsyncFunction(body)))();

describe('stride eval 的多条语句', () => {
  test('最后一条是表达式时返回它的值；跨行的表达式取整条', async () => {
    expect(await run('const a = 2;\nawait null;\na * 3')).toBe(6);
    expect(await run('const a = 2\nawait null\nconst b = { x: a,\n y: 1 }\nb.x\n+ b.y')).toBe(3);
    expect(await run('await null; ({ ok: true });')).toEqual({ ok: true });
    // 字符串、注释里的分号和换行不算边界
    expect(await run("await null\nconst s = 'a;b\\nc' // x; y\ns.length")).toBe(5);
  });

  test('最后一条不是表达式（声明、if）时原样当函数体跑，返回 undefined', async () => {
    expect(await run('await null; const a = 1;')).toBeUndefined();
    expect(await run('await null\nif (true) { 1 }')).toBeUndefined();
  });
});

describe('碰撞体的绝对尺寸换算', () => {
  test('按世界缩放除回去：方块各轴、球和胶囊按平均、圆柱横向按 x、z 竖向按 y，本地位置各轴', () => {
    const scale = [2, 4, 2] as const;
    expect(unscaledShape({ type: 'box', size: [2, 2, 2], position: [2, 4, 0] }, scale)).toMatchObject({ size: [1, 0.5, 1], position: [1, 1, 0] });
    expect(unscaledShape({ type: 'sphere', radius: 1 }, scale)).toMatchObject({ radius: 1 / (8 / 3) });
    expect(unscaledShape({ type: 'capsule', radius: 1, length: 4 }, [2, 2, 2])).toMatchObject({ radius: 0.5, length: 2 });
    expect(unscaledShape({ type: 'cylinder', radius: 1, length: 4 }, scale)).toMatchObject({ radius: 0.5, length: 1 });
  });
});
