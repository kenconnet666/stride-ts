/**
 * Stride 的图形合成器（.sdgfxcomp）里运行时现在用得到的部分：
 * - 相机槽位（Cameras）：按列表顺序编号，相机组件的 Slot 换成下标（Camera.slot），槽位 0 是主画面。
 * - 主画面：从 Game 出发找到渲染槽位 0 的相机的 SceneCameraRenderer，取它下面第一个前向渲染器（不进渲染到纹理的分支）
 *   的清屏色和后处理开关。
 * - 画进渲染目标贴图的相机：SceneCameraRenderer 下面是 RenderTextureSceneRenderer 的，取它的贴图和里面的前向渲染器。
 * 多个相机分屏画、调试渲染器、单独的渲染阶段（UI）等以后随合成器的数据化一起做（docs/roadmap.md 的"合成器的最小数据化"）。
 */
import type { SceneCompositor, SceneForwardRenderer, ScenePostEffects, SceneRenderTexture, SceneTextureCamera } from '@stride-ts/engine/content-format';
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
  const slotIds = Object.values(asObject(compositor?.['Cameras']) ?? {}).map((slot) => asObject(slot)?.['Id']);
  const cameraSlots = new Map(slotIds.flatMap((id, index) => (typeof id === 'string' ? [[id, index] as const] : [])));
  const shared = new Map(Object.values(asObject(compositor?.['SharedRenderers']) ?? {})
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
  const camera = findRenderer(resolve(compositor?.['Game']), resolve, (node) =>
    node.$type?.startsWith('Stride.Rendering.Compositing.SceneCameraRenderer') === true && parseObjectReference(node['Camera']) === mainSlot);
  const forward = camera && findRenderer(resolve(camera['Child']), resolve, isForward);
  const textureCameras = textureCamerasOf(resolve(compositor?.['Game']), resolve, cameraSlots, renderTexture);
  const main = forward && { ...forwardSettings(forward, resolve), ...(textureCameras.length > 0 ? { textureCameras } : {}) };
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
    const child = resolve(node['Child']);
    const slot = cameraSlots.get(parseObjectReference(node['Camera']) ?? '');
    if (child?.$type?.startsWith('Stride.Rendering.Compositing.RenderTextureSceneRenderer') && slot !== undefined) {
      const texture = renderTexture(parseAssetReference(child['RenderTexture'])?.id ?? '');
      const forward = findRenderer(resolve(child['Child']), resolve, isForward);
      return texture && forward ? [{ cameraSlot: slot, texture, ...forwardSettings(forward, resolve) }] : [];
    }
    return [];
  }
  return Object.values(asObject(node['Children']) ?? {}).flatMap((child) => textureCamerasOf(resolve(child), resolve, cameraSlots, renderTexture));
}

function forwardSettings(forward: StrideObject, resolve: (node: StrideValue | undefined) => StrideObject | undefined): SceneForwardRenderer {
  const color = asObject(asObject(forward['Clear'])?.['Color']);
  return {
    // Stride 清屏时把颜色从 sRGB 换到线性空间（ClearRenderer 的 ToColorSpace）
    clearColor: [srgbToLinear(asNumber(color?.['R'], 0.4)), srgbToLinear(asNumber(color?.['G'], 0.4)), srgbToLinear(asNumber(color?.['B'], 0.4)), asNumber(color?.['A'], 1)],
    postEffects: postEffectsOf(resolve(forward['PostEffects'])),
    transparent: forward['TransparentRenderStage'] !== null,
  };
}

/**
 * 后处理里各效果开不开（Stride 的 PostProcessingEffects）：效果的 Enabled 默认是 true；色调映射是颜色变换组
 * （ColorTransforms）里的一项，组的 Transforms 默认是空的，没有 ToneMap 这一项就不做；Antialiasing 是 null 就不做抗锯齿。
 * 我们还没有的效果（环境光遮蔽、屏幕空间反射、景深、雾、描边、胶片颗粒、暗角）不导入，见 docs/roadmap.md 的 P4。
 */
function postEffectsOf(effects: StrideObject | undefined): ScenePostEffects | null {
  if (!effects) return null;
  // 没写的效果是默认的（开着）；写成 null 的是没有这个效果
  const enabled = (node: StrideValue | undefined) => node !== null && asObject(node)?.['Enabled'] !== false;
  const colorTransforms = effects['ColorTransforms'];
  const toneMap = Object.values(asObject(asObject(colorTransforms)?.['Transforms']) ?? {}).find((transform) => asObject(transform)?.$type === 'ToneMap');
  return {
    brightFilter: enabled(effects['BrightFilter']),
    bloom: enabled(effects['Bloom']),
    lightStreak: enabled(effects['LightStreak']),
    lensFlare: enabled(effects['LensFlare']),
    toneMap: toneMap !== undefined && enabled(colorTransforms) && enabled(toneMap),
    antialiasing: enabled(effects['Antialiasing']),
  };
}

/** 深度优先找第一个满足 match 的渲染器；不进渲染到纹理的分支（那里画的不是主画面）。 */
function findRenderer(node: StrideObject | undefined, resolve: (node: StrideValue | undefined) => StrideObject | undefined, match: (node: StrideObject) => boolean): StrideObject | undefined {
  if (!node) return undefined;
  if (match(node)) return node;
  if (node.$type?.startsWith('Stride.Rendering.Compositing.RenderTextureSceneRenderer')) return undefined;
  const children = [node['Child'], ...Object.values(asObject(node['Children']) ?? {})];
  for (const child of children) {
    const found = findRenderer(resolve(child), resolve, match);
    if (found) return found;
  }
  return undefined;
}

const srgbToLinear = (value: number) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
