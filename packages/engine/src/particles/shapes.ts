/**
 * 粒子展开成四边形（Stride 的 ShapeBuilder）：每个粒子 4 个顶点（Hexagon 8 个，两个四边形），写进顶点数组。
 * 共同的部分（Stride 的 ShapeBuilderCommon）：位置加 SamplerPosition（按走过的寿命），大小乘 SamplerSize；局部模拟的粒子按粒子
 * 系统的变换换到世界；颜色是粒子的颜色（没有时白色），UV 按材质的翻页动画取帧。各形状：
 * - Billboard：正对相机，按粒子的转角（加 SamplerRotation 的度数）在屏幕里转；
 * - Quad：本地 X、Z 两条边（平放），按粒子的朝向（SamplerRotation 先转）转；
 * - Hexagon：正对相机的六边形；
 * - OrientedQuad：一条边沿粒子的方向（Direction，没有时朝上）拉长（ScaleLength 时乘大小，再乘 LengthFactor），另一条在屏幕里
 *   垂直于它。
 * Ribbon、Trail 把粒子连成带子，见 ribbons.ts。
 */
import type { ParticleModuleFile } from '../content/format';
import { curveSampler, type CurveSampler } from './curves';
import { combine, normalize, rotate, type Quat, type Vec3 } from './math';
import { value } from './modules';
import type { ParticleEmitter } from './ParticleEmitter';
import { buildRibbons, RibbonSettings, RIBBONS } from './ribbons';

/** 每个顶点：位置 3、UV 2、颜色 4。 */
export const VERTEX_FLOATS = 9;
const SQRT3_HALF = 0.86602540378;
const DEGREES = Math.PI / 180;

export const SHAPES = new Set(['shapeBuilderBillboard', 'shapeBuilderQuad', 'shapeBuilderHexagon', 'shapeBuilderOrientedQuad', ...RIBBONS]);

/** 发射器的形状设置（构造发射器时读一次）。 */
export class ShapeSettings {
  readonly type: string;
  readonly samplerPosition: CurveSampler | undefined;
  readonly samplerSize: CurveSampler | undefined;
  readonly samplerRotation: CurveSampler | undefined;
  readonly scaleLength: boolean;
  readonly lengthFactor: number;
  /** 飘带、拖尾的设置（别的形状没有）。 */
  readonly ribbon: RibbonSettings | undefined;

  constructor(file: ParticleModuleFile) {
    this.type = String(file.$type);
    this.samplerPosition = curveSampler(file['samplerPosition'] as ParticleModuleFile | null | undefined);
    this.samplerSize = curveSampler(file['samplerSize'] as ParticleModuleFile | null | undefined);
    this.samplerRotation = curveSampler(file['samplerRotation'] as ParticleModuleFile | null | undefined);
    this.scaleLength = value(file, 'scaleLength', true);
    this.lengthFactor = value(file, 'lengthFactor', 1);
    this.ribbon = RIBBONS.has(this.type) ? new RibbonSettings(file) : undefined;
  }

  get quadsPerParticle(): number {
    return this.ribbon?.sections ?? (this.type === 'shapeBuilderHexagon' ? 2 : 1);
  }
}

/** 相机的右、上、朝向自己的方向（世界空间），和视图投影矩阵（按列存，飘带按投影到屏幕上的走向定宽度方向）。 */
export interface CameraAxes {
  readonly right: Readonly<Vec3>;
  readonly up: Readonly<Vec3>;
  readonly back: Readonly<Vec3>;
  readonly viewProjection: Readonly<Float32Array>;
}

/**
 * 画粒子的顺序（Stride 的 ParticleSorter*）：ByDepth 从远到近（深度方向是相机的 Z 轴），ByAge 从新到旧，ByOrder 按生成顺序
 * 从新到旧（飘带从发射器那头连起），没有对应的字段或 None 时按池里的顺序。
 */
export function drawOrder(emitter: ParticleEmitter, camera: CameraAxes): number[] {
  const pool = emitter.pool;
  const order = Array.from({ length: pool.living }, (_, i) => i);
  switch (emitter.sortingPolicy) {
    case 'byDepth': {
      const position = pool.field('position')!;
      const [dx, dy, dz] = camera.back;
      const key = (i: number) => position[i * 3]! * dx + position[i * 3 + 1]! * dy + position[i * 3 + 2]! * dz;
      return order.sort((a, b) => key(a) - key(b));
    }
    case 'byAge': {
      const life = pool.field('life')!;
      return order.sort((a, b) => life[b]! - life[a]!);
    }
    case 'byOrder': {
      const spawnOrder = pool.integers('order');
      return spawnOrder ? order.sort((a, b) => spawnOrder[b]! - spawnOrder[a]!) : order;
    }
    default:
      return order;
  }
}

/**
 * 按 order 的顺序把发射器的粒子写进 vertices（从 at 起），返回写完的位置。uv 给出某个粒子的 UV 帧 [u, v, 宽, 高]
 * （材质的翻页动画，没有时 [0, 0, 1, 1]）。
 */
export function buildShapes(
  emitter: ParticleEmitter, shape: ShapeSettings, camera: CameraAxes, order: readonly number[], vertices: Float32Array, at: number,
  uv: (remainingLife: number) => readonly [number, number, number, number],
): number {
  if (shape.ribbon) return buildRibbons(emitter, shape.ribbon, camera, order, vertices, at, uv);
  const pool = emitter.pool;
  const position = pool.field('position')!, size = pool.field('size'), angle = pool.field('rotation');
  const quaternion = pool.field('quaternion'), color = pool.field('color'), life = pool.field('life')!, direction = pool.field('direction');
  const local = emitter.simulationSpace === 'local';
  const space = emitter.drawTransform;
  const v = vertices;
  let cx = 0, cy = 0, cz = 0, ax = 0, ay = 0, az = 0, bx = 0, by = 0, bz = 0;
  let r = 1, g = 1, b = 1, a = 1, u0 = 0, v0 = 0, us = 1, vs = 1;
  const vertex = (sx: number, sy: number, u: number, w: number) => {
    v[at] = cx + ax * sx + bx * sy; v[at + 1] = cy + ay * sx + by * sy; v[at + 2] = cz + az * sx + bz * sy;
    v[at + 3] = u0 + us * u; v[at + 4] = v0 + vs * w;
    v[at + 5] = r; v[at + 6] = g; v[at + 7] = b; v[at + 8] = a;
    at += VERTEX_FLOATS;
  };
  const clamp = (c: number) => (c < 0 ? 0 : c > 1 ? 1 : c);
  const center: Vec3 = [0, 0, 0], axisX: Vec3 = [0, 0, 0], axisY: Vec3 = [0, 0, 0];
  const q: Quat = [0, 0, 0, 1];
  const top = 0.5 - SQRT3_HALF * 0.5;
  for (const i of order) {
    const age = 1 - life[i]!;
    center[0] = position[i * 3]!; center[1] = position[i * 3 + 1]!; center[2] = position[i * 3 + 2]!;
    if (shape.samplerPosition) {
      const offset = shape.samplerPosition.evaluate(age);
      for (let k = 0; k < 3; k++) center[k]! += offset[k] ?? 0;
    }
    let particleSize = size ? size[i]! : 1;
    if (shape.samplerSize) particleSize *= shape.samplerSize.evaluateFloat(age);
    if (local) {
      rotate(space.worldRotation, center);
      for (let k = 0; k < 3; k++) center[k] = center[k]! * space.worldScale[0] + space.worldPosition[k]!;
      particleSize *= space.worldScale[0];
    }
    const half = particleSize * 0.5;
    cx = center[0]; cy = center[1]; cz = center[2];
    switch (shape.type) {
      case 'shapeBuilderQuad': {
        axisX[0] = 1; axisX[1] = 0; axisX[2] = 0;
        axisY[0] = 0; axisY[1] = 0; axisY[2] = 1;
        let rotation: Quat | undefined;
        if (quaternion) {
          q[0] = quaternion[i * 4]!; q[1] = quaternion[i * 4 + 1]!; q[2] = quaternion[i * 4 + 2]!; q[3] = quaternion[i * 4 + 3]!;
          rotation = q;
        }
        if (shape.samplerRotation) rotation = combine(shape.samplerRotation.evaluate(age) as Quat, rotation ?? [0, 0, 0, 1]);
        if (rotation) {
          rotate(rotation, axisX);
          rotate(rotation, axisY);
        }
        if (local) {
          rotate(space.worldRotation, axisX);
          rotate(space.worldRotation, axisY);
        }
        ax = axisX[0] * half; ay = axisX[1] * half; az = axisX[2] * half;
        bx = axisY[0] * half; by = axisY[1] * half; bz = axisY[2] * half;
        break;
      }
      case 'shapeBuilderOrientedQuad': {
        // 方向（Stride 的 Direction 字段，没有时朝上），局部模拟时也转到世界
        axisY[0] = direction ? direction[i * 3]! : 0; axisY[1] = direction ? direction[i * 3 + 1]! : 1; axisY[2] = direction ? direction[i * 3 + 2]! : 0;
        if (local) {
          rotate(space.worldRotation, axisY);
          for (let k = 0; k < 3; k++) axisY[k]! *= space.worldScale[0];
        }
        // 方向投影到屏幕平面，屏幕里垂直于它的那条是 X
        const dotZ = axisY[0] * camera.back[0] + axisY[1] * camera.back[1] + axisY[2] * camera.back[2];
        const flat = normalize<Vec3>([axisY[0] - camera.back[0] * dotZ, axisY[1] - camera.back[1] * dotZ, axisY[2] - camera.back[2] * dotZ]);
        const dotX = flat[0] * camera.right[0] + flat[1] * camera.right[1] + flat[2] * camera.right[2];
        const dotY = flat[0] * camera.up[0] + flat[1] * camera.up[1] + flat[2] * camera.up[2];
        const x = normalize<Vec3>([camera.right[0] * dotY - camera.up[0] * dotX, camera.right[1] * dotY - camera.up[1] * dotX, camera.right[2] * dotY - camera.up[2] * dotX]);
        ax = x[0] * half; ay = x[1] * half; az = x[2] * half;
        const length = shape.lengthFactor * (shape.scaleLength ? half : 0.5);
        bx = axisY[0] * length; by = axisY[1] * length; bz = axisY[2] * length;
        break;
      }
      default: {
        ax = camera.right[0] * half; ay = camera.right[1] * half; az = camera.right[2] * half;
        bx = camera.up[0] * half; by = camera.up[1] * half; bz = camera.up[2] * half;
        let turn = angle ? angle[i]! : 0;
        if (shape.samplerRotation) turn += shape.samplerRotation.evaluateFloat(age) * DEGREES;
        if (turn !== 0) {
          const cos = Math.cos(turn), sin = Math.sin(turn);
          const x0 = ax * cos - bx * sin, x1 = ay * cos - by * sin, x2 = az * cos - bz * sin;
          bx = bx * cos + ax * sin; by = by * cos + ay * sin; bz = bz * cos + az * sin;
          ax = x0; ay = x1; az = x2;
        }
      }
    }
    if (color) {
      r = clamp(color[i * 4]!); g = clamp(color[i * 4 + 1]!); b = clamp(color[i * 4 + 2]!); a = clamp(color[i * 4 + 3]!);
    }
    [u0, v0, us, vs] = uv(life[i]!);
    if (shape.type === 'shapeBuilderHexagon') {
      // 两个四边形拼成六边形（Stride 的 ShapeBuilderHexagon）：上半是梯形加中线，下半同样
      vertex(-0.5, SQRT3_HALF, 0.25, top);
      vertex(0.5, SQRT3_HALF, 0.75, top);
      vertex(1, 0, 1, 0.5);
      vertex(-1, 0, 0, 0.5);
      vertex(1, 0, 1, 0.5);
      vertex(0.5, -SQRT3_HALF, 0.75, 1);
      vertex(-0.5, -SQRT3_HALF, 0.25, 1);
      vertex(-1, 0, 0, 0.5);
    } else {
      vertex(-1, 1, 0, 0);
      vertex(1, 1, 1, 0);
      vertex(1, -1, 1, 1);
      vertex(-1, -1, 0, 1);
    }
  }
  return at;
}
