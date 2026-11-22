/**
 * 城市（W5，Stride 没有）：City 组件引用一个 `.city.json`，CitySystem 按它沿路摆楼（modeling/city.ts 算地块），楼是组件所在实体的
 * 子实体，放在地块四个角的地面里最低的高度上。城市文件、路、楼的模型换了新版本（编辑器、热重载）时整个城重摆；场景里有地形时
 * 等地形加载好再摆。
 *
 *   entity.add(City.with({ city: (await game.content.loadCity('Cities/Valley')).id }));
 */
import type { LoadedModel } from '../content/ContentManager';
import type { CityFile } from '../content/formats/cityFormat';
import type { SplineFile } from '../content/formats/splineFormat';
import { Matrix } from '../data/Matrix';
import { prop, type Branded, type EntityId } from '../data/prop';
import { component } from '../engine/component';
import type { Entity } from '../engine/Entity';
import type { Game } from '../engine/Game';
import { ResourceTable } from '../engine/ResourceTable';
import { system } from '../engine/system';
import { Transform } from '../engine/transform';
import { cityLots, type CityFootprint, type CityLot } from '../modeling/city';

export type CityAssetId = Branded<number, 'CityAssetId'>;

/** 城市：组件所在的实体是城的原点，路的样条和楼都在它的本地坐标里。 */
export const City = component('City', {
  city: prop.u32().brand<'CityAssetId'>().default(0 as CityAssetId),
});

const assets = new ResourceTable<CityAsset>();

/** 加载好的城市资源：文件、路的样条（和 file.roads 一一对应）、楼的模型（和 file.buildings 一一对应）。地块第一次要时算。 */
export class CityAsset {
  readonly id: CityAssetId;
  readonly path: string;
  readonly file: CityFile;
  readonly roads: readonly SplineFile[];
  readonly models: readonly LoadedModel[];
  #lots: CityLot[] | undefined;

  constructor(path: string, file: CityFile, roads: readonly SplineFile[], models: readonly LoadedModel[]) {
    this.path = path;
    this.file = file;
    this.roads = roads;
    this.models = models;
    this.id = assets.add(this) as CityAssetId;
  }

  /** 沿街的地块（算一次留着）。 */
  get lots(): readonly CityLot[] {
    return (this.#lots ??= cityLots(this.file, this.roads, this.models.map(footprintOf)));
  }

  /** @internal City 组件里存的 id 对应的资源。 */
  static byId(id: number): CityAsset | undefined {
    return assets.get(id);
  }
}

/** 模型的占地：所有网格的包围盒在 x、z 上的宽、深和中心。 */
function footprintOf(model: LoadedModel): CityFootprint {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const { mesh } of model.meshes) {
    const { min, max } = mesh.bounds;
    x0 = Math.min(x0, min[0]);
    x1 = Math.max(x1, max[0]);
    z0 = Math.min(z0, min[2]);
    z1 = Math.max(z1, max[2]);
  }
  return { width: Math.max(x1 - x0, 0.1), depth: Math.max(z1 - z0, 0.1), center: [(x0 + x1) / 2, (z0 + z1) / 2] };
}

/** 地上一块矩形（x、z 平面）：中心、两根单位轴、两个半长。 */
export interface GroundBox {
  readonly center: readonly [number, number];
  readonly axes: readonly [readonly [number, number], readonly [number, number]];
  readonly half: readonly [number, number];
}

interface CityState {
  readonly asset: CityAsset;
  readonly buildings: Entity[];
  /** 每栋楼占的地（世界坐标）。 */
  readonly boxes: GroundBox[];
}

/** 记多少次改动的范围：程序化摆放落后更多时整个重撒。 */
const CHANGE_LOG = 64;

/** 城市的系统：Game 每帧在地形更新以后调。 */
export class CitySystem {
  readonly #game: Game;
  readonly #states = new Map<EntityId, CityState>();
  readonly #seen = new Set<EntityId>();
  readonly #inverse = new Float64Array(16);
  /** 摆过几次城、一共摆了几栋楼（调试命令 city 报）。 */
  built = { cities: 0, buildings: 0 };
  /** 楼摆了、拿掉了一次加一；程序化摆放（world/Scatter.ts）按它知道要避开的楼变了。 */
  version = 0;
  /** 每次改动的范围（世界的 x0、z0、x1、z1），只留最近 CHANGE_LOG 次。 */
  readonly #changes: { readonly version: number; readonly bounds: [number, number, number, number] }[] = [];

  readonly #collect = system('CitySystem.collect', {
    with: { city: City, transform: Transform },
    update: ({ entities, count }) => {
      for (let row = 0; row < count; row++) this.#seen.add(entities[row]!);
    },
  });

  constructor(game: Game) {
    this.#game = game;
  }

  update(): void {
    const game = this.#game;
    this.#seen.clear();
    game.entities.run(this.#collect, game.updateTime);
    for (const [id, state] of this.#states) if (!this.#seen.has(id)) this.#drop(id, state);
    // 楼按地面的高度放：场景里的地形还没加载好时等一等
    if (this.#seen.size === 0 || !game.terrain.settled) return;
    for (const id of this.#seen) {
      const entity = game.entities.entity(id);
      const asset = CityAsset.byId(entity.require(City).city);
      const state = this.#states.get(id);
      if (!asset || state?.asset === asset) continue;
      if (state) this.#drop(id, state);
      const boxes: GroundBox[] = [];
      this.#states.set(id, { asset, buildings: this.#build(entity, asset, boxes), boxes });
      this.#changed(boxes);
    }
  }

  /** 所有城里每栋楼占的地（世界坐标的矩形）：程序化摆放的树、草避开它们。 */
  get obstacles(): readonly GroundBox[] {
    return [...this.#states.values()].flatMap((state) => state.boxes);
  }

  /** version 以后楼摆了、拿掉了的范围（世界的 x0、z0、x1、z1）；太久以前的已经不记了时是 undefined（全部重来）。 */
  changesSince(version: number): [number, number, number, number][] | undefined {
    if (version === this.version) return [];
    const first = this.#changes[0];
    if (!first || first.version > version + 1) return undefined;
    return this.#changes.filter((change) => change.version > version).map((change) => change.bounds);
  }

  /** 每个城摆了几栋楼（调试命令 city 报）。 */
  stats(): { entity: string; asset: string; buildings: number; byModel: Record<string, number> }[] {
    return [...this.#states].map(([id, state]) => {
      const byModel: Record<string, number> = {};
      for (const lot of state.asset.lots) {
        const model = state.asset.file.buildings[lot.building]!.model;
        byModel[model] = (byModel[model] ?? 0) + 1;
      }
      return { entity: this.#game.entities.entity(id).name, asset: state.asset.path, buildings: state.buildings.length, byModel };
    });
  }

  #build(entity: Entity, asset: CityAsset, boxes: GroundBox[]): Entity[] {
    const game = this.#game;
    const world = entity.require(Transform).world;
    if (!Matrix.invert(this.#inverse, world)) return [];
    const m = this.#inverse;
    const buildings = asset.lots.map((lot) => {
      // 地块四个角的地面（世界坐标往下打），取最低的，换回城的本地高度；没有地面时放在城的原点高度上
      let base = Infinity;
      const corners = lot.corners.map(([x, z]) => {
        const wx = world[0]! * x + world[8]! * z + world[12]!, wy = world[1]! * x + world[9]! * z + world[13]!, wz = world[2]! * x + world[10]! * z + world[14]!;
        const hit = game.terrain.raycast([wx, wy + 10_000, wz], [0, -1, 0]);
        if (hit) base = Math.min(base, m[1]! * hit.point[0] + m[5]! * hit.point[1] + m[9]! * hit.point[2] + m[13]!);
        return [wx, wz] as const;
      });
      boxes.push(boxOf(corners));
      const y = Number.isFinite(base) ? base : 0;
      const half = lot.yaw / 2;
      const building = game.entities.create({
        name: `${entity.name}/${asset.file.buildings[lot.building]!.model}`,
        components: [Transform.with({ position: [lot.position[0], y, lot.position[1]], rotation: [0, Math.sin(half), 0, Math.cos(half)] })],
      });
      building.require(Transform).parent = entity;
      game.content.addModel(building, asset.models[lot.building]!);
      return building;
    });
    this.built.cities++;
    this.built.buildings += buildings.length;
    return buildings;
  }

  #drop(id: EntityId, state: CityState): void {
    for (const building of state.buildings) if (building.alive) building.destroy();
    this.#states.delete(id);
    this.#changed(state.boxes);
  }

  /** 这些楼摆了或者拿掉了：记下范围，版本加一。 */
  #changed(boxes: readonly GroundBox[]): void {
    if (boxes.length === 0) return;
    const bounds: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const box of boxes) {
      const rx = Math.abs(box.axes[0][0]) * box.half[0] + Math.abs(box.axes[1][0]) * box.half[1], rz = Math.abs(box.axes[0][1]) * box.half[0] + Math.abs(box.axes[1][1]) * box.half[1];
      bounds[0] = Math.min(bounds[0], box.center[0] - rx);
      bounds[1] = Math.min(bounds[1], box.center[1] - rz);
      bounds[2] = Math.max(bounds[2], box.center[0] + rx);
      bounds[3] = Math.max(bounds[3], box.center[1] + rz);
    }
    this.#changes.push({ version: ++this.version, bounds });
    if (this.#changes.length > CHANGE_LOG) this.#changes.shift();
  }
}

/** 矩形的四个角（按顺序）换成中心、轴、半长。 */
function boxOf(corners: readonly (readonly [number, number])[]): GroundBox {
  const [a, b, , d] = corners as [readonly [number, number], readonly [number, number], readonly [number, number], readonly [number, number]];
  const ux = b[0] - a[0], uz = b[1] - a[1], vx = d[0] - a[0], vz = d[1] - a[1];
  const lu = Math.hypot(ux, uz) || 1, lv = Math.hypot(vx, vz) || 1;
  return { center: [a[0] + (ux + vx) / 2, a[1] + (uz + vz) / 2], axes: [[ux / lu, uz / lu], [vx / lv, vz / lv]], half: [lu / 2, lv / 2] };
}
