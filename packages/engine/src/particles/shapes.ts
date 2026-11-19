/**
 * 粒子展开成四边形（Stride 的 ShapeBuilder）：形状按画的顺序把每个粒子写成几个四边形（每个 4 个顶点）的位置和 UV，
 * VertexWriter 再按粒子补上颜色（没有时白色）和材质的 UV 帧（翻页、滚动），同 Stride 的形状加材质的 PatchVertexBuffer。
 * 游戏可以继承 ParticleShapeBuilder 写自己的形状，导出就按类名登记（同脚本，见 Registry 的粒子模块）。
 *
 * 引擎的形状（BuiltinShape）。共同的部分（Stride 的 ShapeBuilderCommon）：位置加 SamplerPosition（按走过的寿命），大小乘
 * SamplerSize；局部模拟的粒子按粒子系统的变换换到世界。各形状：
 * - Billboard：正对相机，按粒子的转角（加 SamplerRotation 的度数）在屏幕里转；
 * - Quad：本地 X、Z 两条边（平放），按粒子的朝向（SamplerRotation 先转）转；
 * - Hexagon：正对相机的六边形（两个四边形）；
 * - OrientedQuad：一条边沿粒子的方向（Direction，没有时朝上）拉长（ScaleLength 时乘大小，再乘 LengthFactor），另一条在屏幕里
 *   垂直于它。
 * Ribbon、Trail 把粒子连成带子，见 ribbons.ts。
 */
import type { ParticleModuleFile } from '../content/format';
import { curveSampler, type CurveSampler } from './curves';
import { combine, normalize, rotate, type Quat, type Vec3 } from './math';
import { value } from './modules';
import type { UVFrame, UVFrames } from './material';
import type { ParticleEmitter } from './ParticleEmitter';
import { buildRibbons, RibbonSettings, RIBBONS } from './ribbons';

/** 每个顶点：位置 3、UV 2、第二套 UV 2、颜色 4。 */
export const VERTEX_FLOATS = 11;
const SQRT3_HALF = 0.86602540378;
const DEGREES = Math.PI / 180;
const clamp = (c: number) => (c < 0 ? 0 : c > 1 ? 1 : c);

/** 相机的右、上、朝向自己的方向（世界空间），和视图投影矩阵（按列存，飘带按投影到屏幕上的走向定宽度方向）。 */
export interface CameraAxes {
  readonly right: Readonly<Vec3>;
  readonly up: Readonly<Vec3>;
  readonly back: Readonly<Vec3>;
  readonly viewProjection: Readonly<Float32Array>;
}

/**
 * 写顶点：先 particle(i) 选粒子（取它的颜色和两套 UV 帧），再按顺序 vertex(...) 写它的四边形，每个四边形的四个角按
 * 左上、右上、右下、左下。uv 是四边形上的 0 到 1，写进去的是按两套 UV 帧分别变换后的。
 */
export class VertexWriter {
  vertices: Float32Array;
  /** 下一个顶点写在哪（float 的下标）。 */
  at: number;
  readonly #color: Float32Array | undefined;
  readonly #life: Float32Array;
  readonly #uv: UVFrame;
  readonly #uv1: UVFrame;
  #r = 1; #g = 1; #b = 1; #a = 1;
  /** 两套 UV 帧：[u, v, 宽, 高]。 */
  #frame: readonly [number, number, number, number] = [0, 0, 1, 1];
  #frame1: readonly [number, number, number, number] = [0, 0, 1, 1];

  /** frames 给出粒子的两套 UV 帧（材质的 UVBuilder，没有时 [0, 0, 1, 1]）。 */
  constructor(emitter: ParticleEmitter, vertices: Float32Array, at: number, frames: UVFrames) {
    this.vertices = vertices;
    this.at = at;
    this.#color = emitter.pool.field('color');
    this.#life = emitter.pool.field('life')!;
    this.#uv = frames.uv;
    this.#uv1 = frames.uv1;
  }

  particle(i: number): void {
    const color = this.#color;
    if (color) {
      this.#r = clamp(color[i * 4]!); this.#g = clamp(color[i * 4 + 1]!); this.#b = clamp(color[i * 4 + 2]!); this.#a = clamp(color[i * 4 + 3]!);
    }
    this.#frame = this.#uv(this.#life[i]!);
    this.#frame1 = this.#uv1(this.#life[i]!);
  }

  vertex(x: number, y: number, z: number, u: number, v: number): void {
    const out = this.vertices, at = this.at;
    out[at] = x; out[at + 1] = y; out[at + 2] = z;
    const f = this.#frame, f1 = this.#frame1;
    out[at + 3] = f[0] + f[2] * u; out[at + 4] = f[1] + f[3] * v;
    out[at + 5] = f1[0] + f1[2] * u; out[at + 6] = f1[1] + f1[3] * v;
    out[at + 7] = this.#r; out[at + 8] = this.#g; out[at + 9] = this.#b; out[at + 10] = this.#a;
    this.at = at + VERTEX_FLOATS;
  }
}

/** 形状（Stride 的 ShapeBuilder）。游戏的形状继承它，构造参数是场景里的属性（ParticleModuleFile）。 */
export abstract class ParticleShapeBuilder {
  /** Registry 按它认出粒子模块。 */
  static readonly particleModuleKind = 'shape';

  /** 每个粒子几个四边形（渲染器按它留顶点的空间）。 */
  get quadsPerParticle(): number {
    return 1;
  }

  /** 按 order 的顺序写出每个粒子的 quadsPerParticle 个四边形。 */
  abstract build(emitter: ParticleEmitter, camera: CameraAxes, order: readonly number[], out: VertexWriter): void;
}

const BUILTIN_SHAPES = new Set(['shapeBuilderBillboard', 'shapeBuilderQuad', 'shapeBuilderHexagon', 'shapeBuilderOrientedQuad', ...RIBBONS]);

/** 引擎的形状：文件不是这几种时是 undefined。 */
export function createBuiltinShape(file: ParticleModuleFile): BuiltinShape | undefined {
  return BUILTIN_SHAPES.has(String(file.$type)) ? new BuiltinShape(file) : undefined;
}

/** 引擎的形状（构造发射器时读一次设置）。 */
export class BuiltinShape extends ParticleShapeBuilder {
  readonly type: string;
  readonly samplerPosition: CurveSampler | undefined;
  readonly samplerSize: CurveSampler | undefined;
  readonly samplerRotation: CurveSampler | undefined;
  readonly scaleLength: boolean;
  readonly lengthFactor: number;
  /** 飘带、拖尾的设置（别的形状没有）。 */
  readonly ribbon: RibbonSettings | undefined;

  constructor(file: ParticleModuleFile) {
    super();
    this.type = String(file.$type);
    this.samplerPosition = curveSampler(file['samplerPosition'] as ParticleModuleFile | null | undefined);
    this.samplerSize = curveSampler(file['samplerSize'] as ParticleModuleFile | null | undefined);
    this.samplerRotation = curveSampler(file['samplerRotation'] as ParticleModuleFile | null | undefined);
    this.scaleLength = value(file, 'scaleLength', true);
    this.lengthFactor = value(file, 'lengthFactor', 1);
    this.ribbon = RIBBONS.has(this.type) ? new RibbonSettings(file) : undefined;
  }

  override get quadsPerParticle(): number {
    return this.ribbon?.sections ?? (this.type === 'shapeBuilderHexagon' ? 2 : 1);
  }

  build(emitter: ParticleEmitter, camera: CameraAxes, order: readonly number[], out: VertexWriter): void {
    if (this.ribbon) buildRibbons(emitter, this.ribbon, camera, order, out);
    else buildQuads(emitter, this, camera, order, out);
  }
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

/** 四边形和六边形的形状：中心 c，两条半边 a（屏幕里向右）、b（向上）。 */
function buildQuads(emitter: ParticleEmitter, shape: BuiltinShape, camera: CameraAxes, order: readonly number[], out: VertexWriter): void {
  const pool = emitter.pool;
  const position = pool.field('position')!, size = pool.field('size'), angle = pool.field('rotation');
  const quaternion = pool.field('quaternion'), life = pool.field('life')!, direction = pool.field('direction');
  const local = emitter.simulationSpace === 'local';
  const space = emitter.drawTransform;
  let cx = 0, cy = 0, cz = 0, ax = 0, ay = 0, az = 0, bx = 0, by = 0, bz = 0;
  const vertex = (sx: number, sy: number, u: number, v: number) =>
    out.vertex(cx + ax * sx + bx * sy, cy + ay * sx + by * sy, cz + az * sx + bz * sy, u, v);
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
    out.particle(i);
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
}

