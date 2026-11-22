import { describe, expect, test } from 'vitest';
import { GLYPH_RECORD, GLYPH_WORDS, type UIFile } from '../src/content/formats/format';
import {
  Border, buildElement, Button, Canvas, collectSemantics, ContentDecorator, ContentPresenter, EditText, Grid, semanticsKey, ImageButton, Slider, ImageElement, imageSize, ModalElement, ScrollViewer, SpriteFromSheet, SpriteSheet,
  ScrollBar, ScrollingText, SpriteFont, StackPanel, StripDefinition, TextBlock, ToggleButton, UIElement, UILibrary, UniformGrid, type PointerEvent, type SpriteFrame, type Texture, type ToggleState,
} from '../src/index';
import { routeKeyEvents } from '../src/ui/UIKeyboard';
import { fullScreenTarget, hitTest, PickingState, routePointerEvents, updateMouseOver } from '../src/ui/UIPicking';

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

  test('Canvas：设相对位置改用相对位置，设绝对位置改用绝对位置（同 Stride 的 SetCanvasRelativePosition）', () => {
    const canvas = new Canvas();
    const child = new Probe(10, 10);
    child.canvasPinOrigin = [0.5, 0.5];
    child.canvasRelativePosition = [0.5, 0.7];
    canvas.children.add(child);
    canvas.measure([200, 100]);
    canvas.arrange([200, 100], false);
    expect(child.canvasUseAbsolutePosition).toBe(false);
    expect(child.arrangeMatrix).toEqual([1, 0, 0, 1, 100 - 5 - 100, 70 - 5 - 50]);
    child.canvasAbsolutePosition = [20, 30];
    expect(child.canvasUseAbsolutePosition).toBe(true);
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

  test('文件里存的 canvasUseAbsolutePosition 不被设位置时顺带改的值盖掉，不论键的顺序', () => {
    const page: UIFile = {
      name: 'Pins', designResolution: [100, 100], root: 0, templates: {},
      elements: [
        { type: 'Canvas', props: {}, children: [1, 2] },
        { type: 'ImageElement', props: { name: 'a' }, attached: { canvasUseAbsolutePosition: true, canvasRelativePosition: [0.5, 0.5] } },
        { type: 'ImageElement', props: { name: 'b' }, attached: { canvasUseAbsolutePosition: false, canvasAbsolutePosition: [1, 2] } },
      ],
    };
    const root = buildElement(page, 0, resources) as Canvas;
    expect(root.find(ImageElement, 'a')!.canvasUseAbsolutePosition).toBe(true);
    expect(root.find(ImageElement, 'b')!.canvasUseAbsolutePosition).toBe(false);
  });

  test('Thickness、颜色里没写的成员保持元素类型的默认值（Button 的内边距默认 10、5、10、7）', () => {
    const button = buildElement({
      name: 'B', designResolution: [1, 1], root: 0,
      elements: [{ type: 'Button', props: { padding: [45, 20, null, 25], color: [null, 0.5, null, null] } }],
    }, 0, resources) as Button;
    expect(button.padding).toEqual([45, 20, 10, 25]);
    expect(button.color).toEqual([1, 0.5, 1, 1]);
  });

  test('Stride 能写进页面的元素类型都建得出来，属性照文件设', () => {
    const types = [
      'Border', 'Button', 'Canvas', 'ContentDecorator', 'ContentPresenter', 'EditText', 'Grid', 'ImageButton', 'ImageElement', 'ModalElement', 'ScrollBar',
      'ScrollingText', 'ScrollViewer', 'Slider', 'StackPanel', 'TextBlock', 'ToggleButton', 'UniformGrid',
    ] as const;
    const none = { spriteSheets: new Map(), fonts: new Map(), textures: new Map() };
    const file: UIFile = {
      name: 'Page', designResolution: [100, 100], root: 0, templates: {},
      elements: [
        ...types.map((type) => ({ type, props: {} })),
        { type: 'ToggleButton', props: { state: 'checked', isThreeState: true } },
        { type: 'ScrollingText', props: { text: 'News', scrollingSpeed: 25, desiredCharacterNumber: 12, repeatText: false } },
        { type: 'ContentPresenter', props: {}, content: 0 },
        { type: 'ScrollBar', props: { barColor: [1, 0, 0, 1] } },
      ],
    };
    expect(types.map((_, index) => buildElement(file, index, none).constructor.name)).toEqual(types);
    const toggle = buildElement(file, types.length, none) as ToggleButton;
    expect([toggle.state, toggle.isThreeState]).toEqual(['checked', true]);
    const scrolling = buildElement(file, types.length + 1, none) as ScrollingText;
    expect([scrolling.text, scrolling.scrollingSpeed, scrolling.desiredCharacterNumber, scrolling.repeatText]).toEqual(['News', 25, 12, false]);
    const presenter = buildElement(file, types.length + 2, none) as ContentPresenter;
    expect(presenter.content).toBeInstanceOf(Border);
    presenter.content!.width = 30;
    presenter.measure([100, 100]);
    expect(presenter.desiredSizeWithMargins[0]).toBe(30);
    expect((buildElement(file, types.length + 3, none) as ScrollBar).barColor).toEqual([1, 0, 0, 1]);
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

describe('UI 的指针（照 Stride 的 UIPicking）', () => {
  /** 400x400 的 UI：左上一个按钮（0..100），右边一个 ScrollViewer，里面是很高的 StackPanel 和一个按钮。 */
  function scene() {
    const root = new Canvas();
    const button = new Button();
    button.width = 100;
    button.height = 100;
    const viewer = new ScrollViewer();
    viewer.scrollMode = 'vertical';
    viewer.width = 100;
    viewer.height = 200;
    viewer.canvasAbsolutePosition = [200, 0];
    const stack = new StackPanel();
    const inner = new Button();
    inner.height = 50;
    stack.children.add(inner);
    for (let i = 0; i < 5; i++) stack.children.add(new Probe(100, 100));
    viewer.content = stack;
    root.children.add(button);
    root.children.add(viewer);
    const target = fullScreenTarget(root, [400, 400]);
    const layout = () => {
      root.measure([400, 400]);
      root.arrange([400, 400], false);
      root.updateWorldMatrix([1, 0, 0, 1, 0, 0]);
      root.updateElementState(0);
    };
    layout();
    return { root, button, viewer, stack, inner, target, layout };
  }
  const event = (eventType: PointerEvent['eventType'], x: number, y: number, dy = 0): PointerEvent =>
    ({ pointerId: 1, device: 'mouse', eventType, position: [x / 400, y / 400], deltaPosition: [0, dy / 400], isDown: eventType === 'pressed' });

  test('找元素：可以点的、画得最靠前的；ClipToBounds 外面不找子元素', () => {
    const { root, button, viewer, inner } = scene();
    expect(hitTest(root, [50, 50])).toBe(button);
    expect(hitTest(root, [250, 20])).toBe(inner);
    expect(hitTest(root, [250, 150])).toBe(viewer);
    expect(hitTest(root, [150, 50])).toBeNull();
    // 内容超出 ScrollViewer 的部分点不到
    expect(hitTest(root, [250, 350])).toBeNull();
  });

  test('在按钮上按下、松开发 Click；按下后移出去再松开不发', () => {
    const { button, target } = scene();
    const state = new PickingState();
    let clicks = 0;
    button.onClick(() => clicks++);
    const presses: PointerEvent[] = [];
    routePointerEvents(target, state, [event('pressed', 50, 50)], 0, (e) => presses.push(e));
    expect([button.isPressed, button.isTouched, presses.length]).toEqual([true, true, 1]);
    routePointerEvents(target, state, [event('released', 50, 50)], 0, () => {});
    expect([clicks, button.isPressed]).toEqual([1, false]);
    routePointerEvents(target, state, [event('pressed', 50, 50), event('moved', 150, 50), event('released', 150, 50)], 0, () => {});
    expect([clicks, button.isPressed, button.isTouched]).toEqual([1, false, false]);
  });

  test('开关按钮：点一下换一个状态并发事件；三态时多一个不确定；图按状态和悬停取', () => {
    const { root, target, layout } = scene();
    const toggle = new ToggleButton();
    toggle.width = toggle.height = 100;
    toggle.canvasAbsolutePosition = [0, 200];
    root.children.add(toggle);
    layout();
    const provider = (frame: SpriteFrame) => ({ getSprite: () => frame });
    const [on, off, maybe, onOver] = [sprite(10, 10), sprite(20, 20), sprite(30, 30), sprite(40, 40)];
    Object.assign(toggle, { checkedImage: provider(on), uncheckedImage: provider(off), indeterminateImage: provider(maybe), checkedMouseOverImage: provider(onOver) });
    const seen: string[] = [];
    for (const [name, event] of [['checked', ToggleButton.checkedEvent], ['indeterminate', ToggleButton.indeterminateEvent], ['unchecked', ToggleButton.uncheckedEvent]] as const) {
      toggle.addHandler(event, () => seen.push(name));
    }
    const state = new PickingState();
    const click = () => routePointerEvents(target, state, [event('pressed', 50, 250), event('released', 50, 250)], 0, () => {});
    expect([toggle.state, toggle.toggleButtonImage, toggle.padding]).toEqual(['unChecked', off, [10, 5, 10, 7]]);
    click();
    expect([toggle.state, toggle.toggleButtonImage]).toEqual(['checked', on]);
    toggle.mouseOverState = 'element';
    expect(toggle.toggleButtonImage).toBe(onOver);
    click();
    // 没给不确定状态的悬停图：用它平常的图
    toggle.isThreeState = true;
    click();
    click();
    expect([toggle.state, toggle.toggleButtonImage]).toEqual(['indeterminate', maybe]);
    // 正在不确定的时候关掉三态：换到下一个状态
    toggle.isThreeState = false;
    expect(toggle.state).toBe('unChecked');
    toggle.state = 'indeterminate';
    expect(toggle.isThreeState).toBe(true);
    expect(seen).toEqual(['checked', 'unchecked', 'checked', 'indeterminate', 'unchecked', 'indeterminate']);
  });

  test('图片按钮：内容是跟着状态换的图，没有内边距，内容不能自己设', () => {
    const button = new ImageButton();
    const provider = (frame: SpriteFrame) => ({ getSprite: () => frame });
    const [up, down] = [provider(sprite(10, 10)), provider(sprite(20, 20))];
    button.notPressedImage = up;
    button.pressedImage = down;
    const image = button.content as ImageElement;
    expect([image instanceof ImageElement, image.source, button.padding]).toEqual([true, up, [0, 0, 0, 0]]);
    expect(() => (button.content = new TextBlock())).toThrow(/cannot be modified/);
  });

  test('键盘事件发给有焦点的元素、往上冒泡：文字、刚按下、刚松开、按着的键；停用的元素收不到', () => {
    const { root, button, layout } = scene();
    const seen: string[] = [];
    const keys = { down: new Set(['ArrowLeft', 'ShiftLeft']), pressed: new Set(['ArrowLeft']), released: new Set(['KeyA']) };
    root.addHandler(UIElement.textInputEvent, (_, args) => seen.push(`text ${args.text}`));
    root.addHandler(UIElement.keyPressedEvent, (_, args) => seen.push(`pressed ${args.key} ${args.source === button} ${args.isKeyDown('LeftShift')} ${args.isKeyDown('A')}`));
    root.addHandler(UIElement.keyReleasedEvent, (_, args) => seen.push(`released ${args.key}`));
    root.addHandler(UIElement.keyDownEvent, (_, args) => seen.push(`down ${args.key}`));
    routeKeyEvents(button, keys, ['a', 'b']);
    expect(seen).toEqual(['text a', 'text b', 'pressed ArrowLeft true true false', 'released KeyA', 'down ArrowLeft', 'down ShiftLeft']);
    // 元素自己处理掉的不再往上
    seen.length = 0;
    button.addHandler(UIElement.keyPressedEvent, (_, args) => (args.handled = true));
    routeKeyEvents(button, keys, []);
    expect(seen).toEqual(['released KeyA', 'down ArrowLeft', 'down ShiftLeft']);
    seen.length = 0;
    root.isEnabled = false;
    layout();
    routeKeyEvents(button, keys, ['a']);
    expect(seen).toEqual([]);
  });

  test('模态的弹窗挡住后面的元素，点到弹窗外面发 OutsideClick', () => {
    const { root, button, target, layout } = scene();
    const modal = new ModalElement();
    modal.width = 100;
    modal.height = 100;
    modal.canvasAbsolutePosition = [300, 300];
    root.children.add(modal);
    layout();
    expect(hitTest(root, [50, 50])).toBe(modal);
    let outside = 0, clicks = 0;
    modal.addHandler(ModalElement.outsideClickEvent, () => outside++);
    button.onClick(() => clicks++);
    routePointerEvents(target, new PickingState(), [event('pressed', 50, 50), event('released', 50, 50)], 0, () => {});
    expect([outside, clicks]).toEqual([1, 0]);
    routePointerEvents(target, new PickingState(), [event('pressed', 350, 350), event('released', 350, 350)], 0, () => {});
    expect(outside).toBe(1);
  });

  test('悬停：鼠标下面的元素是 element，父元素是 child，移开后是 none', () => {
    const { root, viewer, inner, target } = scene();
    const state = new PickingState();
    expect(updateMouseOver(target, state, [250 / 400, 20 / 400])).toBe(inner);
    expect([inner.mouseOverState, viewer.mouseOverState, root.mouseOverState]).toEqual(['element', 'child', 'child']);
    updateMouseOver(target, state, [150 / 400, 50 / 400]);
    expect([inner.mouseOverState, viewer.mouseOverState, root.mouseOverState]).toEqual(['none', 'none', 'none']);
  });

  test('ScrollViewer：拖过阈值才开始滚，开始滚以后里面按着的按钮不再算按下', () => {
    const { viewer, stack, inner, target, layout } = scene();
    const state = new PickingState();
    let clicks = 0;
    inner.onClick(() => clicks++);
    routePointerEvents(target, state, [event('pressed', 250, 20)], 0, () => {});
    expect(inner.isPressed).toBe(true);
    routePointerEvents(target, state, [event('moved', 250, 15, -5)], 0, () => {});
    expect(viewer.isUserScrollingViewer).toBe(false);
    routePointerEvents(target, state, [event('moved', 250, 5, -10)], 0, () => {});
    expect(viewer.isUserScrollingViewer).toBe(true);
    viewer.update(1 / 60);
    layout();
    expect(stack.scrollPosition).toBeGreaterThan(0);
    routePointerEvents(target, state, [event('released', 250, 5)], 0, () => {});
    expect([clicks, inner.isPressed, viewer.isUserScrollingViewer]).toEqual([0, false, false]);
  });
});

/** 合成的字体：字号 20 时 A 宽 10、B 宽 12，字形已经下载好。 */
async function testFont(): Promise<SpriteFont> {
  const advances = [[65, 0.5], [66, 0.6]] as const;
  const glyphs = new ArrayBuffer(advances.length * GLYPH_WORDS * 4);
  advances.forEach(([codepoint, advance], i) => {
    new Uint32Array(glyphs)[i * GLYPH_WORDS + GLYPH_RECORD.codepoint] = codepoint;
    new Float32Array(glyphs)[i * GLYPH_WORDS + GLYPH_RECORD.advance] = advance;
  });
  const font = new SpriteFont(
    {
      name: 'Test', kind: 'dynamic', size: 20, antiAlias: 'default', integerPpem: false, ascent: 0.9, descent: 0.2, lineGap: 0.1, spacing: 0, lineSpacing: 0,
      lineGapFactor: 1, lineGapBaseLineFactor: 1, defaultCharacter: 65, blocks: [0], kerning: [],
    },
    () => Promise.resolve({ glyphs, glyphCount: advances.length, points: new Float32Array(0), bands: new Uint32Array(0), pointStep: 1 / 8192 }),
  );
  await font.ensure('AB');
  return font;
}

describe('滚动的文字（照 Stride 的 ScrollingText）', () => {
  async function scrolling(text: string, repeat = true): Promise<ScrollingText> {
    const element = Object.assign(new ScrollingText(), { font: await testFont(), text, repeatText: repeat, desiredCharacterNumber: 4, horizontalAlignment: 'left' as const });
    element.measure([200, 100]);
    element.arrange([200, 100], false);
    return element;
  }

  test('宽度是 desiredCharacterNumber 个 A；只画在自己的范围里，比文字多画三层', async () => {
    const element = await scrolling('AB');
    expect(element.renderSize[0]).toBeCloseTo(40, 5);
    expect(element.clipToBounds).toBe(true);
    expect(element.drawLayerNumber).toBe(new TextBlock().drawLayerNumber + 3);
    element.desiredCharacterNumber = 6;
    expect(element.isMeasureValid).toBe(false);
  });

  test('从右边进来往左滚：按速度挪，右边不够就接字（重复时从头再接），左边滚出去的字去掉', async () => {
    const element = await scrolling('AB');
    expect(element.scrollingOffset).toBeCloseTo(40, 5);
    expect(element.textToDisplay).toBe('');
    element.update(0.5);
    // 40 像素每秒：半秒挪 20，露出来的 20 里要有字
    expect(element.scrollingOffset).toBeCloseTo(20, 5);
    expect(element.textToDisplay).toBe('AB');
    expect(element.accumulatedWidth).toBeCloseTo(22, 5);
    element.update(1);
    // 那串的左边到了 -20：第一个 A（宽 10）整个滚出去了，去掉以后左边是 -10
    expect(element.textToDisplay).toBe('BABAB');
    expect(element.scrollingOffset).toBeCloseTo(-10, 5);
    expect(element.accumulatedWidth).toBeCloseTo(66, 5);
    // 滚很久那串字也不变长
    for (let i = 0; i < 1000; i++) element.update(0.1);
    expect(element.textToDisplay.length).toBeLessThanOrEqual(6);
    expect(element.scrollingOffset).toBeGreaterThan(-12);
    expect(element.scrollingOffset).toBeLessThanOrEqual(0);
  });

  test('速度不小于 0；禁用时不滚', async () => {
    const element = await scrolling('AB');
    element.scrollingSpeed = -5;
    expect(element.scrollingSpeed).toBe(0);
    element.scrollingSpeed = 100;
    element.isEnabled = false;
    element.update(0.1);
    expect(element.scrollingOffset).toBeCloseTo(40, 5);
    element.isEnabled = true;
    element.update(0.1);
    expect(element.scrollingOffset).toBeCloseTo(30, 5);
  });

  test('不重复：滚完就空了；appendText 接上的字接着滚，直接改 text 从头滚起', async () => {
    const element = await scrolling('AB', false);
    element.update(0.75);
    expect(element.textToDisplay).toBe('AB');
    expect(element.scrollingOffset).toBeCloseTo(10, 5);
    // 接字不打断正在滚的
    element.appendText('B');
    element.arrange([200, 100], false);
    element.update(0.25);
    expect(element.text).toBe('ABB');
    expect(element.textToDisplay).toBe('ABB');
    expect(element.scrollingOffset).toBeCloseTo(0, 5);
    // 全滚出去：停在右边等着
    element.update(5);
    expect(element.textToDisplay).toBe('');
    expect(element.scrollingOffset).toBeCloseTo(40, 5);
    element.appendText('A');
    element.measure([200, 100]);
    element.arrange([200, 100], false);
    element.update(0.25);
    expect(element.textToDisplay).toBe('A');
    expect(element.scrollingOffset).toBeCloseTo(30, 5);
    // 直接改文字：从头
    element.text = 'BA';
    element.measure([200, 100]);
    element.arrange([200, 100], false);
    expect(element.textToDisplay).toBe('');
    expect(element.scrollingOffset).toBeCloseTo(40, 5);
    element.update(0.5);
    expect(element.textToDisplay).toBe('BA');
    element.clearText();
    expect(element.textToDisplay).toBe('');
  });
});

describe('语义树（影子 DOM 的内容）', () => {
  test('文字和控件各一个节点，按树的顺序：角色、名字、状态、位置；看不见的不算', async () => {
    const font = await testFont();
    const root = new Canvas();
    const place = <T extends UIElement>(element: T, x: number, y: number, width: number, height: number): T => {
      Object.assign(element, { width, height, canvasAbsolutePosition: [x, y] });
      root.children.add(element);
      return element;
    };
    const play = place(new Button(), 10, 20, 100, 40);
    play.padding = [0, 0, 0, 0];
    play.content = Object.assign(new TextBlock(), { font, text: 'AB' });
    const sound = place(Object.assign(new ToggleButton(), { accessibleLabel: 'Sound', state: 'checked' as ToggleState }), 10, 80, 40, 40);
    const volume = place(Object.assign(new Slider(), { name: 'Volume', minimum: 0, maximum: 10, value: 4 }), 10, 140, 200, 20);
    const lines = place(Object.assign(new TextBlock(), { font, text: 'AB\nA', textAlignment: 'center' as const, isSelectable: true }), 200, 0, 100, 60);
    place(Object.assign(new TextBlock(), { font, text: 'AAA', visibility: 'hidden' as const }), 0, 300, 50, 20);
    place(Object.assign(new EditText(), { name: 'Password', inputType: 'password' as const, text: 'AB' }), 0, 330, 50, 20);
    place(Object.assign(new ScrollingText(), { font, text: 'ABBA' }), 0, 360, 40, 20);
    const dialog = place(Object.assign(new ModalElement(), { name: 'Confirm' }), 100, 200, 200, 100);
    const ok = Object.assign(new Button(), { isEnabled: false });
    ok.content = Object.assign(new TextBlock(), { font, text: 'BA' });
    dialog.content = ok;
    root.measure([400, 400]);
    root.arrange([400, 400], false);
    root.updateWorldMatrix([1, 0, 0, 1, 0, 0]);
    root.updateElementState(0);

    const nodes = collectSemantics(root);
    // 最后一列：被模态的弹窗挡住（弹窗和它里面的不挡）
    expect(nodes.map((node) => [node.role, node.label, node.hidden, node.disabled, node.blocked])).toEqual([
      ['button', 'AB', false, false, true],
      // 按钮里的文字：名字已经在按钮上，对读屏软件藏起来
      ['text', 'AB', true, false, true],
      ['checkbox', 'Sound', false, false, true],
      ['slider', 'Volume', false, false, true],
      ['text', 'AB\nA', false, false, true],
      // 没在编辑的输入框：名字和里面的文字（密码是圆点）
      ['textbox', 'Password', false, false, true],
      // 滚动的文字给整段，不是这一帧露出来的几个字
      ['marquee', 'ABBA', false, false, true],
      ['dialog', 'Confirm', false, false, false],
      ['button', 'BA', false, true, false],
      ['text', 'BA', true, true, false],
    ]);
    expect([nodes[5]!.value, nodes[5]!.readOnly]).toEqual(['••', false]);
    // 弹窗不是模态的：谁都不挡
    dialog.isModal = false;
    expect(collectSemantics(root).some((node) => node.blocked)).toBe(false);
    dialog.isModal = true;
    const [button, , checkbox, slider, text] = nodes;
    // 位置是元素的左上角（世界矩阵的原点在中心）
    expect([button!.matrix, button!.size]).toEqual([[1, 0, 0, 1, 10, 20], [100, 40]]);
    expect([checkbox!.element, checkbox!.checked]).toEqual([sound, 'true']);
    expect([slider!.element, slider!.range]).toEqual([volume, { min: 0, max: 10, value: 4 }]);
    // 两行，居中：A 宽 10、B 宽 12，框宽 100
    expect(text!.element).toBe(lines);
    expect(text!.text!.selectable).toBe(true);
    expect(text!.text!.lines.map((line) => [line.text, line.x, line.width, line.start])).toEqual([['AB', 39, 22, 0], ['A', 45, 10, 3]]);
    expect(text!.text!.lines[1]!.y).toBeCloseTo(text!.text!.lineHeight, 5);

    // 没变时节点的键不变；状态变了才变（影子 DOM 靠它决定要不要写 DOM）
    const keys = nodes.map(semanticsKey);
    expect(collectSemantics(root).map(semanticsKey)).toEqual(keys);
    sound.state = 'indeterminate';
    volume.value = 7;
    const changed = collectSemantics(root);
    expect(changed.map(semanticsKey).map((key, i) => key !== keys[i])).toEqual([false, false, true, true, false, false, false, false, false, false]);
    expect([changed[2]!.checked, changed[3]!.range!.value]).toEqual(['mixed', 7]);
    // 代码点一下按钮：发 Click；停用的不发
    const clicks: string[] = [];
    play.onClick(() => clicks.push('play'));
    ok.onClick(() => clicks.push('ok'));
    play.performClick();
    ok.performClick();
    expect(clicks).toEqual(['play']);
  });
});

describe('滑条和边框（照 Stride 的 Slider、Border）', () => {
  test('值钳在范围里，吸附刻度；改了才发 ValueChanged；最大值不小于最小值', () => {
    const slider = new Slider();
    const changes: number[] = [];
    slider.onValueChanged((s) => changes.push(s.value));
    slider.minimum = -1;
    slider.maximum = 2;
    slider.value = 5;
    slider.value = 2;
    expect([slider.value, changes]).toEqual([2, [2]]);
    slider.maximum = -3;
    expect([slider.maximum, slider.value]).toEqual([-1, -1]);
    slider.maximum = 2;
    slider.tickFrequency = 3;
    slider.shouldSnapToTicks = true;
    slider.value = 0.4;
    expect(slider.value).toBe(0);
    slider.increase();
    expect(slider.value).toBe(1);
  });

  test('按下跳到指针的位置，按住拖动跟着走（扣掉两头的 trackStartingOffsets）', () => {
    const root = new Canvas();
    const slider = new Slider();
    slider.width = 100;
    slider.height = 20;
    slider.canvasAbsolutePosition = [0, 0];
    slider.trackStartingOffsets = [10, 10];
    root.children.add(slider);
    const target = fullScreenTarget(root, [400, 400]);
    root.measure([400, 400]);
    root.arrange([400, 400], false);
    root.updateWorldMatrix([1, 0, 0, 1, 0, 0]);
    root.updateElementState(0);
    const event = (eventType: PointerEvent['eventType'], x: number): PointerEvent =>
      ({ pointerId: 1, device: 'mouse', eventType, position: [x / 400, 10 / 400], deltaPosition: [0, 0], isDown: eventType !== 'released' });
    const state = new PickingState();
    routePointerEvents(target, state, [event('pressed', 30)], 0, () => {});
    expect(slider.value).toBeCloseTo(0.25);
    routePointerEvents(target, state, [event('moved', 90)], 0, () => {});
    expect(slider.value).toBe(1);
    routePointerEvents(target, state, [event('released', 90), event('moved', 50)], 0, () => {});
    expect(slider.value).toBe(1);
  });

  test('边框：内容放在边和内边距里面', () => {
    const border = new Border();
    border.borderThickness = [1, 2, 3, 4];
    border.padding = [10, 10, 10, 10];
    const content = new Probe(30, 40);
    border.content = content;
    border.measure([200, 200]);
    expect(border.desiredSize).toEqual([54, 66]);
    border.arrange([54, 66], false);
    expect(content.arrangeMatrix).toEqual([1, 0, 0, 1, 11 - 27, 12 - 33]);
  });
});
