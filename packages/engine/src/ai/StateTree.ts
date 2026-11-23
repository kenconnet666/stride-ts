/**
 * 状态树的运行（格式和规则见 content/formats/stateTreeFormat.ts）：`StateTreeInstance` 只管选状态、跑任务、换状态，不依赖实体，
 * 任务通过 context 拿实体和游戏（单测里可以不给）。StateTreeRunner 脚本每帧调 update。
 *
 * 和虚幻的 StateTree 对应：状态的进入条件（Enter Conditions）、任务（Tasks，状态完成看任何一个任务）、过渡（Transitions：
 * On State Completed/Succeeded/Failed、On Tick、On Event，目标 Next/Root/Succeeded/Failed）、参数（Parameters）。没有的：
 * 评估器（Evaluators，用游戏代码设参数代替）、链接别的树（Linked Subtree）、过渡的优先级和延迟。
 */
import type { Entity } from '../engine/Entity';
import type { Game } from '../engine/Game';
import type { StateTreeConditionData, StateTreeData, StateTreeStateData, StateTreeTaskData } from '../content/formats/stateTreeFormat';
import { Vector3, type Vec3Like } from '../data/vectors';
import { Transform } from '../engine/transform';

/** 加载好的状态树资源。 */
export interface StateTree {
  readonly path: string;
  readonly data: StateTreeData;
}

/** 任务、整棵树的状况。 */
export type StateTreeStatus = 'running' | 'succeeded' | 'failed';

/** 任务和条件拿到的东西。 */
export interface StateTreeContext {
  readonly tree: StateTreeInstance;
  /** 跑这棵树的实体（单测里可以没有）。 */
  readonly entity: Entity | undefined;
  readonly game: Game | undefined;
}

/** 一个任务在一次状态里的运行：进入状态时由工厂建，每帧 update，离开状态时 exit。 */
export interface StateTreeTaskRun {
  /** 这一帧以后的状况；没有 update 的任务一直在跑（靠过渡离开）。 */
  update?(elapsed: number): StateTreeStatus;
  exit?(): void;
}

/** 建一个任务的运行（进入状态时调）。 */
export type StateTreeTaskFactory = (context: StateTreeContext, args: Readonly<Record<string, unknown>>) => StateTreeTaskRun;
/** 一个条件。 */
export type StateTreeConditionFunction = (context: StateTreeContext, args: Readonly<Record<string, unknown>>) => boolean;

const customTasks = new Map<string, StateTreeTaskFactory>();
const customConditions = new Map<string, StateTreeConditionFunction>();

/** 登记状态树文件里 `{ type: 'call', name }` 的任务。 */
export function registerStateTreeTask(name: string, factory: StateTreeTaskFactory): void {
  customTasks.set(name, factory);
}

/** 登记状态树文件里 `{ type: 'call', name }` 的条件。 */
export function registerStateTreeCondition(name: string, condition: StateTreeConditionFunction): void {
  customConditions.set(name, condition);
}

type BuiltInTaskType = Exclude<StateTreeTaskData['type'], 'call'>;
/** 内置任务（content/formats/stateTreeFormat.ts 的 STATE_TREE_TASK，除了 call）：在 ai/stateTreeTasks.ts 里登记。 */
const builtInTasks = new Map<string, (context: StateTreeContext, task: StateTreeTaskData) => StateTreeTaskRun>();

/** @internal ai/stateTreeTasks.ts 用。 */
export function registerBuiltInTask<T extends BuiltInTaskType>(type: T, factory: (context: StateTreeContext, task: Extract<StateTreeTaskData, { type: T }>) => StateTreeTaskRun): void {
  builtInTasks.set(type, factory as (context: StateTreeContext, task: StateTreeTaskData) => StateTreeTaskRun);
}

interface ActiveState {
  readonly state: StateTreeStateData;
  runs: StateTreeTaskRun[];
}

/** 一棵状态树的一次运行：参数、活的状态（从根到叶子）、收到的事件。 */
export class StateTreeInstance {
  readonly tree: StateTree;
  readonly context: StateTreeContext;
  #status: StateTreeStatus = 'running';
  #active: ActiveState[] = [];
  readonly #numbers = new Map<string, number>();
  readonly #vectors = new Map<string, Vector3>();
  readonly #children = new Map<string | undefined, StateTreeStateData[]>();
  readonly #states = new Map<string, StateTreeStateData>();
  #events: string[] = [];
  /** 这一次运行换过几次状态（调试用）。 */
  transitions = 0;

  constructor(tree: StateTree, context: { readonly entity?: Entity; readonly game?: Game } = {}) {
    this.tree = tree;
    this.context = { tree: this, entity: context.entity, game: context.game };
    for (const parameter of tree.data.parameters) {
      if (parameter.type === 'vector') this.#vectors.set(parameter.name, new Vector3(...parameter.defaultVector));
      else this.#numbers.set(parameter.name, parameter.default);
    }
    for (const state of tree.data.states) {
      this.#states.set(state.name, state);
      const siblings = this.#children.get(state.parent) ?? [];
      siblings.push(state);
      this.#children.set(state.parent, siblings);
    }
  }

  /** 整棵树：在跑，或者按某个结果结束了。 */
  get status(): StateTreeStatus {
    return this.#status;
  }

  /** 活的状态的名字，从根到叶子。 */
  get activePath(): readonly string[] {
    return this.#active.map(({ state }) => state.name);
  }

  /** 设参数：数、开关（存成 0、1）或位置。 */
  set(name: string, value: number | boolean | Vec3Like): void {
    if (typeof value === 'object') {
      const vector = this.#vectors.get(name);
      if (!vector) throw new Error(`state tree '${this.tree.path}' has no vector parameter '${name}'`);
      vector.set(value.x, value.y, value.z);
      return;
    }
    if (!this.#numbers.has(name)) throw new Error(`state tree '${this.tree.path}' has no number or bool parameter '${name}'`);
    this.#numbers.set(name, typeof value === 'boolean' ? (value ? 1 : 0) : value);
  }

  /** 数或开关的参数（开关是 0、1）。 */
  get(name: string): number {
    const value = this.#numbers.get(name);
    if (value === undefined) throw new Error(`state tree '${this.tree.path}' has no number or bool parameter '${name}'`);
    return value;
  }

  /** 位置参数（同一个对象，别改它）。 */
  vector(name: string): Vector3 {
    const value = this.#vectors.get(name);
    if (!value) throw new Error(`state tree '${this.tree.path}' has no vector parameter '${name}'`);
    return value;
  }

  /** 发一个事件：下一次 update 时 on: event 的过渡看得到，看完清掉。 */
  send(event: string): void {
    this.#events.push(event);
  }

  /** 从顶层重新选状态（结束了的树重新开始）。 */
  restart(): void {
    this.#exitFrom(0);
    this.#status = 'running';
    const path = this.#selectAmong(this.#children.get(undefined) ?? []);
    if (!path) {
      this.#status = 'failed';
      return;
    }
    this.#enter(path, 0);
  }

  /** 一帧：跑活的状态的任务，看过渡，换状态。第一次调时先选状态。 */
  update(elapsed: number): void {
    if (this.#status !== 'running') return;
    if (this.#active.length === 0) {
      this.restart();
      if (this.#status !== 'running') return;
    }
    // 任务从根往叶子跑；一个状态的任何一个任务结束，这个状态就完成了（取最深的那个）
    let completed: { depth: number; result: 'succeeded' | 'failed' } | undefined;
    this.#active.forEach((active, depth) => {
      for (const run of active.runs) {
        const result = run.update?.(elapsed) ?? 'running';
        if (result === 'running') continue;
        // 取最深的完成的状态；同一层有一个失败就算失败
        if (!completed || depth > completed.depth || (depth === completed.depth && result === 'failed')) completed = { depth, result };
      }
    });
    const events = this.#events;
    this.#events = [];
    // 从叶子往根看过渡
    for (let depth = this.#active.length - 1; depth >= 0; depth--) {
      const owner = this.#active[depth]!.state;
      for (const transition of owner.transitions) {
        const fires = transition.on === 'tick'
          || (transition.on === 'event' && events.includes(transition.event!))
          || (completed !== undefined && completed.depth >= depth && (transition.on === 'completed' || transition.on === completed.result));
        if (!fires || !transition.when.every((condition) => this.#holds(condition))) continue;
        if (this.#go(transition.to, depth)) return;
      }
    }
    // 完成了却没有过渡接住：整棵树按它的结果结束
    if (completed) this.#finish(completed.result);
  }

  /** 停下：离开所有状态（任务的 exit）。 */
  stop(): void {
    this.#exitFrom(0);
  }

  /** 去 target（过渡属于第 depth 层的状态）；去不了（进入条件不满足、没有下一个兄弟）时 false。 */
  #go(target: string, depth: number): boolean {
    if (target === '$succeeded' || target === '$failed') {
      this.#finish(target === '$succeeded' ? 'succeeded' : 'failed');
      return true;
    }
    let path: StateTreeStateData[] | undefined;
    if (target === '$root') path = this.#selectAmong(this.#children.get(undefined) ?? []);
    else if (target === '$next') {
      const owner = this.#active[depth]!.state;
      const siblings = this.#children.get(owner.parent) ?? [];
      const after = siblings.slice(siblings.indexOf(owner) + 1);
      const below = this.#selectAmong(after);
      path = below && [...this.#ancestors(owner), ...below];
    } else {
      const state = this.#states.get(target)!;
      const below = this.#select(state);
      path = below && [...this.#ancestors(state), ...below];
    }
    if (!path) return false;
    // 和现在相同的前缀留着（不重新进入）；去一个具体的状态时它自己总是重新进入（去自己、去祖先都算一次新的进入）
    let keep = 0;
    while (keep < path.length && keep < this.#active.length && path[keep] === this.#active[keep]!.state) keep++;
    const named = this.#states.get(target);
    if (named) keep = Math.min(keep, path.indexOf(named));
    this.#exitFrom(keep);
    this.#enter(path, keep);
    this.transitions++;
    return true;
  }

  /** state 的祖先（从顶层到它的父状态）。 */
  #ancestors(state: StateTreeStateData): StateTreeStateData[] {
    const chain: StateTreeStateData[] = [];
    for (let up = state.parent; up !== undefined; up = this.#states.get(up)!.parent) chain.unshift(this.#states.get(up)!);
    return chain;
  }

  /** 从 state 往下选：进入条件满足、有子状态时要能选进一个子状态；返回从 state 到叶子的一串。 */
  #select(state: StateTreeStateData): StateTreeStateData[] | undefined {
    if (!state.enter.every((condition) => this.#holds(condition))) return undefined;
    const children = this.#children.get(state.name);
    if (!children) return [state];
    const below = this.#selectAmong(children);
    return below && [state, ...below];
  }

  #selectAmong(candidates: readonly StateTreeStateData[]): StateTreeStateData[] | undefined {
    for (const candidate of candidates) {
      const path = this.#select(candidate);
      if (path) return path;
    }
    return undefined;
  }

  #enter(path: readonly StateTreeStateData[], from: number): void {
    for (let depth = from; depth < path.length; depth++) {
      const state = path[depth]!;
      const active: ActiveState = { state, runs: [] };
      this.#active[depth] = active;
      this.#active.length = depth + 1;
      active.runs = state.tasks.map((task) => this.#startTask(task));
    }
  }

  /** 离开第 from 层往下的状态（叶子先离开）。 */
  #exitFrom(from: number): void {
    for (let depth = this.#active.length - 1; depth >= from; depth--) {
      for (const run of this.#active[depth]!.runs) run.exit?.();
    }
    this.#active.length = Math.min(this.#active.length, from);
  }

  #finish(result: 'succeeded' | 'failed'): void {
    this.#exitFrom(0);
    this.#status = result;
  }

  #startTask(task: StateTreeTaskData): StateTreeTaskRun {
    if (task.type === 'call') {
      const factory = customTasks.get(task.name);
      if (!factory) throw new Error(`state tree '${this.tree.path}': task '${task.name}' is not registered (registerStateTreeTask)`);
      return factory(this.context, task.args);
    }
    const factory = builtInTasks.get(task.type);
    if (!factory) throw new Error(`state tree '${this.tree.path}': built-in task '${task.type}' is missing (import ai/stateTreeTasks)`);
    return factory(this.context, task);
  }

  #holds(condition: StateTreeConditionData): boolean {
    return this.#test(condition) !== condition.not;
  }

  #test(condition: StateTreeConditionData): boolean {
    switch (condition.type) {
      case 'parameter': {
        const value = this.get(condition.parameter);
        switch (condition.test) {
          case '>': return value > condition.value;
          case '<': return value < condition.value;
          case '>=': return value >= condition.value;
          case '<=': return value <= condition.value;
          case '==': return value === condition.value;
          case '!=': return value !== condition.value;
        }
        return false;
      }
      case 'distance': {
        const world = this.context.entity?.get(Transform)?.world;
        if (!world) return false;
        const target = this.vector(condition.parameter);
        const distance = Math.hypot(world[12]! - target.x, world[14]! - target.z);
        return condition.test === '<' ? distance < condition.value : distance > condition.value;
      }
      case 'chance':
        return Math.random() < condition.probability;
      case 'call': {
        const test = customConditions.get(condition.name);
        if (!test) throw new Error(`state tree '${this.tree.path}': condition '${condition.name}' is not registered (registerStateTreeCondition)`);
        return test(this.context, condition.args);
      }
    }
  }
}
