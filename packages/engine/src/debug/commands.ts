/**
 * 引擎自带的调试命令（Game.run 打开 debug 时登记）。参数和返回值都是能 JSON 的值；CLI（@stride-ts/cli）的子命令
 * 一一对应地调用它们，游戏可以用 game.debug.command 再加自己的。
 *
 * 实体参数可以是 id（数字）或名字（先按全名找，再按包含这段文字找，不唯一时报错并列出候选）。组件和脚本按登记的名字
 * （`路径#导出名`）或 # 后面的部分找。
 */
import { QUALITY_TIERS, type QualityTier } from '../rendering/Quality';
import { Model } from '../rendering/components';
import { Material } from '../rendering/Material';
import { Transform } from '../engine/transform';
import type { EntityId } from '../data/prop';
import type { ComponentType } from '../engine/component';
import type { Entity } from '../engine/Entity';
import { scriptName, type ScriptComponent, type ScriptConstructor } from '../engine/scripts';
import type { Game } from '../games/Game';
import type { MouseButton } from '../input/InputManager';
import { keyCode } from '../input/keys';
import { describe, type Debug } from './Debug';
import { devtoolsBridgeVersion, sendDevtools } from './devtoolsBridge';

type Args = Readonly<Record<string, unknown>>;

export function registerGameCommands(debug: Debug, game: Game): void {
  debug.command('commands', 'List the registered commands.', () => debug.commands());
  debug.command('status', 'Game status, time, frame rate, canvas, GPU adapter, counters and watches.', () => status(debug, game));
  debug.command('entities', 'List entities. args: name (substring), with (component or script name), limit (default 200).', (args) => entities(game, args));
  debug.command('inspect', 'All component values and script properties of one entity. args: entity (id or name).', (args) => inspect(game, entityArg(game, args)));
  debug.command('set', "Set a component field or script property. args: entity, path ('Component.field' or 'Script.prop', optionally '.x'), value.", (args) => set(game, args));
  debug.command('time', 'Pause, resume, step frames, time scale, fixed time step, set the game clock. args: pause, resume, step (frames), timeScale, fixedTimeStep (seconds, or null to clear), total (seconds).', (args) => time(game, args));
  debug.command('input', "Simulate input. args: key (KeyboardEvent.code or a Stride key name) with action 'press' | 'down' | 'up' | 'hold' (ms); mouse [dx, dy] in CSS pixels; button ('left' | 'middle' | 'right') with action.", (args) => input(game, args));
  debug.command('screenshot', 'PNG of the next drawn frame (back buffer only, no page UI), as base64.', () => screenshot(debug, game));
  debug.command('perf', 'Sample for some seconds: frame times, CPU time per system and phase, GPU time per pass, render stats. args: seconds (default 3), gpu (default true).', (args) => perf(debug, game, args));
  debug.command('native', 'Native module stats: counters, timings since the last reset (or since perf started), memory. args: reset (clear the timings afterwards).', (args) => nativeStats(game, args));
  debug.command('draws', 'Draw calls of the last frame per GPU render pass (scene stages, shadows, each post-processing step, UI, debug lines), in drawing order.', () => {
    const { total, byPass } = game.graphicsDevice.draws;
    return { total, passes: Object.fromEntries(byPass) };
  });
  debug.command('metrics', 'Statistics of the systems and their budgets (entities, draw calls, GPU memory, native memory, frame times, and what the game registered). args: over (only those over budget).', (args) => {
    return args['over'] === true ? game.metrics.over() : game.metrics.snapshot();
  });
  debug.command('quality', 'Quality tier of the renderer (caps on shadows and post effects). args: tier (low, medium, high, ultra; omitted reads the current settings).', (args) => {
    const tier = args['tier'];
    if (typeof tier === 'string') {
      if (!Object.hasOwn(QUALITY_TIERS, tier)) throw new Error(`quality tier must be one of ${Object.keys(QUALITY_TIERS).join(', ')}, got '${tier}'`);
      game.graphicsCompositor.quality = QUALITY_TIERS[tier as QualityTier];
    }
    const current = game.graphicsCompositor.quality;
    return { tier: Object.entries(QUALITY_TIERS).find(([, settings]) => settings === current)?.[0] ?? 'custom', ...current };
  });
  debug.command('ao', 'Screen-space ambient occlusion (GTAO) of the main view. args: on (true/false; omitted toggles), radius (world units).', (args) => {
    const ao = game.graphicsCompositor.ambientOcclusion;
    ao.enabled = typeof args['on'] === 'boolean' ? args['on'] : !ao.enabled;
    if (typeof args['radius'] === 'number') ao.radius = args['radius'];
    return { enabled: ao.enabled, radius: ao.radius, power: ao.power };
  });
  debug.command('blur', 'Motion blur of the main view. args: on (true/false; omitted toggles), shutter (fraction of a frame), maxPixels.', (args) => {
    const blur = game.graphicsCompositor.motionBlur;
    blur.enabled = typeof args['on'] === 'boolean' ? args['on'] : !blur.enabled;
    for (const key of ['shutter', 'maxPixels'] as const) if (typeof args[key] === 'number') blur[key] = args[key];
    return { enabled: blur.enabled, shutter: blur.shutter, maxPixels: blur.maxPixels };
  });
  debug.command('contact', 'Contact shadows (screen-space shadows of the shadow-casting directional light). args: on (true/false; omitted toggles), length (world units), steps, thickness.', (args) => {
    const contact = game.graphicsCompositor.contactShadows;
    contact.enabled = typeof args['on'] === 'boolean' ? args['on'] : !contact.enabled;
    for (const key of ['length', 'steps', 'thickness'] as const) if (typeof args[key] === 'number') contact[key] = args[key];
    return { enabled: contact.enabled, length: contact.length, steps: contact.steps, thickness: contact.thickness };
  });
  debug.command('ssgi', 'Screen-space global illumination of the main view (indirect diffuse light and occlusion; replaces GTAO while on). args: on (true/false; omitted toggles), radius, thickness (world units), intensity, feedback.', (args) => {
    const gi = game.graphicsCompositor.globalIllumination;
    gi.enabled = typeof args['on'] === 'boolean' ? args['on'] : !gi.enabled;
    for (const key of ['radius', 'thickness', 'intensity', 'feedback'] as const) if (typeof args[key] === 'number') gi[key] = args[key];
    return { enabled: gi.enabled, radius: gi.radius, thickness: gi.thickness, intensity: gi.intensity, feedback: gi.feedback };
  });
  debug.command('sss', 'Subsurface scattering blur of the main view (compositor switch). args: on (true/false; omitted toggles), entity (id or name): the models of this entity and its children get Stride\'s skin scattering while on (width, translucency override it) and lose it while off.', (args) => {
    const sss = game.graphicsCompositor.subsurfaceScattering;
    sss.enabled = typeof args['on'] === 'boolean' ? args['on'] : !sss.enabled;
    const materials = new Set<string>();
    if (args['entity'] !== undefined) {
      const root = entityArg(game, args);
      const under = (entity: Entity) => {
        for (let at: Entity | undefined = entity; at; at = (at.get(Transform) as { parent?: Entity } | undefined)?.parent) if (at === root) return true;
        return false;
      };
      const settings = Object.fromEntries((['width', 'translucency'] as const).filter((key) => typeof args[key] === 'number').map((key) => [key, args[key] as number]));
      for (const entity of game.entities.ids().map((id) => game.entities.entity(id)).filter(under)) {
        const material = Material.byId(entity.get(Model)?.material ?? 0);
        if (!material) continue;
        material.setSubsurfaceScattering(sss.enabled ? settings : undefined);
        materials.add(material.name);
      }
    }
    return { enabled: sss.enabled, materials: [...materials], scatteringMaterials: game.renderSystem.subsurfaceMaterials.count };
  });
  debug.command('ssr', 'Screen-space reflections of the main view. args: on (true/false; omitted toggles), maxRoughness, thickness, maxSteps, debug (off, hits, reflection).', (args) => {
    const ssr = game.graphicsCompositor.screenSpaceReflections;
    ssr.enabled = typeof args['on'] === 'boolean' ? args['on'] : !ssr.enabled;
    for (const key of ['maxRoughness', 'thickness', 'maxSteps'] as const) if (typeof args[key] === 'number') ssr[key] = args[key];
    if (args['debug'] === 'off' || args['debug'] === 'hits' || args['debug'] === 'reflection') ssr.debug = args['debug'];
    return { enabled: ssr.enabled, maxRoughness: ssr.maxRoughness, thickness: ssr.thickness, edgeFade: ssr.edgeFade, maxSteps: ssr.maxSteps, debug: ssr.debug };
  });
  debug.command('taa', 'Temporal anti-aliasing of the main view instead of FXAA. args: on (true/false; omitted toggles).', (args) => {
    const taa = game.graphicsCompositor.temporalAntialiasing;
    taa.enabled = typeof args['on'] === 'boolean' ? args['on'] : !taa.enabled;
    return { enabled: taa.enabled, feedback: taa.feedback, clipSigma: taa.clipSigma, sharpness: taa.sharpness };
  });
  debug.command('wireframe', 'Overlay the wireframe of the meshes on the main view. args: on (boolean; omitted toggles).', (args) => {
    const compositor = game.graphicsCompositor;
    compositor.wireframe = typeof args['on'] === 'boolean' ? args['on'] : !compositor.wireframe;
    return { wireframe: compositor.wireframe };
  });
  debug.command('pick', 'Entity under a canvas pixel (GPU id buffer). args: x, y in CSS pixels from the top-left of the canvas.', async (args) => {
    const entity = await game.pick(Number(args['x']), Number(args['y']));
    return { entity: entity ? describe(entity) : null };
  });
  debug.command('raycast', 'Physics ray cast. args: origin [x,y,z], direction [x,y,z], maxDistance (default 1000), mask.', (args) => raycast(game, args));
  debug.command('debug-text', 'Lines the scripts printed with game.debugText in the last frame.', () => game.debugText.lines);
  debug.command('devtools', "Run a DevTools protocol command on this tab through the Stride Debug Bridge extension (tools/debug-bridge). args: method ('detach' ends debugging), params, waitFor (an event to wait for after the command; returns its params).", (args) =>
    sendDevtools(String(args['method']), (args['params'] ?? {}) as Readonly<Record<string, unknown>>, args['waitFor'] === undefined ? undefined : String(args['waitFor'])));
  debug.command('eval', 'Evaluate JavaScript in the page (globalThis.strideGame is the game); awaits promises. args: code.', (args) => evaluate(args));
}

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
  const path = String(args['path'] ?? '');
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

function entityArg(game: Game, args: Args): Entity {
  const ref = args['entity'];
  if (typeof ref === 'number' || (typeof ref === 'string' && /^\d+$/.test(ref))) {
    const id = Number(ref) as EntityId;
    if (!game.entities.isAlive(id)) throw new Error(`entity ${id} does not exist`);
    return game.entities.entity(id);
  }
  if (typeof ref !== 'string' || ref === '') throw new Error('entity must be an id or a name');
  const all = game.entities.ids().map((id) => game.entities.entity(id));
  const exact = all.filter((e) => e.name === ref);
  const found = exact.length > 0 ? exact : all.filter((e) => e.name.toLowerCase().includes(ref.toLowerCase()));
  if (found.length === 1) return found[0]!;
  if (found.length === 0) throw new Error(`no entity named '${ref}'`);
  throw new Error(`'${ref}' matches ${found.length} entities: ${found.slice(0, 20).map((e) => `${e.name} (${e.id})`).join(', ')}`);
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
  const action = String(args['action'] ?? 'press');
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

/** 等游戏的帧号前进 n（暂停时不前进：最多等 2 秒）。 */
async function framesPassed(game: Game, n: number): Promise<void> {
  const target = game.frames + n;
  const deadline = performance.now() + 2000;
  while (game.frames < target && performance.now() < deadline) await new Promise((resolve) => requestAnimationFrame(resolve));
}

async function screenshot(debug: Debug, game: Game): Promise<unknown> {
  const canvas = game.graphicsDevice.canvas;
  // 画完的同一个任务里拿画布内容（WebGPU 画布的当前纹理在呈现之后就失效）
  const bitmap = await debug.afterNextDraw(() => createImageBitmap(canvas));
  const image = await bitmap;
  const offscreen = new OffscreenCanvas(image.width, image.height);
  offscreen.getContext('2d')!.drawImage(image, 0, 0);
  image.close();
  const blob = await offscreen.convertToBlob({ type: 'image/png' });
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  return { width: offscreen.width, height: offscreen.height, frame: game.frames, png: dataUrl.slice(dataUrl.indexOf(',') + 1) };
}

async function perf(debug: Debug, game: Game, args: Args): Promise<unknown> {
  const seconds = Number(args['seconds'] ?? 3);
  const profiler = game.graphicsDevice.profiler;
  const gpu = args['gpu'] !== false && profiler.supported;
  const wasProfiling = profiler.enabled;
  const timings = new Map<string, number>();
  game.entities.timings = timings;
  if (gpu) {
    profiler.enabled = true;
    // 打开后第一帧的读回还没回来：等一帧再清零
    await framesPassed(game, 1);
    profiler.reset();
  }
  game.native.resetDebugTimings();
  const firstFrame = debug.frames.total;
  const firstUpdate = game.frames;
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  const frames = Math.min(debug.frames.total - firstFrame, debug.frames.interval.length);
  const updates = Math.max(1, game.frames - firstUpdate);
  game.entities.timings = undefined;
  const gpuReport = gpu ? profiler.report() : [];
  const native = game.native.debugSnapshot();
  if (!wasProfiling) profiler.enabled = false;
  const intervals = debug.frames.last(frames, debug.frames.interval);
  const perFrame = (total: number) => total / updates;
  return {
    seconds,
    frames,
    fps: frames / seconds,
    frameMs: summary(intervals),
    updateMs: summary(debug.frames.last(frames, debug.frames.update)),
    drawMs: summary(debug.frames.last(frames, debug.frames.draw)),
    cpuMsPerUpdate: Object.fromEntries([...timings].sort((a, b) => b[1] - a[1]).map(([label, ms]) => [label, round(perFrame(ms))])),
    nativeMsPerUpdate: Object.fromEntries(Object.entries(native.timings).sort((a, b) => b[1].ms - a[1].ms).map(([label, t]) => [label, round(perFrame(t.ms))])),
    gpu: gpu ? { totalMs: round(gpuReport.reduce((sum, [, t]) => sum + t.milliseconds, 0)), passes: Object.fromEntries(gpuReport.map(([label, t]) => [label, round(t.milliseconds)])) } : 'timestamp-query is not available',
    render: Object.fromEntries(game.renderSystem.features.map((feature) => [feature.name, feature.stats()])),
    graph: game.graphicsCompositor.graphStats,
  };
}

function summary(values: readonly number[]): unknown {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!);
  return { mean: round(values.reduce((sum, v) => sum + v, 0) / values.length), p50: at(0.5), p95: at(0.95), p99: at(0.99), max: round(sorted.at(-1)!) };
}

const round = (value: number) => Math.round(value * 1000) / 1000;

function nativeStats(game: Game, { reset }: Args): unknown {
  const snapshot = game.native.debugSnapshot();
  if (reset === true) game.native.resetDebugTimings();
  return { workerThreads: game.native.workerThreadCount, collecting: game.native.debugCollecting, ...snapshot };
}

function raycast(game: Game, args: Args): unknown {
  if (!game.simulation) throw new Error('the game has no physics (nativeFeatures has no physics)');
  const origin = vector(args['origin'], 'origin');
  const direction = vector(args['direction'], 'direction');
  const hit = game.simulation.rayCast(origin, direction, Number(args['maxDistance'] ?? 1000), typeof args['mask'] === 'number' ? { mask: args['mask'] } : {});
  if (!hit) return { hit: null };
  return { hit: { distance: hit.distance, point: Array.from(hit.point), normal: Array.from(hit.normal), entity: describe(game.entities.entity(hit.entity)) } };
}

function vector(value: unknown, name: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3 || value.some((v) => typeof v !== 'number')) throw new Error(`${name} must be [x, y, z]`);
  return value as [number, number, number];
}

async function evaluate({ code }: Args): Promise<unknown> {
  if (typeof code !== 'string') throw new Error('code must be a string');
  // 间接 eval：在全局作用域执行，globalThis.strideGame、strideEngine 都能用
  return await (0, eval)(code);
}
