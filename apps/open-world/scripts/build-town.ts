// 只用编辑器的 MCP 从零搭一个世界 Worlds/Town（agent 的做法，W1 的验收之一）：建世界、建地面和楼的模型、材质，
// 再按世界坐标往里放东西（place_in_world 自己分到格子里）。
//   node apps/open-world/scripts/build-town.ts
// 打开 http://localhost:5232/?world=Worlds/Town 看。同一个种子每次一样；已经有了会先删掉重来。
import path from 'node:path';
import { McpProcess } from '../../../packages/editor/src/mcp/client.ts';

const project = path.resolve(import.meta.dirname, '..');
const mcp = new McpProcess(project);
await mcp.start();

const call = async (tool: string, args: object): Promise<unknown> => {
  const start = performance.now();
  const { error, value } = await mcp.call(tool, args);
  if (error) throw new Error(`${tool}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  console.log(`${tool} (${Math.round(performance.now() - start)} ms)`);
  return value;
};

/** 确定的随机数（mulberry32）。 */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CELL = 128, BLOCKS = 12, BLOCK = 64, STREET = 16;
const entity = (name: string, position: [number, number, number], components: object, scale: [number, number, number] = [1, 1, 1]) =>
  ({ id: '', name, parent: null, position, rotation: [0, 0, 0, 1], scale, components });

// 重来：删掉旧的世界和格子（格子在 Worlds/Town/ 下面）
const assets = await call('list_assets', { folder: 'Worlds/Town' }) as { kind: string; path: string }[];
for (const asset of assets) await call('delete_asset', { kind: asset.kind, path: asset.path });
const existing = await call('list_assets', { kind: 'world' }) as { path: string }[];
if (existing.some((asset) => asset.path === 'Worlds/Town')) await call('delete_asset', { kind: 'world', path: 'Worlds/Town' });

await call('write_asset', { kind: 'material', path: 'Materials/Street', content: { name: 'Street', baseColor: [0.18, 0.18, 0.19, 1], metalness: 0, roughness: 0.85 } });
await call('write_asset', { kind: 'material', path: 'Materials/Facade', content: { name: 'Facade', baseColor: [0.62, 0.6, 0.56, 1], metalness: 0, roughness: 0.6 } });
await call('write_asset', { kind: 'material', path: 'Materials/Glass', content: { name: 'Glass', baseColor: [0.15, 0.2, 0.26, 1], metalness: 0.6, roughness: 0.12 } });
await call('write_asset', { kind: 'model', path: 'Models/TownGround', content: { format: 1, procedural: { type: 'plane', size: [BLOCK + STREET, BLOCK + STREET], uvScale: [8, 8] }, materials: ['Materials/Street'] } });
await call('write_asset', { kind: 'model', path: 'Models/Tower', content: { format: 1, procedural: { type: 'cube', size: [1, 1, 1] }, materials: ['Materials/Facade'] } });
await call('write_asset', { kind: 'model', path: 'Models/GlassTower', content: { format: 1, procedural: { type: 'cube', size: [1, 1, 1] }, materials: ['Materials/Glass'] } });

await call('create_world', { path: 'Worlds/Town', cellSize: CELL, persistent: 'MainScene', layers: [{ name: 'ground', loadRadius: 900 }, { name: 'buildings', loadRadius: 600 }] });

// 街区：BLOCKS × BLOCKS 个，每块一片地面、几栋楼（离中心近的高）
const next = random(7);
const ground = [], buildings = [];
const span = BLOCKS * (BLOCK + STREET);
for (let i = 0; i < BLOCKS; i++) {
  for (let j = 0; j < BLOCKS; j++) {
    const cx = -span / 2 + (i + 0.5) * (BLOCK + STREET), cz = -span / 2 + (j + 0.5) * (BLOCK + STREET);
    ground.push(entity(`Block ${i},${j}`, [cx, 0, cz], { model: { model: 'Models/TownGround', materials: [] } }));
    const central = 1 - Math.min(1, Math.hypot(cx, cz) / (span / 2));
    for (let k = 0; k < 4; k++) {
      const w = 12 + next() * 14, d = 12 + next() * 14, h = 10 + next() * 30 + central * central * 160 * next();
      const x = cx + (k % 2 === 0 ? -1 : 1) * (BLOCK / 4), z = cz + (k < 2 ? -1 : 1) * (BLOCK / 4);
      const model = next() < 0.3 ? 'Models/GlassTower' : 'Models/Tower';
      buildings.push(entity(`Tower ${i},${j},${k}`, [x, h / 2, z], { model: { model, materials: [] } }, [w, h, d]));
    }
  }
}
const placedGround = await call('place_in_world', { world: 'Worlds/Town', layer: 'ground', entities: ground }) as unknown[];
const placedBuildings = await call('place_in_world', { world: 'Worlds/Town', layer: 'buildings', entities: buildings }) as unknown[];
const info = await call('world_info', { world: 'Worlds/Town' }) as { cells: unknown[] };
console.log(`Worlds/Town: ${placedGround.length} ground pieces, ${placedBuildings.length} buildings in ${info.cells.length} cell scenes (${span} m across)`);
await mcp.stop();
