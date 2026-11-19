import { describe as group, expect, it } from 'vitest';
import { Debug, FrameTimings, describe } from '../src/debug/Debug';
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
