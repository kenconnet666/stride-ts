/**
 * 世界格子的占位（加载与缓存的"骨架"，docs/stages.md）：还没读到的格子在地面上先画一块和格子一样大的平板，让人看出世界的轮廓和
 * "前方还有格子没到"，格子读到的那一帧就换成真内容。只给图层声明了 `placeholder` 的格子画（地面一类铺满的图层；不知道高度的
 * 内容不乱画），平板在 y 的高度（默认 0）、一种颜色（默认中灰）。
 *
 * 占位是普通的实体加一个共用的平板模型，不进格子的场景：用 `World placeholder` 命名，阴影不投、不进光追。
 */
import type { LoadedModel } from '../content/ContentManager';
import { FLOAT_LAYOUT, VERTEX_FLOATS } from '../content/formats/format';
import type { WorldFile } from '../content/formats/worldFormat';
import type { Entity } from '../engine/Entity';
import type { Game } from '../engine/Game';
import { Transform } from '../engine/transform';
import { Material } from '../rendering/mesh/Material';
import { Mesh } from '../rendering/mesh/Mesh';

/** 一个要占位的格子（WorldStreaming 的格子状态）。 */
export interface PlaceholderCell {
  readonly key: string;
  readonly layer: string;
  readonly x: number;
  readonly z: number;
  /** 读好了的不画占位。 */
  readonly ready: boolean;
}

const DEFAULT_COLOR: readonly [number, number, number] = [0.32, 0.33, 0.35];

/** 1 米见方、在 XZ 平面上、朝上的平板（按格子的大小缩放）。 */
function quadMesh(): Mesh {
  const h = 0.5;
  const vertices = new Float32Array(4 * VERTEX_FLOATS);
  [[-h, -h], [h, -h], [h, h], [-h, h]].forEach(([x, z], i) => vertices.set([x!, 0, z!, 0, 1, 0, x! + 0.5, z! + 0.5], i * VERTEX_FLOATS));
  return new Mesh('World placeholder', { vertices, indices: new Uint16Array([0, 3, 2, 0, 2, 1]), layout: FLOAT_LAYOUT });
}

export class WorldPlaceholders {
  readonly #entities = new Map<string, Entity>();
  readonly #models = new Map<string, LoadedModel>();
  #mesh: Mesh | undefined;

  /** 现在有几个占位。 */
  get count(): number {
    return this.#entities.size;
  }

  /** 让占位和格子状态一致：没读好的、图层要占位的有占位，读好了的、不要了的去掉。 */
  sync(game: Game, file: WorldFile, cells: readonly PlaceholderCell[]): void {
    const wanted = new Set<string>();
    for (const cell of cells) {
      const layer = file.layers.find((candidate) => candidate.name === cell.layer);
      if (cell.ready || !layer?.placeholder) continue;
      wanted.add(cell.key);
      if (this.#entities.has(cell.key)) continue;
      const color = layer.placeholder.color ?? DEFAULT_COLOR;
      const entity = game.entities.create({ name: 'World placeholder', components: [Transform] });
      const transform = entity.require(Transform);
      const size = file.cellSize;
      Object.assign(transform.position, { x: (cell.x + 0.5) * size, y: layer.placeholder.y ?? 0, z: (cell.z + 0.5) * size });
      Object.assign(transform.scale, { x: size, y: 1, z: size });
      game.content.addModel(entity, this.#model(color), { isShadowCaster: false, visibleInRayTracing: false });
      this.#entities.set(cell.key, entity);
    }
    for (const [key, entity] of this.#entities) {
      if (wanted.has(key)) continue;
      entity.destroy();
      this.#entities.delete(key);
    }
  }

  /** 全部去掉（换世界、卸载世界时）。 */
  clear(): void {
    for (const entity of this.#entities.values()) entity.destroy();
    this.#entities.clear();
  }

  #model(color: readonly [number, number, number]): LoadedModel {
    const key = color.join(',');
    let model = this.#models.get(key);
    if (!model) {
      const material = new Material('World placeholder', { baseColor: [color[0], color[1], color[2], 1], metalness: 0, roughness: 1, doubleSided: true });
      model = { meshes: [{ mesh: (this.#mesh ??= quadMesh()), material: 0 }], materials: [material] };
      this.#models.set(key, model);
    }
    return model;
  }
}
