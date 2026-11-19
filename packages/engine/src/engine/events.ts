/**
 * 两种事件（docs/architecture.md 的“事件”）：
 *
 * - EventKey<T>：广播，同 Stride。每个接收者各有一个队列；同步脚本每帧取空一次，异步脚本 await receive()。
 * - Hook<T>：组件自己做某件事之前发出的同步、可拦截的通知。处理函数按登记顺序在组件自己的行为之前运行，
 *   调用 preventDefault() 就跳过那个行为。事件对象每次派发都复用，处理函数不能把它存下来。
 */

export class EventKey<T> {
  readonly #receivers = new Set<EventReceiver<T>>();

  /** 把值放进现有每个接收者的队列。 */
  broadcast(value: T): void {
    for (const receiver of this.#receivers) receiver.push(value);
  }

  /** 新的接收者，用完要释放（脚本里用 this.receive(key)，随脚本一起释放）。 */
  receiver(): EventReceiver<T> {
    const receiver = new EventReceiver<T>(() => this.#receivers.delete(receiver));
    this.#receivers.add(receiver);
    return receiver;
  }

  get receiverCount(): number {
    return this.#receivers.size;
  }
}

export class EventReceiver<T> implements Disposable {
  #queue: T[] = [];
  #waiting: { resolve: (value: T) => void; reject: (reason: unknown) => void; signal: AbortSignal | undefined; onAbort: () => void }[] = [];
  readonly #detach: () => void;
  #disposed = false;

  constructor(detach: () => void) {
    this.#detach = detach;
  }

  /** @internal 由事件键调用。有正在等的 receive() 时先给它。 */
  push(value: T): void {
    const waiter = this.#waiting.shift();
    if (waiter) {
      waiter.signal?.removeEventListener('abort', waiter.onAbort);
      waiter.resolve(value);
    } else {
      this.#queue.push(value);
    }
  }

  /** 队列里最早的值，没有时是 undefined。 */
  tryReceive(): T | undefined {
    return this.#queue.shift();
  }

  /** 取走队列里最早的一个，返回有没有（Stride 无参数事件的 TryReceive；EventKey<void> 的 tryReceive 分不出有没有）。 */
  tryConsume(): boolean {
    if (this.#queue.length === 0) return false;
    this.#queue.shift();
    return true;
  }

  /** 队列里所有的值，从早到晚；之后队列为空。 */
  drain(): readonly T[] {
    if (this.#queue.length === 0) return EMPTY as readonly T[];
    const values = this.#queue;
    this.#queue = [];
    return values;
  }

  /** 下一个值：队列里有就取，没有就等下一次广播。signal 中止时拒绝。 */
  receive(signal?: AbortSignal): Promise<T> {
    if (this.#queue.length > 0) return Promise.resolve(this.#queue.shift()!);
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.#disposed) return Promise.reject(new Error('the receiver was disposed'));
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        this.#waiting = this.#waiting.filter((w) => w.onAbort !== onAbort);
        reject(signal!.reason);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#waiting.push({ resolve, reject, signal, onAbort });
    });
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#detach();
    this.#queue = [];
    for (const waiter of this.#waiting) waiter.reject(new Error('the receiver was disposed'));
    this.#waiting = [];
  }
}

const EMPTY: readonly never[] = Object.freeze([]);

/** 钩子处理函数拿到的东西：值，以及跳过组件自己行为的 preventDefault。 */
export interface HookEvent<T> {
  readonly value: T;
  readonly defaultPrevented: boolean;
  preventDefault(): void;
}

export type HookHandler<T> = (event: HookEvent<T>) => void;

class ReusedHookEvent<T> implements HookEvent<T> {
  #value: T | undefined;
  #active = false;
  #prevented = false;
  readonly #hookName: string;

  constructor(hookName: string) {
    this.#hookName = hookName;
  }

  get value(): T {
    this.#assertActive();
    return this.#value as T;
  }

  get defaultPrevented(): boolean {
    return this.#prevented;
  }

  preventDefault(): void {
    this.#assertActive();
    this.#prevented = true;
  }

  /** @internal */
  begin(value: T): void {
    this.#value = value;
    this.#active = true;
    this.#prevented = false;
  }

  /** @internal 派发结束后对象会复用：之后再读会读到别的派发的值，所以标成失效。 */
  end(): void {
    this.#active = false;
    this.#value = undefined;
  }

  #assertActive(): void {
    if (!this.#active) throw new Error(`a ${this.#hookName} event was kept after its handler returned; copy the values you need instead`);
  }
}

export class Hook<T> {
  readonly name: string;
  #handlers: HookHandler<T>[] = [];
  readonly #event: ReusedHookEvent<T>;
  #dispatching = false;

  constructor(name = 'hook') {
    this.name = name;
    this.#event = new ReusedHookEvent<T>(name);
  }

  /** 加一个处理函数；释放返回值就移除它（脚本里用 this.on(hook, handler)，随脚本移除）。 */
  on(handler: HookHandler<T>): Disposable {
    this.#handlers = [...this.#handlers, handler];
    return { [Symbol.dispose]: () => (this.#handlers = this.#handlers.filter((h) => h !== handler)) };
  }

  /**
   * 由拥有钩子的组件调用：先跑处理函数，没有人调用 preventDefault() 时再执行 `behaviour`。
   * 返回 behaviour 有没有执行。
   */
  run(value: T, behaviour?: (value: T) => void): boolean {
    if (this.#dispatching) throw new Error(`${this.name} was raised again from one of its own handlers`);
    this.#dispatching = true;
    this.#event.begin(value);
    let prevented: boolean;
    try {
      for (const handler of this.#handlers) handler(this.#event);
      prevented = this.#event.defaultPrevented;
    } finally {
      this.#event.end();
      this.#dispatching = false;
    }
    if (!prevented) behaviour?.(value);
    return !prevented;
  }
}

/** 在脚本或组件上声明钩子：`readonly opening = hook<{ by: EntityId }>('opening')`。 */
export function hook<T>(name?: string): Hook<T> {
  return new Hook<T>(name);
}
