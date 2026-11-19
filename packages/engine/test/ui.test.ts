import { describe, expect, test } from 'vitest';
import type { UIFile } from '../src/content/format';
import {
  buildElement, Button, Canvas, ContentDecorator, Grid, ImageElement, imageSize, ModalElement, ScrollViewer, SpriteFromSheet, SpriteSheet, StackPanel,
  StripDefinition, TextBlock, UIElement, UILibrary, UniformGrid, type SpriteFrame, type Texture,
} from '../src/index';

/** 测试用的元素（Stride 测试里的 MeasureValidator、ArrangeValidator）：量出固定的大小，记下给它的空间。 */
class Probe extends UIElement {
  measured: [number, number];
  measureAvailable: [number, number] = [NaN, NaN];
  arrangeSize: [number, number] = [NaN, NaN];

  constructor(width = 0, height = 0) {
    super();
    this.measured = [width, height];
  }

  protected override measureOverride(available: [number, number]): [number, number] {
    this.measureAvailable = [available[0], available[1]];
    return [...this.measured];
  }

  protected override arrangeOverride(size: [number, number]): [number, number] {
    this.arrangeSize = [size[0], size[1]];
    return size;
  }
}

/** 一列一列的网格：每个子元素 [列, 跨几列, 量出来的宽] 放在第 row 行（第几个元素就是第几行时传 index）。 */
function columnGrid(definitions: readonly StripDefinition[], rows: number, children: readonly { column?: number; span?: number; row?: number; width: number }[]): { grid: Grid; probes: Probe[] } {
  const grid = new Grid();
  for (const definition of definitions) grid.columnDefinitions.add(definition);
  for (let i = 0; i < rows; i++) grid.rowDefinitions.add(new StripDefinition('auto'));
  const probes = children.map(({ column = 0, span = 1, row = 0, width }) => {
    const probe = new Probe(width, 0);
    probe.gridColumn = column;
    probe.gridColumnSpan = span;
    probe.gridRow = row;
    grid.children.add(probe);
    return probe;
  });
  return { grid, probes };
}

const star = (value = 1, min?: number, max?: number) => {
  const strip = new StripDefinition('star', value);
  if (min !== undefined) strip.minimumSize = min;
  if (max !== undefined) strip.maximumSize = max;
  return strip;
};

describe('UI 元素的布局（照 Stride 的 UIElement）', () => {
  test('想要的大小：内容的大小加外边距，夹在最小、最大值之间；设了宽高时用宽高', () => {
    const probe = new Probe(30, 40);
    probe.margin = [1, 2, 3, 4];
    probe.minimumWidth = 50;
    probe.maximumHeight = 35;
    probe.measure([1000, 1000]);
    expect(probe.desiredSize).toEqual([50, 35]);
    expect(probe.desiredSizeWithMargins).toEqual([54, 41]);
    // 内容拿到的空间：可用空间减外边距，夹在最小、最大值之间
    expect(probe.measureAvailable).toEqual([996, 35]);

    probe.width = 20;
    probe.measure([1000, 1000]);
    expect(probe.desiredSize).toEqual([50, 35]);
    expect(probe.measureAvailable[0]).toBe(50);
  });

  test('排列：拉伸时占满给的空间，否则用想要的大小，按对齐放；折叠的元素大小都是 0', () => {
    const probe = new Probe(30, 40);
    probe.margin = [10, 0, 0, 20];
    probe.measure([200, 100]);
    probe.arrange([200, 100], false);
    expect(probe.renderSize).toEqual([190, 80]);
    expect(probe.renderOffsets).toEqual([10, 0]);

    probe.horizontalAlignment = 'right';
    probe.verticalAlignment = 'center';
    probe.arrange([200, 100], false);
    expect(probe.renderSize).toEqual([30, 40]);
    expect(probe.renderOffsets).toEqual([170, 20]);

    probe.horizontalAlignment = 'center';
    probe.verticalAlignment = 'bottom';
    probe.arrange([200, 100], false);
    expect(probe.renderOffsets).toEqual([10 + 80, 40]);

    probe.visibility = 'collapsed';
    probe.measure([200, 100]);
    probe.arrange([200, 100], false);
    expect(probe.desiredSizeWithMargins).toEqual([0, 0]);
    expect(probe.renderSize).toEqual([0, 0]);
  });

  test('布局有缓存：给的空间一样时不重新量，改了属性才重新量（向上传给父元素）', () => {
    const parent = new UniformGrid();
    const probe = new Probe(10, 10);
    parent.children.add(probe);
    parent.measure([100, 100]);
    probe.measured = [20, 20];
    parent.measure([100, 100]);
    expect(parent.desiredSize).toEqual([10, 10]);
    probe.invalidateMeasure();
    expect(parent.isMeasureValid).toBe(false);
    parent.measure([100, 100]);
    expect(parent.desiredSize).toEqual([20, 20]);
  });

  test('世界矩阵：原点在元素中心，按父元素给的位置和局部矩阵', () => {
    const grid = new UniformGrid();
    grid.columns = 2;
    const left = new Probe(), right = new Probe();
    right.gridColumn = 1;
    right.margin = [5, 0, 0, 0];
    grid.children.add(left);
    grid.children.add(right);
    grid.measure([200, 100]);
    grid.arrange([200, 100], false);
    grid.updateWorldMatrix([1, 0, 0, 1, 0, 0]);
    expect(left.worldMatrix).toEqual([1, 0, 0, 1, 50, 50]);
    expect(right.worldMatrix).toEqual([1, 0, 0, 1, 152.5, 50]);
  });

  test('画的先后：按树的顺序，每个元素占 drawLayerNumber 层；面板的子元素按 ZIndex 排', () => {
    const grid = new UniformGrid();
    const a = new ContentDecorator(), b = new Button(), c = new Probe();
    a.content = c;
    b.panelZIndex = -1;
    grid.children.add(a);
    grid.children.add(b);
    expect(grid.visualChildren).toEqual([b, a]);
    grid.updateElementState(0);
    expect([grid.depthBias, b.depthBias, a.depthBias, c.depthBias]).toEqual([0, 1, 3, 5]);
    expect(grid.maxChildrenDepthBias).toBe(6);
    a.panelZIndex = -2;
    expect(grid.visualChildren).toEqual([a, b]);
  });

  test('按名字和类型找后代', () => {
    const grid = new UniformGrid();
    const text = new TextBlock();
    text.name = 'label';
    const decorator = new ContentDecorator();
    decorator.content = text;
    grid.children.add(decorator);
    expect(grid.findName('label')).toBe(text);
    expect(grid.find(TextBlock, 'label')).toBe(text);
    expect(grid.find(Button, 'label')).toBeNull();
    expect(grid.find(ContentDecorator)).toBe(decorator);
  });
});

describe('Grid（照 Stride 的 GridTests）', () => {
  test('只有星号：按份数分', () => {
    const { grid } = columnGrid([star(10), star(20), star(30)], 1, [{ width: 10 }, { column: 1, width: 15 }, { column: 2, width: 20 }]);
    grid.measure([50, 50]);
    expect(grid.desiredSizeWithMargins[0]).toBe(60);
    grid.arrange([120, 120], false);
    expect([...grid.columnDefinitions].map((s) => s.actualSize)).toEqual([20, 40, 60]);
  });

  test('星号的最小、最大值', () => {
    let { grid } = columnGrid([star(10, 20)], 1, [{ width: 10 }]);
    grid.measure([50, 50]);
    expect(grid.desiredSizeWithMargins[0]).toBe(20);
    grid.arrange([15, 15], false);
    expect(grid.columnDefinitions.at(0)!.actualSize).toBe(20);

    ({ grid } = columnGrid([star(10, undefined, 20)], 1, [{ width: 30 }]));
    grid.measure([50, 50]);
    expect(grid.desiredSizeWithMargins[0]).toBe(20);
    grid.arrange([40, 40], false);
    expect(grid.columnDefinitions.at(0)!.actualSize).toBe(20);
  });

  test('跨四列的元素撑开有最小、最大值的星号列', () => {
    let { grid } = columnGrid([star(1, 10, 20), star(1, 25, 35), star(1, 30, 40), star(1, 45, 60)], 1, [{ span: 4, width: 145 }]);
    grid.measure([50, 50]);
    expect(grid.desiredSizeWithMargins[0]).toBe(145);
    grid.arrange([145, 145], false);
    expect([...grid.columnDefinitions].map((s) => s.actualSize)).toEqual([20, 35, 40, 50]);

    ({ grid } = columnGrid([star(1, 10, 70), star(1, 20, 35), star(1, 30, 55), star(1, 40, 45)], 1, [{ span: 4, width: 195 }]));
    grid.measure([50, 50]);
    expect(grid.desiredSizeWithMargins[0]).toBe(195);
    grid.arrange([195, 195], false);
    expect([...grid.columnDefinitions].map((s) => s.actualSize)).toEqual([60, 35, 55, 45]);
  });

  test('固定、auto、星号混在一起', () => {
    const { grid, probes } = columnGrid([new StripDefinition('fixed', 30), new StripDefinition('auto'), star()], 2, [
      { width: 20 }, { column: 1, width: 30 }, { column: 1, row: 1, span: 2, width: 70 },
    ]);
    grid.measure([50, 50]);
    expect(grid.desiredSizeWithMargins[0]).toBe(100);
    grid.arrange([110, 110], false);
    expect([...grid.columnDefinitions].map((s) => s.actualSize)).toEqual([30, 30, 50]);
    expect(probes.map((p) => p.arrangeSize[0])).toEqual([30, 30, 80]);
  });

  test('auto：取放得下各元素的最小值，跨几列的元素缺的放到最后一列', () => {
    let { grid } = columnGrid([new StripDefinition('auto'), new StripDefinition('auto'), new StripDefinition('auto')], 2, [
      { width: 10 }, { column: 1, width: 20 }, { column: 1, row: 1, width: 30 }, { column: 2, row: 1, width: 40 },
    ]);
    grid.measure([30, 30]);
    expect(grid.desiredSizeWithMargins[0]).toBe(80);
    grid.arrange([30, 30], false);
    expect([...grid.columnDefinitions].map((s) => s.actualSize)).toEqual([10, 30, 40]);

    ({ grid } = columnGrid([new StripDefinition('auto'), new StripDefinition('auto'), new StripDefinition('auto')], 4, [
      { width: 10 }, { column: 1, width: 20 }, { row: 1, span: 2, width: 40 }, { column: 2, row: 1, width: 10 },
      { column: 1, row: 2, span: 2, width: 30 }, { row: 3, span: 3, width: 70 },
    ]));
    grid.measure([30, 30]);
    expect(grid.desiredSizeWithMargins[0]).toBe(70);
    grid.arrange([50, 50], false);
    expect([...grid.columnDefinitions].map((s) => s.actualSize)).toEqual([10, 30, 30]);
  });

  test('没写行列定义时整个网格是一格；子元素的位置是行列的起点（相对网格中心）', () => {
    const grid = new Grid();
    grid.rowDefinitions.add(new StripDefinition('fixed', 15));
    grid.rowDefinitions.add(star());
    const a = new Probe(5, 5), b = new Probe(5, 5);
    b.gridRow = 1;
    grid.children.add(a);
    grid.children.add(b);
    grid.measure([100, 100]);
    grid.arrange([100, 100], false);
    expect(grid.actualColumnDefinitions).toHaveLength(1);
    expect(a.arrangeMatrix).toEqual([1, 0, 0, 1, -50, -50]);
    expect(b.arrangeMatrix).toEqual([1, 0, 0, 1, -50, -35]);
    expect(b.arrangeSize).toEqual([100, 85]);
  });
});

describe('其他面板', () => {
  test('UniformGrid：每格一样大，跨格的元素加上中间的空隙', () => {
    const grid = new UniformGrid();
    grid.rows = 2;
    grid.columns = 3;
    grid.columnGap = 10;
    const a = new Probe(20, 10), b = new Probe(50, 10);
    b.gridColumn = 1;
    b.gridColumnSpan = 2;
    b.gridRow = 1;
    grid.children.add(a);
    grid.children.add(b);
    grid.measure([400, 400]);
    // 一格要 max(20, (50)/2) = 25 宽、10 高；三列加两个空隙
    expect(grid.desiredSize).toEqual([95, 20]);
    grid.arrange([320, 200], false);
    expect(b.arrangeSize).toEqual([210, 100]);
    expect(b.arrangeMatrix).toEqual([1, 0, 0, 1, 110 - 160, 100 - 100]);
  });

  test('StackPanel：按方向堆叠，另一方向取最大；子元素之间加空隙', () => {
    const stack = new StackPanel();
    stack.gap = 5;
    const a = new Probe(30, 10), b = new Probe(50, 20);
    b.margin = [0, 2, 0, 3];
    stack.children.add(a);
    stack.children.add(b);
    stack.measure([100, 100]);
    expect(stack.desiredSize).toEqual([50, 40]);
    expect(a.measureAvailable).toEqual([100, Infinity]);
    stack.arrange([100, 100], false);
    expect(b.arrangeMatrix).toEqual([1, 0, 0, 1, -50, 15 - 50]);
    expect(stack.extent).toEqual([100, 40]);
  });

  test('StackPanel 的滚动：以子元素为单位，排列失效时先记下请求（照 Stride 的 TestOffset、TestScrollOf）', () => {
    const stack = new StackPanel();
    stack.orientation = 'horizontal';
    stack.width = 100;
    stack.height = 200;
    const sizes = [50, 150, 250, 350];
    for (const width of sizes) {
      const child = new StackPanel();
      child.width = width;
      child.height = 100;
      stack.children.add(child);
    }
    stack.scrollToElement(1);
    stack.arrange([0, 0], false);
    expect(stack.offset[0]).toBe(-50);
    stack.scrollToElement(2.5);
    stack.arrange([0, 0], false);
    expect(stack.offset[0]).toBe(-50 - 150 - 125);
    stack.scrollToEnd(0);
    stack.arrange([0, 0], false);
    expect(stack.offset[0]).toBeCloseTo(-800 + 100, 3);

    stack.scrollToElement(0);
    stack.arrange([0, 0], false);
    stack.scrollOf([50, 0]);
    expect(stack.scrollPosition).toBeCloseTo(1);
    stack.scrollOf([50, 0]);
    expect(stack.scrollPosition).toBeCloseTo(1 + 1 / 3);
    stack.invalidateArrange();
    stack.scrollOf([50, 0]);
    expect(stack.scrollPosition).toBeCloseTo(1 + 1 / 3);
    stack.arrange([0, 0], false);
    expect(stack.scrollPosition).toBeCloseTo(1 + 2 / 3);
  });

  test('Canvas：子元素按比例的大小量，钉在相对位置（照 Stride 的 TestArrangeOverrideRelative）', () => {
    const canvas = new Canvas();
    const child = new Probe(4, 12);
    child.canvasUseAbsolutePosition = false;
    child.canvasRelativeSize = [0.2, 0.3];
    child.canvasPinOrigin = [0, 0.5];
    child.canvasRelativePosition = [0.2, 0.4];
    canvas.children.add(child);
    canvas.measure([10, 20]);
    expect(canvas.desiredSize).toEqual([0, 0]);
    expect(child.measureAvailable).toEqual([2, 6]);
    canvas.arrange([10, 20], false);
    expect(child.arrangeMatrix).toEqual([1, 0, 0, 1, 2 - 5, 8 - 6 - 10]);
  });

  test('Canvas：绝对位置的某一维是 NaN 时用相对位置', () => {
    const canvas = new Canvas();
    const child = new Probe(10, 10);
    child.canvasAbsolutePosition = [128, NaN];
    child.canvasRelativePosition = [NaN, 0.5];
    canvas.children.add(child);
    canvas.measure([200, 100]);
    canvas.arrange([200, 100], false);
    expect(child.arrangeMatrix).toEqual([1, 0, 0, 1, 128 - 100, 50 - 50]);
  });
});

/** 一张 100x50 的精灵（可以带九宫格的边框）。 */
function sprite(width = 100, height = 50, borders?: readonly [number, number, number, number]): SpriteFrame {
  return { name: 's', texture: {} as Texture, region: [0, 0, width, height], pixelsPerUnit: 100, center: [0, 0], centerFromMiddle: true, ...(borders ? { borders } : {}) };
}

describe('控件', () => {
  test('图片的大小按拉伸方式（ImageSizeHelper）', () => {
    const s = sprite();
    expect(imageSize(s, [Infinity, Infinity], 'uniform', 'both', true)).toEqual([100, 50]);
    expect(imageSize(s, [50, 50], 'uniform', 'both', true)).toEqual([50, 25]);
    expect(imageSize(s, [50, 50], 'uniformToFill', 'both', true)).toEqual([100, 50]);
    expect(imageSize(s, [300, Infinity], 'uniform', 'both', true)).toEqual([300, 150]);
    expect(imageSize(s, [300, 300], 'uniform', 'downOnly', true)).toEqual([100, 50]);
    expect(imageSize(s, [50, 10], 'fill', 'both', false)).toEqual([50, 10]);
    expect(imageSize(s, [50, 10], 'fillOnStretch', 'both', true)).toEqual([20, 10]);
    expect(imageSize(s, [50, 10], 'none', 'both', true)).toEqual([100, 50]);
    // 量的时候不小于九宫格的边框
    expect(imageSize(sprite(100, 50, [30, 10, 40, 5]), [50, 10], 'uniform', 'both', true)).toEqual([70, 15]);
  });

  test('ImageElement 换了精灵表的帧就重新量', () => {
    const sheet = new SpriteSheet('sheet', [sprite(100, 50), sprite(20, 20)]);
    const image = new ImageElement();
    const source = new SpriteFromSheet(sheet, 0);
    image.source = source;
    image.measure([Infinity, Infinity]);
    expect(image.desiredSize).toEqual([100, 50]);
    source.currentFrame = 1;
    image.update(0.016);
    image.measure([Infinity, Infinity]);
    expect(image.desiredSize).toEqual([20, 20]);
  });

  test('ContentDecorator、Button：内容加内边距；Button 默认内边距 (10, 5, 10, 7)，多画一层', () => {
    const button = new Button();
    button.content = new Probe(30, 20);
    button.measure([200, 200]);
    expect(button.desiredSize).toEqual([50, 32]);
    expect(button.drawLayerNumber).toBe(2);
    expect(button.canBeHitByUser).toBe(true);
    button.arrange([200, 200], false);
    expect(button.content!.arrangeMatrix).toEqual([1, 0, 0, 1, 10 - 100, 5 - 100]);
  });

  test('ModalElement 默认居中，盖上 60% 的黑', () => {
    const modal = new ModalElement();
    expect([modal.horizontalAlignment, modal.verticalAlignment, modal.overlayColor, modal.drawLayerNumber]).toEqual(['center', 'center', [0, 0, 0, 0.6], 2]);
  });

  test('ScrollViewer：滚动方向上内容的空间不限，偏移限制在内容范围里；内容是 StackPanel 时由它滚', () => {
    const viewer = new ScrollViewer();
    viewer.scrollMode = 'vertical';
    const probe = new Probe(50, 300);
    viewer.content = probe;
    viewer.measure([100, 100]);
    expect(probe.measureAvailable).toEqual([100, Infinity]);
    viewer.arrange([100, 100], false);
    expect(probe.arrangeSize).toEqual([100, 300]);
    viewer.scrollOf([0, 500]);
    expect(viewer.scrollPosition).toEqual([0, 200]);
    expect(probe.arrangeMatrix).toEqual([1, 0, 0, 1, -50, -200 - 50]);

    const stack = new StackPanel();
    for (let i = 0; i < 4; i++) stack.children.add(new Probe(50, 50));
    viewer.content = stack;
    expect(stack.scrollOwner).toBe(viewer);
    viewer.measure([100, 100]);
    viewer.arrange([100, 100], false);
    viewer.scrollOf([0, 75]);
    expect(stack.scrollPosition).toBeCloseTo(1.5);
    expect(viewer.scrollPosition).toEqual([0, 0]);
    expect(stack.arrangeMatrix).toEqual([1, 0, 0, 1, -50, -75 - 50]);
  });
});

describe('按 UIFile 建元素', () => {
  const file: UIFile = {
    name: 'Menu',
    designResolution: [640, 1136],
    root: 0,
    templates: { Popup: 3 },
    elements: [
      { type: 'Grid', props: { name: 'layout', rowDefinitions: [{ type: 'fixed', sizeValue: 10 }, {}], columnDefinitions: [{}] }, children: [1, 2] },
      { type: 'ContentDecorator', props: { name: 'status', padding: [1, 2, 3, 4], backgroundImage: { sheet: 'Sheet', frame: 1 } }, attached: { gridRow: 1, panelZIndex: 2 }, content: 4 },
      { type: 'Canvas', props: { visibility: 'collapsed' }, attached: { canvasRelativeSize: [null, 0.4] }, children: [] },
      { type: 'ModalElement', props: { name: 'Popup', overlayColor: [0, 0, 0, 0.5] } },
      { type: 'ImageElement', props: { stretchDirection: 'downOnly', source: { sheet: 'Sheet', frame: 0 } } },
    ],
  };
  const sheet = new SpriteSheet('Sheet', [sprite(), sprite(10, 10)]);
  const resources = { spriteSheets: new Map([['Sheet', sheet]]), fonts: new Map(), textures: new Map() };

  test('类型、属性、附加属性、子元素和内容；行列定义；NaN 写成 null', () => {
    const root = buildElement(file, 0, resources) as Grid;
    expect(root).toBeInstanceOf(Grid);
    expect([...root.rowDefinitions].map((s) => [s.type, s.sizeValue])).toEqual([['fixed', 10], ['star', 1]]);
    const status = root.find(ContentDecorator, 'status')!;
    expect([status.padding, status.gridRow, status.panelZIndex]).toEqual([[1, 2, 3, 4], 1, 2]);
    expect((status.backgroundImage as SpriteFromSheet).getSprite()).toBe(sheet.sprites[1]);
    const image = status.content as ImageElement;
    expect([image.stretchDirection, image.sprite]).toEqual(['downOnly', sheet.sprites[0]]);
    const canvas = root.find(Canvas)!;
    expect(canvas.visibility).toBe('collapsed');
    expect(canvas.canvasRelativeSize[0]).toBeNaN();
    // 画的顺序按 ZIndex：Canvas（0）在前
    expect(root.visualChildren).toEqual([canvas, status]);
  });

  test('UI 库每次实例化都新建一个；名字不对、类型不对时报错', () => {
    const library = new UILibrary(file, resources);
    const a = library.instantiateElement('Popup', ModalElement);
    const b = library.instantiateElement('Popup');
    expect(a).not.toBe(b);
    expect(a.overlayColor).toEqual([0, 0, 0, 0.5]);
    expect(() => library.instantiateElement('Nope')).toThrow(/no element named 'Nope'/);
    expect(() => library.instantiateElement('Popup', Button)).toThrow(/is a ModalElement, not a Button/);
  });
});
