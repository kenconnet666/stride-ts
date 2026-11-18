/**
 * 接触事件（Stride.BepuPhysics 的 IContactHandler）：碰撞体设了处理器后，和别的物体开始接触、不再接触时回调。
 * 按一对物体算（复合碰撞体的多个形状算一次）；物体睡着时接触还在（同 Bepu）。用 `game.simulation.setContactHandler(entity, handler)`
 * 设，场景里 ContactEventHandler 是 Trigger 的碰撞体自带一个 TriggerHandler（`simulation.contactHandler(entity)` 取）。
 */
import type { EntityId } from '../data/prop';

/** 一次接触：自己（设了处理器的实体）和对方。 */
export interface Contact {
  readonly entity: EntityId;
  readonly other: EntityId;
}

export interface ContactHandler {
  /** 只检测、不产生碰撞响应（Stride 的 NoContactResponse）；设处理器时读一次。 */
  readonly noContactResponse?: boolean;
  onStartedTouching?(contact: Contact): void;
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
