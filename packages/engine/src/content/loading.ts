/** 内容加载里共用的小工具。 */
import type { TextureRef } from './format';

/** 并行加载一组（去重的）路径，结果按路径放进 Map。 */
export async function preload<T>(paths: readonly string[], load: (path: string) => Promise<T>): Promise<Map<string, T>> {
  return new Map(await Promise.all([...new Set(paths)].map(async (path) => [path, await load(path)] as const)));
}

/** 一棵 JSON 里引用的贴图（粒子系统的模块、材质的颜色树：ComputeTextureColor 这些）。 */
export function textureRefs(tree: unknown): TextureRef[] {
  const found: TextureRef[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      if (typeof (value as TextureRef).texture === 'string' && !('$type' in value)) found.push(value as TextureRef);
      else Object.values(value).forEach(visit);
    }
  };
  visit(tree);
  return found;
}
