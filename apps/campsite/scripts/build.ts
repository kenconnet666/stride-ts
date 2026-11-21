// S2 的验收（docs/roadmap.md 第三节 S2）：不用外部软件、全部资源在编辑器里做——这里是 agent 那一遍，只用编辑器的 MCP 服务
// （和 Claude Code 这类工具接上的是同一套工具）。黄昏的营地：白盒搭的木屋（布尔运算）、SDF 捏的石头、火塘、木头、提灯、
// 多边形编辑的箱子、材质节点图写的屋顶瓦片、石头、草地，库里拿的木头、石板、拉丝钢和篝火，音效生成器做的噼啪声。
//   node apps/campsite/scripts/build.ts      重搭一遍（资源和场景按这里写的覆盖，几秒，烘模型在编辑器后端）
// 搭完开 `pnpm --filter @stride-ts/campsite dev` 看，或者编辑器 http://localhost:5230/__stride/editor/ 里接着改。
import path from 'node:path';
import { McpProcess } from '../../../packages/editor/src/mcp/client.ts';

const project = path.resolve(import.meta.dirname, '..');
const mcp = new McpProcess(project);
await mcp.start();

const call = async (tool: string, args: object) => {
  const start = performance.now();
  const { error, value } = await mcp.call(tool, args);
  if (error) throw new Error(`${tool}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  console.log(`${tool} ${'path' in args ? String(args.path) : 'id' in args ? String(args.id) : ''} (${Math.round(performance.now() - start)} ms)`);
  return value;
};
const write = (kind: string, path: string, content: object) => call('write_asset', { kind, path, content });

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];
/** 先绕 Y 转 yaw 度、再绕 X 转 pitch 度、再绕 Z 转 roll 度（同编辑器里的欧拉角）。 */
function euler(yaw: number, pitch = 0, roll = 0): Quat {
  const [y, x, z] = [yaw, pitch, roll].map((degrees) => (degrees * Math.PI) / 360);
  const [cy, sy, cx, sx, cz, sz] = [Math.cos(y!), Math.sin(y!), Math.cos(x!), Math.sin(x!), Math.cos(z!), Math.sin(z!)];
  // q = qY * qX * qZ
  return [
    cy * sx * cz + sy * cx * sz,
    sy * cx * cz - cy * sx * sz,
    cy * cx * sz - sy * sx * cz,
    cy * cx * cz + sy * sx * sz,
  ];
}
/** 相机（看 -Z）从 eye 看 target 的朝向。 */
function lookAt(eye: Vec3, target: Vec3): Quat {
  const d = target.map((v, i) => v - eye[i]!) as Vec3;
  const length = Math.hypot(...d);
  return euler((Math.atan2(-d[0], -d[2]) * 180) / Math.PI, (Math.asin(d[1] / length) * 180) / Math.PI);
}

// ---- 材质：库里拿的，加自己用节点图写的 ----
for (const id of ['wood', 'stoneTiles', 'brushedSteel']) await call('use_library', { id });
const WOOD = 'Materials/Library/Wood', TILES = 'Materials/Library/StoneTiles', STEEL = 'Materials/Library/BrushedSteel';

const node = (id: string, type: string, params: object = {}, inputs: Record<string, string | [string, string]> = {}, position: [number, number] = [0, 0]) => ({
  id, type, params, position,
  inputs: Object.fromEntries(Object.entries(inputs).map(([port, source]) => [port, typeof source === 'string' ? { node: source } : { node: source[0], output: source[1] }])),
});
const graphMaterial = (name: string, roughness: number, nodes: object[], outputs: Record<string, string>) => ({
  name, baseColor: [1, 1, 1, 1], metalness: 0, roughness,
  graph: { nodes, outputs: Object.fromEntries(Object.entries(outputs).map(([output, source]) => [output, { node: source }])) },
});
// 屋顶的木瓦：错缝的窄长条，每片一个色调
await write('material', 'Materials/Shingles', graphMaterial('Shingles', 0.8, [
  node('uv', 'uv', { scale: [2, 2] }),
  node('rows', 'bricks', { columns: 6, rows: 14, mortar: 0.04, shift: 0.5 }, { uv: 'uv' }, [220, 0]),
  node('tone', 'colorRamp', { from: [0.16, 0.06, 0.04], to: [0.32, 0.14, 0.08] }, { t: ['rows', 'brick'] }, [440, 0]),
  node('gap', 'color', { color: [0.04, 0.03, 0.03] }, {}, [440, 160]),
  node('color', 'mix', {}, { a: 'gap', b: 'tone', t: ['rows', 'mask'] }, [660, 0]),
  node('normal', 'normalFromHeight', { strength: 2.5 }, { height: ['rows', 'mask'], uv: 'uv' }, [660, 160]),
], { baseColor: 'color', normal: 'normal' }));
// 石头：大块的明暗加细的颗粒和凹凸
await write('material', 'Materials/Rock', graphMaterial('Rock', 0.85, [
  node('uv', 'uv'),
  node('blotch', 'noise', { scale: 3, octaves: 4, seed: 3 }, { uv: 'uv' }, [220, 0]),
  node('grain', 'noise', { scale: 30, octaves: 5, roughness: 0.6 }, { uv: 'uv' }, [220, 160]),
  node('tone', 'colorRamp', { from: [0.22, 0.21, 0.2], to: [0.48, 0.46, 0.42] }, { t: 'blotch' }, [440, 0]),
  node('speckle', 'colorRamp', { from: [0.8, 0.8, 0.8], to: [1.1, 1.1, 1.1] }, { t: 'grain' }, [440, 160]),
  node('color', 'multiply', {}, { a: 'tone', b: 'speckle' }, [660, 0]),
  node('normal', 'normalFromHeight', { strength: 1.2 }, { height: 'grain', uv: 'uv' }, [660, 160]),
], { baseColor: 'color', normal: 'normal' }));
// 草地（换掉模板的纯色地面）：两层噪声的绿，远看不重复
await write('material', 'Materials/Ground', graphMaterial('Ground', 0.95, [
  node('uv', 'uv'),
  node('patches', 'noise', { scale: 0.6, octaves: 3, seed: 7 }, { uv: 'uv' }, [220, 0]),
  node('blades', 'noise', { scale: 12, octaves: 4 }, { uv: 'uv' }, [220, 160]),
  node('tone', 'colorRamp', { from: [0.07, 0.11, 0.04], to: [0.17, 0.22, 0.08] }, { t: 'patches' }, [440, 0]),
  node('detail', 'colorRamp', { from: [0.75, 0.75, 0.75], to: [1.15, 1.15, 1.15] }, { t: 'blades' }, [440, 160]),
  node('color', 'multiply', {}, { a: 'tone', b: 'detail' }, [660, 0]),
], { baseColor: 'color' }));
await write('material', 'Materials/LanternGlow', { name: 'LanternGlow', baseColor: [1, 0.85, 0.6, 1], metalness: 0, roughness: 0.3, emissive: [8, 4.5, 1.6] });

// ---- 模型 ----
// 木屋：白盒（Manifold 的布尔），墙挖空、开门窗，三角的屋顶是绕 X 转过的挤出多边形
await write('brush', 'Models/Cabin', {
  name: 'Cabin', materials: [WOOD, 'Materials/Shingles'], uvScale: 1,
  brushes: [
    { name: 'Walls', kind: 'box', operation: 'add', position: [0, 1.3, 0], size: [4, 2.6, 3] },
    { name: 'Inside', kind: 'box', operation: 'subtract', position: [0, 1.45, 0], size: [3.7, 2.6, 2.7] },
    { name: 'Door', kind: 'box', operation: 'subtract', position: [0.8, 1.05, 1.5], size: [0.9, 1.9, 0.6] },
    { name: 'Window', kind: 'box', operation: 'subtract', position: [-0.9, 1.55, 1.5], size: [0.8, 0.7, 0.6] },
    { name: 'Side window', kind: 'box', operation: 'subtract', position: [2, 1.55, 0], size: [0.6, 0.7, 0.8] },
    { name: 'Roof', kind: 'prism', operation: 'add', material: 1, position: [0, 2.6, -1.85], rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2], points: [[-2.45, 0], [2.45, 0], [0, -1.5]], height: 3.7 },
  ],
});
// 石头：两个椭球平滑地融在一起，底下切平好放在地上
await write('sdf', 'Models/Rock', {
  name: 'Rock', materials: ['Materials/Rock'], resolution: 0.04,
  shapes: [
    { name: 'Body', kind: 'ellipsoid', operation: 'add', position: [0, 0.2, 0], radii: [0.7, 0.45, 0.55] },
    { name: 'Lump', kind: 'ellipsoid', operation: 'add', smoothness: 0.18, position: [0.45, 0.35, 0.15], radii: [0.35, 0.3, 0.32] },
    { name: 'Cut', kind: 'box', operation: 'subtract', position: [0, -0.5, 0], size: [3, 1, 3] },
  ],
});
// 火塘：一圈石头
await write('sdf', 'Models/FirePit', {
  name: 'FirePit', materials: ['Materials/Rock'], resolution: 0.025,
  shapes: Array.from({ length: 9 }, (_, i) => {
    const angle = (i / 9) * Math.PI * 2;
    return { name: `Stone ${i + 1}`, kind: 'ellipsoid', operation: 'add', smoothness: 0.04, position: [Math.cos(angle) * 0.55, 0.08, Math.sin(angle) * 0.55], radii: [0.17, 0.12 + (i % 3) * 0.02, 0.14] };
  }),
});
// 坐的木头：横放的胶囊，两头切平
await write('sdf', 'Models/Log', {
  name: 'Log', materials: [WOOD], resolution: 0.025,
  shapes: [
    { name: 'Trunk', kind: 'capsule', operation: 'add', position: [0, 0.18, 0], rotation: euler(0, 0, 90), height: 1.3, radius: 0.18 },
    { name: 'End A', kind: 'box', operation: 'subtract', position: [0.75, 0.18, 0], size: [0.3, 1, 1] },
    { name: 'End B', kind: 'box', operation: 'subtract', position: [-0.75, 0.18, 0], size: [0.3, 1, 1] },
  ],
});
// 提灯：金属的底和盖、发光的灯罩、提手
await write('sdf', 'Models/Lantern', {
  name: 'Lantern', materials: [STEEL, 'Materials/LanternGlow'], resolution: 0.008,
  shapes: [
    { name: 'Base', kind: 'cylinder', operation: 'add', position: [0, 0.02, 0], height: 0.04, radius: 0.11, edgeRadius: 0.008 },
    { name: 'Glass', kind: 'capsule', operation: 'add', smoothness: 0.01, material: 1, position: [0, 0.17, 0], height: 0.14, radius: 0.08 },
    { name: 'Cap', kind: 'cylinder', operation: 'add', smoothness: 0.01, position: [0, 0.3, 0], height: 0.04, radius: 0.09, edgeRadius: 0.01 },
    { name: 'Handle', kind: 'torus', operation: 'add', position: [0, 0.37, 0], rotation: euler(0, 90), ringRadius: 0.06, tubeRadius: 0.01 },
  ],
});
// 箱子：多边形网格的方块，每个面内插一圈再往里压一点，成了带边框的板子
await write('poly', 'Models/Crate', {
  name: 'Crate', materials: [WOOD], smoothAngle: 0,
  vertices: [[-0.3, 0, -0.3], [0.3, 0, -0.3], [0.3, 0.6, -0.3], [-0.3, 0.6, -0.3], [-0.3, 0, 0.3], [0.3, 0, 0.3], [0.3, 0.6, 0.3], [-0.3, 0.6, 0.3]],
  faces: [[4, 5, 6, 7], [1, 0, 3, 2], [3, 7, 6, 2], [0, 1, 5, 4], [1, 2, 6, 5], [0, 4, 7, 3]].map((vertices) => ({ vertices })),
});
const inset = await call('edit_poly', { path: 'Models/Crate', op: 'inset', faces: [0, 1, 2, 4, 5], amount: 0.15 }) as { selected: { faces: number[] } };
await call('edit_poly', { path: 'Models/Crate', op: 'extrude', faces: inset.selected.faces, distance: -0.025 });
// 小路：JSON 写的平面
await write('model', 'Models/Path', { format: 1, procedural: { type: 'plane', size: [1.2, 3.6], uvScale: [1, 3] }, materials: [TILES] });

// ---- 声音：音效生成器起个头，再按需要细调 ----
await call('generate_sound', { path: 'Sounds/Crackle', preset: 'hit', seed: 11 });
await write('sound', 'Sounds/Crackle', {
  name: 'Crackle', encoding: 'synth', streamFromDisk: false, spatialized: false,
  synth: { wave: 'noise', attack: 0, sustain: 0.02, punch: 0.6, decay: 0.16, frequency: 0.55, slide: -0.25, highPassCutoff: 0.12, volume: 0.6, seed: 11 },
});

// ---- 场景 ----
const scene = await call('read_asset', { kind: 'scene', path: 'MainScene' }) as { entities: { id: string; name: string }[] };
const kept = new Set(['Camera', 'Sun', 'Sky', 'Ground']);
const entity = (id: string, name: string, position: Vec3, rotation: Quat, components: object, scale: Vec3 = [1, 1, 1], scripts?: object[]) =>
  ({ id, name, parent: null, position, rotation, scale, components: { ...components, ...(scripts ? { scripts } : {}) } });
const model = (path: string) => ({ model: { model: path, materials: [] } });
const FIRE: Vec3 = [1.6, 0, 1.4];
const added = [
  entity('cabin', 'Cabin', [-3, 0, -3], euler(20), model('Models/Cabin')),
  // 从门口通到火塘：门在木屋的 (0.8, 1.5)，转 20° 以后在世界的 (-1.74, -1.86)
  entity('path', 'Path', [-0.45, 0.01, -0.6], euler(45.7), model('Models/Path')),
  entity('fire-pit', 'Fire pit', FIRE, euler(0), model('Models/FirePit')),
  entity('fire-light', 'Fire light', [FIRE[0], 0.7, FIRE[2]], euler(0), { light: { type: 'point', color: [1, 0.55, 0.2], intensity: 25, radius: 7 } }, [1, 1, 1],
    [{ type: 'game/Crackle#Crackle', props: { sound: { $asset: 'Sounds/Crackle', kind: 'sound' } } }]),
  entity('log-1', 'Log', [FIRE[0] - 1.3, 0, FIRE[2] + 0.2], euler(80), model('Models/Log')),
  entity('log-2', 'Log 2', [FIRE[0] + 0.6, 0, FIRE[2] + 1.2], euler(-20), model('Models/Log')),
  entity('rock-1', 'Rock', [4, 0, -2.5], euler(30), model('Models/Rock'), [1.4, 1.2, 1.4]),
  entity('rock-2', 'Rock 2', [-5.5, 0, 2], euler(-60), model('Models/Rock')),
  entity('rock-3', 'Rock 3', [3.5, 0, 3.5], euler(110), model('Models/Rock'), [0.6, 0.6, 0.6]),
  entity('crate', 'Crate', [-0.7, 0, -1.8], euler(15), model('Models/Crate')),
  entity('lantern', 'Lantern', [-0.7, 0.6, -1.8], euler(0), model('Models/Lantern')),
  entity('lantern-light', 'Lantern light', [-0.7, 0.8, -1.8], euler(0), { light: { type: 'point', color: [1, 0.7, 0.4], intensity: 4, radius: 4 } }),
];
await call('edit_scene', {
  kind: 'scene', path: 'MainScene', edits: [
    { type: 'remove', entities: scene.entities.filter((e) => !kept.has(e.name)).map((e) => e.id) },
    { type: 'add', entities: added.map((e, i) => ({ entity: e, index: kept.size + i })) },
    // 黄昏：太阳低、偏暖、弱一些；相机从火塘的斜前方看木屋
    ...['Sun', 'Camera'].flatMap((name) => {
      const id = scene.entities.find((e) => e.name === name)!.id;
      return name === 'Sun'
        ? [{ type: 'set', entity: id, path: ['rotation'], value: euler(70, -14) }, { type: 'set', entity: id, path: ['components', 'light', 'color'], value: [1, 0.72, 0.5] }, { type: 'set', entity: id, path: ['components', 'light', 'intensity'], value: 4 }]
        : [{ type: 'set', entity: id, path: ['position'], value: [6.5, 2.2, 7.5] }, { type: 'set', entity: id, path: ['rotation'], value: lookAt([6.5, 2.2, 7.5], [-0.5, 0.9, -1]) }];
    }),
  ],
});
// 篝火：库里的特效，放在火塘中间
await call('use_library', { id: 'campfire', scene: 'MainScene', position: [FIRE[0], 0.05, FIRE[2]], entityId: 'campfire' });

console.log(await call('list_assets', {}));
await mcp.stop();
