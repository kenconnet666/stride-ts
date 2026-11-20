/**
 * 资源移动、改名时改写引用它的文件：资源之间按内容路径引用（用户 2026-11-20 定），文件里写的就是路径，所以挪了一个资源，
 * 引用它的每个文件里的那几处都要换成新路径。写在哪由引擎的 assetReferenceSlots 找（和数据库取引用关系是同一份逻辑），
 * 只改那几处；JSON 照导入器的格式（缩进 1 格）写回。
 */
import { readFile } from 'node:fs/promises';
import { decodeAnimation, decodeModel, encodeAnimation, encodeModel, isProceduralModel, parseProceduralModel } from '@stride-ts/engine/content-format';
import { assetReferenceSlots, type AssetKind } from '@stride-ts/engine/content-references';
import { assetKey, ownBuffer } from './AssetDatabase.ts';

/** `种类:路径` → 新路径。 */
export type PathChanges = ReadonlyMap<string, string>;

/**
 * 读一个资源的主文件，把指向挪了的资源的引用换成新路径；返回改写后的内容，没有要改的返回 undefined。
 * 会引用别的资源的是 JSON 文件、模型（材质、骨架的路径在文件头里）和动画（骨架）。
 */
export async function rewriteReferences(kind: AssetKind, file: string, changes: PathChanges): Promise<Uint8Array | string | undefined> {
  // 二进制的两种：引用在文件头里，解开、改、再编回去（材质表拷一份，解出来的是只读的类型）
  if (kind === 'model') {
    const bytes = await readFile(file);
    // JSON 写的（程序生成的形状）：材质槽就在 JSON 里，照 JSON 改
    if (isProceduralModel(bytes)) {
      const content = { ...parseProceduralModel(bytes, file) };
      const slots = { materials: [...(content.materials ?? [])] };
      return apply(kind, slots, changes) ? JSON.stringify({ ...content, materials: slots.materials }, null, 1) : undefined;
    }
    const model = decodeModel(ownBuffer(bytes), file);
    const mutable = { ...model, materials: [...model.materials] };
    return apply(kind, mutable, changes) ? encodeModel(mutable) : undefined;
  }
  if (kind === 'animation') {
    const animation = { ...decodeAnimation(ownBuffer(await readFile(file)), file) };
    return apply(kind, animation, changes) ? encodeAnimation(animation) : undefined;
  }
  if (!file.endsWith('.json')) return undefined;
  const content: unknown = JSON.parse(await readFile(file, 'utf8'));
  return apply(kind, content, changes) ? JSON.stringify(content, null, 1) : undefined;
}

function apply(kind: AssetKind, content: unknown, changes: PathChanges): boolean {
  let changed = false;
  for (const slot of assetReferenceSlots(kind, content)) {
    const to = changes.get(assetKey(slot.kind, slot.path));
    if (to === undefined) continue;
    (slot.owner as Record<string | number, string>)[slot.key] = to;
    changed = true;
  }
  return changed;
}
