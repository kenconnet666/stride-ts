/**
 * Stride 的图形合成器（.sdgfxcomp）里运行时现在用得到的部分：
 * - 相机槽位（Cameras）：按列表顺序编号，相机组件的 Slot 换成下标（Camera.slot），槽位 0 是主画面。
 * - 主画面：从 Game 出发找到渲染槽位 0 的相机的 SceneCameraRenderer，取它下面第一个前向渲染器（不进渲染到纹理的分支）
 *   的清屏色和后处理开关。
 * - 画进渲染目标贴图的相机：SceneCameraRenderer 下面是 RenderTextureSceneRenderer 的，取它的贴图和里面的前向渲染器。
 * 多个相机分屏画、调试渲染器、单独的渲染阶段（UI）等以后随合成器的数据化一起做（docs/roadmap.md 的"合成器的最小数据化"）。
 */
import type { SceneCompositor, SceneForwardRenderer, SceneRenderTexture, SceneTextureCamera } from '@stride-ts/engine/content-format';
import { asNumber, asObject, parseAssetReference, parseObjectReference, type StrideObject, type StrideValue } from './yaml.ts';

export interface ImportedCompositor {
  /** 相机槽位的 Id 到下标。 */
  readonly cameraSlots: ReadonlyMap<string, number>;
  /** 主画面的设置；找不到前向渲染器时是 undefined（运行时用默认值）。 */
  readonly main: SceneCompositor | undefined;
}

/** 渲染目标贴图资源的引用（Id）换成场景里的写法；找不到时返回 undefined。 */
export type RenderTextureResolver = (assetId: string) => SceneRenderTexture | undefined;

export function importCompositor(compositor: StrideObject | undefined, renderTexture: RenderTextureResolver = () => undefined): ImportedCompositor {
  const slotIds = Object.values(asObject(field(compositor, 'Cameras')) ?? {}).map((slot) => asObject(slot)?.['Id']);
  const cameraSlots = new Map(slotIds.flatMap((id, index) => (typeof id === 'string' ? [[id, index] as const] : [])));
  const shared = new Map(Object.values(asObject(field(compositor, 'SharedRenderers')) ?? {})
    .flatMap((renderer) => {
      const object = asObject(renderer);
      return typeof object?.['Id'] === 'string' ? [[object['Id'], object] as const] : [];
    }));
  // 引用共享的渲染器时写成 `!类型 ref!! Id`，解析出来是 { $type, value: 'ref!! Id' }
  const resolve = (node: StrideValue | undefined): StrideObject | undefined => {
    const object = asObject(node);
    const reference = parseObjectReference(object?.['value']);
    return reference ? shared.get(reference) : object;
  };
  const mainSlot = slotIds[0];
  const camera = findRenderer(resolve(field(compositor, 'Game')), resolve, (node) =>
    node.$type?.startsWith('Stride.Rendering.Compositing.SceneCameraRenderer') === true && parseObjectReference(field(node, 'Camera')) === mainSlot);
  const forward = camera && findRenderer(resolve(field(camera, 'Child')), resolve, isForward);
  const textureCameras = textureCamerasOf(resolve(field(compositor, 'Game')), resolve, cameraSlots, renderTexture);
  const main = forward && { ...forwardSettings(forward), ...(textureCameras.length > 0 ? { textureCameras } : {}) };
  return { cameraSlots, main };
}

const isForward = (node: StrideObject) => node.$type?.startsWith('Stride.Rendering.Compositing.ForwardRenderer') === true;

/** 树里所有"相机画进渲染目标贴图"的分支，按出现的顺序（Stride 也按这个顺序画，先于主画面就能被主画面用上）。 */
function textureCamerasOf(
  node: StrideObject | undefined,
  resolve: (node: StrideValue | undefined) => StrideObject | undefined,
  cameraSlots: ReadonlyMap<string, number>,
  renderTexture: RenderTextureResolver,
): SceneTextureCamera[] {
  if (!node) return [];
  if (node.$type?.startsWith('Stride.Rendering.Compositing.SceneCameraRenderer')) {
    const child = resolve(field(node, 'Child'));
    const slot = cameraSlots.get(parseObjectReference(field(node, 'Camera')) ?? '');
    if (child?.$type?.startsWith('Stride.Rendering.Compositing.RenderTextureSceneRenderer') && slot !== undefined) {
      const texture = renderTexture(parseAssetReference(field(child, 'RenderTexture'))?.id ?? '');
      const forward = findRenderer(resolve(field(child, 'Child')), resolve, isForward);
      return texture && forward ? [{ cameraSlot: slot, texture, ...forwardSettings(forward) }] : [];
    }
    return [];
  }
  return Object.values(asObject(field(node, 'Children')) ?? {}).flatMap((child) => textureCamerasOf(resolve(child), resolve, cameraSlots, renderTexture));
}

function forwardSettings(forward: StrideObject): SceneForwardRenderer {
  const color = asObject(asObject(field(forward, 'Clear'))?.['Color']);
  return {
    // Stride 清屏时把颜色从 sRGB 换到线性空间（ClearRenderer 的 ToColorSpace）
    clearColor: [srgbToLinear(asNumber(color?.['R'], 0.4)), srgbToLinear(asNumber(color?.['G'], 0.4)), srgbToLinear(asNumber(color?.['B'], 0.4)), asNumber(color?.['A'], 1)],
    postEffects: field(forward, 'PostEffects') !== null,
    transparent: field(forward, 'TransparentRenderStage') !== null,
  };
}

/** 深度优先找第一个满足 match 的渲染器；不进渲染到纹理的分支（那里画的不是主画面）。 */
function findRenderer(node: StrideObject | undefined, resolve: (node: StrideValue | undefined) => StrideObject | undefined, match: (node: StrideObject) => boolean): StrideObject | undefined {
  if (!node) return undefined;
  if (match(node)) return node;
  if (node.$type?.startsWith('Stride.Rendering.Compositing.RenderTextureSceneRenderer')) return undefined;
  const children = [field(node, 'Child'), ...Object.values(asObject(field(node, 'Children')) ?? {})];
  for (const child of children) {
    const found = findRenderer(resolve(child), resolve, match);
    if (found) return found;
  }
  return undefined;
}

/** 取字段；派生资源里改过的字段名后面带 *（Stride 的覆盖标记）。 */
function field(object: StrideObject | undefined, name: string): StrideValue | undefined {
  if (!object) return undefined;
  return name in object ? object[name] : object[`${name}*`];
}

const srgbToLinear = (value: number) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
