/**
 * 画 GPU 上的粒子：顶点着色器直接读粒子的存储缓冲，按形状展开四边形（同 CPU 的 shapes.ts 的 buildQuads：Billboard、Quad、
 * Hexagon、OrientedQuad，位置、大小、转角的曲线，局部模拟换到世界），UV 帧按寿命在着色器里算（同 material.ts 的翻页、滚动）。
 * 片元着色器和 CPU 的粒子是同一份（材质的 materialColor），所以画出来的样子一样。
 *
 * 每个粒子一个实例：Billboard 等 6 个顶点（两个三角形，同 CPU 的下标 0 1 2 0 2 3），Hexagon 12 个。死了的槽输出到裁剪
 * 范围以外。画的顺序：按槽、从新到旧（环的头往回）或者按深度排好的（sort.ts）。
 */
import type { UVBuilderParams } from '../material';
import type { ParticleEmitter } from '../ParticleEmitter';
import { BuiltinShape } from '../shapes';
import { packCurve, PARTICLE_WGSL } from './kernel';

const SHAPE_KINDS: Readonly<Record<string, number>> = { shapeBuilderBillboard: 0, shapeBuilderQuad: 1, shapeBuilderHexagon: 2, shapeBuilderOrientedQuad: 3 };
const UV_KINDS: Readonly<Record<UVBuilderParams['kind'], number>> = { whole: 0, flipbook: 1, scroll: 2 };
const SORT_MODES = { none: 0, byAge: 1, byDepth: 2 } as const;

/** Shape 的标志位。 */
export const SHAPE_FLAGS = { local: 1, positionCurve: 2, sizeCurve: 4, rotationCurve: 8, scaleLength: 16, hasSize: 32, hasQuaternion: 64, hasDirection: 128 } as const;

/** Shape 的大小：info、uvKind、四个 UV 参数、位置曲线 32、大小曲线 8、转角曲线 32（vec4）。 */
export const SHAPE_VEC4S = 6 + 32 + 8 + 32;

/** 发射器的形状参数（画的时候不变的部分，建 GPU 发射器时写一次）。 */
export function packShape(emitter: ParticleEmitter): ArrayBuffer {
  const shape = emitter.shape as BuiltinShape;
  const buffer = new ArrayBuffer(SHAPE_VEC4S * 16);
  const f32 = new Float32Array(buffer), u32 = new Uint32Array(buffer);
  const pool = emitter.pool;
  let flags = 0;
  if (emitter.simulationSpace === 'local') flags |= SHAPE_FLAGS.local;
  if (shape.samplerPosition) flags |= SHAPE_FLAGS.positionCurve;
  if (shape.samplerSize) flags |= SHAPE_FLAGS.sizeCurve;
  if (shape.samplerRotation) flags |= SHAPE_FLAGS.rotationCurve;
  if (shape.scaleLength) flags |= SHAPE_FLAGS.scaleLength;
  // CPU 上字段不存在时用固定值（大小 1、不转、朝上），GPU 的粒子字段都在，按标志选
  if (pool.field('size')) flags |= SHAPE_FLAGS.hasSize;
  if (pool.field('quaternion')) flags |= SHAPE_FLAGS.hasQuaternion;
  if (pool.field('direction')) flags |= SHAPE_FLAGS.hasDirection;
  const sorting = emitter.sortingPolicy === 'byDepth' ? SORT_MODES.byDepth : emitter.sortingPolicy === 'byAge' ? SORT_MODES.byAge : SORT_MODES.none;
  u32.set([SHAPE_KINDS[shape.type] ?? 0, flags, 0, sorting], 0);
  f32[2] = shape.lengthFactor;
  const uv = emitter.program?.uvParams ?? { uv: { kind: 'whole' } as const, uv1: { kind: 'whole' } as const };
  u32.set([UV_KINDS[uv.uv.kind], UV_KINDS[uv.uv1.kind], 0, 0], 4);
  [uv.uv, uv.uv1].forEach((params, i) => f32.set(uvVectors(params), 8 + i * 8));
  if (shape.samplerPosition) packCurve(shape.samplerPosition, false, f32, 6);
  if (shape.samplerSize) packCurve(shape.samplerSize, true, f32, 6 + 32);
  // Quad 的转角曲线是四元数（每个 vec4 一个），别的形状是度数（每个 vec4 四个）
  if (shape.samplerRotation) packCurve(shape.samplerRotation, !shape.samplerRotation.isQuaternion, f32, 6 + 32 + 8);
  return buffer;
}

/** 一套 UV 的两个 vec4：翻页是 [每行几帧, 几行, 起始帧, 速度]，滚动是起止帧的 [左, 上, 右, 下]。 */
function uvVectors(params: UVBuilderParams): number[] {
  if (params.kind === 'flipbook') return [params.x, params.y, params.start, params.speed, 0, 0, 0, 0];
  if (params.kind === 'scroll') return [...params.start, ...params.end];
  return [0, 0, 0, 0, 0, 0, 0, 0];
}

/** 接在粒子渲染器的 SHADER_HEAD（Draw、Varyings）后面的顶点着色器。 */
export const GPU_DRAW_WGSL = /* wgsl */ `${PARTICLE_WGSL}
struct Shape {
  info: vec4u,
  uvKind: vec4u,
  uv0a: vec4f,
  uv0b: vec4f,
  uv1a: vec4f,
  uv1b: vec4f,
  position: array<vec4f, 32>,
  size: array<vec4f, 8>,
  rotation: array<vec4f, 32>,
};
@group(2) @binding(0) var<storage, read> particles: array<Particle>;
@group(2) @binding(1) var<storage, read> sorted: array<vec2u>;
@group(2) @binding(2) var<uniform> shape: Shape;

const SQRT3_HALF = 0.86602540378;
const HEX_TOP = 0.5 - SQRT3_HALF * 0.5;
// 角（x、y 是四边形上的 -1..1，z、w 是 UV），按三角形展开（下标 0 1 2 0 2 3）
const QUAD = array<vec4f, 6>(vec4f(-1.0, 1.0, 0.0, 0.0), vec4f(1.0, 1.0, 1.0, 0.0), vec4f(1.0, -1.0, 1.0, 1.0), vec4f(-1.0, 1.0, 0.0, 0.0), vec4f(1.0, -1.0, 1.0, 1.0), vec4f(-1.0, -1.0, 0.0, 1.0));
const HEXAGON = array<vec4f, 12>(
  vec4f(-0.5, SQRT3_HALF, 0.25, HEX_TOP), vec4f(0.5, SQRT3_HALF, 0.75, HEX_TOP), vec4f(1.0, 0.0, 1.0, 0.5),
  vec4f(-0.5, SQRT3_HALF, 0.25, HEX_TOP), vec4f(1.0, 0.0, 1.0, 0.5), vec4f(-1.0, 0.0, 0.0, 0.5),
  vec4f(1.0, 0.0, 1.0, 0.5), vec4f(0.5, -SQRT3_HALF, 0.75, 1.0), vec4f(-0.5, -SQRT3_HALF, 0.25, 1.0),
  vec4f(1.0, 0.0, 1.0, 0.5), vec4f(-0.5, -SQRT3_HALF, 0.25, 1.0), vec4f(-1.0, 0.0, 0.0, 0.5));

fn rotateByQuaternion(q: vec4f, v: vec3f) -> vec3f {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}

// Stride 的 a * b：先转 a 再转 b
fn combineQuaternions(a: vec4f, b: vec4f) -> vec4f {
  return vec4f(
    b.x * a.w + a.x * b.w + b.y * a.z - b.z * a.y,
    b.y * a.w + a.y * b.w + b.z * a.x - b.x * a.z,
    b.z * a.w + a.z * b.w + b.x * a.y - b.y * a.x,
    b.w * a.w - dot(b.xyz, a.xyz));
}

fn sampleAt(age: f32) -> vec2f {
  let at = clamp(age, 0.0, 1.0) * 31.0;
  return vec2f(floor(at), at - floor(at));
}

fn shapeScalar(curve: u32, age: f32) -> f32 {
  let s = sampleAt(age);
  let i = u32(s.x);
  let j = min(i + 1u, 31u);
  var a: f32;
  var b: f32;
  if (curve == 0u) {
    a = shape.size[i / 4u][i % 4u];
    b = shape.size[j / 4u][j % 4u];
  } else {
    a = shape.rotation[i / 4u][i % 4u];
    b = shape.rotation[j / 4u][j % 4u];
  }
  return mix(a, b, s.y);
}

// UV 帧 [u, v, 宽, 高]（material.ts 的 flipbookOf、scrollOf）
fn uvFrame(kind: u32, a: vec4f, b: vec4f, life: f32) -> vec4f {
  if (kind == 1u) {
    let frame = a.z + trunc((1.0 - life) * a.w);
    return vec4f((frame % a.x) / a.x, floor(frame / a.x) / a.y, 1.0 / a.x, 1.0 / a.y);
  }
  if (kind == 2u) {
    let r = mix(a, b, 1.0 - life);
    return vec4f(r.x, r.y, r.z - r.x, r.w - r.y);
  }
  return vec4f(0.0, 0.0, 1.0, 1.0);
}

fn slotOf(instance: u32) -> u32 {
  let capacity = draw.ring.y;
  switch shape.info.w {
    case 1u: { return (draw.ring.x + capacity - 1u - instance % capacity) % capacity; }
    case 2u: { return sorted[instance].y; }
    default: { return instance; }
  }
}

@vertex fn vsGpu(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> Varyings {
  var out: Varyings;
  // 死了的槽：放到裁剪范围外（三个顶点一样，什么都不画）
  out.position = vec4f(2.0, 2.0, 2.0, 1.0);
  out.uv = vec2f(0.0);
  out.uv1 = vec2f(0.0);
  out.color = vec4f(0.0);
  let slot = slotOf(instance);
  if (slot >= draw.ring.y) {
    return out;
  }
  let p = particles[slot];
  if (p.life <= 0.0) {
    return out;
  }
  let flags = shape.info.y;
  let age = 1.0 - p.life;
  var center = p.position;
  if ((flags & ${SHAPE_FLAGS.positionCurve}u) != 0u) {
    let s = sampleAt(age);
    center += mix(shape.position[u32(s.x)], shape.position[min(u32(s.x) + 1u, 31u)], s.y).xyz;
  }
  var size = select(1.0, p.size, (flags & ${SHAPE_FLAGS.hasSize}u) != 0u);
  if ((flags & ${SHAPE_FLAGS.sizeCurve}u) != 0u) {
    size *= shapeScalar(0u, age);
  }
  let local = (flags & ${SHAPE_FLAGS.local}u) != 0u;
  if (local) {
    center = rotateByQuaternion(draw.spaceRotation, center) * draw.spacePosition.w + draw.spacePosition.xyz;
    size *= draw.spacePosition.w;
  }
  let half = size * 0.5;
  var a: vec3f;
  var b: vec3f;
  switch shape.info.x {
    case 1u: {
      var q = select(vec4f(0.0, 0.0, 0.0, 1.0), p.quaternion, (flags & ${SHAPE_FLAGS.hasQuaternion}u) != 0u);
      if ((flags & ${SHAPE_FLAGS.rotationCurve}u) != 0u) {
        let s = sampleAt(age);
        let c = mix(shape.rotation[u32(s.x)], shape.rotation[min(u32(s.x) + 1u, 31u)], s.y);
        q = combineQuaternions(c / max(length(c), 1e-6), q);
      }
      a = rotateByQuaternion(q, vec3f(1.0, 0.0, 0.0));
      b = rotateByQuaternion(q, vec3f(0.0, 0.0, 1.0));
      if (local) {
        a = rotateByQuaternion(draw.spaceRotation, a);
        b = rotateByQuaternion(draw.spaceRotation, b);
      }
      a *= half;
      b *= half;
    }
    case 3u: {
      var axis = select(vec3f(0.0, 1.0, 0.0), p.direction, (flags & ${SHAPE_FLAGS.hasDirection}u) != 0u);
      if (local) {
        axis = rotateByQuaternion(draw.spaceRotation, axis) * draw.spacePosition.w;
      }
      // 方向投影到屏幕平面，屏幕里垂直于它的那条是 X
      let back = draw.cameraBack.xyz;
      var flat = axis - back * dot(axis, back);
      flat = select(flat, normalize(flat), length(flat) > 1e-6);
      var x = draw.cameraRight.xyz * dot(flat, draw.cameraUp.xyz) - draw.cameraUp.xyz * dot(flat, draw.cameraRight.xyz);
      x = select(x, normalize(x), length(x) > 1e-6);
      a = x * half;
      let lengthFactor = bitcast<f32>(shape.info.z);
      b = axis * lengthFactor * select(0.5, half, (flags & ${SHAPE_FLAGS.scaleLength}u) != 0u);
    }
    default: {
      a = draw.cameraRight.xyz * half;
      b = draw.cameraUp.xyz * half;
      var turn = p.rotation;
      if ((flags & ${SHAPE_FLAGS.rotationCurve}u) != 0u) {
        turn += shapeScalar(1u, age) * ${Math.PI / 180};
      }
      if (turn != 0.0) {
        let c = cos(turn);
        let s = sin(turn);
        let x = a * c - b * s;
        b = b * c + a * s;
        a = x;
      }
    }
  }
  var corner: vec4f;
  if (shape.info.x == 2u) {
    corner = HEXAGON[vertex % 12u];
  } else {
    corner = QUAD[vertex % 6u];
  }
  out.position = draw.viewProjection * vec4f(center + a * corner.x + b * corner.y, 1.0);
  let f0 = uvFrame(shape.uvKind.x, shape.uv0a, shape.uv0b, p.life);
  let f1 = uvFrame(shape.uvKind.y, shape.uv1a, shape.uv1b, p.life);
  out.uv = f0.xy + f0.zw * corner.zw;
  out.uv1 = f1.xy + f1.zw * corner.zw;
  out.color = clamp(p.color, vec4f(0.0), vec4f(1.0));
  return out;
}
`;

/** 每个粒子几个顶点。 */
export function verticesPerParticle(emitter: ParticleEmitter): number {
  return (emitter.shape as BuiltinShape).type === 'shapeBuilderHexagon' ? 12 : 6;
}
