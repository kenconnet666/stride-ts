/**
 * 滑条（Stride 的 Slider）：在 minimum 到 maximum 之间拖动取值。按下时值跳到指针的位置，按住拖动跟着走；值变了发
 * ValueChanged（冒泡）。画法（UIRenderer）：轨道背景铺满元素，轨道前景从起点画到当前值，可选的刻度，最后是滑块（指针悬停时
 * 换 mouseOverThumbImage）。高度按轨道背景图的高，长度按给它的空间。
 *
 * 和 Stride 不同：只有水平的（Stride 的竖直滑条要把图转 90 度，用到的样例再做）；没有键盘的左右键。
 */
import { RoutedEvent, RoutedEventArgs, type TouchEventArgs } from '../events';
import { clamp, UIElement, type Vec2 } from '../UIElement';
import { spriteSize, type SpriteProvider } from '../sprites';
import type { SpriteFrame } from '../../rendering/SpriteSheet';

/** Stride 的 MathUtil.ZeroTolerance。 */
const ZERO_TOLERANCE = 1e-6;

export class Slider extends UIElement {
  /** 值变了（Stride 的 ValueChanged，冒泡）：`slider.onValueChanged(() => ...)`。 */
  static readonly valueChangedEvent = new RoutedEvent<RoutedEventArgs>('ValueChanged', 'bubble');
  #value = 0;
  #minimum = 0;
  #maximum = 1;
  #step = 0.1;
  #tickFrequency = 10;
  #tickOffset = 10;
  #shouldSnapToTicks = false;
  #trackBackgroundImage: SpriteProvider | null = null;
  #trackBackgroundSprite: SpriteFrame | undefined;
  #isTouchedDown = false;
  trackForegroundImage: SpriteProvider | null = null;
  /** 轨道两头留出的长度（起点、终点），值的范围对应中间那段。 */
  trackStartingOffsets: Vec2 = [0, 0];
  thumbImage: SpriteProvider | null = null;
  mouseOverThumbImage: SpriteProvider | null = null;
  tickImage: SpriteProvider | null = null;
  areTicksDisplayed = false;
  /** 从右往左（最小值在右边）。 */
  isDirectionReversed = false;

  constructor() {
    super();
    this.canBeHitByUser = true;
    this.verticalAlignment = 'center';
    this.horizontalAlignment = 'center';
    // 轨道背景、轨道前景、刻度、滑块
    this.drawLayerNumber += 4;
  }

  get value(): number { return this.#value; }
  set value(value: number) {
    if (Number.isNaN(value)) return;
    const old = this.#value;
    this.#value = clamp(value, this.#minimum, this.#maximum);
    if (this.#shouldSnapToTicks) this.#value = clamp(this.#closestTick(this.#value), this.#minimum, this.#maximum);
    if (Math.abs(old - this.#value) > ZERO_TOLERANCE) this.raiseEvent(new RoutedEventArgs(Slider.valueChangedEvent));
  }

  get minimum(): number { return this.#minimum; }
  set minimum(value: number) {
    if (Number.isNaN(value)) return;
    this.#minimum = value;
    this.#coerceMaximum(this.#maximum);
  }

  /** 不小于 minimum。 */
  get maximum(): number { return this.#maximum; }
  set maximum(value: number) {
    if (Number.isNaN(value)) return;
    this.#coerceMaximum(value);
  }

  /** increase、decrease 一次走多少。 */
  get step(): number { return this.#step; }
  set step(value: number) {
    if (!Number.isNaN(value)) this.#step = Math.max(0, value);
  }

  /** 刻度把范围分成几段（至少 1）。 */
  get tickFrequency(): number { return this.#tickFrequency; }
  set tickFrequency(value: number) {
    if (Number.isNaN(value)) return;
    this.#tickFrequency = Math.max(1, value);
    this.value = this.#value;
  }

  /** 刻度离轨道中线的距离。 */
  get tickOffset(): number { return this.#tickOffset; }
  set tickOffset(value: number) {
    if (!Number.isNaN(value)) this.#tickOffset = Math.max(0, value);
  }

  /** 值吸附到最近的刻度。 */
  get shouldSnapToTicks(): boolean { return this.#shouldSnapToTicks; }
  set shouldSnapToTicks(value: boolean) {
    this.#shouldSnapToTicks = value;
    this.value = this.#value;
  }

  get trackBackgroundImage(): SpriteProvider | null { return this.#trackBackgroundImage; }
  set trackBackgroundImage(value: SpriteProvider | null) {
    if (value === this.#trackBackgroundImage) return;
    this.#trackBackgroundImage = value;
    this.#onTrackBackgroundChanged(value?.getSprite());
  }

  /** 现在的轨道背景精灵（画和量都用它）。 */
  get trackBackgroundSprite(): SpriteFrame | undefined { return this.#trackBackgroundSprite; }

  /** 登记值变了的处理函数（addHandler(Slider.valueChangedEvent, ...) 的简写）。 */
  onValueChanged(handler: (sender: Slider) => void): void {
    this.addHandler(Slider.valueChangedEvent, (sender) => handler(sender as Slider));
  }

  increase(): void {
    this.value = this.#value + this.#increment();
  }

  decrease(): void {
    this.value = this.#value - this.#increment();
  }

  snapToClosestTick(): void {
    this.value = this.#closestTick(this.#value);
  }

  protected override measureOverride(available: Vec2): Vec2 {
    const sprite = this.#trackBackgroundSprite;
    if (!sprite) return super.measureOverride(available);
    return [available[0], spriteSize(sprite)[1]];
  }

  protected override onTouchDown(args: TouchEventArgs): void {
    super.onTouchDown(args);
    this.#setValueFromTouch(args.worldPosition);
    this.#isTouchedDown = true;
  }

  protected override onTouchUp(args: TouchEventArgs): void {
    super.onTouchUp(args);
    this.#isTouchedDown = false;
  }

  protected override onTouchLeave(args: TouchEventArgs): void {
    super.onTouchLeave(args);
    this.#isTouchedDown = false;
  }

  protected override onTouchMove(args: TouchEventArgs): void {
    super.onTouchMove(args);
    if (this.#isTouchedDown) this.#setValueFromTouch(args.worldPosition);
  }

  /** 轨道背景换了图（精灵表换帧）时重新量。 */
  protected override onUpdate(): void {
    const sprite = this.#trackBackgroundImage?.getSprite();
    if (sprite !== this.#trackBackgroundSprite) this.#onTrackBackgroundChanged(sprite);
  }

  #setValueFromTouch(world: readonly [number, number]): void {
    const [start, end] = this.trackStartingOffsets;
    const size = this.renderSize[0];
    const position = world[0] - this.worldMatrix[4] + size / 2;
    const ratio = (position - start) / (size - start - end);
    this.value = this.#minimum + (this.#maximum - this.#minimum) * (this.isDirectionReversed ? 1 - ratio : ratio);
  }

  #closestTick(raw: number): number {
    if (this.#maximum === this.#minimum) return this.#minimum;
    const step = (this.#maximum - this.#minimum) / this.#tickFrequency;
    return Math.round((raw - this.#minimum) / step) * step + this.#minimum;
  }

  #increment(): number {
    return this.#shouldSnapToTicks ? Math.max(this.#step, (this.#maximum - this.#minimum) / this.#tickFrequency) : this.#step;
  }

  #coerceMaximum(value: number): void {
    this.#maximum = Math.max(value, this.#minimum);
    this.value = this.#value;
  }

  #onTrackBackgroundChanged(sprite: SpriteFrame | undefined): void {
    this.#trackBackgroundSprite = sprite;
    this.invalidateMeasure();
  }
}
