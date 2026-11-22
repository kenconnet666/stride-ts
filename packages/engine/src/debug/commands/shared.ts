/** 几组调试命令共用的：参数的类型、按 id 或名字找实体、等几帧、编 PNG、页面是不是被节流了。 */
import type { EntityId } from '../../data/prop';
import type { Entity } from '../../engine/Entity';
import type { Game } from '../../engine/Game';
import type { Debug } from '../Debug';

/** 调试命令的参数（JSON 解出来的对象）。 */
export type Args = Readonly<Record<string, unknown>>;

/**
 * 页面看得见、帧却很慢，而一帧里的更新加绘制只占很小一部分：是浏览器在节流（主 Chrome 的窗口被别的窗口挡住时呈现被压到一两帧
 * 每秒），不是游戏慢。量帧时间换到 stride open --headless 起的 Chrome。不是这种情况时是 null。
 */
export function throttled(debug: Debug, meanInterval: number): string | null {
  if (document.visibilityState !== 'visible' || !(meanInterval > 100)) return null;
  const busy = debug.frames.last(30, debug.frames.update).reduce((sum, ms) => sum + ms, 0) / 30 + debug.frames.last(30, debug.frames.draw).reduce((sum, ms) => sum + ms, 0) / 30;
  if (busy > meanInterval * 0.3) return null;
  return `frames come every ${Math.round(meanInterval)} ms but update + draw take ${busy.toFixed(1)} ms: the browser is throttling the page (an occluded window?); measure frame times in a stride open --headless Chrome`;
}
export function entityArg(game: Game, args: Args): Entity {
  const ref = args['entity'];
  if (typeof ref === 'number' || (typeof ref === 'string' && /^\d+$/.test(ref))) {
    const id = Number(ref) as EntityId;
    if (!game.entities.isAlive(id)) throw new Error(`entity ${id} does not exist`);
    return game.entities.entity(id);
  }
  if (typeof ref !== 'string' || ref === '') throw new Error('entity must be an id or a name');
  // 编辑状态的页面里也认场景文件里的 id（编辑器、MCP 说的都是它）
  const fromScene = game.editor?.live?.entity(ref);
  if (fromScene) return fromScene;
  const all = game.entities.ids().map((id) => game.entities.entity(id));
  const exact = all.filter((e) => e.name === ref);
  const found = exact.length > 0 ? exact : all.filter((e) => e.name.toLowerCase().includes(ref.toLowerCase()));
  if (found.length === 1) return found[0]!;
  if (found.length === 0) throw new Error(`no entity named '${ref}'`);
  throw new Error(`'${ref}' matches ${found.length} entities: ${found.slice(0, 20).map((e) => `${e.name} (${e.id})`).join(', ')}`);
}
/** 等游戏的帧号前进 n（暂停时不前进：最多等 2 秒）。 */
export async function framesPassed(game: Game, n: number): Promise<void> {
  const target = game.frames + n;
  const deadline = performance.now() + 2000;
  while (game.frames < target && performance.now() < deadline) await new Promise((resolve) => requestAnimationFrame(resolve));
}
/** 画布的内容编成 PNG，base64（调试命令的返回值走 JSON）。 */
export async function pngBase64(canvas: OffscreenCanvas): Promise<string> {
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}
