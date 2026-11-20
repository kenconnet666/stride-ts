/**
 * GPU 粒子的模拟内核：按发射器用到的初始化器、更新器拼出一个计算着色器（同样的模块组合拼出同样的代码，管线共用），
 * 模块的参数和世界变换每帧打包进 uniform（pack），不用重编着色器。
 *
 * 粒子放在一块存储缓冲里（Particle，96 字节），按环形下标生成：这一帧新粒子是从 spawnStart 起的 spawnCount 个槽（CPU 记着
 * 环的头，见 GpuEmitter）。一次派发处理可能活着的那一段环（windowStart 起 windowCount 个：最近"最长寿命"秒里生成的，
 * 更早的一定死了），粒子少、容量大时不白跑。每个槽：新生成的设默认值、跑初始化器、跑后置更新器；活着的照 CPU
 * （ParticleEmitter.update）的顺序：减寿命（到了就死）、按速度移动、更新器、后置更新器。
 *
 * 和 Stride（CPU 的粒子）不同：随机数是 PCG 哈希（Stride 的 RandomSeed 对大整数取 sin、cos，GPU 的 f32 算不准），同样的
 * 分布、不同的取值；种子是发射器生成的第几个粒子加上起始种子（同 Stride 的 RandomSeedGenerator），存 32 位。
 *
 * 支持的模块（其余的发射器留在 CPU 上，见 gpuUnsupported）：初始化器 SizeSeed、PositionSeed、VelocitySeed、DirectionSeed、
 * RotationSeed、3DRotationSeed、ColorSeed、SpawnOrder；更新器 Gravity、SizeOverTime、ColorOverTime、RotationOverTime、
 * SpeedToDirection、Wind（风场的全局风和离发射器最近的 GPU_LOCAL_WINDS 个局部风源，见 weather/WindField.ts）。
 */
import { CurveSampler } from './curves';
import { BuiltinShape } from './shapes';
import { isChildModule } from './children';
import { boxFrame, Initial3DRotationSeed, InitialColorSeed, InitialDirectionSeed, InitialPositionSeed, InitialRotationSeed, InitialSizeSeed, InitialSpawnOrder, InitialVelocitySeed } from './modules';
import type { ParticleModule } from './modules';
import type { ParticleEmitter } from './ParticleEmitter';
import { RandomOffset } from './random';
import { UpdaterColorOverTime, UpdaterGravity, UpdaterRotationOverTime, UpdaterSizeOverTime, UpdaterSpeedToDirection, UpdaterWind } from './updaters';
import { GPU_LOCAL_WINDS, packWind, WIND_WGSL } from '../weather/WindField';
import { OCCLUSION_WGSL } from '../weather/SkyOcclusion';

/** 一个粒子在存储缓冲里占的字节（WGSL 的 Particle）。 */
export const PARTICLE_BYTES = 96;
/** uniform 开头的固定部分（Sim 的 data 之前），vec4 的个数。 */
export const HEADER_VEC4S = 5;
export const WORKGROUP_SIZE = 64;
const CURVE_SAMPLES = 32;
const DEGREES = Math.PI / 180;

/** 粒子的结构和随机数，模拟、排序、画都用。 */
export const PARTICLE_WGSL = /* wgsl */ `
struct Particle {
  position: vec3f,
  // 剩下的寿命（1 到 0，同 CPU 的 life 字段），0 是死了（或者这个槽还没用过）
  life: f32,
  velocity: vec3f,
  invLifetime: f32,
  // 预乘 alpha
  color: vec4f,
  direction: vec3f,
  size: f32,
  quaternion: vec4f,
  rotation: f32,
  seed: u32,
  order: u32,
  pad: u32,
};

// PCG 哈希（Jarzynski、Olano 的 "Hash Functions for GPU Rendering"）
fn pcg(v: u32) -> u32 {
  let state = v * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

// 种子在偏移 offset 处的随机数，[0, 1)（偏移同 Stride 的 RandomOffset）
fn seedFloat(seed: u32, offset: u32) -> f32 {
  return f32(pcg(seed ^ pcg(offset)) >> 8u) / 16777216.0;
}
`;

/** 一个模块拼进内核的部分：占几个 vec4、代码（d(k) 是自己的第 k 个 vec4，slot(k) 是它在 data 里的下标）、每帧怎么打包。 */
interface KernelPart {
  readonly stage: 'init' | 'update' | 'post';
  readonly slots: number;
  readonly code: string;
  /** 往 out 的第 base 个 vec4 起写自己的数据。 */
  readonly pack: (out: Float32Array, base: number) => void;
}

/** 拼好的内核。 */
export interface GpuKernel {
  readonly code: string;
  /** 用遮挡（绑定 2、3 是深度图和它的视图投影，见 weather/SkyOcclusion）。 */
  readonly occluded: boolean;
  /** data 里一共几个 vec4。 */
  readonly slots: number;
  /** 把各模块这一帧的数据写进 out（uniform 的 data 部分，按 vec4 排）。 */
  pack(out: Float32Array): void;
}

/** 这个发射器为什么不能放到 GPU 上；能放时是 undefined。 */
export function gpuUnsupported(emitter: ParticleEmitter): string | undefined {
  const shape = emitter.shape;
  if (!(shape instanceof BuiltinShape)) return 'its shape is a game module';
  if (shape.ribbon) return 'ribbons and trails are drawn on the CPU';
  if (emitter.program && !emitter.program.uvParams) return 'its material has no UV builder parameters';
  if (emitter.sortingPolicy === 'byOrder') return 'sorting by spawn order is CPU-only';
  if (emitter.delayParticleDeath > 0 || emitter.pool.field('children0')) return 'it is the parent of child particles';
  for (const module of emitter.spawners) if (isChildModule(module)) return 'it spawns from a parent emitter';
  for (const module of [...emitter.initializers, ...emitter.updaters]) {
    if (!module.enabled) continue;
    if (!partFor(module)) return `${module.constructor.name} has no GPU version`;
  }
  return undefined;
}

/** 按发射器的模块拼内核（先用 gpuUnsupported 检查过）。 */
export function buildKernel(emitter: ParticleEmitter): GpuKernel {
  const parts: KernelPart[] = [];
  for (const module of [...emitter.initializers, ...emitter.updaters]) {
    if (!module.enabled) continue;
    const part = partFor(module);
    if (!part) throw new Error(`particle module ${module.constructor.name} has no GPU version`);
    parts.push(part);
  }
  let slots = 0;
  const placed = parts.map((part) => {
    const base = slots;
    slots += part.slots;
    const code = part.code
      .replace(/\bd\((\d+)\)/g, (_, k: string) => `sim.data[${base + Number(k)}]`)
      .replace(/\bslot\((\d+)\)/g, (_, k: string) => `${base + Number(k)}u`);
    return { part, base, code };
  });
  const occluded = emitter.gpuOccluder !== undefined;
  const stage = (name: KernelPart['stage']) => placed.filter(({ part }) => part.stage === name).map(({ code }) => `  {\n${code}\n  }`).join('\n');
  const code = `${PARTICLE_WGSL}
struct Sim {
  dt: f32,
  capacity: u32,
  spawnStart: u32,
  spawnCount: u32,
  seedBase: u32,
  lifeMin: f32,
  lifeMax: f32,
  // 游戏时间，秒（风的阵风、湍流按它变）
  time: f32,
  defaultPosition: vec3f,
  defaultScale: f32,
  defaultRotation: vec4f,
  // 这一帧要处理的槽：从 windowStart 起 windowCount 个（最近"最长寿命"秒里生成的，别的一定死了，不用看）
  windowStart: u32,
  windowCount: u32,
  pad0: u32,
  pad1: u32,
  data: array<vec4f, ${Math.max(slots, 1)}>,
};
@group(0) @binding(0) var<uniform> sim: Sim;
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;

// 间接绘制的参数：实例数是这一帧活着的粒子数（每个活着的粒子加一），alive 是它们的槽号（顺序不定）
struct DrawArgs {
  vertexCount: u32,
  instanceCount: atomic<u32>,
  firstVertex: u32,
  firstInstance: u32,
};
@group(0) @binding(4) var<storage, read_write> drawArgs: DrawArgs;
@group(0) @binding(5) var<storage, read_write> alive: array<u32>;

fn markAlive(i: u32) {
  alive[atomicAdd(&drawArgs.instanceCount, 1u)] = i;
}

${HELPERS_WGSL}
${WIND_WGSL}
${occluded ? OCCLUSION_WGSL : ''}

fn initialize(p: ptr<function, Particle>, spawnIndex: u32) {
${stage('init')}
}

fn update(p: ptr<function, Particle>, dt: f32) {
${stage('update')}
}

fn postUpdate(p: ptr<function, Particle>, dt: f32, old: vec3f) {
${stage('post')}
}

@compute @workgroup_size(${WORKGROUP_SIZE}) fn simulate(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= sim.windowCount) {
    return;
  }
  let i = (sim.windowStart + id.x) % sim.capacity;
  var p = particles[i];
  let spawnIndex = (i + sim.capacity - sim.spawnStart) % sim.capacity;
  if (spawnIndex < sim.spawnCount) {
    // 新粒子：默认值（CPU 的 InitialDefaultFields），寿命按种子在范围里取
    let seed = sim.seedBase + spawnIndex;
    p.seed = seed;
    p.life = 1.0;
    p.invLifetime = 1.0 / mix(sim.lifeMin, sim.lifeMax, seedFloat(seed, ${RandomOffset.lifetime}u));
    p.position = sim.defaultPosition;
    p.velocity = vec3f(0.0);
    p.direction = vec3f(0.0);
    p.quaternion = sim.defaultRotation;
    p.rotation = 0.0;
    p.size = sim.defaultScale;
    p.color = vec4f(1.0);
    p.order = seed;
    initialize(&p, spawnIndex);
    postUpdate(&p, sim.dt, p.position);
    particles[i] = p;
    markAlive(i);
    return;
  }
  if (p.life <= 0.0) {
    return;
  }
  p.life = min(p.life, 1.0) - sim.dt * p.invLifetime;
  if (p.life <= 1e-6) {
    particles[i].life = 0.0;
    return;
  }
  let old = p.position;
  p.position += p.velocity * sim.dt;
  update(&p, sim.dt);
  postUpdate(&p, sim.dt, old);${occluded ? `
  // 落到遮挡的表面以下（屋顶、树冠）就死
  if (occluded(p.position)) {
    p.life = 0.0;
  }` : ''}
  particles[i] = p;
  if (p.life > 0.0) {
    markAlive(i);
  }
}
`;
  return {
    code,
    occluded,
    slots,
    pack(out) {
      for (const { part, base } of placed) part.pack(out, base);
    },
  };
}

/** 着色器里的小工具：盒子里的随机点、四元数、按寿命取曲线。 */
const HELPERS_WGSL = /* wgsl */ `
const OFFSET_1A = ${RandomOffset.offset1A}u;

// 角 + 三条边 · 随机数（CPU 的 randomBox）
fn randomBox(corner: vec4f, x: vec4f, y: vec4f, z: vec4f, seed: u32, seedOffset: u32) -> vec3f {
  let r = vec3f(seedFloat(seed, ${RandomOffset.offset3A}u + seedOffset), seedFloat(seed, ${RandomOffset.offset3B}u + seedOffset), seedFloat(seed, ${RandomOffset.offset3C}u + seedOffset));
  return corner.xyz + x.xyz * r.x + y.xyz * r.y + z.xyz * r.z;
}

// Stride 的 a * b：先转 a 再转 b
fn combine(a: vec4f, b: vec4f) -> vec4f {
  return vec4f(
    b.x * a.w + a.x * b.w + b.y * a.z - b.z * a.y,
    b.y * a.w + a.y * b.w + b.z * a.x - b.x * a.z,
    b.z * a.w + a.z * b.w + b.x * a.y - b.y * a.x,
    b.w * a.w - dot(b.xyz, a.xyz));
}

fn slerp(a: vec4f, b: vec4f, t: f32) -> vec4f {
  let d = dot(a, b);
  if (abs(d) > 1.0 - 1e-6) {
    return a * (1.0 - t) + b * t * sign(d);
  }
  let angle = acos(abs(d));
  let inv = 1.0 / sin(angle);
  return a * (sin((1.0 - t) * angle) * inv) + b * (sin(t * angle) * inv * sign(d));
}

fn normalizeSafe(q: vec4f) -> vec4f {
  let l = length(q);
  return select(q, q / l, l > 1e-6);
}

// 按寿命取曲线（CurveSampler.evaluate）：32 个采样点之间线性插值。标量的从 first 起每个 vec4 放 4 个，向量的每个 vec4 一个
fn curveScalar(age: f32, first: u32) -> f32 {
  let at = clamp(age, 0.0, 1.0) * 31.0;
  let i = u32(at);
  let j = min(i + 1u, 31u);
  return mix(sim.data[first + i / 4u][i % 4u], sim.data[first + j / 4u][j % 4u], at - f32(i));
}

fn curveVector(age: f32, first: u32) -> vec4f {
  let at = clamp(age, 0.0, 1.0) * 31.0;
  let i = u32(at);
  return mix(sim.data[first + i], sim.data[first + min(i + 1u, 31u)], at - f32(i));
}
`;

/** 曲线的 32 个采样点打包：标量每个 vec4 放 4 个，向量、颜色每个 vec4 放 1 个（不足的分量补 0）。 */
export function packCurve(curve: CurveSampler, scalar: boolean, out: Float32Array, base: number): void {
  const samples = curve.samples;
  if (scalar) for (let i = 0; i < CURVE_SAMPLES; i++) out[base * 4 + i] = samples[i]![0] ?? 0;
  else for (let i = 0; i < CURVE_SAMPLES; i++) for (let k = 0; k < 4; k++) out[(base + i) * 4 + k] = samples[i]![k] ?? 0;
}

/**
 * 按寿命改值的更新器共用：主曲线、可选的第二条（两条之间按种子插值）。标量曲线每条占 8 个 vec4，向量 32 个；返回占的
 * vec4 数、取值的表达式和打包。
 */
function overTime(curves: { readonly main: CurveSampler | undefined; readonly optional: CurveSampler | undefined; readonly seedOffset: number }, scalar: boolean) {
  const per = scalar ? CURVE_SAMPLES / 4 : CURVE_SAMPLES;
  const read = (first: number) => `${scalar ? 'curveScalar' : 'curveVector'}(age, slot(${first}))`;
  const value = curves.optional ? `mix(${read(0)}, ${read(per)}, seedFloat((*p).seed, OFFSET_1A + ${curves.seedOffset >>> 0}u))` : read(0);
  return {
    slots: curves.optional ? 2 * per : per,
    value,
    pack(out: Float32Array, base: number) {
      if (curves.main) packCurve(curves.main, scalar, out, base);
      if (curves.optional) packCurve(curves.optional, scalar, out, base + per);
    },
  };
}

/** 模块对应的内核部分；没有 GPU 版时是 undefined。 */
function partFor(module: ParticleModule): KernelPart | undefined {
  const write = (out: Float32Array, slot: number, values: readonly number[]) => out.set(values, slot * 4);
  if (module instanceof InitialSizeSeed) {
    return {
      stage: 'init', slots: 1,
      code: `    (*p).size = d(0).x + d(0).y * seedFloat((*p).seed, OFFSET_1A + ${module.seedOffset >>> 0}u);`,
      pack: (out, base) => {
        const min = module.worldScale[0] * module.randomSize[0];
        write(out, base, [min, module.worldScale[0] * module.randomSize[1] - min, 0, 0]);
      },
    };
  }
  const box = (field: string, min: () => readonly number[], max: () => readonly number[], translate: boolean, seedOffset: number): KernelPart => ({
    stage: 'init', slots: 4,
    code: `    (*p).${field} = randomBox(d(0), d(1), d(2), d(3), (*p).seed, ${seedOffset >>> 0}u);`,
    pack: (out, base) => {
      const { corner, axes } = boxFrame(module, min() as [number, number, number], max() as [number, number, number], translate);
      write(out, base, [...corner, 0]);
      axes.forEach((axis, k) => write(out, base + 1 + k, [...axis, 0]));
    },
  });
  if (module instanceof InitialPositionSeed) return box('position', () => module.positionMin, () => module.positionMax, true, module.seedOffset);
  if (module instanceof InitialVelocitySeed) return box('velocity', () => module.velocityMin, () => module.velocityMax, false, module.seedOffset);
  if (module instanceof InitialDirectionSeed) return box('direction', () => module.directionMin, () => module.directionMax, false, module.seedOffset);
  if (module instanceof InitialRotationSeed) {
    return {
      stage: 'init', slots: 1,
      code: `    (*p).rotation = d(0).x + d(0).y * seedFloat((*p).seed, OFFSET_1A + ${module.seedOffset >>> 0}u);`,
      pack: (out, base) => write(out, base, [module.angularRotation[0] * DEGREES, (module.angularRotation[1] - module.angularRotation[0]) * DEGREES, 0, 0]),
    };
  }
  if (module instanceof Initial3DRotationSeed) {
    return {
      stage: 'init', slots: 3,
      code: `    (*p).quaternion = combine(normalizeSafe(slerp(d(0), d(1), seedFloat((*p).seed, OFFSET_1A + ${module.seedOffset >>> 0}u))), d(2));`,
      pack: (out, base) => {
        write(out, base, module.rotationMin);
        write(out, base + 1, module.rotationMax);
        write(out, base + 2, module.worldRotation);
      },
    };
  }
  if (module instanceof InitialColorSeed) {
    return {
      stage: 'init', slots: 2,
      code: `    let c = mix(d(0), d(1), seedFloat((*p).seed, OFFSET_1A + ${module.seedOffset >>> 0}u));
    (*p).color = vec4f(c.rgb * c.a, c.a);`,
      pack: (out, base) => {
        write(out, base, module.colorMin);
        write(out, base + 1, module.colorMax);
      },
    };
  }
  // 生成的顺序：GPU 上没有按它排序、连成飘带的用处，order 已经是种子（单调增）
  if (module instanceof InitialSpawnOrder) return { stage: 'init', slots: 0, code: '', pack: () => {} };
  if (module instanceof UpdaterGravity) {
    return {
      stage: 'update', slots: 1,
      code: `    let dv = d(0).xyz * dt;
    (*p).position += dv * dt * 0.5;
    (*p).velocity += dv;`,
      pack: (out, base) => write(out, base, [...module.acceleration, 0]),
    };
  }
  if (module instanceof UpdaterSizeOverTime || module instanceof UpdaterRotationOverTime) {
    if (!module.curves.main) return { stage: 'post', slots: 0, code: '', pack: () => {} };
    const curves = overTime(module.curves, true);
    const size = module instanceof UpdaterSizeOverTime;
    // 曲线后面一个 vec4 放世界缩放
    const settings = curves.slots;
    return {
      stage: 'post', slots: curves.slots + 1,
      code: `    let age = 1.0 - (*p).life;
    ${size ? `(*p).size = d(${settings}).x * ${curves.value};` : `(*p).rotation = ${curves.value} * ${DEGREES};`}`,
      pack: (out, base) => {
        curves.pack(out, base);
        write(out, base + settings, [module.worldScale[0], 0, 0, 0]);
      },
    };
  }
  if (module instanceof UpdaterColorOverTime) {
    if (!module.curves.main) return { stage: 'post', slots: 0, code: '', pack: () => {} };
    const curves = overTime(module.curves, false);
    return {
      stage: 'post', slots: curves.slots,
      code: `    let age = 1.0 - (*p).life;
    let c = ${curves.value};
    (*p).color = vec4f(c.rgb * c.a, c.a);`,
      pack: (out, base) => curves.pack(out, base),
    };
  }
  if (module instanceof UpdaterWind) {
    // 风 2 + 2 · GPU_LOCAL_WINDS 个 vec4，最后一个放 drag 和终端速度
    const windSlots = 2 + 2 * GPU_LOCAL_WINDS;
    return {
      stage: 'update', slots: windSlots + 1,
      code: `    (*p).velocity += (windAt((*p).position, sim.time, slot(0)) + d(${windSlots}).yzw - (*p).velocity) * min(1.0, d(${windSlots}).x * dt);`,
      pack: (out, base) => {
        if (module.field) packWind(module.field, module.worldPosition, out, base);
        else out.fill(0, base * 4, (base + windSlots) * 4);
        write(out, base + windSlots, [module.drag, ...module.terminalVelocity]);
      },
    };
  }
  if (module instanceof UpdaterSpeedToDirection) {
    return {
      stage: 'post', slots: 0,
      code: `    if (dt > 1e-6) {
      (*p).direction = ((*p).position - old) / dt;
    }`,
      pack: () => {},
    };
  }
  return undefined;
}
