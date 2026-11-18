/**
 * 方向光的级联阴影：按相机视锥切出各级联，每个级联一个正交的阴影视图（Stride 的 LightDirectionalShadowMapRenderer
 * 的 Collect 和 ComputeCascadeSplits，公式、常数和稳定化做法照抄）。
 * - 深度范围自动时取可见物体到相机近平面的距离，带滞后：变大超过 1.1 倍、变小到一半以下才调整，画面里物体进出时
 *   级联不会每帧跳动。这份状态跨帧保留（Stride 存在 LightShadowMapTexture 上）。
 * - 对数划分：均匀和对数分布按 pssmFactor 插值。
 * - 级联用切出来的视锥段的外接球定大小，投影按阴影图的像素对齐（ProjectionSnapping），相机转动、移动时阴影边缘不闪。
 */
import { Matrix } from '../../mathematics/Matrix';
import type { Vector3 } from '../../mathematics/vectors';
import { RenderView, type DirectionalShadowSettings, type ShadowReceiver } from '../RenderSystem';

const DEPTH_INCREASE_THRESHOLD = 1.1;
const DEPTH_DECREASE_THRESHOLD = 2.0;
/** Stride 的 LightShadowMapTexture.DistanceMinRange。 */
const DISTANCE_MIN_RANGE = 0.001;
const VECTOR_UPS = [[0, 1, 0], [1, 0, 0], [0, 0, 1]] as const;
/** 裁剪空间的视锥角点：前 4 个在近平面（z = 0），后 4 个在远平面。 */
const FRUSTUM_BASE_POINTS = [[-1, -1, 0], [1, -1, 0], [-1, 1, 0], [1, 1, 0], [-1, -1, 1], [1, -1, 1], [-1, 1, 1], [1, 1, 1]] as const;

/** 图集里一个级联占的方块（像素）。 */
export interface CascadeRectangle {
  readonly x: number;
  readonly y: number;
}

type Vec3 = [number, number, number];

export class DirectionalShadowCascades {
  /** 第 i 个级联的阴影视图（忽略近、远平面剔除）。 */
  readonly views: RenderView[] = Array.from({ length: 4 }, () => Object.assign(new RenderView(), { ignoreDepthPlanes: true }));
  #currentMin = 1;
  #currentMax = 2;
  readonly #splitRatios = new Float64Array(4);
  readonly #cornersWS: Vec3[] = [];
  readonly #cornersVS: Vec3[] = [];
  readonly #viewToWorld = Matrix.identity();
  readonly #projectionToView = Matrix.identity();
  readonly #lightView = Matrix.identity();
  readonly #viewProjection = Matrix.identity();
  readonly #adjustment = Matrix.identity();

  /**
   * 按主视图算出各级联：写进 views 的前 cascadeCount 个和 receiver（矩阵、分割距离）。direction 是光前进的方向。
   */
  collect(source: RenderView, direction: Readonly<Vector3>, settings: Readonly<DirectionalShadowSettings>, size: number, rectangles: readonly CascadeRectangle[],
    atlasSize: number, receiver: ShadowReceiver): void {
    // 正交相机只用一个级联（Stride：Projection.M44 == 1）
    const cascadeCount = source.projection[15] === 1 ? 1 : settings.cascadeCount;
    receiver.cascadeCount = cascadeCount;
    Matrix.invert(this.#viewToWorld, source.view);
    this.#updateFrustum(source);
    const [minDistance] = this.#computeCascadeSplits(source, settings, cascadeCount);

    const length = Math.hypot(direction.x, direction.y, direction.z) || 1;
    const dir: Vec3 = [direction.x / length, direction.y / length, direction.z / length];
    let side: Vec3 = [1, 0, 0];
    let up: Vec3 = [1, 0, 0];
    for (const vectorUp of VECTOR_UPS) {
      if (Math.abs(dot(dir, vectorUp)) < 1 - 0.0001) {
        side = normalize(cross(vectorUp, dir));
        up = normalize(cross(dir, side));
        break;
      }
    }

    const near = source.nearClipPlane, far = source.farClipPlane;
    let splitMaxRatio = (minDistance - near) / (far - near);
    let splitMinRatio = 0;
    const cascadeWS: Vec3[] = Array.from({ length: 8 }, () => [0, 0, 0]);
    const cascadeVS: Vec3[] = Array.from({ length: 8 }, () => [0, 0, 0]);
    for (let level = 0; level < cascadeCount; level++) {
      const oldSplitMinRatio = splitMinRatio;
      splitMinRatio = splitMaxRatio;
      splitMaxRatio = this.#splitRatios[level]!;
      // 相邻级联重叠 20%，交界处才能混合
      const overlap = level > 0 && settings.blendCascades ? 0.2 * (splitMinRatio - oldSplitMinRatio) : 0;
      for (let j = 0; j < 4; j++) {
        for (const [corners, out] of [[this.#cornersWS, cascadeWS], [this.#cornersVS, cascadeVS]] as const) {
          const a = corners[j]!, b = corners[j + 4]!;
          for (let c = 0; c < 3; c++) {
            const range = b[c]! - a[c]!;
            out[j]![c] = a[c]! + range * (splitMinRatio - overlap);
            out[j + 4]![c] = a[c]! + range * splitMaxRatio;
          }
        }
      }

      let target: Vec3;
      let minBound: Vec3, maxBound: Vec3;
      if (settings.stabilization !== 'none') {
        // 外接球（Stride 的 BoundingSphere.FromPoints：重心，加最远点的距离）：转动相机时大小不变
        const center: Vec3 = [0, 0, 0];
        for (const p of cascadeVS) for (let c = 0; c < 3; c++) center[c]! += p[c]! / 8;
        let radius = 0;
        for (const p of cascadeVS) radius = Math.max(radius, Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2]));
        target = Matrix.transformPoint(this.#viewToWorld, center[0], center[1], center[2]);
        maxBound = [radius, radius, radius];
        minBound = [-radius, -radius, -radius];
        if (settings.stabilization === 'viewSnapping') {
          const snapping = (size * 0.5 * 0.25) / radius;
          const x = Math.ceil(dot(target, up) * snapping) / snapping;
          const y = Math.ceil(dot(target, side) * snapping) / snapping;
          const z = dot(target, dir);
          target = [up[0] * x + side[0] * y + dir[0] * z, up[1] * x + side[1] * y + dir[1] * z, up[2] * x + side[2] * y + dir[2] * z];
        }
      } else {
        const low: Vec3 = [Infinity, Infinity, Infinity], high: Vec3 = [-Infinity, -Infinity, -Infinity];
        for (const p of cascadeWS) for (let c = 0; c < 3; c++) { low[c] = Math.min(low[c]!, p[c]!); high[c] = Math.max(high[c]!, p[c]!); }
        target = [(low[0] + high[0]) / 2, (low[1] + high[1]) / 2, (low[2] + high[2]) / 2];
        const lightView = Matrix.lookAtRH(this.#lightView, target, [target[0] + dir[0], target[1] + dir[1], target[2] + dir[2]], up);
        minBound = [Infinity, Infinity, Infinity];
        maxBound = [-Infinity, -Infinity, -Infinity];
        for (const p of cascadeWS) {
          const q = Matrix.transformPoint(lightView, p[0], p[1], p[2]);
          for (let c = 0; c < 3; c++) { minBound[c] = Math.min(minBound[c]!, q[c]!); maxBound[c] = Math.max(maxBound[c]!, q[c]!); }
        }
      }

      const view = this.views[level]!;
      const back = maxBound[2];
      Matrix.lookAtRH(view.view, [target[0] - dir[0] * back, target[1] - dir[1] * back, target[2] - dir[2] * back], target, up);
      const farClip = maxBound[2] - minBound[2];
      Matrix.orthoOffCenterRH(view.projection, minBound[0], maxBound[0], minBound[1], maxBound[1], 0, farClip);
      if (settings.stabilization === 'projectionSnapping') {
        // 把投影平移到阴影图的整像素上
        const vp = Matrix.multiply(this.#viewProjection, view.projection, view.view);
        const px = vp[12]! * size * 0.5, py = vp[13]! * size * 0.5;
        view.projection[12]! += ((Math.round(px) - px) * 2) / size;
        view.projection[13]! += ((Math.round(py) - py) * 2) / size;
      }
      view.nearClipPlane = 0;
      view.farClipPlane = farClip;
      const rect = rectangles[level]!;
      view.viewport = { x: rect.x, y: rect.y, width: size, height: size };
      view.width = view.height = size;
      view.update();

      // 世界坐标到图集 UV：裁剪空间 xy 缩放到这一块，y 朝下
      const half = (size / atlasSize) * 0.5;
      Matrix.scaleTranslation(this.#adjustment, half, -half, 1, (rect.x + size / 2) / atlasSize, (rect.y + size / 2) / atlasSize, 0);
      Matrix.multiply(receiver.worldToShadow.subarray(level * 16, level * 16 + 16), this.#adjustment, view.viewProjection);
      receiver.splits[level] = near + (far - near) * this.#splitRatios[level]!;
    }
  }

  /** 主视图视锥的 8 个角，世界空间和视图空间各一份。 */
  #updateFrustum(source: RenderView): void {
    Matrix.invert(this.#projectionToView, source.projection);
    this.#cornersWS.length = this.#cornersVS.length = 0;
    for (const [x, y, z] of FRUSTUM_BASE_POINTS) {
      this.#cornersWS.push(Matrix.transformPoint(source.inverseViewProjection, x, y, z));
      this.#cornersVS.push(Matrix.transformPoint(this.#projectionToView, x, y, z));
    }
  }

  /** 各级联结束处在 near..far 之间的比例写进 #splitRatios，返回用到的最近、最远距离。 */
  #computeCascadeSplits(source: RenderView, settings: Readonly<DirectionalShadowSettings>, cascadeCount: number): [number, number] {
    const near = source.nearClipPlane, far = source.farClipPlane;
    const cameraRange = far - near;
    let minDistance: number, maxDistance: number;
    if (settings.depthRange === 'automatic') {
      minDistance = Math.max(source.minimumDistance, near);
      maxDistance = Math.max(source.maximumDistance, minDistance);
      let threshold = maxDistance > this.#currentMax ? DEPTH_INCREASE_THRESHOLD : DEPTH_DECREASE_THRESHOLD;
      maxDistance = logCeiling(maxDistance / this.#currentMax, threshold) * this.#currentMax;
      this.#setCurrentMax(maxDistance);
      const range = maxDistance - minDistance;
      const currentRange = this.#currentMax - this.#currentMin;
      threshold = range > currentRange ? DEPTH_INCREASE_THRESHOLD : DEPTH_DECREASE_THRESHOLD;
      minDistance = Math.max(maxDistance - logCeiling(range / currentRange, threshold) * currentRange, near);
      this.#setCurrentMin(minDistance);
    } else {
      minDistance = near + settings.minDistance;
      maxDistance = near + settings.maxDistance;
    }
    const ratio = maxDistance / minDistance;
    const logRatio = Math.min(Math.max(1 - settings.pssmFactor, 0), 1);
    for (let level = 0; level < cascadeCount; level++) {
      const distribution = (level + 1) / cascadeCount;
      const logZ = minDistance * ratio ** distribution;
      const uniformZ = minDistance + (maxDistance - minDistance) * distribution;
      this.#splitRatios[level] = (uniformZ + (logZ - uniformZ) * logRatio - near) / cameraRange;
    }
    return [minDistance, maxDistance];
  }

  // 同 Stride 的 LightShadowMapTexture.CurrentMinDistance、CurrentMaxDistance 的 setter：太小的值忽略，保持最小间隔
  #setCurrentMin(value: number): void {
    if (value <= DISTANCE_MIN_RANGE) return;
    this.#currentMin = value;
    if (this.#currentMax < value + DISTANCE_MIN_RANGE) this.#currentMax = value + DISTANCE_MIN_RANGE;
  }

  #setCurrentMax(value: number): void {
    if (value <= DISTANCE_MIN_RANGE * 2) return;
    this.#currentMax = value;
    if (this.#currentMin > value - DISTANCE_MIN_RANGE) this.#currentMin = value - DISTANCE_MIN_RANGE;
  }
}

/** newBase 的整数次幂里不小于 value 的最小那个（Stride 的 LogCeiling）。 */
function logCeiling(value: number, newBase: number): number {
  return newBase ** Math.ceil(Math.log(value) / Math.log(newBase));
}

function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
}

function cross(a: ArrayLike<number>, b: ArrayLike<number>): Vec3 {
  return [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
}

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}
