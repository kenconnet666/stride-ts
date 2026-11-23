/**
 * 接触事件（Stride.BepuPhysics 的 IContactHandler）：碰撞体设了处理器后，和别的物体开始接触、接触期间每步、不再接触时回调。
 * 按一对物体算（复合碰撞体的多个形状算一次）；物体睡着时接触还在（同 Bepu）。用 `game.simulation.setContactHandler(entity, handler)`
 * 设，场景里 ContactEventHandler 是 Trigger 的碰撞体自带一个 TriggerHandler（`simulation.contactHandler(entity)` 取）。
 */
import type { EntityId } from '../data/prop';

/** 一次接触：自己（设了处理器的实体）和对方。 */
export interface Contact {
  readonly entity: EntityId;
  readonly other: EntityId;
}

/** 开始接触：两者在接触点上互相接近的速度（米/秒，碰撞求解之前的、沿接触法线；Stride 没有）。撞得多狠——可破碎、撞击声——按它。 */
export interface StartedContact extends Contact {
  readonly speed: number;
  /** 接触点（几个接触点的平均，世界位置，双精度）。 */
  readonly point: readonly [number, number, number];
  /** 接触的法线（单位向量，从自己指向对方）。 */
  readonly normal: readonly [number, number, number];
}

/** 正在接触：这一个物理步里两者最深的穿透深度（米，正数是陷进去）。 */
export interface TouchingContact extends Contact {
  readonly depth: number;
}

export interface ContactHandler {
  /** 只检测、不产生碰撞响应（Stride 的 NoContactResponse）；设处理器时读一次。 */
  readonly noContactResponse?: boolean;
  /**
   * 破碎速度（米/秒，Stride 没有）：开始接触时接近的速度（StartedContact.speed）到它，这一对这一步不做碰撞响应——物体要换成碎块了，
   * 撞它的东西带着原来的速度穿进去、撞上碎块（Breakable 用）。设处理器时读一次；没有或 0 是照常挡住。
   */
  readonly breakSpeed?: number;
  onStartedTouching?(contact: StartedContact): void;
  /**
   * 接触期间每个物理步调一次（Stride 的 OnTouching，那里给每个接触点，这里给这一步最深的深度）。设处理器时看有没有这个方法，
   * 有才让原生侧报（每步每对物体一个事件）。
   */
  onTouching?(contact: TouchingContact): void;
  onStoppedTouching?(contact: Contact): void;
}

type TriggerListener = (contact: Contact) => void;

/**
 * Stride 的 Trigger（ContactEventHandler）：不挡东西，物体进出时通知 onEnter、onLeave 的监听者。
 *
 *   this.disposables.use(trigger.onEnter(({ other }) => ...));
 */
export class TriggerHandler implements ContactHandler {
  readonly noContactResponse = true;
  readonly #enter = new Set<TriggerListener>();
  readonly #leave = new Set<TriggerListener>();

  /** 物体进入时调用 listener；返回的 Disposable 取消监听。 */
  onEnter(listener: TriggerListener): Disposable {
    return subscribe(this.#enter, listener);
  }

  onLeave(listener: TriggerListener): Disposable {
    return subscribe(this.#leave, listener);
  }

  onStartedTouching(contact: Contact): void {
    for (const listener of [...this.#enter]) listener(contact);
  }

  onStoppedTouching(contact: Contact): void {
    for (const listener of [...this.#leave]) listener(contact);
  }
}

function subscribe(listeners: Set<TriggerListener>, listener: TriggerListener): Disposable {
  listeners.add(listener);
  return { [Symbol.dispose]: () => void listeners.delete(listener) };
}
