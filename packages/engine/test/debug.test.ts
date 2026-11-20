import { describe as group, expect, it } from 'vitest';
import { Debug, FrameTimings, describe } from '../src/debug/Debug';
import { DebugDraw, DEBUG_LINE_FLOATS } from '../src/debug/DebugDraw';
import { Collider } from '../src/physics/Collider';
import { drawCollider } from '../src/physics/debugShapes';
import { Mesh } from '../src/rendering/mesh/Mesh';
import { DebugText } from '../src/debug/DebugText';

group('describe', () => {
  it('实体只写 id 和名字，类型数组变数组，循环引用和太长的部分截断', () => {
    const entity = { id: 7, name: 'Player', manager: { huge: true } };
    const looped: Record<string, unknown> = { name: 'loop' };
    looped['self'] = looped;
    expect(describe({ entity, world: new Float32Array([1, 2]), looped, big: 10n, f: function named() {} })).toEqual({
      entity: { entity: 7, name: 'Player' },
      world: [1, 2],
      looped: { name: 'loop', self: '[circular]' },
      big: '10n',
      f: '[function named]',
    });
    const long = describe(Array.from({ length: 300 }, (_, i) => i)) as unknown[];
    expect(long).toHaveLength(257);
    expect(long.at(-1)).toBe('… 44 more');
    expect(describe(Number.NaN)).toBe('NaN');
  });
});

group('FrameTimings', () => {
  it('环形存放，last 从旧到新，total 不受容量限制', () => {
    const timings = new FrameTimings(3);
    for (let i = 1; i <= 5; i++) timings.record(i, i * 10, i * 100);
    expect(timings.last(10, timings.interval)).toEqual([3, 4, 5]);
    expect(timings.last(2, timings.draw)).toEqual([400, 500]);
    expect(timings.total).toBe(5);
  });
});

group('Debug', () => {
  it('命令和观察项可以登记、列出、注销；观察项出错时值是错误信息', () => {
    const debug = new Debug(() => undefined);
    using _ = debug.command('b', 'second', () => 1);
    const a = debug.command('a', 'first', () => 2);
    expect(debug.commands().map((c) => c.name)).toEqual(['a', 'b']);
    a[Symbol.dispose]();
    expect(debug.commands().map((c) => c.name)).toEqual(['b']);
    debug.watch('ok', () => ({ x: 1 }));
    debug.watch('broken', () => {
      throw new Error('boom');
    });
    expect(debug.watches()).toEqual({ ok: { x: 1 }, broken: 'error: boom' });
    debug.counter('agents', 3);
    expect(debug.counters()).toEqual({ agents: 3 });
  });
});

group('DebugText', () => {
  it('一帧里 print 的文字在下一帧开始时成为 lines，再下一帧清掉', () => {
    const text = new DebugText();
    text.print('a', [1, 2]);
    text.print('b');
    expect(text.lines).toEqual([]);
    text.beginFrame();
    expect(text.lines).toEqual([{ text: 'a', position: [1, 2] }, { text: 'b', position: [0, 0] }]);
    text.beginFrame();
    expect(text.lines).toEqual([]);
  });

  it('位置默认是 CSS 像素；设了 virtualResolution 时按高度缩放、水平居中换到画布上，fromCanvas 反过来', () => {
    const text = new DebugText(() => [1920, 900]);
    expect([text.scale, text.toCanvas([500, 320]), text.fromCanvas([500, 320])]).toEqual([1, [500, 320], [500, 320]]);
    text.virtualResolution = [1280, 720];
    expect(text.scale).toBe(1.25);
    // 画面中间还在中间；左边缘落在居中的 16:9 区域的左边缘
    expect([text.toCanvas([640, 360]), text.toCanvas([0, 720])]).toEqual([[960, 450], [160, 900]]);
    expect(text.fromCanvas(text.toCanvas([500, 320]))).toEqual([500, 320]);
  });
});

group('DebugDraw（调试用的线）', () => {
  const lines = (buffer: { data: Float32Array; count: number }) =>
    Array.from({ length: buffer.count }, (_, i) => [...buffer.data.subarray(i * DEBUG_LINE_FLOATS, (i + 1) * DEBUG_LINE_FLOATS)].map((v) => Math.round(v * 1000) / 1000));

  it('一条线 12 个数：起点、线宽，终点，线性的颜色；点可以是 {x, y, z} 或数组；depthTest: false 的另放一组', () => {
    const draw = new DebugDraw();
    draw.line({ x: 1, y: 2, z: 3 }, [4, 5, 6], [1, 0.5, 0, 0.8], { width: 2 });
    draw.line([0, 0, 0], [1, 0, 0], undefined, { depthTest: false });
    // sRGB 0.5 是线性的 0.214
    expect(lines(draw.tested)).toEqual([[1, 2, 3, 2, 4, 5, 6, 0, 1, 0.214, 0, 0.8]]);
    expect(lines(draw.overlay)).toEqual([[0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 1, 1]]);
    expect(draw.count).toBe(2);
  });

  it('没给 duration 的只留到下一次 update 开始；给了的留那么多秒；线变了 version 才变', () => {
    const draw = new DebugDraw();
    draw.beginFrame(10);
    draw.line([0, 0, 0], [1, 0, 0]);
    draw.line([0, 0, 0], [0, 1, 0], undefined, { duration: 0.5 });
    draw.line([0, 0, 0], [0, 0, 1], undefined, { duration: 2, depthTest: false });
    expect(draw.count).toBe(3);
    const version = draw.version;
    draw.beginFrame(10.1);
    expect([draw.tested.count, draw.overlay.count]).toEqual([1, 1]);
    // 留下的那条挪到了前面
    expect(lines(draw.tested)[0]!.slice(4, 7)).toEqual([0, 1, 0]);
    expect(draw.version).toBeGreaterThan(version);
    const kept = draw.version;
    draw.beginFrame(10.2);
    expect(draw.version).toBe(kept);
    draw.beginFrame(10.6);
    expect([draw.tested.count, draw.overlay.count]).toEqual([0, 1]);
    draw.clear();
    expect(draw.count).toBe(0);
  });

  it('形状拆成线：盒子 12 条棱，球三个大圆，网格每个方向 2n + 1 条，箭头 5 条，坐标轴 3 条；多了缓冲自己长大', () => {
    const draw = new DebugDraw();
    // 平移 (10, 0, 0)、绕 Y 转 90 度（X 轴转到 -Z）的矩阵
    const world = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 10, 0, 0, 1];
    draw.box(world, [1, 2, 3]);
    expect(draw.count).toBe(12);
    const corners = new Set(lines(draw.tested).flatMap((line) => [line.slice(0, 3).join(), line.slice(4, 7).join()]));
    expect(corners.size).toBe(8);
    // 本地 (1, 2, 3) 的角：X 的 1 到了 -Z，Z 的 3 到了 +X
    expect(corners.has('13,2,-1')).toBe(true);
    draw.clear();
    draw.bounds([0, 0, 0], [1, 1, 1]);
    expect(draw.count).toBe(12);
    draw.clear();
    draw.sphere([0, 0, 0], 2, undefined, { segments: 16 });
    expect(draw.count).toBe(48);
    // 每条线的两头都在球面上
    for (const line of lines(draw.tested)) expect(Math.hypot(line[0]!, line[1]!, line[2]!)).toBeCloseTo(2, 2);
    draw.clear();
    draw.grid([0, 0, 0], 1, 10);
    expect(draw.count).toBe(42);
    draw.clear();
    draw.arrow([0, 0, 0], [0, 5, 0]);
    draw.axes(world, 2);
    expect(draw.count).toBe(8);
    // 坐标轴的 X 沿 world 的第一列（-Z），长 2
    expect(lines(draw.tested)[5]!.slice(4, 7)).toEqual([10, 0, -2]);
    draw.clear();
    draw.capsule([0, 0, 0], [0, 2, 0], 0.5, undefined, { segments: 8 });
    draw.cylinder([0, 0, 0], [0, 2, 0], 0.5, undefined, { segments: 8, topRadius: 0 });
    draw.circle([0, 0, 0], [0, 1, 0], 1, undefined, { segments: 8 });
    draw.polyline([[0, 0, 0], [1, 0, 0], [1, 1, 0]], undefined, { closed: true });
    // 胶囊：4 条母线、4 个半圆（各 4 段）、2 个圆（各 8 段）；圆锥：底面 8 段加 4 条母线；圆 8 段；闭合的折线 3 段
    expect(draw.count).toBe(4 + 16 + 16 + 12 + 8 + 3);
    draw.clear();
    // 视锥：单位矩阵的逆还是单位矩阵，八个角是裁剪空间的盒子（深度 0 到 1）
    draw.frustum([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect(draw.count).toBe(12);
    expect(new Set(lines(draw.tested).map((line) => line[2])).size).toBe(2);
    for (let i = 0; i < 1000; i++) draw.line([i, 0, 0], [i, 1, 0]);
    expect(draw.count).toBe(1012);
    expect(lines(draw.tested)[1011]!.slice(0, 3)).toEqual([999, 0, 0]);
  });
});

group('碰撞体的线框（drawCollider）', () => {
  const ends = (draw: DebugDraw) => {
    const out: number[][] = [];
    for (let i = 0; i < draw.tested.count; i++) for (const o of [0, 4]) out.push([...draw.tested.data.subarray(i * DEBUG_LINE_FLOATS + o, i * DEBUG_LINE_FLOATS + o + 3)].map((v) => Math.round(v * 100) / 100));
    return out;
  };
  const range = (points: number[][], axis: number): [number, number] => [Math.min(...points.map((p) => p[axis]!)), Math.max(...points.map((p) => p[axis]!))];

  it('基本形状按实体的位置和朝向画、不跟实体的缩放；形状自己的位置算进去', () => {
    const draw = new DebugDraw();
    // 实体在 (10, 0, 0)，缩放 (2, 3, 4)
    const world = [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 10, 0, 0, 1];
    drawCollider(draw, new Collider([{ type: 'box', size: [2, 4, 6], position: [0, 5, 0] }]), world, [1, 1, 1, 1]);
    expect(draw.count).toBe(12);
    const box = ends(draw);
    expect([range(box, 0), range(box, 1), range(box, 2)]).toEqual([[9, 11], [3, 7], [-3, 3]]);
    draw.clear();
    // 胶囊沿本地 Y：两个球心相距 length，加上两头的半径
    drawCollider(draw, new Collider([{ type: 'capsule', radius: 0.5, length: 2 }]), world, [1, 1, 1, 1]);
    const capsule = ends(draw);
    expect([range(capsule, 0), range(capsule, 1)]).toEqual([[9.5, 10.5], [-1.5, 1.5]]);
    draw.clear();
    drawCollider(draw, new Collider([{ type: 'sphere', radius: 2 }, { type: 'empty' }]), world, [1, 1, 1, 1]);
    expect(range(ends(draw), 1)).toEqual([-2, 2]);
  });

  it('网格形状画三角形的边（共用的边只画一条），按实体的缩放', () => {
    const draw = new DebugDraw();
    const cube = Mesh.cube();
    const world = [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    drawCollider(draw, new Collider([{ type: 'mesh', meshes: [cube] }]), world, [1, 1, 1, 1]);
    // 立方体每个面两个三角形：4 条边加 1 条对角线（各面的顶点不共用），6 个面
    expect(draw.count).toBe(30);
    const points = ends(draw);
    const [x0, x1] = range(points, 0), [y0, y1] = range(points, 1);
    expect(x1 - x0).toBeCloseTo((y1 - y0) * 2, 5);
  });
});
