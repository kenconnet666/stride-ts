/** 调试命令：页面和实体：命令列表、状态、实体、看和改属性、时间、模拟输入、在页面里求值、放慢、调试文字、DevTools 协议。 */
import { textOf } from '../../data/text.ts';
import type { ComponentType } from '../../engine/component';
import type { Entity } from '../../engine/Entity';
import { scriptName, type ScriptComponent, type ScriptConstructor } from '../../engine/scripts';
import type { Game } from '../../engine/Game';
import type { MouseButton } from '../../input/InputManager';
import { keyCode } from '../../input/keys';
import { describe, type Debug } from '../Debug';
import { pageHelpers } from '../pageHelpers';
import { devtoolsBridgeVersion, sendDevtools } from '../devtoolsBridge';
import { type Args, throttled, entityArg, framesPassed } from './shared.ts';

function status(debug: Debug, game: Game): unknown {
  const recent = debug.frames.last(60, debug.frames.interval).filter((ms) => ms > 0);
  const meanInterval = recent.reduce((sum, ms) => sum + ms, 0) / Math.max(1, recent.length);
  const device = game.graphicsDevice as Game['graphicsDevice'] | undefined;
  const canvas = device?.canvas;
  return {
    status: game.status,
    error: game.error ?? null,
    frame: game.frames,
    sceneFrame: game.sceneFrame ?? null,
    scene: game.rootScene?.name ?? null,
    time: { total: game.updateTime.total, paused: game.paused, timeScale: game.timeScale, fixedTimeStep: game.fixedTimeStep ?? null },
    fps: recent.length > 0 ? 1000 / meanInterval : null,
    startup: game.startup,
    canvas: canvas ? { width: canvas.width, height: canvas.height, clientWidth: canvas.clientWidth, clientHeight: canvas.clientHeight, devicePixelRatio } : null,
    gpu: device ? { ...adapterInfo(device.device.adapterInfo), textureTarget: device.textureTarget, timestamps: device.profiler.supported } : null,
    native: game.native ? { workerThreads: game.native.workerThreadCount } : null,
    /** 调试桥扩展的版本（没装时是 null）：有它时 cpu-profile、mouse --trusted 在任何 Chrome 里都能用。 */
    devtoolsBridge: devtoolsBridgeVersion() ?? null,
    /** 页面看得见没有：hidden 时（标签在后台、窗口最小化）requestAnimationFrame 不走，游戏不出帧；stride front 切到前面。 */
    visibility: document.visibilityState,
    throttled: throttled(debug, meanInterval),
    entities: game.entities.count,
    counters: debug.counters(),
    watches: debug.watches(),
  };
}
function adapterInfo(info: GPUAdapterInfo): Record<string, string> {
  return { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description };
}
function entities(game: Game, { name, with: having, limit = 200 }: Args): unknown {
  const filter = typeof name === 'string' ? name.toLowerCase() : undefined;
  const result: unknown[] = [];
  let matched = 0;
  for (const id of game.entities.ids()) {
    const entity = game.entities.entity(id);
    if (filter !== undefined && !entity.name.toLowerCase().includes(filter)) continue;
    const components = game.entities.componentTypes(id).map((type) => type.name);
    const scripts = [...entity.scripts.keys()].map(scriptName);
    if (typeof having === 'string' && ![...components, ...scripts].some((n) => nameMatches(n, having))) continue;
    if (matched++ < Number(limit)) result.push({ id, name: entity.name, parent: parentOf(entity), components, scripts });
  }
  return { count: matched, entities: result };
}
function parentOf(entity: Entity): unknown {
  const transform = [...entity.manager.componentTypes(entity.id)].find((type) => type.name === 'Transform');
  const parent = transform ? (entity.get(transform) as { parent?: Entity } | undefined)?.parent : undefined;
  return parent ? { entity: parent.id, name: parent.name } : null;
}
function inspect(game: Game, entity: Entity): unknown {
  const components: Record<string, unknown> = {};
  for (const type of game.entities.componentTypes(entity.id)) components[type.name] = describe(entity.get(type));
  const scripts: Record<string, unknown> = {};
  for (const [type, script] of entity.scripts) scripts[scriptName(type)] = scriptProps(type, script);
  return { id: entity.id, name: entity.name, parent: parentOf(entity), components, scripts };
}
/** 脚本的属性（schema 里的字段）和 enabled，不展开 entity、game 这些引用。 */
function scriptProps(type: ScriptConstructor, script: ScriptComponent): unknown {
  const values: Record<string, unknown> = {};
  for (const field of type.schema.fields) values[field.name] = (script as unknown as Record<string, unknown>)[field.name];
  if ('enabled' in script) values['enabled'] = (script as { enabled: unknown }).enabled;
  return describe(values);
}
function set(game: Game, args: Args): unknown {
  const entity = entityArg(game, args);
  const path = textOf(args['path']);
  const [owner, ...keys] = path.split('.');
  if (!owner || keys.length === 0) throw new Error(`path must be 'Component.field' or 'Script.prop', got '${path}'`);
  const target = findOwner(game, entity, owner);
  let object = target as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) {
    const next = object[key];
    if (typeof next !== 'object' || next === null) throw new Error(`'${key}' in ${path} is not an object`);
    object = next as Record<string, unknown>;
  }
  const last = keys.at(-1)!;
  if (!(last in object)) throw new Error(`${owner} has no '${last}' (it has ${Object.keys(object).join(', ')})`);
  object[last] = args['value'];
  return { [path]: describe(object[last]) };
}
/** 实体上名字对得上的数据组件的视图或脚本实例。 */
function findOwner(game: Game, entity: Entity, name: string): object {
  const types: { name: string; get: () => object }[] = [
    ...game.entities.componentTypes(entity.id).map((type: ComponentType<any>) => ({ name: type.name, get: () => entity.get(type) as object })),
    ...[...entity.scripts].map(([type, script]) => ({ name: scriptName(type), get: () => script })),
  ];
  const found = types.filter((t) => nameMatches(t.name, name));
  if (found.length !== 1) {
    throw new Error(`${found.length === 0 ? 'no' : 'more than one'} component or script '${name}' on '${entity.name}' (it has ${types.map((t) => t.name).join(', ')})`);
  }
  return found[0]!.get();
}
/** 全名，或 `路径#导出名` 里 # 后面的部分。 */
function nameMatches(registered: string, name: string): boolean {
  return registered === name || registered.slice(registered.lastIndexOf('#') + 1) === name;
}
function time(game: Game, args: Args): unknown {
  if (args['pause'] === true) game.paused = true;
  if (args['resume'] === true) game.paused = false;
  if (typeof args['timeScale'] === 'number') game.timeScale = args['timeScale'];
  if ('fixedTimeStep' in args) game.fixedTimeStep = typeof args['fixedTimeStep'] === 'number' ? args['fixedTimeStep'] : undefined;
  // 把游戏时钟拨到这个秒数（比对截图：按时间动的着色器两边在同一个时间截）
  if (typeof args['total'] === 'number') game.updateTime.total = args['total'];
  if (typeof args['step'] === 'number') {
    if (!game.paused) throw new Error('step needs a paused game: pause first');
    game.step(args['step']);
  }
  return { frame: game.frames, total: game.updateTime.total, paused: game.paused, timeScale: game.timeScale, fixedTimeStep: game.fixedTimeStep ?? null };
}
const MOUSE_BUTTONS: Record<MouseButton, number> = { left: 0, middle: 1, right: 2 };
/** 合成的鼠标指针的 pointerId（浏览器真实鼠标的是 1，用别的值不和它混在一起）。 */
const SYNTHETIC_POINTER = 1000;
/** 上一次合成的指针位置（client 坐标）。 */
let syntheticPointer: [number, number] | undefined;
/**
 * 派发合成的 DOM 事件，走和真实输入一样的路径（InputManager 的监听器）。press 按下后等游戏跑过一帧再松开，
 * 这样脚本一定能看到这次按下；hold 按住 ms 毫秒的真实时间。合成事件拿不到指针锁定。
 */
async function input(game: Game, args: Args): Promise<unknown> {
  const action = textOf(args['action'], 'press');
  const canvas = game.graphicsDevice.canvas;
  if (Array.isArray(args['mouse'])) {
    const [dx = 0, dy = 0] = args['mouse'] as number[];
    const rect = canvas.getBoundingClientRect();
    // 指针从上一次合成的位置（第一次从画布中心）移过去；先在起点发一个，没见过这个指针的 InputManager 也能算出移动量
    const [x, y] = (syntheticPointer ??= [rect.left + rect.width / 2, rect.top + rect.height / 2]);
    syntheticPointer = [x + dx, y + dy];
    canvas.dispatchEvent(new PointerEvent('pointermove', { pointerId: SYNTHETIC_POINTER, pointerType: 'mouse', clientX: x, clientY: y }));
    canvas.dispatchEvent(new PointerEvent('pointermove', { pointerId: SYNTHETIC_POINTER, pointerType: 'mouse', clientX: x + dx, clientY: y + dy }));
    window.dispatchEvent(new MouseEvent('mousemove', { movementX: dx, movementY: dy, clientX: x + dx, clientY: y + dy }));
  }
  let down: () => void, up: () => void;
  if (typeof args['key'] === 'string') {
    // Stride 的键名（'W'、'Left'）也认，派发的事件用浏览器的 code
    const code = keyCode(args['key']);
    down = () => window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code }));
    up = () => window.dispatchEvent(new KeyboardEvent('keyup', { code, key: code }));
  } else if (typeof args['button'] === 'string') {
    const button = MOUSE_BUTTONS[args['button'] as MouseButton];
    if (button === undefined) throw new Error(`button must be left, middle or right, got '${args['button']}'`);
    const rect = canvas.getBoundingClientRect();
    const [clientX, clientY] = syntheticPointer ?? [rect.left + rect.width / 2, rect.top + rect.height / 2];
    const pointer = { pointerId: SYNTHETIC_POINTER, pointerType: 'mouse', clientX, clientY, button };
    down = () => {
      canvas.dispatchEvent(new PointerEvent('pointerdown', pointer));
      canvas.dispatchEvent(new MouseEvent('mousedown', { button, bubbles: true }));
    };
    up = () => {
      window.dispatchEvent(new PointerEvent('pointerup', pointer));
      window.dispatchEvent(new MouseEvent('mouseup', { button }));
    };
  } else {
    return { frame: game.frames };
  }
  if (action === 'down') down();
  else if (action === 'up') up();
  else if (action === 'press') {
    down();
    await framesPassed(game, 2);
    up();
  } else if (action === 'hold') {
    down();
    await new Promise((resolve) => setTimeout(resolve, Number(args['ms'] ?? 500)));
    up();
  } else throw new Error(`action must be press, down, up or hold, got '${action}'`);
  return { frame: game.frames };
}
/**
 * 页面里跑一段代码（`stride eval`），结果等到 Promise 落定。能用的名字：game、engine（样例的 main.ts 挂的 strideEngine，
 * 引擎的全部导出），加上 pageHelpers 的那些（entity、named、frames、seconds、until、tap、click……，见 debug/pageHelpers.ts）。
 * - 一个表达式：结果是它的值，能直接 await。
 * - 几条语句：包进一个块里间接 eval（块里先声明上面那些名字），结果是最后一条语句的值；块里的 const、let 不留到下一次。
 *   语句里有顶层 await 时间接 eval 不支持，改成异步函数体跑，结果要用 return 给。
 * 页面自己有同名全局变量的帮手用页面的（样例的冒烟会换掉其中几个）；game 不用页面的：画布的 id 常是 game，浏览器会把它挂成
 * 全局的 window.game。
 */
async function evaluate(game: Game, { code }: Args): Promise<unknown> {
  if (typeof code !== 'string') throw new Error('code must be a string');
  // 页面自己有同名全局变量的帮手用页面的：样例的冒烟会换掉其中几个（比如按坐标点的 uiClick），不能被这里的盖住
  // 只认函数：浏览器自己的同名全局（window.frames 是窗口列表）不算，不然 frames(n) 调的是它
  const helpers = Object.fromEntries(Object.entries(pageHelpers(game)).filter(([name]) => typeof (globalThis as Record<string, unknown>)[name] !== 'function'));
  const scope: Record<string, unknown> = { game, engine: (globalThis as { strideEngine?: unknown }).strideEngine, ...helpers };
  const names = Object.keys(scope);
  const values = names.map((name) => scope[name]);
  const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<unknown>;
  try {
    return await new AsyncFunction(...names, `return (${code}\n);`)(...values);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  const global = globalThis as { __strideEval?: Record<string, unknown> };
  global.__strideEval = scope;
  try {
    // eval 命令就是要在页面的全局作用域里跑 agent 给的代码（间接 eval：不碰这里的局部变量）
    // oxlint-disable-next-line no-eval
    return await (0, eval)(`{ const { ${names.join(', ')} } = globalThis.__strideEval;\n${code}\n}`);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  } finally {
    delete global.__strideEval;
  }
  // 多半是顶层 await：当异步函数体跑，最后一条是表达式时返回它的值（同浏览器控制台；不然多条语句的结果总是 null）
  return await new AsyncFunction(...names, withLastValue(code, (body) => new AsyncFunction(...names, body)))(...values);
}
/**
 * 把语句序列的最后一条表达式改成 return：在顶层（不在括号、字符串、注释里）的 `;` 和换行处切开，从最长的尾巴试起，把它包成
 * `return (…)`，编译得过（compile 不抛 SyntaxError，只编译不运行）就用它；都不行原样返回。
 */
export function withLastValue(code: string, compile: (body: string) => unknown): string {
  const boundaries: number[] = [];
  let depth = 0;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!;
    if (ch === '"' || ch === "'" || ch === '`') {
      for (i++; i < code.length && code[i] !== ch; i++) if (code[i] === '\\') i++;
    } else if (ch === '/' && code[i + 1] === '/') {
      while (i < code.length && code[i] !== '\n') i++;
      if (depth === 0) boundaries.push(i);
    } else if (ch === '/' && code[i + 1] === '*') {
      i = code.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (depth === 0 && (ch === ';' || ch === '\n')) boundaries.push(i);
  }
  const trimmed = code.replace(/[\s;]+$/, '');
  // 从最长的尾巴试起：跨行的表达式（第二行以 + 开头）不会只取到半截
  for (const at of [-1, ...boundaries.filter((b) => b < trimmed.length)]) {
    const tail = trimmed.slice(at + 1).trim();
    if (tail === '' || /^(const|let|var|if|for|while|return|throw|function|class|try|switch|do)\b/.test(tail)) continue;
    const body = `${trimmed.slice(0, at + 1)}\nreturn (${tail}\n);`;
    try {
      compile(body);
      return body;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  return code;
}

export function registerCoreCommands(debug: Debug, game: Game): void {
  debug.command('commands', 'List the registered commands.', () => debug.commands());
  debug.command('status', 'Game status, time, frame rate, canvas, GPU adapter, counters and watches.', () => status(debug, game));
  debug.command('entities', 'List entities. args: name (substring), with (component or script name), limit (default 200).', (args) => entities(game, args));
  debug.command('inspect', 'All component values and script properties of one entity. args: entity (id, name, or in the editor the scene file id).', (args) => inspect(game, entityArg(game, args)));
  debug.command('set', "Set a component field or script property. args: entity, path ('Component.field' or 'Script.prop', optionally '.x'), value.", (args) => set(game, args));
  debug.command('time', 'Pause, resume, step frames, time scale, fixed time step, set the game clock. args: pause, resume, step (frames), timeScale, fixedTimeStep (seconds, or null to clear), total (seconds).', (args) => time(game, args));
  debug.command('input', "Simulate input. args: key (KeyboardEvent.code or a Stride key name) with action 'press' | 'down' | 'up' | 'hold' (ms); mouse [dx, dy] in CSS pixels; button ('left' | 'middle' | 'right') with action.", (args) => input(game, args));
  debug.command('debug-text', 'Lines the scripts printed with game.debugText in the last frame.', () => game.debugText.lines);
  debug.command('devtools', "Run a DevTools protocol command on this tab through the Stride Debug Bridge extension (tools/debug-bridge). args: method ('detach' ends this session's debugging; the tab stays attached while other sessions use it), params, waitFor (an event to wait for after the command; returns its params), session (the debugging session's id, so several sessions can share the tab).", (args) =>
    sendDevtools(textOf(args['method']), (args['params'] ?? {}) as Readonly<Record<string, unknown>>, args['waitFor'] === undefined ? undefined : textOf(args['waitFor']), args['session'] === undefined ? undefined : textOf(args['session'])));
  debug.command('eval', 'Evaluate JavaScript in the page. An expression: its value; await works; in scope are game, engine, entity(name | id), named(name), frames(n), seconds(s) (game time). Statements: the value of the last one, in global scope; with a top-level await they run as an async function body (use return). args: code.', (args) => evaluate(game, args));
  // 慢帧：每帧在 requestAnimationFrame 里忙等 ms 毫秒（和游戏的帧在同一轮，所以帧间隔加长这么多）。页面地址带
  // ?stride-slow=<毫秒> 时一开始就慢（regress.ps1 -Slow；重载页面后还在）
  let slowMs = 0, slowing = false;
  const slow = (ms: number) => {
    slowMs = Math.max(0, ms);
    if (slowMs > 0 && !slowing) {
      slowing = true;
      const tick = () => {
        if (slowMs <= 0) {
          slowing = false;
          return;
        }
        // 游戏跑起来以后才慢：加载、连中枢的时候忙等会把它们饿死（CI 上慢的是每一帧的画，不是加载）
        if (game.status === 'running' && game.frames > 0) {
          const end = performance.now() + slowMs;
          while (performance.now() < end);
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
    return { ms: slowMs };
  };
  if (typeof location !== 'undefined') slow(Number(new URLSearchParams(location.search).get('stride-slow') ?? 0));
  debug.command('slow', "Make every frame take ms longer (busy wait on the main thread), to reproduce slow machines such as CI's software WebGPU (frames of a few hundred ms); the page url's ?stride-slow=<ms> does it from the start. args: ms (0 stops).", (args) => slow(Number(args['ms'] ?? 0)));
}
