// SpriteFonts 的 FontRenderer（Stride 里是合成器的根渲染器 SceneRendererBase）：清成绿色，用 SpriteBatch 画背景和八屏文字
// （介绍、编译期字体、运行时字体、粗体斜体、三种抗锯齿、日文、左中右对齐、旋转缩放的动画），每屏淡入淡出、到时间换下一屏；
// 空格或点击暂停，左右键换屏。虚拟分辨率 1920x1080。
// 照 Stride 保留的：颜色是 Color.White * alpha（四个通道都乘）；动画那屏的原点是虚拟坐标量出来的大小的一半，Stride 把它当字体
// 像素用（窗口不是 1920x1080 时旋转中心不在文字中间）。
import { SpriteBatch, type Color, type RenderContext, type SceneRenderer, type SpriteFont, type Texture, type Vec2 } from '@stride-ts/engine';

/** 每屏显示的秒数：第一个是介绍，后面依次是各组文字。 */
const TIME_TO_DISPLAY = [3, 5, 5, 4, 5, 5, 5, 10];
const FADE_IN = 1;
const FADE_OUT = 1;
const DYNAMIC_FONT_CONTENT_SIZE = 50;
// 换行同 C# 的逐字字符串（源文件是 CRLF，\r 排版时跳过）
const REFERENCE_TEXT = `
In the first centuries of typesetting,
quotations were distinguished merely by
indicating the speaker, and this can still
be seen in some editions of the Bible.
During the Renaissance, quotations
were distinguished by setting in a typeface
contrasting with the main body text
(often Italic type with roman,
or the other way round).
Block quotations were set this way
at full size and full measure`;
// new Color(0xFF3008da)：R = 0xda、G = 0x08、B = 0x30
const STRIDE_COLOR: Color = [0xda / 255, 0x08 / 255, 0x30 / 255, 1];
const VIRTUAL_RESOLUTION: Vec2 = [1920, 1080];
const HEADER_POSITION: Vec2 = [0.5, 0.25];
const CONTENT_POSITION: Vec2 = [0.5, 0.4];
// Stride 清屏用的 Color.Green（0, 128, 0），按线性值写进 sRGB 的后备缓冲
const CLEAR_COLOR: GPUColor = { r: 0, g: 128 / 255, b: 0, a: 1 };

export interface FontRendererAssets {
  readonly background?: Texture;
  readonly staticFont: SpriteFont;
  readonly dynamicFont: SpriteFont;
  readonly boldFont: SpriteFont;
  readonly italicFont: SpriteFont;
  readonly aliasedFont: SpriteFont;
  readonly antialiasedFont: SpriteFont;
  readonly clearTypeFont: SpriteFont;
  readonly japaneseFont: SpriteFont;
  readonly timesNewRoman: SpriteFont;
  readonly headerFont: SpriteFont;
}

export class FontRenderer implements SceneRenderer {
  readonly #assets: FontRendererAssets;
  #spriteBatch: SpriteBatch | undefined;
  readonly #screens: readonly (() => void)[];
  #screenSize: Vec2 = [1, 1];
  #animatedPosition: Vec2 = [0, 0];
  #animatedScale = 1;
  #animatedRotation = 0;
  #animatedAlpha = 1;
  isPlaying = true;
  currentScreen = 0;
  currentTime = 0;

  constructor(assets: FontRendererAssets) {
    this.#assets = assets;
    this.#screens = [
      () => this.#drawIntroduction(), () => this.#drawStatic(), () => this.#drawDynamic(), () => this.#drawStyle(),
      () => this.#drawAlias(), () => this.#drawLanguage(), () => this.#drawAlignment(), () => this.#drawAnimation(),
    ];
  }

  draw({ game, time }: RenderContext): void {
    const device = game.graphicsDevice;
    const batch = (this.#spriteBatch ??= Object.assign(new SpriteBatch(device.device, game.renderSystem.resources), { virtualResolution: VIRTUAL_RESOLUTION }));
    this.#screenSize = [device.canvas.width, device.canvas.height];
    this.#updateAnimatedFont();
    this.#updateInput(game.input);
    this.#updateCurrentScreen();
    if (this.isPlaying) this.currentTime += time.elapsed;

    const encoder = device.device.createCommandEncoder({ label: 'FontRenderer' });
    const pass = encoder.beginRenderPass({
      label: 'FontRenderer',
      colorAttachments: [{ view: device.currentBackBufferView(), clearValue: CLEAR_COLOR, loadOp: 'clear', storeOp: 'store' }],
    });
    batch.begin(pass, device.canvas.width, device.canvas.height, device.backBufferViewFormat);
    this.#drawBackground(batch);
    this.#screens[this.currentScreen]!();
    batch.end();
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    this.#spriteBatch?.destroy();
  }

  /** 背景铺满虚拟分辨率：从贴图中间裁出和渲染目标同样宽高比的一块（同 Stride）。 */
  #drawBackground(batch: SpriteBatch): void {
    const background = this.#assets.background;
    if (!background) return;
    const { width, height } = background.data;
    const [tw, th] = this.#screenSize;
    const ratio = Math.min(width / tw, height / th);
    const [sw, sh] = [tw * ratio, th * ratio];
    batch.draw(background, [0, 0, VIRTUAL_RESOLUTION[0], VIRTUAL_RESOLUTION[1]], { source: [(width - sw) / 2, (height - sh) / 2, sw, sh] });
  }

  get #batch(): SpriteBatch {
    return this.#spriteBatch!;
  }

  #drawHeader(part1: string, part2: string, part3: string): void {
    const size = 70;
    const font = this.#assets.headerFont;
    const position = this.#virtual(HEADER_POSITION);
    const measure = (text: string) => this.#batch.measureString(font, text, size, this.#screenSize);
    const whole = measure(part1 + part2 + part3);
    let x = position[0] - whole[0] * 0.5;
    const y = position[1] - whole[1] * 0.5;
    this.#batch.drawString(font, part1, [x, y], { fontSize: size, color: this.#white() });
    x += measure(part1)[0];
    this.#batch.drawString(font, part2, [x, y], { fontSize: size, color: this.#tinted(STRIDE_COLOR) });
    x += measure(part2)[0];
    this.#batch.drawString(font, part3, [x, y], { fontSize: size, color: this.#white() });
  }

  #drawIntroduction(): void {
    const size = 80;
    const font = this.#assets.dynamicFont;
    const [part1, part2, part3] = ['Create cross-platform', ' games ', 'in C#'];
    const measure = (text: string) => this.#batch.measureString(font, text, size, this.#screenSize);
    const position = this.#virtual([0.5, 0.5]);
    const whole = measure(part1 + part2 + part3);
    let x = position[0] - whole[0] * 0.5;
    const y = position[1] - whole[1] * 0.5;
    this.#batch.drawString(font, part1, [x, y], { fontSize: size, color: this.#white() });
    x += measure(part1)[0];
    this.#batch.drawString(font, part2, [x, y], { fontSize: size, color: this.#tinted(STRIDE_COLOR) });
    x += measure(part2)[0];
    this.#batch.drawString(font, part3, [x, y], { fontSize: size, color: this.#white() });
  }

  #drawStatic(): void {
    this.#drawHeader('Compile-time rendered ', 'static', ' fonts');
    const font = this.#assets.staticFont;
    const text = 'Embeds only required characters into the database\n'
      + 'Does not require any rendering time at execution\n'
      + 'Cannot adjust their size to the virtual resolution\n'
      + 'Cannot modify their size at run-time';
    const [x, y] = this.#virtual(CONTENT_POSITION);
    this.#batch.drawString(font, text, [x - this.#batch.measureString(font, text, font.size, this.#screenSize)[0] / 2, y], { color: this.#white() });
  }

  #drawDynamic(): void {
    this.#drawHeader('Run-time rendered ', 'dynamic', ' fonts');
    const font = this.#assets.dynamicFont;
    let text = 'Embeds all characters of the font into the database\n'
      + 'Is rendered at execution time and requires some time for rendering\n'
      + 'Can adjust their size to the virtual resolution\n';
    let [x, y] = this.#virtual(CONTENT_POSITION);
    const first = this.#batch.measureString(font, text, DYNAMIC_FONT_CONTENT_SIZE, this.#screenSize);
    x -= first[0] / 2;
    this.#batch.drawString(font, text, [x, y], { fontSize: DYNAMIC_FONT_CONTENT_SIZE, color: this.#white() });
    text = 'Can modify their size at execution time';
    y += first[1];
    this.#batch.drawString(font, text, [x, y], { fontSize: 80, color: this.#white() });
  }

  #drawStyle(): void {
    this.#drawHeader('Support common font ', 'styles', '');
    const { dynamicFont, italicFont, boldFont } = this.#assets;
    let [x, y] = this.#virtual(CONTENT_POSITION);
    let text = 'None - This is a sample sentence.';
    const first = this.#batch.measureString(dynamicFont, text, DYNAMIC_FONT_CONTENT_SIZE, this.#screenSize);
    x -= first[0] / 2;
    this.#batch.drawString(dynamicFont, text, [x, y], { fontSize: DYNAMIC_FONT_CONTENT_SIZE, color: this.#white() });
    text = 'Italic - This is a sample sentence.';
    y += first[1];
    this.#batch.drawString(italicFont, text, [x, y], { fontSize: DYNAMIC_FONT_CONTENT_SIZE, color: this.#white() });
    text = 'Bold - This is a sample sentence.';
    y += this.#batch.measureString(italicFont, text, DYNAMIC_FONT_CONTENT_SIZE, this.#screenSize)[1];
    this.#batch.drawString(boldFont, text, [x, y], { fontSize: DYNAMIC_FONT_CONTENT_SIZE, color: this.#white() });
  }

  #drawAlias(): void {
    this.#drawHeader('Support common ', 'anti-aliasing', ' modes');
    const { aliasedFont, antialiasedFont, clearTypeFont } = this.#assets;
    let [x, y] = this.#virtual(CONTENT_POSITION);
    let text = 'Aliased - This is a sample sentence.';
    const first = this.#batch.measureString(aliasedFont, text, DYNAMIC_FONT_CONTENT_SIZE, this.#screenSize);
    x -= first[0] / 2;
    this.#batch.drawString(aliasedFont, text, [x, y], { color: this.#white() });
    y += first[1];
    text = 'Anti-aliased - This is a sample sentence.';
    this.#batch.drawString(antialiasedFont, text, [x, y], { color: this.#white() });
    y += this.#batch.measureString(antialiasedFont, text, antialiasedFont.size, this.#screenSize)[1];
    text = 'Clear-type - This is a sample sentence.';
    this.#batch.drawString(clearTypeFont, text, [x, y], { color: this.#white() });
  }

  #drawLanguage(): void {
    this.#drawHeader('Support ', 'pictogram-based', ' fonts');
    const font = this.#assets.japaneseFont;
    const size = 0.8 * (DYNAMIC_FONT_CONTENT_SIZE + 15);
    const text = 'Japanese dynamic sprite font\nあいうえおかきくけこ   天竜の\nアイウエオカキクケコ   幅八町の\n一二三四五六七八九十   梅雨濁り';
    const [x, y] = this.#virtual(CONTENT_POSITION);
    this.#batch.drawString(font, text, [x - this.#batch.measureString(font, text, size, this.#screenSize)[0] / 2, y], { fontSize: size, color: this.#white() });
  }

  #drawAlignment(): void {
    this.#drawHeader('Support standard ', 'text alignment', ' modes');
    const font = this.#assets.timesNewRoman;
    const size = 28;
    let [x, y] = this.#virtual(CONTENT_POSITION);
    x = VIRTUAL_RESOLUTION[0] * 0.03;
    let text = 'LEFT-ALIGNED TEXT\n' + REFERENCE_TEXT;
    this.#batch.drawString(font, text, [x, y], { fontSize: size, color: this.#white() });
    x = VIRTUAL_RESOLUTION[0] * 0.5 - 0.5 * this.#batch.measureString(font, text, size, this.#screenSize)[0];
    text = 'CENTERED TEXT\n' + REFERENCE_TEXT;
    this.#batch.drawString(font, text, [x, y], { fontSize: size, color: this.#white(), alignment: 'center' });
    x = VIRTUAL_RESOLUTION[0] - this.#batch.measureString(font, text, size, this.#screenSize)[0] - VIRTUAL_RESOLUTION[0] * 0.03;
    text = 'RIGHT-ALIGNED TEXT\n' + REFERENCE_TEXT;
    this.#batch.drawString(font, text, [x, y], { fontSize: size, color: this.#white(), alignment: 'right' });
  }

  #drawAnimation(): void {
    this.#drawHeader('Easily ', 'animate', ' your texts!');
    const font = this.#assets.dynamicFont;
    const text = 'Stride Engine';
    const [w, h] = this.#batch.measureString(font, text, DYNAMIC_FONT_CONTENT_SIZE, this.#screenSize);
    const alpha = this.#animatedAlpha * this.#interpolatedAlpha();
    this.#batch.drawString(font, text, this.#animatedPosition, {
      fontSize: DYNAMIC_FONT_CONTENT_SIZE, color: [alpha, alpha, alpha, alpha], rotation: this.#animatedRotation,
      origin: [0.5 * w, 0.5 * h], scale: [this.#animatedScale, this.#animatedScale],
    });
  }

  #updateInput(input: RenderContext['game']['input']): void {
    if (input.isKeyPressed('Space') || input.pointerEvents.some((event) => event.eventType === 'pressed')) {
      this.isPlaying = !this.isPlaying;
    } else if (input.isKeyPressed('Left') || input.isKeyPressed('Right')) {
      // 暂停时跳过淡入，换过去的屏马上看得清
      this.currentTime = this.isPlaying ? 0 : FADE_IN;
      const step = input.isKeyPressed('Left') ? -1 : 1;
      this.currentScreen = (this.currentScreen + step + this.#screens.length) % this.#screens.length;
    }
  }

  #updateCurrentScreen(): void {
    if (this.currentTime <= TIME_TO_DISPLAY[this.currentScreen]!) return;
    this.currentTime = 0;
    this.currentScreen = (this.currentScreen + 1) % this.#screens.length;
  }

  #updateAnimatedFont(): void {
    const t = this.currentTime;
    this.#animatedAlpha = varying(1.6 * t);
    this.#animatedRotation = 2 * t * Math.PI;
    const center = this.#virtual([0.5, 0.65]);
    this.#animatedPosition = [center[0] + 160 * 1.5 * Math.cos(1.5 * t), center[1] + 160 * Math.sin(1.5 * t)];
    this.#animatedScale = 0.9 + 0.2 * varying(2.5 * t);
  }

  #interpolatedAlpha(): number {
    const upper = TIME_TO_DISPLAY[this.currentScreen]!;
    if (this.currentTime < FADE_IN) return this.currentTime / FADE_IN;
    if (this.currentTime < upper - FADE_OUT) return 1;
    return Math.max(upper - this.currentTime, 0) / FADE_OUT;
  }

  /** Color.White * alpha：四个通道都乘。 */
  #white(): Color {
    const a = this.#interpolatedAlpha();
    return [a, a, a, a];
  }

  #tinted([r, g, b, a]: Color): Color {
    const alpha = this.#interpolatedAlpha();
    return [r * alpha, g * alpha, b * alpha, a * alpha];
  }

  #virtual([x, y]: Vec2): Vec2 {
    return [VIRTUAL_RESOLUTION[0] * x, VIRTUAL_RESOLUTION[1] * y];
  }
}

function varying(time: number): number {
  return Math.cos(time) * 0.5 + 0.5;
}
