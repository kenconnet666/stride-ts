/**
 * 手势识别（Stride.Input 的 Gestures）：点、长按、拖动、轻扫、双指的组合（平移、旋转、缩放）。往 `game.input.gestures` 里加配置，
 * 每帧从 `game.input.gestureEvents` 读识别出来的事件：
 *
 *   override start(): void { this.game.input.gestures.add(Gestures.drag('free', { minimumDragDistance: 0.02 })); }
 *   override update(): void {
 *     for (const event of this.game.input.gestureEvents) {
 *       if (event.type === 'drag' && event.state === 'began') this.#turn(event.totalTranslation);
 *     }
 *   }
 *
 * 状态机、默认值和判定的阈值照 Stride 的各个 GestureRecognizer。位置和距离是归一化的（画布的宽、高各是 1）；识别器内部按
 * 屏幕的宽高比把短边那一维换算到和长边同一个尺度再量距离，给出事件之前换回来（Stride 的 Unnormalize、Normalize）。
 * 和 Stride 不同：配置是不可变的普通对象（`Gestures.tap({ … })`），不是先 new 再改属性、加进集合以后冻结；时间用秒。
 */
import type { PointerEvent } from './InputManager';

/** 平移类手势限定的方向（Stride 的 GestureShape）。 */
export type GestureShape = 'horizontal' | 'vertical' | 'free';
/** 一次性的手势是 occurred；连续的手势依次是 began、changed……、ended。 */
export type GestureState = 'occurred' | 'began' | 'changed' | 'ended';
type Vec2 = readonly [number, number];

export interface TapConfig {
  readonly type: 'tap';
  readonly requiredNumberOfFingers: number;
  readonly requiredNumberOfTaps: number;
  /** 两次点之间最多隔多久（秒）。 */
  readonly maximumTimeBetweenTaps: number;
  /** 手指最多按多久还算点（秒）。 */
  readonly maximumPressTime: number;
  /** 多次点之间、点的过程中手指最多挪多远。 */
  readonly maximumDistanceTaps: number;
}
export interface LongPressConfig {
  readonly type: 'longPress';
  readonly requiredNumberOfFingers: number;
  /** 按住多久算长按（秒）。 */
  readonly requiredPressTime: number;
  /** 按住期间手指最多挪多远。 */
  readonly maximumTranslationDistance: number;
}
export interface DragConfig {
  readonly type: 'drag';
  readonly requiredNumberOfFingers: number;
  readonly shape: GestureShape;
  /** 拖过这么远手势才开始。 */
  readonly minimumDragDistance: number;
  /** shape 不是 free 时，垂直于那个方向最多偏多少（x、y）。 */
  readonly allowedErrorMargins: Vec2;
}
export interface FlickConfig {
  readonly type: 'flick';
  readonly requiredNumberOfFingers: number;
  readonly shape: GestureShape;
  /** 最小的平均速度（每秒多少个屏幕）。 */
  readonly minimumAverageSpeed: number;
  readonly minimumFlickLength: number;
  readonly allowedErrorMargins: Vec2;
}
export interface CompositeConfig {
  readonly type: 'composite';
  /** 固定是 2。 */
  readonly requiredNumberOfFingers: 2;
  /** 转过这么多弧度、缩放到这个倍数（或它的倒数）、或者中心挪了这么远，手势才开始。 */
  readonly minimumRotationAngle: number;
  readonly minimumScaleValue: number;
  readonly minimumTranslationDistance: number;
}
export type GestureConfig = TapConfig | LongPressConfig | DragConfig | FlickConfig | CompositeConfig;

type Options<C> = Partial<Omit<C, 'type' | 'shape'>>;

/** 各种手势的配置，默认值同 Stride。 */
export const Gestures = {
  tap: (options: Options<TapConfig> = {}): TapConfig => checked({
    type: 'tap', requiredNumberOfFingers: 1, requiredNumberOfTaps: 1, maximumTimeBetweenTaps: 0.4, maximumPressTime: 0.1, maximumDistanceTaps: 0.04, ...options,
  }),
  longPress: (options: Options<LongPressConfig> = {}): LongPressConfig => checked({
    type: 'longPress', requiredNumberOfFingers: 1, requiredPressTime: 0.75, maximumTranslationDistance: 0.02, ...options,
  }),
  drag: (shape: GestureShape = 'free', options: Options<DragConfig> = {}): DragConfig => checked({
    type: 'drag', shape, requiredNumberOfFingers: 1, minimumDragDistance: 0.02, allowedErrorMargins: [0.02, 0.02], ...options,
  }),
  flick: (shape: GestureShape = 'free', options: Options<FlickConfig> = {}): FlickConfig => checked({
    type: 'flick', shape, requiredNumberOfFingers: 1, minimumAverageSpeed: 0.4, minimumFlickLength: 0.04, allowedErrorMargins: [0.02, 0.02], ...options,
  }),
  composite: (options: Omit<Options<CompositeConfig>, 'requiredNumberOfFingers'> = {}): CompositeConfig => checked({
    type: 'composite', requiredNumberOfFingers: 2, minimumRotationAngle: 0.1, minimumScaleValue: 1.075, minimumTranslationDistance: 0.016, ...options,
  }),
} as const;

function checked<C extends GestureConfig>(config: C): C {
  if (!Number.isInteger(config.requiredNumberOfFingers) || config.requiredNumberOfFingers < 1) throw new RangeError('a gesture needs at least one finger');
  if (config.type === 'tap' && (!Number.isInteger(config.requiredNumberOfTaps) || config.requiredNumberOfTaps < 1)) throw new RangeError('a tap gesture needs at least one tap');
  if (config.type === 'composite' && config.minimumScaleValue <= 1) throw new RangeError('minimumScaleValue must be greater than 1');
  return Object.freeze(config);
}

interface GestureEventBase {
  readonly state: GestureState;
  readonly numberOfFingers: number;
  /** 离这个手势上一个事件多久（秒）。 */
  readonly deltaTime: number;
  /** 手势开始以来多久（秒）。 */
  readonly totalTime: number;
}
export interface TapEvent extends GestureEventBase {
  readonly type: 'tap';
  readonly numberOfTaps: number;
  readonly tapPosition: Vec2;
}
export interface LongPressEvent extends GestureEventBase {
  readonly type: 'longPress';
  readonly position: Vec2;
}
interface TranslationEvent extends GestureEventBase {
  readonly shape: GestureShape;
  readonly startPosition: Vec2;
  readonly currentPosition: Vec2;
  /** 离上一个事件挪了多少。 */
  readonly deltaTranslation: Vec2;
  readonly totalTranslation: Vec2;
  /** 每秒多少个屏幕。 */
  readonly averageSpeed: Vec2;
}
export interface DragEvent extends TranslationEvent {
  readonly type: 'drag';
}
export interface FlickEvent extends TranslationEvent {
  readonly type: 'flick';
}
export interface CompositeEvent extends GestureEventBase {
  readonly type: 'composite';
  readonly centerBeginningPosition: Vec2;
  readonly centerCurrentPosition: Vec2;
  /** 弧度；两指连线离上一个事件、离开始转了多少。 */
  readonly deltaRotation: number;
  readonly totalRotation: number;
  /** 两指的距离是开始时的几倍；delta 是和上一个事件的差。 */
  readonly deltaScale: number;
  readonly totalScale: number;
  readonly deltaTranslation: Vec2;
  readonly totalTranslation: Vec2;
}
export type GestureEvent = TapEvent | LongPressEvent | DragEvent | FlickEvent | CompositeEvent;

type Point = [number, number];
const length = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const subtract = (a: Vec2, b: Vec2): Point => [a[0] - b[0], a[1] - b[1]];
function mean(points: Iterable<Vec2>): Point {
  let x = 0, y = 0, count = 0;
  for (const point of points) {
    x += point[0];
    y += point[1];
    count++;
  }
  return [x / count, y / count];
}

/** 一种手势的识别器：每帧喂这一帧的指针事件，给出识别到的手势事件（Stride 的 GestureRecognizer）。 */
export abstract class GestureRecognizer {
  /** 画布的宽除以高；量距离之前把短边那一维换到和长边同一个尺度。 */
  screenRatio: number;
  protected readonly beginPositions = new Map<number, Point>();
  protected readonly lastPositions = new Map<number, Point>();
  protected events: GestureEvent[] = [];
  protected elapsedSinceBeginning = 0;
  protected elapsedSinceLast = 0;
  readonly #moved = new Map<number, Point>();
  #started = false;

  constructor(screenRatio: number) {
    this.screenRatio = screenRatio;
  }

  /** 这一帧的事件追加到 out。elapsed 是秒。 */
  process(elapsed: number, pointerEvents: readonly PointerEvent[], out: GestureEvent[]): void {
    this.elapsedSinceBeginning += elapsed;
    this.elapsedSinceLast += elapsed;
    this.events = out;
    this.processPointerEvents(elapsed, pointerEvents);
  }

  protected get started(): boolean {
    return this.#started;
  }

  protected set started(value: boolean) {
    if (value && !this.#started) this.elapsedSinceBeginning = this.elapsedSinceLast = 0;
    this.#started = value;
  }

  protected get fingersOnScreen(): number {
    return this.lastPositions.size;
  }

  protected processPointerEvents(_elapsed: number, pointerEvents: readonly PointerEvent[]): void {
    this.analyse(pointerEvents);
  }

  /** 按下、抬起逐个处理；移动先攒着（每根手指只留最后的位置），到抬起之前或者这一帧末尾一起处理。 */
  protected analyse(pointerEvents: readonly PointerEvent[]): void {
    for (const { eventType, pointerId, position } of pointerEvents) {
      if (eventType === 'pressed') this.down(pointerId, this.unnormalize(position));
      else if (eventType === 'moved') {
        if (this.beginPositions.has(pointerId)) this.#moved.set(pointerId, this.unnormalize(position));
      } else {
        this.#flushMoves();
        this.up(pointerId, this.unnormalize(position));
      }
    }
    this.#flushMoves();
  }

  /** 识别器内部的尺度换回归一化的（给事件用）。 */
  protected normalize([x, y]: Vec2): Point {
    return this.screenRatio > 1 ? [x, y * this.screenRatio] : [x / this.screenRatio, y];
  }

  protected unnormalize([x, y]: Vec2): Point {
    return this.screenRatio > 1 ? [x, y / this.screenRatio] : [x * this.screenRatio, y];
  }

  #flushMoves(): void {
    if (this.#moved.size === 0) return;
    this.moved(this.#moved);
    this.#moved.clear();
  }

  protected abstract down(id: number, position: Point): void;
  protected abstract moved(positions: ReadonlyMap<number, Point>): void;
  protected abstract up(id: number, position: Point): void;
}

class TapRecognizer extends GestureRecognizer {
  readonly #config: TapConfig;
  #taps = 0;
  #sinceTakeOff = 0;
  #sinceDown = 0;
  #isDown = false;
  #maxFingers = 0;

  constructor(config: TapConfig, screenRatio: number) {
    super(screenRatio);
    this.#config = config;
  }

  protected override processPointerEvents(elapsed: number, pointerEvents: readonly PointerEvent[]): void {
    if (this.#isDown) this.#sinceDown += elapsed;
    else this.#sinceTakeOff += elapsed;
    this.analyse(pointerEvents);
    if (this.started && (this.#sinceDown > this.#config.maximumPressTime || this.#sinceTakeOff > this.#config.maximumTimeBetweenTaps)) this.#end();
  }

  protected down(id: number, position: Point): void {
    if (!this.beginPositions.has(id)) this.beginPositions.set(id, position);
    this.lastPositions.set(id, position);
    this.#maxFingers = Math.max(this.#maxFingers, this.fingersOnScreen);
    this.#isDown = true;
    if (this.fingersOnScreen === 1) {
      this.#sinceTakeOff = this.#sinceDown = 0;
      this.started = true;
    }
    if (this.started && this.#maxFingers > this.#config.requiredNumberOfFingers) this.#end();
    // 这一下离之前点的地方太远：前面的那组点到此为止，从这一下重新开始
    if (this.started && ![...this.beginPositions.values()].some((begin) => length(position, begin) < this.#config.maximumDistanceTaps)) {
      this.#end();
      this.#maxFingers = this.fingersOnScreen;
      this.#sinceTakeOff = this.#sinceDown = 0;
      this.started = true;
      for (const [finger, last] of this.lastPositions) this.beginPositions.set(finger, last);
    }
  }

  protected moved(positions: ReadonlyMap<number, Point>): void {
    if (!this.started) return;
    for (const [id, position] of positions) {
      const last = this.lastPositions.get(id);
      if (last && length(position, last) > this.#config.maximumDistanceTaps) return this.#end();
    }
  }

  protected up(id: number): void {
    if (!this.lastPositions.delete(id) || this.fingersOnScreen > 0) return;
    this.#sinceTakeOff = 0;
    this.#isDown = false;
    if (this.started && this.#maxFingers === this.#config.requiredNumberOfFingers) this.#taps++;
    this.#maxFingers = 0;
  }

  #end(): void {
    if (this.#taps === this.#config.requiredNumberOfTaps) {
      this.events.push({
        type: 'tap', state: 'occurred', numberOfFingers: this.#config.requiredNumberOfFingers, deltaTime: this.elapsedSinceBeginning,
        totalTime: this.elapsedSinceBeginning, numberOfTaps: this.#taps, tapPosition: this.normalize(mean(this.beginPositions.values())),
      });
    }
    this.#taps = 0;
    this.started = false;
    this.beginPositions.clear();
  }
}

class LongPressRecognizer extends GestureRecognizer {
  readonly #config: LongPressConfig;

  constructor(config: LongPressConfig, screenRatio: number) {
    super(screenRatio);
    this.#config = config;
  }

  protected override get fingersOnScreen(): number {
    return this.beginPositions.size;
  }

  protected override processPointerEvents(_elapsed: number, pointerEvents: readonly PointerEvent[]): void {
    this.analyse(pointerEvents);
    if (!this.started || this.elapsedSinceBeginning < this.#config.requiredPressTime) return;
    this.events.push({
      type: 'longPress', state: 'occurred', numberOfFingers: this.#config.requiredNumberOfFingers, deltaTime: this.elapsedSinceBeginning,
      totalTime: this.elapsedSinceBeginning, position: this.normalize(mean(this.beginPositions.values())),
    });
    this.started = false;
  }

  protected down(id: number, position: Point): void {
    this.beginPositions.set(id, position);
    this.started = this.fingersOnScreen === this.#config.requiredNumberOfFingers;
  }

  protected moved(positions: ReadonlyMap<number, Point>): void {
    for (const [id, position] of positions) {
      if (length(position, this.beginPositions.get(id)!) > this.#config.maximumTranslationDistance) this.started = false;
    }
  }

  protected up(id: number): void {
    this.beginPositions.delete(id);
    this.started = this.fingersOnScreen === this.#config.requiredNumberOfFingers;
  }
}

/** 连续的手势（拖动、组合）共用的开始、变化、结束（Stride 的 GestureRecognizerContMotion）。 */
abstract class ContinuousRecognizer extends GestureRecognizer {
  protected beganSent = false;
  protected abstract readonly requiredFingers: number;

  protected down(id: number, position: Point): void {
    this.#fingerChanged(true, id, position);
  }

  protected up(id: number, position: Point): void {
    if (this.lastPositions.has(id)) this.#fingerChanged(false, id, position);
  }

  #fingerChanged(isDown: boolean, id: number, position: Point): void {
    const wasStarted = this.started;
    this.started = this.fingersOnScreen + (isDown ? 1 : -1) === this.requiredFingers;
    if (isDown) {
      this.beginPositions.set(id, position);
      this.lastPositions.set(id, position);
    } else {
      this.beginPositions.delete(id);
      this.lastPositions.delete(id);
    }
    if (this.started) this.initialize();
    else if (wasStarted && this.beganSent) this.emit('ended');
  }

  protected moved(positions: ReadonlyMap<number, Point>): void {
    for (const [id, position] of positions) this.lastPositions.set(id, position);
    if (!this.started) return;
    this.updateVariables();
    if (!this.beganSent && this.started && this.beginningConditionFulfilled()) {
      this.emit('began');
      this.beganSent = true;
    }
    if (this.beganSent) this.emit(this.started ? 'changed' : 'ended');
  }

  /** 发一个事件；子类先填事件再调这里。 */
  protected emit(state: GestureState): void {
    this.elapsedSinceLast = 0;
    if (state === 'ended') this.beganSent = false;
  }

  protected abstract initialize(): void;
  protected abstract updateVariables(): void;
  protected abstract beginningConditionFulfilled(): boolean;
}

class DragRecognizer extends ContinuousRecognizer {
  readonly #config: DragConfig;
  #filtered = new Map<number, Point>();
  #start: Point = [0, 0];
  #last: Point = [0, 0];
  #current: Point = [0, 0];

  constructor(config: DragConfig, screenRatio: number) {
    super(screenRatio);
    this.#config = config;
  }

  protected get requiredFingers(): number {
    return this.#config.requiredNumberOfFingers;
  }

  protected initialize(): void {
    this.#start = mean(this.lastPositions.values());
    this.#last = this.#start;
    this.#filtered = new Map(this.lastPositions);
  }

  protected updateVariables(): void {
    for (const [id, position] of this.lastPositions) {
      const filtered = this.#filtered.get(id)!;
      if (this.#config.shape !== 'free') {
        // 横向的拖动看 y 偏了多少，纵向的看 x
        const axis = this.#config.shape === 'horizontal' ? 1 : 0;
        if (Math.abs(position[axis] - filtered[axis]) > this.#config.allowedErrorMargins[axis]) this.started = false;
      }
      // 低通滤过的位置：慢慢跟着手指，偏离只和最近的走向比
      this.#filtered.set(id, [filtered[0] * 0.9 + position[0] * 0.1, filtered[1] * 0.9 + position[1] * 0.1]);
    }
    this.#current = mean(this.lastPositions.values());
  }

  protected beginningConditionFulfilled(): boolean {
    return length(this.#current, this.#start) >= this.#config.minimumDragDistance;
  }

  protected override emit(state: GestureState): void {
    const start = this.normalize(this.#start), current = this.normalize(this.#current);
    this.events.push(translation('drag', state, this.#config.requiredNumberOfFingers, this.elapsedSinceLast, this.elapsedSinceBeginning, this.#config.shape,
      start, current, this.normalize(subtract(this.#current, this.#last))));
    this.#last = this.#current;
    super.emit(state);
  }
}

class FlickRecognizer extends GestureRecognizer {
  readonly #config: FlickConfig;

  constructor(config: FlickConfig, screenRatio: number) {
    super(screenRatio);
    this.#config = config;
  }

  protected down(id: number, position: Point): void {
    this.beginPositions.set(id, position);
    this.lastPositions.set(id, position);
    this.started = this.fingersOnScreen === this.#config.requiredNumberOfFingers;
  }

  protected moved(positions: ReadonlyMap<number, Point>): void {
    if (!this.started) return;
    for (const [id, position] of positions) {
      if (this.#config.shape !== 'free') {
        const axis = this.#config.shape === 'horizontal' ? 1 : 0;
        if (Math.abs(position[axis] - this.beginPositions.get(id)![axis]) > this.#config.allowedErrorMargins[axis]) this.started = false;
      }
      this.lastPositions.set(id, position);
    }
    if (!this.started) return;
    const start = mean(this.beginPositions.values()), current = mean(this.lastPositions.values());
    const distance = length(current, start);
    if (distance <= this.#config.minimumFlickLength || distance / this.elapsedSinceBeginning <= this.#config.minimumAverageSpeed) return;
    this.events.push(translation('flick', 'occurred', this.#config.requiredNumberOfFingers, this.elapsedSinceBeginning, this.elapsedSinceBeginning, this.#config.shape,
      this.normalize(start), this.normalize(current), this.normalize(subtract(current, start))));
    this.started = false;
  }

  protected up(id: number): void {
    this.beginPositions.delete(id);
    this.lastPositions.delete(id);
    this.started = this.fingersOnScreen === this.#config.requiredNumberOfFingers;
  }
}

class CompositeRecognizer extends ContinuousRecognizer {
  readonly #config: CompositeConfig;
  protected readonly requiredFingers = 2;
  #first = 0;
  #second = 0;
  #beginDirection: Point = [1, 0];
  #beginLength = 0;
  #beginCenter: Point = [0, 0];
  #lastCenter: Point = [0, 0];
  #currentCenter: Point = [0, 0];
  #rotation = 0;
  #lastRotation = 0;
  #scale = 1;
  #lastScale = 1;

  constructor(config: CompositeConfig, screenRatio: number) {
    super(screenRatio);
    this.#config = config;
  }

  protected initialize(): void {
    [this.#first, this.#second] = [...this.lastPositions.keys()] as [number, number];
    const [a, b] = [this.lastPositions.get(this.#first)!, this.lastPositions.get(this.#second)!];
    const direction = subtract(b, a);
    this.#beginLength = Math.hypot(...direction);
    this.#beginDirection = [direction[0] / (this.#beginLength || 1), direction[1] / (this.#beginLength || 1)];
    this.#beginCenter = this.#lastCenter = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    this.#lastRotation = 0;
    this.#lastScale = 1;
  }

  protected beginningConditionFulfilled(): boolean {
    return Math.abs(this.#rotation) >= this.#config.minimumRotationAngle
      || this.#scale <= 1 / this.#config.minimumScaleValue || this.#scale >= this.#config.minimumScaleValue
      || length(this.#currentCenter, this.#beginCenter) >= this.#config.minimumTranslationDistance;
  }

  protected updateVariables(): void {
    const [a, b] = [this.lastPositions.get(this.#first)!, this.lastPositions.get(this.#second)!];
    const vector = subtract(b, a), size = Math.hypot(...vector);
    const direction: Point = [vector[0] / (size || 1), vector[1] / (size || 1)];
    const sign = Math.sign(this.#beginDirection[0] * direction[1] - this.#beginDirection[1] * direction[0]);
    const cosine = Math.min(1, Math.max(-1, direction[0] * this.#beginDirection[0] + direction[1] * this.#beginDirection[1]));
    this.#rotation = sign * Math.acos(cosine);
    this.#currentCenter = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    this.#scale = Math.abs(this.#beginLength) > 1e-6 ? size / this.#beginLength : 0;
  }

  protected override emit(state: GestureState): void {
    const begin = this.normalize(this.#beginCenter), last = this.normalize(this.#lastCenter), current = this.normalize(this.#currentCenter);
    this.events.push({
      type: 'composite', state, numberOfFingers: 2, deltaTime: this.elapsedSinceLast, totalTime: this.elapsedSinceBeginning,
      centerBeginningPosition: begin, centerCurrentPosition: current,
      deltaRotation: this.#rotation - this.#lastRotation, totalRotation: this.#rotation, deltaScale: this.#scale - this.#lastScale, totalScale: this.#scale,
      deltaTranslation: subtract(current, last), totalTranslation: subtract(current, begin),
    });
    this.#lastRotation = this.#rotation;
    this.#lastScale = this.#scale;
    this.#lastCenter = this.#currentCenter;
    super.emit(state);
  }
}

function translation<T extends 'drag' | 'flick'>(type: T, state: GestureState, numberOfFingers: number, deltaTime: number, totalTime: number, shape: GestureShape,
  startPosition: Point, currentPosition: Point, deltaTranslation: Point): Extract<GestureEvent, { type: T }> {
  const totalTranslation = subtract(currentPosition, startPosition);
  // 除数加一点，免得刚开始时除以 0（同 Stride）
  const seconds = totalTime + 0.0001;
  return {
    type, state, numberOfFingers, deltaTime, totalTime, shape, startPosition, currentPosition, deltaTranslation, totalTranslation,
    averageSpeed: [totalTranslation[0] / seconds, totalTranslation[1] / seconds],
  } as Extract<GestureEvent, { type: T }>;
}

/** 给一种手势的配置建识别器。 */
export function createGestureRecognizer(config: GestureConfig, screenRatio: number): GestureRecognizer {
  switch (config.type) {
    case 'tap': return new TapRecognizer(config, screenRatio);
    case 'longPress': return new LongPressRecognizer(config, screenRatio);
    case 'drag': return new DragRecognizer(config, screenRatio);
    case 'flick': return new FlickRecognizer(config, screenRatio);
    case 'composite': return new CompositeRecognizer(config, screenRatio);
  }
}

/** 正在识别的手势（Stride 的 InputManager.Gestures）：加进去的配置各有一个识别器，移除就停止识别。 */
export class GestureCollection implements Iterable<GestureConfig> {
  readonly #recognizers = new Map<GestureConfig, GestureRecognizer>();
  #screenRatio = 1;

  /** 加一种手势；同一个配置对象加两次只算一次。返回这个配置，移除时用。 */
  add<C extends GestureConfig>(config: C): C {
    if (!this.#recognizers.has(config)) this.#recognizers.set(config, createGestureRecognizer(config, this.#screenRatio));
    return config;
  }

  remove(config: GestureConfig): boolean {
    return this.#recognizers.delete(config);
  }

  clear(): void {
    this.#recognizers.clear();
  }

  get size(): number {
    return this.#recognizers.size;
  }

  [Symbol.iterator](): Iterator<GestureConfig> {
    return this.#recognizers.keys();
  }

  /** @internal 每帧由 InputManager 调用：这一帧的指针事件喂给每个识别器，返回识别到的手势事件。 */
  process(elapsed: number, pointerEvents: readonly PointerEvent[], screenRatio: number): GestureEvent[] {
    this.#screenRatio = screenRatio;
    const events: GestureEvent[] = [];
    for (const recognizer of this.#recognizers.values()) {
      recognizer.screenRatio = screenRatio;
      recognizer.process(elapsed, pointerEvents, events);
    }
    return events;
  }
}
