/**
 * 雨雪（Stride 没有，新加的）：带 Precipitation 组件的实体让主相机周围下雨或下雪。不是整个世界撒，而是跟着相机的一块体积：
 * 在相机上方 height 米、半径 radius 米的方形里生成，落到相机下方差不多同样深的地方寿命到了；体积跟着相机走，雨点留在世界里。
 *
 * 用 GPU 粒子（particles/gpu）：每个组件在里面建一个发射器（一个内部的实体，名字是"组件实体名 (precipitation)"），模块是现成的：
 * 盒子里的位置、下落速度、风（UpdaterWind：风速加上下落的终端速度）、速度方向（雨按它拉长成线）。生成数不走生成器，每帧按
 * 强度 · 密度 · 面积 · dt 直接给。强度由外面给（以后天气状态驱动它，和云量、雾一起），这里不读天空。
 *
 * 被屋顶挡住的地方不下：用天空遮挡（weather/SkyOcclusion，`renderSystem.skyOcclusion`，从上往下的深度图），GPU 粒子落到它记的
 * 表面以下就死。有雨雪时每帧 use() 它，没有时它不画。
 */
import { prop } from '../data/prop';
import { component } from '../engine/component';
import type { Entity } from '../engine/Entity';
import { system } from '../engine/system';
import { Transform } from '../engine/transform';
import type { ParticleModuleFile } from '../content/format';
import type { Game } from '../games/Game';
import { NO_CONTEXT } from '../particles/modules';
import { ParticleSystemComponent } from '../particles/ParticleSystemComponent';
import { Texture } from '../rendering/Texture';

export const Precipitation = component('Precipitation', {
  kind: prop.enum(['rain', 'snow']).default('rain'),
  /** 0 到 1：0 是不下，1 是这种的最大密度（外面给，比如天气状态）。 */
  intensity: prop.f32().default(1).min(0).max(1),
  /** 体积的半宽，米。 */
  radius: prop.f32().default(20).min(1),
  /** 在相机上方多高生成，米。 */
  height: prop.f32().default(12).min(1),
});

/** 每种的预设：强度 1 时每秒每平方米落几个、下落速度（米每秒）、往风速靠的快慢、大小、颜色（预乘前的 sRGB 和 alpha）。 */
export const PRECIPITATION_PRESETS = {
  rain: { density: 20, fallSpeed: 9, drag: 0.8, width: 0.012, streak: 0.45, color: [0.75, 0.8, 0.9, 0.35] },
  snow: { density: 6, fallSpeed: 1.2, drag: 1.5, width: 0.04, streak: 0, color: [1, 1, 1, 0.9] },
} as const;

type Kind = keyof typeof PRECIPITATION_PRESETS;

/** 软圆点贴图在材质里的名字（不是内容路径，建发射器时直接给贴图）。 */
const SOFT_DOT = 'stride:precipitation-dot';
let softDot: Texture | undefined;

/** 32x32 的白色圆点，alpha 从中心到边缘平滑落到 0。 */
function softDotTexture(): Texture {
  if (softDot) return softDot;
  const size = 32, pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const r = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
    const alpha = Math.max(0, 1 - r) ** 1.5;
    pixels.set([255, 255, 255, Math.round(alpha * 255)], (y * size + x) * 4);
  }
  return (softDot = new Texture('precipitation dot', { format: 'rgba8unorm', width: size, height: size, levels: [pixels] }));
}

/** 发射器的文件（建内部的粒子系统用；单测检查它）。 */
export function precipitationEmitter(kind: Kind, radius: number, height: number): { file: ParticleModuleFile; rate: number } {
  const preset = PRECIPITATION_PRESETS[kind];
  // 从上方 height 落到下方 height
  const lifetime = (2 * height) / preset.fallSpeed;
  const rate = preset.density * (2 * radius) ** 2;
  const rain = kind === 'rain';
  const file: ParticleModuleFile = {
    emitterName: rain ? 'Rain' : 'Snow',
    simulation: 'gpu',
    randomSeedMethod: 'time',
    maxParticlesOverride: Math.ceil(rate * lifetime * 1.1),
    particleLifetime: [lifetime, lifetime * 1.1],
    sortingPolicy: 'none',
    spawners: [],
    // 雨是沿速度拉长的线（整条长 streak 米：OrientedQuad 的长是 |方向| · lengthFactor），雪是正对相机的点
    shapeBuilder: rain
      ? { $type: 'shapeBuilderOrientedQuad', scaleLength: false, lengthFactor: preset.streak / preset.fallSpeed }
      : { $type: 'shapeBuilderBillboard' },
    // 粒子的颜色乘一个软的圆点（雪花；雨的线横向也是软边）
    material: {
      $type: 'particleMaterialComputeColor',
      computeColor: { $type: 'computeBinaryColor', operator: 'multiply', leftChild: { $type: 'computeVertexStreamColor' }, rightChild: { $type: 'computeTextureColor', texture: { texture: SOFT_DOT } } },
    },
    initializers: [
      { $type: 'initialPositionSeed', positionMin: [-radius, 0, -radius], positionMax: [radius, 0, radius] },
      { $type: 'initialVelocitySeed', velocityMin: [0, -preset.fallSpeed * 1.1, 0], velocityMax: [0, -preset.fallSpeed * 0.9, 0] },
      { $type: 'initialSizeSeed', randomSize: [preset.width * 0.7, preset.width * 1.3] },
      { $type: 'initialColorSeed', colorMin: [...preset.color], colorMax: [...preset.color] },
    ],
    updaters: [
      { $type: 'updaterWind', drag: preset.drag, terminalVelocity: [0, -preset.fallSpeed, 0] },
      ...(rain ? [{ $type: 'updaterSpeedToDirection' }] : []),
    ],
  };
  return { file: { particleSystem: { emitters: [file] } }, rate };
}

interface State {
  readonly entity: Entity;
  readonly component: ParticleSystemComponent;
  readonly key: string;
  readonly height: number;
  rate: number;
  intensity: number;
  carry: number;
  seen: boolean;
}

/** 所有雨雪（`game.precipitation`）：每帧在粒子模拟之前，让内部的发射器跟着主相机、按强度给生成数。 */
export class PrecipitationSystem {
  readonly #states = new Map<Entity, State>();
  #game: Game | undefined;
  #dt = 0;

  /** 这一帧的组件（系统遍历时只记下来：遍历时不能建实体）。 */
  #found: { owner: Entity; kind: Kind; radius: number; height: number; intensity: number }[] = [];

  readonly #collect = system('Precipitation.collect', {
    with: { precipitation: Precipitation, transform: Transform },
    update: ({ precipitation, entities, count }) => {
      const game = this.#game!;
      for (let i = 0; i < count; i++) {
        this.#found.push({
          owner: game.entities.entity(entities[i]!), kind: precipitation.kind[i] as Kind,
          radius: precipitation.radius[i]!, height: precipitation.height[i]!, intensity: precipitation.intensity[i]!,
        });
      }
    },
  });

  /** 内部的发射器（单测、调试用）：组件所在的实体 → 下雨的粒子系统组件。 */
  emitterOf(owner: Entity): ParticleSystemComponent | undefined {
    return this.#states.get(owner)?.component;
  }

  /** @internal Game 每帧在粒子模拟之前调用。 */
  update(game: Game): void {
    this.#game = game;
    this.#dt = game.updateTime.elapsed;
    for (const state of this.#states.values()) state.seen = false;
    this.#found = [];
    game.entities.run(this.#collect, game.updateTime);
    const sky = (game.renderSystem as Game['renderSystem'] | undefined)?.skyOcclusion;
    if (this.#found.length > 0) sky?.use();
    for (const { owner, kind, radius, height, intensity } of this.#found) {
      // 种类、范围变了：重建内部的发射器
      const key = `${kind}:${radius}:${height}`;
      let state = this.#states.get(owner);
      if (state && state.key !== key) {
        state.entity.destroy();
        state = undefined;
      }
      state ??= this.#create(game, owner, kind, radius, height, key);
      state.seen = true;
      state.intensity = intensity;
    }
    const eye = game.graphicsCompositor?.mainView?.eye;
    for (const [owner, state] of this.#states) {
      if (!state.seen || !owner.alive) {
        if (state.entity.alive) state.entity.destroy();
        this.#states.delete(owner);
        continue;
      }
      // 体积跟着相机（上一帧的主视图）；生成数按强度，小数部分攒到下一帧
      if (eye) Object.assign(state.entity.require(Transform).position, { x: eye.x, y: eye.y + state.height, z: eye.z });
      const wanted = state.rate * state.intensity * this.#dt + state.carry;
      const whole = Math.floor(wanted);
      state.carry = wanted - whole;
      const emitter = state.component.particleSystem.emitters[0];
      if (emitter) emitter.emit(whole);
    }
  }

  #create(game: Game, owner: Entity, kind: Kind, radius: number, height: number, key: string): State {
    const { file, rate } = precipitationEmitter(kind, radius, height);
    const entity = game.entities.create({ name: `${owner.name ?? 'Weather'} (precipitation)`, components: [Transform] });
    entity.scene = owner.scene;
    entity.add({ script: ParticleSystemComponent, init: {} });
    const component = entity.require(ParticleSystemComponent);
    component.load(file, { ...NO_CONTEXT, texture: (path) => (path === SOFT_DOT ? softDotTexture() : undefined) });
    // 屋顶下不下：GPU 状态建之前挂上遮挡（粒子系统在这之后的 update 里建它）
    const sky = (game.renderSystem as Game['renderSystem'] | undefined)?.skyOcclusion;
    for (const emitter of component.particleSystem.emitters) emitter.gpuOccluder = sky;
    const state: State = { entity, component, key, height, rate, intensity: 0, carry: 0, seen: true };
    this.#states.set(owner, state);
    return state;
  }
}
