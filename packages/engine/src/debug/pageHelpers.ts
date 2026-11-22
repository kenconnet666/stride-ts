/**
 * 页面里试玩、测量用的帮手（一份实现）：`stride eval` 的代码里直接能用；冒烟脚本（@stride-ts/devkit/smoke 的 PAGE_HELPERS）把它们装成
 * 页面的全局变量，样例自己的帮手用它们拼。等待都按游戏时间和状态，不按墙钟（CI 的软件 WebGPU 上一帧几百毫秒到几秒），也不按
 * 帧数（帧率随机器变）。
 */
import type { Entity } from '../engine/Entity';
import type { Game } from '../engine/Game';
import { Transform } from '../engine/transform';
import { UISystem } from '../ui/UISystem';
import type { UIElement } from '../ui/UIElement';

/** 等待的墙钟上限：只防游戏停着时卡死（中枢的 eval 两分钟超时）。 */
const WALL_LIMIT_MS = 100000;

export function pageHelpers(game: Game) {
  const canvas = () => game.graphicsDevice.canvas;
  /** 等游戏跑过一帧（游戏没在跑时等下一次 requestAnimationFrame，不让调用方的循环空转）。 */
  const frame = () => new Promise<void>((resolve) => {
    const start = game.frames;
    const next = () => (game.frames > start || game.status !== 'running' ? resolve() : requestAnimationFrame(next));
    requestAnimationFrame(next);
  });
  const frames = async (n: number) => { for (let i = 0; i < n; i++) await frame(); };
  /** 等游戏时间走 s 秒。 */
  const seconds = async (s: number) => {
    const end = game.updateTime.total + s, wall = performance.now() + WALL_LIMIT_MS;
    while (game.updateTime.total < end && performance.now() < wall) await frame();
  };
  /** 每帧看一次 fn()，真了就返回它的值；最多等 s 秒游戏时间，到了返回最后一次的值。 */
  const until = async <T>(fn: () => T, s: number): Promise<T> => {
    const end = game.updateTime.total + s, wall = performance.now() + WALL_LIMIT_MS;
    for (let value = fn(); ; value = fn()) {
      if (value || game.updateTime.total >= end || performance.now() > wall) return value;
      await frame();
    }
  };
  /** 等根场景从 from 换掉、新场景画过一帧；返回新场景的名字。 */
  const sceneChanged = async (from: string | undefined) => {
    const wall = performance.now() + WALL_LIMIT_MS;
    while ((game.rootScene?.name === from || game.sceneFrame === undefined || game.frames <= game.sceneFrame) && performance.now() < wall) await frame();
    return game.rootScene?.name ?? null;
  };
  const all = () => game.entities.ids().map((id) => game.entities.entity(id));
  /** 这个名字的实体（数组）。 */
  const named = (name: string) => all().filter((entity) => entity.name === name);
  /** 名字或 id 对应的实体（名字取第一个）；没有时报错。 */
  const entity = (key: string | number): Entity => {
    const found = typeof key === 'number' || /^\d+$/.test(key) ? all().find((e) => e.id === Number(key)) : named(key)[0];
    if (!found) throw new Error(`no entity ${key}`);
    return found;
  };
  const position = (name: string) => { const p = named(name)[0]!.require(Transform).position; return [p.x, p.y, p.z]; };
  const rotation = (name: string) => { const q = named(name)[0]!.require(Transform).rotation; return [q.x, q.y, q.z, q.w]; };
  /** 屏幕上的调试文字。 */
  const lines = () => game.debugText.lines.map((line) => line.text);
  const key = (type: string, code: string) => window.dispatchEvent(new KeyboardEvent(type, { code }));
  /** 按一下键（KeyboardEvent.code）。 */
  const tap = async (code: string) => { key('keydown', code); await frames(2); key('keyup', code); await frames(2); };
  /** 按住 n 帧，返回按着时的调试文字。 */
  const hold = async (code: string, n: number) => { key('keydown', code); await frames(n); const seen = lines(); key('keyup', code); await frames(2); return seen; };
  /** 按住 s 秒游戏时间再松开，返回松开前一刻 sample() 的值。 */
  const holdFor = async <T>(code: string, s: number, sample?: () => T) => { key('keydown', code); await seconds(s); const seen = sample?.(); key('keyup', code); await frames(2); return seen; };
  const pointer = (type: string, x: number, y: number, button: number, target: EventTarget = canvas()) => {
    const r = canvas().getBoundingClientRect();
    const init = { clientX: r.left + x, clientY: r.top + y, pointerId: 1, pointerType: 'mouse', bubbles: true, button };
    target.dispatchEvent(new PointerEvent(type, init));
    const mouse = ({ pointermove: 'mousemove', pointerdown: 'mousedown', pointerup: 'mouseup' } as Record<string, string>)[type];
    if (mouse) (type === 'pointerdown' ? canvas() : window).dispatchEvent(new MouseEvent(mouse, init));
  };
  /** 在画布的 (x, y)（CSS 像素）发一个合成的指针事件（连同对应的鼠标事件）。 */
  const pointerAt = (type: string, x: number, y: number, target?: EventTarget) => pointer(type, x, y, 0, target);
  /** 在画布的 (x, y) 点一下；给了 during 时按下一帧后等它、再松开，返回它的值（看"按着的时候"的状态）。 */
  const click = async <T>(x: number, y: number, button = 0, during?: () => Promise<T> | T) => {
    pointer('pointermove', x, y, button); await frame();
    pointer('pointerdown', x, y, button); await frame();
    const seen = await during?.(); await frame();
    pointer('pointerup', x, y, button, window); await frames(2);
    return seen;
  };
  const tree = (e: UIElement, out: UIElement[] = []): UIElement[] => { out.push(e); for (const c of e.visualChildren) tree(c, out); return out; };
  const pages = () => game.ui.components.filter((c) => c.page?.rootElement);
  /** 所有页面的全部 UI 元素。 */
  const uiElements = () => pages().flatMap((c) => tree(c.page!.rootElement!));
  /** 这个名字的 UI 元素。 */
  const uiFind = (name: string) => { for (const c of pages()) { const e = c.page!.rootElement!.findName(name); if (e) return e; } return null; };
  /** 全屏 UI 的元素的中心在画布上的位置（CSS 像素）。 */
  const uiPoint = (target: string | UIElement): [number, number] => {
    const e = typeof target === 'string' ? uiFind(target) : target;
    if (!e) throw new Error(`no UI element ${JSON.stringify(target)}`);
    const c = pages().find((c) => tree(c.page!.rootElement!).includes(e))!;
    // 元素的位置是页面的虚拟分辨率里的，换到画布的 CSS 像素
    const [vx, vy] = UISystem.virtualResolution(c, [canvas().width, canvas().height]);
    return [(e.worldPosition[0]! / vx) * canvas().clientWidth, (e.worldPosition[1]! / vy) * canvas().clientHeight];
  };
  const uiClick = async (target: string | UIElement) => click(...uiPoint(target));
  return { frame, frames, seconds, until, sceneChanged, named, entity, position, rotation, lines, tap, hold, holdFor, pointerAt, click, uiElements, uiFind, uiPoint, uiClick };
}

export type PageHelpers = ReturnType<typeof pageHelpers>;
