/**
 * Stride 的图形合成器（.sdgfxcomp）里运行时现在用得到的部分：
 * - 相机槽位（Cameras）：按列表顺序编号，相机组件的 Slot 换成下标（Camera.slot），槽位 0 是主画面。
 * - 主画面：从 Game 出发找到渲染槽位 0 的相机的 SceneCameraRenderer，取它下面第一个前向渲染器（不进渲染到纹理的分支）
 *   的清屏色和后处理开关。
 * 渲染到纹理、多个相机的画面、调试渲染器等以后随合成器的数据化一起做（docs/roadmap.md 的"合成器的最小数据化"）。
 */
import type { SceneCompositor } from '@stride-ts/engine/content-format';
import { asNumber, asObject, parseObjectReference, type StrideObject, type StrideValue } from './yaml.ts';

export interface ImportedCompositor {
  /** 相机槽位的 Id 到下标。 */
  readonly cameraSlots: ReadonlyMap<string, number>;
  /** 主画面的设置；找不到前向渲染器时是 undefined（运行时用默认值）。 */
  readonly main: SceneCompositor | undefined;
}

export function importCompositor(compositor: StrideObject | undefined): ImportedCompositor {
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
  const forward = camera && findRenderer(resolve(field(camera, 'Child')), resolve, (node) => node.$type?.startsWith('Stride.Rendering.Compositing.ForwardRenderer') === true);
  return { cameraSlots, main: forward && mainSettings(forward) };
}

function mainSettings(forward: StrideObject): SceneCompositor {
  const color = asObject(asObject(field(forward, 'Clear'))?.['Color']);
  return {
    // Stride 清屏时把颜色从 sRGB 换到线性空间（ClearRenderer 的 ToColorSpace）
    clearColor: [srgbToLinear(asNumber(color?.['R'], 0.4)), srgbToLinear(asNumber(color?.['G'], 0.4)), srgbToLinear(asNumber(color?.['B'], 0.4)), asNumber(color?.['A'], 1)],
    postEffects: field(forward, 'PostEffects') !== null,
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
