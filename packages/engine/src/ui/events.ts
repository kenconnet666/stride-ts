/**
 * UI 的路由事件（Stride 的 RoutedEvent、RoutedEventArgs、EventManager）：事件从源元素出发，冒泡（bubble）的一路传给父元素，
 * 隧道（tunnel）的从根传到源元素，直接（direct）的只给源元素。每个元素先跑类处理函数（元素自己的行为，比如按钮在按下时
 * 变成按下状态），再跑登记的处理函数；handled 之后后面的处理函数不再收到（登记时说了 handledEventsToo 的除外）。
 */
import type { UIElement } from './UIElement';

export type RoutingStrategy = 'bubble' | 'tunnel' | 'direct';

export class RoutedEvent<A extends RoutedEventArgs = RoutedEventArgs> {
  readonly name: string;
  readonly strategy: RoutingStrategy;
  declare readonly __args: A;

  constructor(name: string, strategy: RoutingStrategy) {
    this.name = name;
    this.strategy = strategy;
  }
}

export class RoutedEventArgs {
  routedEvent: RoutedEvent | undefined;
  /** 最早发出事件的元素。 */
  source: UIElement | undefined;
  /** 设成 true 后，后面的处理函数（没说 handledEventsToo 的）不再收到。 */
  handled = false;

  constructor(routedEvent?: RoutedEvent) {
    this.routedEvent = routedEvent;
  }
}

/** 指针事件的动作（Stride 的 TouchAction）。 */
export type TouchAction = 'down' | 'move' | 'up';

/** 指针事件（Stride 的 TouchEventArgs）：位置是画布里的 0..1 和 UI 的虚拟坐标。 */
export class TouchEventArgs extends RoutedEventArgs {
  action: TouchAction = 'down';
  /** 游戏时间，秒。 */
  timestamp = 0;
  /** 画布里归一化到 0..1 的位置。 */
  screenPosition: readonly [number, number] = [0, 0];
  screenTranslation: readonly [number, number] = [0, 0];
  /** UI 虚拟坐标里的位置（左上角是原点，同 UIElement 的世界矩阵）。 */
  worldPosition: readonly [number, number] = [0, 0];
  /** 和上一个事件的位置差，虚拟坐标。 */
  worldTranslation: readonly [number, number] = [0, 0];
}

/** 按键事件（Stride 的 KeyEventArgs）：key 是 KeyboardEvent.code。 */
export class KeyEventArgs extends RoutedEventArgs {
  key = '';
}

export type RoutedEventHandler<A extends RoutedEventArgs> = (sender: UIElement, args: A) => void;

interface HandlerInfo {
  readonly handler: RoutedEventHandler<never>;
  readonly handledEventsToo: boolean;
}

/** 类处理函数：按元素的类登记（Stride 的 EventManager.RegisterClassHandler），子类继承父类的。 */
const classHandlers = new Map<RoutedEvent, Map<abstract new (...args: never[]) => UIElement, RoutedEventHandler<never>>>();

export function registerClassHandler<A extends RoutedEventArgs>(type: abstract new (...args: never[]) => UIElement, event: RoutedEvent<A>, handler: RoutedEventHandler<A>): void {
  let handlers = classHandlers.get(event);
  if (!handlers) classHandlers.set(event, (handlers = new Map()));
  handlers.set(type, handler as RoutedEventHandler<never>);
}

/** 元素的类（或最近的父类）登记的处理函数。 */
function classHandlerOf(element: UIElement, event: RoutedEvent): RoutedEventHandler<never> | undefined {
  const handlers = classHandlers.get(event);
  if (!handlers) return undefined;
  for (let type = element.constructor; type && type !== Object; type = Object.getPrototypeOf(type)) {
    const handler = handlers.get(type as abstract new (...args: never[]) => UIElement);
    if (handler) return handler;
  }
  return undefined;
}

/** 每个元素登记的处理函数（UIElement 用 WeakMap 存，不占元素的字段）。 */
const elementHandlers = new WeakMap<UIElement, Map<RoutedEvent, HandlerInfo[]>>();

export function addHandler<A extends RoutedEventArgs>(element: UIElement, event: RoutedEvent<A>, handler: RoutedEventHandler<A>, handledEventsToo = false): void {
  let handlers = elementHandlers.get(element);
  if (!handlers) elementHandlers.set(element, (handlers = new Map()));
  const key = event;
  handlers.set(key, [...(handlers.get(key) ?? []), { handler: handler as RoutedEventHandler<never>, handledEventsToo }]);
}

export function removeHandler<A extends RoutedEventArgs>(element: UIElement, event: RoutedEvent<A>, handler: RoutedEventHandler<A>): void {
  const handlers = elementHandlers.get(element);
  const key = event;
  const list = handlers?.get(key);
  if (!list) return;
  const index = list.findIndex((info) => info.handler === handler);
  if (index >= 0) handlers!.set(key, list.toSpliced(index, 1));
}

/** 从 element 发出事件，按事件的路由方式传（Stride 的 UIElement.RaiseEvent）。 */
export function raiseEvent(element: UIElement, args: RoutedEventArgs): void {
  const event = args.routedEvent;
  if (!event) return;
  const sourceWasUnset = args.source === undefined;
  if (sourceWasUnset) args.source = element;
  propagate(element, args, event);
  if (sourceWasUnset) args.source = undefined;
}

function propagate(element: UIElement, args: RoutedEventArgs, event: RoutedEvent): void {
  if (event.strategy === 'tunnel' && element.visualParent) propagate(element.visualParent, args, event);
  const classHandler = classHandlerOf(element, event);
  if (classHandler && !args.handled) classHandler(element, args as never);
  // 增删处理函数时换成新的数组，这一轮还按原来的跑
  for (const { handler, handledEventsToo } of elementHandlers.get(element)?.get(event) ?? []) {
    if (handledEventsToo || !args.handled) handler(element, args as never);
  }
  if (event.strategy === 'bubble' && element.visualParent) propagate(element.visualParent, args, event);
}
