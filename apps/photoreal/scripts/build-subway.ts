// 路线图 R5 的第一步：照用户拍的高架地铁站台（reference/subway/platform-screen-doors.jpg，不进仓库）搭白模，当照片比对、全局光照、
// 曝光和材质的试验场。只用编辑器的 MCP 服务（agent 那条路），资源和场景按这里写的覆盖，重跑就是重搭。
//   node apps/photoreal/scripts/build-subway.ts
// 坐标（米）：站台地面 y = 0，屏蔽门沿 x 排在站台边上（z = −0.6），轨道在 −z 那边，站台往 +z。机位照照片：端门右后方约 2 米、
// 1.55 米高，竖拍（窗口 960 × 1280，竖向视角 67°，手机主摄约等效 26 毫米）。
//   比对：pnpm exec stride open "http://localhost:5234/?scene=Subway" --headless --size 960x1280
//         pnpm exec stride shot out.png --photo reference/subway/platform-screen-doors.jpg
import path from 'node:path';
import { nodeGraph } from '@stride-ts/editor/library';
import { McpProcess } from '@stride-ts/editor/mcp-client';

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
/** 先绕 Y 转 yaw 度、再绕 X 转 pitch 度（同编辑器里的欧拉角）。 */
function euler(yaw: number, pitch = 0): Quat {
  const [y, x] = [yaw, pitch].map((degrees) => (degrees * Math.PI) / 360);
  const [cy, sy, cx, sx] = [Math.cos(y!), Math.sin(y!), Math.cos(x!), Math.sin(x!)];
  return [cy * sx, sy * cx, -sy * sx, cy * cx];
}
/** 看 −Z 的东西（相机、方向光）从 eye 看 target 的朝向。 */
function lookAt(eye: Vec3, target: Vec3): Quat {
  const d = target.map((v, i) => v - eye[i]!) as Vec3;
  return euler((Math.atan2(-d[0], -d[2]) * 180) / Math.PI, (Math.asin(d[1] / Math.hypot(...d)) * 180) / Math.PI);
}

// ---- 材质 ----
for (const id of ['brushedSteel', 'clearGlass', 'concrete']) await call('use_library', { id });
const STEEL = 'Materials/Library/BrushedSteel', GLASS = 'Materials/Library/ClearGlass', CONCRETE = 'Materials/Library/Concrete';
const plain = (name: string, baseColor: [number, number, number], roughness: number, extra: object = {}) =>
  write('material', `Subway/Materials/${name}`, { name, baseColor: [...baseColor, 1], metalness: 0, roughness, ...extra });
await plain('Tile', [0.42, 0.41, 0.39], 0.35);
await plain('FrameBlack', [0.015, 0.015, 0.016], 0.45);
await plain('Ballast', [0.2, 0.16, 0.13], 0.95);
await plain('Grass', [0.12, 0.17, 0.06], 0.9);
await plain('Foliage', [0.06, 0.12, 0.04], 0.85);
// 黄黑的挡杆：斜条纹（UV 按米：先转 45°，再沿一个方向拉开，棋盘就成了 10 厘米宽的条），棱边掉漆露出底下的铁（屏幕空间的曲率乘
// 斑驳的噪声），缝里、挨着地的地方攒灰（遮蔽乘噪声）
await write('material', 'Subway/Materials/HazardYellow', {
  name: 'HazardYellow', baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.6,
  graph: nodeGraph([
    ['uv', 'uv'],
    ['turned', 'uvTransform', { rotation: 45, offset: [20, 20] }, { uv: 'uv' }],
    ['across', 'uvTransform', { scale: [1.25, 0.0001] }, { uv: 'turned' }],
    ['stripes', 'checker', { scale: 8 }, { uv: 'across' }],
    ['yellow', 'color', { color: [0.75, 0.55, 0.02] }],
    ['black', 'color', { color: [0.02, 0.02, 0.02] }],
    ['paint', 'mix', {}, { a: 'yellow', b: 'black', t: 'stripes' }],
    ['corners', 'curvatureMask', { from: 0.05, to: 0.25 }],
    ['breakup', 'noise', { scale: 30, octaves: 4, roughness: 0.6, seed: 7 }, { uv: 'uv' }],
    ['chipping', 'levels', { inMin: 0.3, inMax: 0.55 }, { in: 'breakup' }],
    ['wear', 'multiply', {}, { a: ['corners', 'edges'], b: 'chipping' }],
    ['iron', 'color', { color: [0.3, 0.29, 0.27] }],
    ['chipped', 'mix', {}, { a: 'paint', b: 'iron', t: 'wear' }],
    ['shadowed', 'occlusionMask', { from: 0.15, to: 0.6 }],
    ['grimeBreakup', 'noise', { scale: 12, octaves: 3, seed: 13 }, { uv: 'uv' }],
    ['dirt', 'multiply', {}, { a: 'shadowed', b: 'grimeBreakup' }],
    ['dirtColor', 'color', { color: [0.06, 0.05, 0.04] }],
    ['color', 'mix', {}, { a: 'chipped', b: 'dirtColor', t: 'dirt' }],
    ['paintRoughness', 'value', { value: 0.6 }],
    ['ironRoughness', 'value', { value: 0.4 }],
    ['roughness', 'mix', {}, { a: 'paintRoughness', b: 'ironRoughness', t: 'wear' }],
  ], { baseColor: 'color', metalness: 'wear', roughness: 'roughness' }),
});
// 屏蔽门的不锈钢：拉丝（各向异性），离地 30 厘米以内被鞋、箱子蹭花（更粗糙、略暗的斑），棱边磨亮
await write('material', 'Subway/Materials/DoorSteel', {
  name: 'DoorSteel', baseColor: [0.56, 0.57, 0.58, 1], metalness: 1, roughness: 0.35, anisotropy: { strength: 0.8 },
  graph: nodeGraph([
    ['uv', 'uv'],
    ['low', 'heightMask', { minHeight: -10, maxHeight: 0.3, blend: 0.15 }],
    ['scratches', 'noise', { scale: 60, octaves: 4, roughness: 0.7, seed: 3 }, { uv: 'uv' }],
    ['scuffSpots', 'levels', { inMin: 0.4, inMax: 0.7 }, { in: 'scratches' }],
    ['scuff', 'multiply', {}, { a: 'low', b: 'scuffSpots' }],
    ['corners', 'curvatureMask', { from: 0.05, to: 0.3 }],
    ['steel', 'color', { color: [0.56, 0.57, 0.58] }],
    ['scuffed', 'color', { color: [0.42, 0.42, 0.42] }],
    ['color', 'mix', {}, { a: 'steel', b: 'scuffed', t: 'scuff' }],
    ['base', 'value', { value: 0.35 }],
    ['rough', 'value', { value: 0.6 }],
    ['polished', 'value', { value: 0.15 }],
    ['scuffRoughness', 'mix', {}, { a: 'base', b: 'rough', t: 'scuff' }],
    ['roughness', 'mix', {}, { a: 'scuffRoughness', b: 'polished', t: ['corners', 'edges'] }],
  ], { baseColor: 'color', roughness: 'roughness' }),
});
await plain('RoofPaint', [0.5, 0.52, 0.54], 0.6);
await plain('LampRed', [0.3, 0.02, 0.01], 0.4, { emissive: [6, 0.6, 0.2] });
await plain('LampGreen', [0.02, 0.3, 0.05], 0.3, { emissive: [0.4, 6, 1.2] });
const M = (name: string) => `Subway/Materials/${name}`;

type Brush = Record<string, unknown>;
const box = (name: string, position: Vec3, size: Vec3, material: number, operation = 'add'): Brush => ({ name, kind: 'box', operation, position, size, material });
const cylinder = (name: string, position: Vec3, height: number, radius: number, material: number, rotation?: Quat): Brush =>
  ({ name, kind: 'cylinder', operation: 'add', position, height, radius, material, segments: 16, ...(rotation ? { rotation } : {}) });

// ---- 场景：先只有相机、太阳和天空（编辑器里打开着的话，接下来一样一样地出现）----
const entity = (id: string, name: string, position: Vec3, components: object, rotation: Quat = [0, 0, 0, 1]) => ({ id, name, parent: null, position, rotation, scale: [1, 1, 1], components });
const eye: Vec3 = [3.6, 1.45, 1.1];
const sunAt: Vec3 = [-20, 25, 20];
await write('scene', 'Subway', {
  name: 'Subway',
  compositor: {
    clearColor: [0.1, 0.1, 0.12, 1],
    postEffects: { brightFilter: true, bloom: true, lightStreak: false, lensFlare: false, toneMap: true, antialiasing: true, antialiasingMode: 'temporal', ambientOcclusion: { radius: 0.25 }, localReflections: { maxRoughness: 0.45, edgeFade: 0.1 },
      // 照片是手机拍的：AgX 的高光褪色、白平衡偏冷一点、反差低一点（手机的 HDR 合成）；畸变、色差、噪点手机自己校正掉了
      colorGrading: { operator: 'agx', temperature: 5600, contrast: 0.9, saturation: 1.15, vignette: 0.15 },
      // 直方图测光：大片的天空和黑的门框不把曝光拽偏；局部曝光提亮暗处（手机的 HDR 合成）
      exposure: { metering: 'histogram', localShadows: 0.4 } },
    transparent: true,
  },
  entities: [
    entity('0b6c7c1e-0001-4000-8000-000000000001', 'Camera', eye, { camera: { verticalFieldOfView: 67, nearClipPlane: 0.05, farClipPlane: 2000 } }, lookAt(eye, [0.4, 1.3, -0.9])),
    entity('0b6c7c1e-0001-4000-8000-000000000002', 'Sun', sunAt, {
      light: {
        type: 'directional', color: [1, 0.97, 0.92], intensity: 10,
        shadow: { size: 'large', filter: 'pcf5x5', cascadeCount: 'four', depthBias: 0.0015, normalOffsetScale: 10, stabilization: 'projectionSnapping', pssmFactor: 0.5, depthRange: 'automatic', minDistance: 0, maxDistance: 80, blendCascades: true },
      },
    }, lookAt(sunAt, [0, 0, 0])),
    entity('0b6c7c1e-0001-4000-8000-000000000003', 'Sky', [0, 0, 0], { skyAtmosphere: { sun: '0b6c7c1e-0001-4000-8000-000000000002' } }),
    // 机位附近的一段站台和轨道：光追的探针给漫反射的间接光（顶棚下、屏蔽门后面暗下来，地面反上来的光）
    entity('0b6c7c1e-0001-4000-8000-000000000004', 'Irradiance', [8, 2.5, 0], { irradianceVolume: { size: [40, 6, 16], spacing: 1 } }),
  ],
});
// 观看时每一块之间停一下（STRIDE_BUILD_PAUSE 毫秒，默认 0）
const pause = Number(process.env['STRIDE_BUILD_PAUSE'] ?? 0);
let placed = 0x10;
/** 白盒模型写好以后放进场景（实体编号按顺序，重搭时一样）。 */
const brushModel = async (name: string, materials: string[], brushes: Brush[]) => {
  await write('brush', `Subway/Models/${name}`, { name, materials, uvScale: 1, brushes });
  // 场景在开头重写过（相机、太阳、天空、辐照度体四个）：这里按顺序往后加
  const index = 4 + placed - 0x10;
  const id = `0b6c7c1e-0001-4000-8000-${(placed++).toString(16).padStart(12, '0')}`;
  await call('edit_scene', { kind: 'scene', path: 'Subway', edits: [{ type: 'add', entities: [{ entity: entity(id, name, [0, 0, 0], { model: { model: `Subway/Models/${name}`, materials: [] } }), index }] }] });
  if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));
};


// ---- 站台和轨道 ----
const LENGTH = 60, START = -12, CENTER = START + LENGTH / 2;
await brushModel('Platform', [M('FloorTiles'), CONCRETE], [
  box('Floor', [CENTER, -0.5, 4], [LENGTH, 1, 10], 0),
  // 站台边缘的混凝土立面（站台边在 z = −1）
  box('Edge', [CENTER, -0.7, -0.95], [LENGTH, 1.2, 0.1], 1),
]);
const TRACKS = [-2.6, -6.6];
await brushModel('Tracks', [M('Ballast'), STEEL, CONCRETE], [
  box('Bed', [CENTER, -1.55, -4.6], [LENGTH, 0.5, 7.2], 0),
  ...TRACKS.flatMap((z, t) => [-0.72, 0.72].map((offset, r) => box(`Rail${t}${r}`, [CENTER, -1.22, z + offset], [LENGTH, 0.16, 0.07], 1))),
  ...TRACKS.map((z, t) => box(`Slab${t}`, [CENTER, -1.33, z], [LENGTH, 0.06, 2.6], 2)),
]);

// ---- 屏蔽门：一跨是 立柱 0.4 | 滑动门 2.0（两扇）| 立柱 0.4 | 固定门 1.8 ----
const Z = -0.6, SILL = 0.04, TOP = 2.05;
const doorBrushes: Brush[] = [];
/** 一扇带黑框的玻璃：x0 起、宽 width。 */
const leaf = (name: string, x0: number, width: number) => {
  const cx = x0 + width / 2, height = TOP - SILL, cy = SILL + height / 2;
  doorBrushes.push(box(`${name}Frame`, [cx, cy, Z], [width, height, 0.06], 1));
  doorBrushes.push(box(`${name}Hole`, [cx, cy + 0.05, Z], [width - 0.12, height - 0.22, 0.2], 1, 'subtract'));
};
const glassBrushes: Brush[] = [];
const pane = (x0: number, width: number) => glassBrushes.push(box('Glass', [x0 + width / 2, SILL + (TOP - SILL) / 2 + 0.05, Z], [width - 0.1, TOP - SILL - 0.2, 0.012], 0));
const post = (name: string, x0: number) => {
  doorBrushes.push(box(name, [x0 + 0.2, 1.1, Z], [0.4, 2.2, 0.32], 0));
  // 立柱顶上的门灯
  doorBrushes.push(box(`${name}Lamp`, [x0 + 0.2, 2.24, Z], [0.26, 0.08, 0.2], 2));
};
let x = 1.0;
for (let bay = 0; bay < 8; bay++) {
  post(`Post${bay}a`, x);
  leaf(`Door${bay}L`, x + 0.4, 1.0);
  leaf(`Door${bay}R`, x + 1.4, 1.0);
  pane(x + 0.4, 1.0);
  pane(x + 1.4, 1.0);
  doorBrushes.push(box(`Header${bay}`, [x + 1.4, TOP + 0.07, Z], [2.0, 0.14, 0.24], 0));
  post(`Post${bay}b`, x + 2.4);
  leaf(`Fixed${bay}`, x + 2.8, 1.8);
  pane(x + 2.8, 1.8);
  x += 4.6;
}
// 端门（左边的玻璃门）和带小窗的立柱
leaf('Gate', -1.6, 2.0);
pane(-1.6, 2.0);
doorBrushes.push(box('GatePost', [0.7, 1.15, Z], [0.6, 2.3, 0.32], 0));
doorBrushes.push(box('GatePostWindow', [0.7, 1.95, Z + 0.17], [0.46, 0.4, 0.04], 1));
await brushModel('ScreenDoors', [M('DoorSteel'), M('FrameBlack'), M('LampRed')], doorBrushes);
await brushModel('ScreenDoorGlass', [GLASS], glassBrushes);

// 站台尽头：栏杆、黄黑挡杆、信号灯
const railing: Brush[] = [];
for (let i = 0; i <= 6; i++) railing.push(cylinder(`RailPost${i}`, [-8.6 + i * 1.15, 0, -0.75], 1.1, 0.025, 0));
railing.push(box('RailTop', [-5.15, 1.1, -0.75], [6.9, 0.05, 0.05], 0));
railing.push(box('RailMid', [-5.15, 0.55, -0.75], [6.9, 0.04, 0.04], 0));
railing.push(box('HazardBar', [-3.2, 0.42, 0.9], [3.0, 0.14, 0.06], 1));
await brushModel('EndRailing', [STEEL, M('HazardYellow')], railing);
await brushModel('Signal', [STEEL, M('FrameBlack'), M('LampGreen')], [
  cylinder('Pole', [1.55, 0, -1.25], 3.4, 0.05, 0),
  box('Head', [1.55, 3.55, -1.25], [0.28, 0.4, 0.24], 1),
  cylinder('Lens', [1.55, 3.5, -1.12], 0.04, 0.08, 2, euler(0, 90)),
]);

// ---- 顶棚：屋面、梁、檐口、立柱 ----
const roof: Brush[] = [box('Deck', [CENTER, 4.8, 3.5], [LENGTH, 0.12, 11], 0), box('Fascia', [CENTER, 4.55, -2.0], [LENGTH, 0.5, 0.12], 0)];
for (let i = 0; i * 6 <= LENGTH; i++) {
  roof.push(box(`Beam${i}`, [START + i * 6, 4.55, 3.5], [0.25, 0.4, 11], 1));
  roof.push(cylinder(`Column${i}`, [START + i * 6, 0, 7.5], 4.4, 0.18, 1));
}
await brushModel('Canopy', [M('RoofPaint'), STEEL], roof);

// ---- 接触网：支柱、腕臂、承力索和接触线 ----
const catenary: Brush[] = [];
for (const mx of [-6, 39]) {
  catenary.push(cylinder(`Mast${mx}`, [mx, -1.3, -9.5], 8.2, 0.14, 0));
  catenary.push(box(`Arm${mx}`, [mx, 5.3, -5.8], [0.08, 0.08, 7.4], 0));
}
for (const z of TRACKS) {
  catenary.push(box(`Contact${z}`, [CENTER, 4.0, z], [LENGTH, 0.015, 0.015], 1));
  catenary.push(box(`Messenger${z}`, [CENTER, 5.1, z], [LENGTH, 0.015, 0.015], 1));
}
await brushModel('Catenary', [STEEL, M('FrameBlack')], catenary);

// ---- 远处：地面和一排树（白模先用球） ----
const trees: Brush[] = [box('Field', [CENTER, -2.2, -60], [300, 1, 100], 0)];
for (let i = 0; i < 14; i++) {
  const tx = START - 30 + i * 9 + ((i * 37) % 5), tz = -22 - ((i * 13) % 7);
  trees.push({ name: `Tree${i}`, kind: 'sphere', operation: 'add', position: [tx, 2 + ((i * 7) % 3), tz], radius: 4 + ((i * 11) % 3), material: 1, segments: 16 });
}
await brushModel('Surroundings', [M('Grass'), M('Foliage')], trees);

await mcp.stop();
