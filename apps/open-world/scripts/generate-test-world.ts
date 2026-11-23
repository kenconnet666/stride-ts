// 生成测流式加载用的世界 Worlds/Test（W1 的验收用；以后的世界在编辑器里从零建，这个只是量加载、卸载）：
//   node apps/open-world/scripts/generate-test-world.ts [格子数 16] [格子边长 256]
// 每个格子：ground 图层一块地面（加载半径 1 公里），props 图层几个随机的方块（加载半径 256 米）；同一个种子每次一样。
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const count = Number(process.argv[2] ?? 16);
const size = Number(process.argv[3] ?? 256);
const content = path.join(import.meta.dirname, '../public/content');
const worldDir = path.join(content, 'Worlds/Test');

/** 确定的随机数（mulberry32）。 */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 同编辑器后端写的格式（缩进 1、末尾不换行）：编辑器打开、不改就存，文件逐字节不变
const json = (value: unknown) => JSON.stringify(value, null, 1);
const entity = (id: string, name: string, position: number[], components: object, scale = [1, 1, 1]) => ({ id, name, parent: null, position, rotation: [0, 0, 0, 1], scale, components });

await rm(worldDir, { recursive: true, force: true });
await mkdir(path.join(worldDir, 'ground'), { recursive: true });
await mkdir(path.join(worldDir, 'props'), { recursive: true });
await writeFile(path.join(content, 'Models/CellGround.model'), json({ format: 1, procedural: { type: 'plane', size: [size, size], uvScale: [size / 2, size / 2] }, materials: ['Materials/Ground'] }));
await writeFile(path.join(content, 'Models/Box.model'), json({ format: 1, procedural: { type: 'cube', size: [1, 1, 1] }, materials: ['Materials/Box'] }));
await writeFile(path.join(content, 'Materials/Box.material.json'), json({ name: 'Box', baseColor: [0.55, 0.5, 0.45, 1], metalness: 0, roughness: 0.7 }));

const half = count / 2;
const cells: [number, number][] = [];
for (let x = -half; x < half; x++) {
  for (let z = -half; z < half; z++) {
    cells.push([x, z]);
    const name = `${x}_${z}`;
    // 地面：格子中心一块（格子的原点在角上）
    await writeFile(path.join(worldDir, 'ground', `${name}.scene.json`), json({
      name, entities: [entity(`ground-${name}`, 'Ground', [size / 2, 0, size / 2], { model: { model: 'Models/CellGround', materials: [] } })],
    }));
    const next = random((x + 1000) * 7919 + z);
    const boxes = Array.from({ length: 6 }, (_, i) => {
      const height = 2 + next() * 18;
      const width = 3 + next() * 10;
      // 方块带静态的碰撞体（跟着实体的缩放）：格子读进来、卸掉时碰撞体一起加、一起去；0_0 的第一个方块是持久的（冒烟里挪它，格子卸掉再读回来还在）
      const id = `box-${name}-${i}`;
      const components = {
        model: { model: 'Models/Box', materials: [] },
        static: { shapes: [{ type: 'box', size: [1, 1, 1], position: [0, 0, 0], rotation: [0, 0, 0, 1], mass: 1 }], layer: 0, friction: 1 },
        ...(id === 'box-0_0-0' ? { persistent: {} } : {}),
      };
      return entity(id, `Box ${i}`, [next() * size, height / 2, next() * size], components, [width, height, width]);
    });
    await writeFile(path.join(worldDir, 'props', `${name}.scene.json`), json({ name, entities: boxes }));
  }
}
await writeFile(path.join(content, 'Worlds/Test.world.json'), json({
  name: 'Test', cellSize: size, persistent: 'MainScene',
  // 地面没读到的格子先画一块平板（world/WorldPlaceholders.ts）
  layers: [{ name: 'ground', loadRadius: 1024, placeholder: { y: 0, color: [0.25, 0.27, 0.3] } }, { name: 'props', loadRadius: 256 }],
  cells: { ground: cells, props: cells },
}));
console.log(`Worlds/Test: ${count} × ${count} cells of ${size} m (${count * size} m across), ${cells.length * 2} cell scenes`);
