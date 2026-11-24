/**
 * 点光、聚光的阴影视图（Stride 的 LightPointShadowMapRendererCubeMap、LightSpotShadowMapRenderer 的 Collect，公式和常数照抄）。
 * - 点光：立方体的六个面各一个透视视图，视场角比 90° 大一点（四周多出 BORDER_PIXELS 像素），PCF 在面的边上采样时取得到邻面的
 *   内容；近平面 0.1，远平面是半径的两倍。
 * - 聚光：一个透视视图，按光源实体的世界矩阵摆，视场角是外锥的全角；近平面 0.01，远平面是射程的两倍。
 * 阴影图的大小按光源在主视图上盖住多大算（ComputeScreenCoverage）。
 */
import { Matrix, type Matrix4 } from '../../data/Matrix';
import { RenderView, type LocalLight, type LocalShadowReceiver } from '../RenderSystem';
import type { PackedRectangle } from './ShadowAtlasAllocator';

/** 立方体每个面四周留的边（Stride 的 LightPointShadowMapRendererCubeMap.BorderPixels）。 */
const BORDER_PIXELS = 8;
const POINT_NEAR = 0.1, SPOT_NEAR = 0.01;

const rotationY = (angle: number): Matrix4 => Float32Array.of(Math.cos(angle), 0, -Math.sin(angle), 0, 0, 1, 0, 0, Math.sin(angle), 0, Math.cos(angle), 0, 0, 0, 0, 1);
const rotationX = (angle: number): Matrix4 => Float32Array.of(1, 0, 0, 0, 0, Math.cos(angle), Math.sin(angle), 0, 0, -Math.sin(angle), Math.cos(angle), 0, 0, 0, 0, 1);
/**
 * 六个面的视图旋转（Stride 的 ViewFaceRotationMatrices）：前（+Z）、后（-Z）、右（+X）、左（-X）、上（+Y）、下（-Y），
 * 着色器按到光源的方向里最长的那个轴选面，顺序要和它一致。
 */
const FACE_ROTATIONS: readonly Matrix4[] = [rotationY(Math.PI), Matrix.identity(), rotationY(Math.PI / 2), rotationY(-Math.PI / 2), rotationX(-Math.PI / 2), rotationX(Math.PI / 2)];

/** 光源在视图上盖住的大小（像素），阴影图的大小按它定（Stride 的 LightPoint、LightSpot 的 ComputeScreenCoverage）。 */
export function screenCoverage(view: RenderView, light: Readonly<LocalLight>): number {
  const { position: p, direction: d, radius } = light;
  // 点光看球心；聚光看光锥底面的中心和底面的半径
  const [x, y, z] = light.spot ? [p.x + d.x * radius, p.y + d.y * radius, p.z + d.z * radius] : [p.x, p.y, p.z];
  const r = light.spot ? radius * Math.sin((light.angleOuter * Math.PI) / 360) : radius;
  const m = view.viewProjection;
  const distance = Math.abs(m[3]! * x + m[7]! * y + m[11]! * z + m[15]!) + 0.00001;
  const longest = Math.max(view.width, view.height);
  // 相机在球里面
  if (distance < r) return longest;
  return ((r * view.projection[5]!) / (Math.sqrt(distance * distance - r * r) + 0.00001)) * longest;
}

export class LocalShadowViews {
  readonly #views: RenderView[] = [];
  #used = 0;
  readonly #translation = Matrix.identity();
  readonly #adjustment = Matrix.identity();

  /** 新的一帧：视图从头用起。 */
  reset(): void {
    this.#used = 0;
  }

  /**
   * 一盏光的阴影视图（点光六个、聚光一个），画进图集里的 rectangles；着色器要的数据写进 receiver。
   * 返回的视图只在这一帧有效（下一帧重用）。
   */
  collect(light: Readonly<LocalLight>, rectangles: readonly PackedRectangle[], atlasSize: number, receiver: LocalShadowReceiver): RenderView[] {
    receiver.point = !light.spot;
    receiver.depthBias = light.shadow.depthBias;
    receiver.normalOffsetScale = light.shadow.normalOffsetScale;
    const near = light.spot ? SPOT_NEAR : POINT_NEAR, far = light.radius * 2;
    // 深度 = A + B / z：z 在近平面是 0、远平面是 1
    receiver.depthA = far / (far - near);
    receiver.depthB = (near * far) / (near - far);
    const views: RenderView[] = [];
    rectangles.forEach((rectangle, face) => {
      const view = (this.#views[this.#used++] ??= Object.assign(new RenderView(), { reversedDepth: false }));
      const size = rectangle.width;
      if (light.spot) {
        Matrix.invert(view.view, light.world);
        Matrix.perspectiveFovRH(view.projection, (light.angleOuter * Math.PI) / 180, 1, near, far);
      } else {
        const { x, y, z } = light.position;
        Matrix.scaleTranslation(this.#translation, 1, 1, 1, -x, -y, -z);
        Matrix.multiply(view.view, FACE_ROTATIONS[face]!, this.#translation);
        const half = size / 2;
        Matrix.perspectiveFovRH(view.projection, Math.atan((half + BORDER_PIXELS) / half) * 2, 1, near, far);
      }
      view.nearClipPlane = near;
      view.farClipPlane = far;
      view.viewport = { x: rectangle.x, y: rectangle.y, width: size, height: size };
      view.width = view.height = size;
      view.receivesShadows = false;
      view.update();
      // 裁剪空间的 xy（-1..1，y 朝上）到图集的 UV
      const half = size / atlasSize / 2;
      Matrix.scaleTranslation(this.#adjustment, half, -half, 1, (rectangle.x + size / 2) / atlasSize, (rectangle.y + size / 2) / atlasSize, 0);
      Matrix.multiply(receiver.worldToShadow.subarray(face * 16, face * 16 + 16), this.#adjustment, view.viewProjection);
      views.push(view);
    });
    return views;
  }
}
