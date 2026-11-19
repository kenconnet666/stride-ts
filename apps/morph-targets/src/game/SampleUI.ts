// MorphTargets 的 SampleUI：样例面板的样式——深色面板、标题、按钮、滑条、单选按钮组。按钮、轨道、滑块的图都是代码生成的
// 纯色小贴图（同 Stride：rgba8unorm，不是 sRGB）。
import {
  Border, Button, Grid, Slider, SpriteFromTexture, Texture, TextBlock, UIComponent, UIPage, UniformGrid,
  type Color, type Entity, type HorizontalAlignment, type SpriteFont, type SpriteProvider, type StackPanel, type Thickness, type UIElement, type VerticalAlignment,
} from '@stride-ts/engine';

/** Stride 的 new Color(r, g, b, a)：0 到 255。 */
export const rgba = (r: number, g: number, b: number, a = 255): Color => [r / 255, g / 255, b / 255, a / 255];

export const ACCENT = rgba(70, 140, 220);
export const MUTED = rgba(170, 175, 185);
export const WHITE = rgba(255, 255, 255);
const PANEL_COLOR = rgba(16, 18, 22, 210);
const SLIDER_HEIGHT = 20;

export class SampleUI {
  readonly #font: SpriteFont;
  readonly #button = solid(rgba(52, 56, 64), 4, 4);
  readonly #buttonHover = solid(rgba(72, 78, 90), 4, 4);
  readonly #buttonPressed = solid(ACCENT, 4, 4);
  readonly #current = solid(rgba(45, 95, 155), 4, 4);
  // Stride 按滑条高 / 轨道图高缩放滑块，所以轨道图和滑条一样高，中间一条不透明的带子
  readonly #track = band(rgba(60, 64, 72), 6);
  readonly #fill = band(ACCENT, 6);
  readonly #thumb = solid(rgba(225, 228, 235), 8, SLIDER_HEIGHT);
  readonly #thumbHover = solid(WHITE, 8, SLIDER_HEIGHT);

  constructor(font: SpriteFont) {
    this.#font = font;
  }

  panel(content: UIElement, horizontal: HorizontalAlignment, vertical: VerticalAlignment = 'top'): Border {
    return Object.assign(new Border(), {
      content, horizontalAlignment: horizontal, verticalAlignment: vertical,
      margin: [16, 16, 16, 16] as Thickness, padding: [14, 10, 14, 14] as Thickness, backgroundColor: PANEL_COLOR,
    });
  }

  heading(text: string): TextBlock {
    return this.text(text, 20, WHITE, [0, 4, 0, 4]);
  }

  section(text: string): TextBlock {
    return this.text(text.toUpperCase(), 13, MUTED, [0, 12, 0, 2]);
  }

  label(text = '', size = 16): TextBlock {
    return this.text(text, size, WHITE, [0, 6, 0, 2]);
  }

  text(text: string, size: number, color: Color, margin: Thickness): TextBlock {
    return Object.assign(new TextBlock(), { text, font: this.#font, textSize: size, textColor: color, margin, verticalAlignment: 'center' as const });
  }

  button(label: TextBlock, click: () => void, isCurrent = false): Button {
    const button = Object.assign(new Button(), {
      content: label,
      notPressedImage: isCurrent ? this.#current : this.#button,
      mouseOverImage: isCurrent ? this.#current : this.#buttonHover,
      pressedImage: this.#buttonPressed,
      padding: [10, 5, 10, 5] as Thickness,
      margin: [0, 6, 6, 0] as Thickness,
      horizontalAlignment: 'left' as const,
      canBeHitByUser: !isCurrent,
    });
    label.margin = [0, 0, 0, 0];
    button.onClick(click);
    return button;
  }

  /** 一行互斥的选项：选中的高亮、不能点。返回改选中项的函数（不调用 changed）。 */
  radioGroup(panel: StackPanel, title: string, options: readonly string[], selected: number, changed: (index: number) => void, columns = Infinity): (index: number) => void {
    panel.children.add(this.section(title));
    columns = Math.min(columns, options.length);
    const row = Object.assign(new UniformGrid(), { columns, rows: Math.ceil(options.length / columns), horizontalAlignment: 'left' as const });
    const buttons: Button[] = [];
    const select = (index: number) => buttons.forEach((button, i) => {
      button.notPressedImage = i === index ? this.#current : this.#button;
      button.mouseOverImage = i === index ? this.#current : this.#buttonHover;
      button.canBeHitByUser = i !== index;
    });
    options.forEach((option, index) => {
      const label = this.label(option, 15);
      label.horizontalAlignment = 'center';
      const button = this.button(label, () => {
        select(index);
        changed(index);
      });
      Object.assign(button, { horizontalAlignment: 'stretch' as const, margin: [0, 2, 4, 2] as Thickness, gridColumn: index % columns, gridRow: Math.floor(index / columns) });
      buttons.push(button);
      row.children.add(button);
    });
    select(selected);
    panel.children.add(row);
    return select;
  }

  /** 滑条；bipolar 时不画填充（填充从最小值起，不是从 0 起）。 */
  slider(minimum: number, maximum: number, value: number, width: number, bipolar = false): Slider {
    const slider = Object.assign(new Slider(), {
      width, height: SLIDER_HEIGHT,
      trackBackgroundImage: this.#track, trackForegroundImage: bipolar ? null : this.#fill,
      thumbImage: this.#thumb, mouseOverThumbImage: this.#thumbHover,
      verticalAlignment: 'center' as const, margin: [0, 2, 0, 4] as Thickness,
    });
    // 先定范围再给值（值按范围钳）
    slider.minimum = minimum;
    slider.maximum = maximum;
    slider.value = value;
    return slider;
  }

  /** 把面板放进一个页面挂到实体上，各自按自己的对齐方式放；虚拟分辨率比默认的 1280x720 大，面板画得小一些（字按真实大小栅格化）。 */
  static show(entity: Entity, ...panels: UIElement[]): void {
    const root = new Grid();
    for (const panel of panels) root.children.add(panel);
    entity.add(UIComponent.with({ page: new UIPage('SampleUI', root), resolution: [1920, 1080, 1000] }));
  }
}

function band(color: Color, height: number): SpriteProvider {
  const width = 16;
  const pixels = new Uint8Array(width * SLIDER_HEIGHT * 4);
  const top = Math.floor((SLIDER_HEIGHT - height) / 2);
  for (let y = top; y < top + height; y++) for (let x = 0; x < width; x++) pixels.set(bytes(color), (y * width + x) * 4);
  return sprite(pixels, width, SLIDER_HEIGHT);
}

function solid(color: Color, width: number, height: number): SpriteProvider {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) pixels.set(bytes(color), i * 4);
  return sprite(pixels, width, height);
}

const bytes = (color: Color) => color.map((channel) => Math.round(channel * 255));

function sprite(pixels: Uint8Array, width: number, height: number): SpriteProvider {
  return new SpriteFromTexture(new Texture('SampleUI', { format: 'rgba8unorm', width, height, levels: [pixels] }));
}
