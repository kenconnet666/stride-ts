import { createStrideNative, type StrideNative } from '@stride-ts/native';
import { physics } from '@stride-ts/native/physics';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Body, Breakable, Collider, Game, Mesh, Simulation, solidOf, Static, Transform, type LoadedModel } from '../../src';

let native: StrideNative;

beforeAll(async () => {
  native = await createStrideNative({ workerThreads: 1, features: [physics] });
});

afterAll(() => native?.shutdown());

/** 一个方块的网格（每个顶点位置、法线、UV，朝外逆时针）。 */
function box(name: string, min: readonly number[], max: readonly number[]): Mesh {
  const vertices: number[] = [], indices: number[] = [];
  const faces = [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]] as const;
  for (const [axis, sign] of faces) {
    const u = (axis + 1) % 3, v = (axis + 2) % 3;
    const base = vertices.length / 8;
    for (const [a, b] of [[0, 0], [1, 0], [1, 1], [0, 1]] as const) {
      const p = [0, 0, 0];
      p[axis] = sign > 0 ? max[axis]! : min[axis]!;
      p[u] = a ? max[u]! : min[u]!;
      p[v] = b ? max[v]! : min[v]!;
      const n = [0, 0, 0];
      n[axis] = sign;
      vertices.push(...p, ...n, a, b);
    }
    indices.push(...(sign > 0 ? [base, base + 1, base + 2, base, base + 2, base + 3] : [base, base + 2, base + 1, base, base + 3, base + 2]));
  }
  return new Mesh(name, { vertices: Float32Array.from(vertices), indices: Uint16Array.from(indices) });
}

/** 1 米的方块切成上下两半的碎块模型（每块一个外表面的网格）。 */
const halves: LoadedModel = {
  meshes: [
    { mesh: box('Crate.pieces/piece-0-0', [-0.5, -0.5, -0.5], [0.5, 0, 0.5]), material: null },
    { mesh: box('Crate.pieces/piece-1-0', [-0.5, 0, -0.5], [0.5, 0.5, 0.5]), material: null },
  ],
  materials: [],
};

function physicsGame(): Game & { simulation: Simulation } {
  const game = new Game();
  game.native = native;
  game.transforms = native.createTransforms(64);
  game.simulation = new Simulation(native, game.transforms, game.entities, 64);
  return game as Game & { simulation: Simulation };
}

function run(game: Game & { simulation: Simulation }, frames: number): void {
  for (let i = 0; i < frames; i++) {
    game.updateTime.advance(1 / 60);
    game.entities.update(game.updateTime, (time) => game.simulation.update(time));
    game.transforms.update();
  }
}

describe('可破碎的物体', () => {
  test('体积和体积中心按封闭网格算', () => {
    const { volume, center } = solidOf([box('b', [0, 0, 0], [2, 1, 1])]);
    expect(volume).toBeCloseTo(2, 9);
    expect(center.map((v) => +v.toFixed(9))).toEqual([1, 0.5, 0.5]);
  });

  test.each([
    { height: 5, breaks: true },
    { height: 0.3, breaks: false },
  ])('重物从 $height 米落到静态的箱子上：接近的速度过 5 米/秒才碎；碎块是动态物体，到时消失', ({ height, breaks }) => {
    const game = physicsGame();
    game.entities.create({ name: 'Ground', components: [Transform.with({ position: [0, -0.5, 0] }), Static.with({ collider: new Collider([{ type: 'box', size: [20, 1, 20] }]).id })] });
    const crate = game.entities.create({ name: 'Crate', components: [Transform.with({ position: [0, 0.5, 0] }), Static.with({ collider: new Collider([{ type: 'box', size: [1, 1, 1] }]).id })] });
    game.content.addModel(crate, { meshes: [{ mesh: box('Crate/mesh0', [-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]), material: null }], materials: [] });
    crate.add({ script: Breakable, init: { pieces: halves, breakSpeed: 5, lifetime: 1 } });
    game.entities.create({ name: 'Rock', components: [Transform.with({ position: [0, 1.3 + height, 0] }), Body.with({ collider: new Collider([{ type: 'sphere', radius: 0.3, mass: 50 }]).id })] });
    game.transforms.update();
    run(game, 90);
    const breakable = crate.require(Breakable);
    expect(breakable.broken).toBe(breaks);
    if (!breaks) {
      expect(crate.get(Static)).toBeDefined();
      return;
    }
    expect(crate.get(Static)).toBeUndefined();
    expect(breakable.pieceEntities).toHaveLength(2);
    const pieces = [...breakable.pieceEntities];
    for (const piece of pieces) expect(piece.get(Body)).toBeDefined();
    // 半块 0.5 立方米，乘默认的密度 600
    expect(Collider.byId(pieces[0]!.require(Body).collider)!.shapes[0]!.mass).toBeCloseTo(300, 6);
    run(game, 60);
    expect(breakable.pieceEntities).toHaveLength(0);
    expect(pieces.every((piece) => !piece.alive)).toBe(true);
  });
});
