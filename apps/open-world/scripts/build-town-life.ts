// 只用编辑器的 MCP 搭 Valley 小镇里的"生活"（世界模拟底座的验收，agent 的做法）：长椅的模型和材质，行人、能开的车、长椅三个
// 预制体，再往 Valley 的常驻场景里东路边放一辆车（PlayerCar）、几张长椅、一群行人；高度用 terrain_height 按地形算，不开页面。
//   node apps/open-world/scripts/build-town-life.ts
// 位置沿东路的中心线量（读样条、按弧长采样）。
// 打开 http://localhost:5232/?world=Worlds/Valley&drive 开车（WASD），行人逛街、坐长椅、晚上回家，被车撞倒了过一会儿爬起来。
// 同一个种子每次一样（实体的 id 按名字算）；已经有了会先拿掉重放。
import { createHash } from 'node:crypto';
import path from 'node:path';
import { McpProcess } from '@stride-ts/editor/mcp-client';
import { sampleSpline } from '@stride-ts/engine/modeling';
import type { SplineFile } from '@stride-ts/engine/content-format';

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

/** 按名字算的 id（UUID 的样子）：重跑时 id 不变，场景文件的差异只有真改了的。 */
const idOf = (name: string) => {
  const h = createHash('sha1').update(`town-life/${name}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};
type Vec3 = [number, number, number];
/** 绕竖直轴转 yaw（弧度）的四元数。 */
const yawRotation = (yaw: number): [number, number, number, number] => [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
const entity = (name: string, parent: string | null, position: Vec3, components: object, extra: object = {}, rotation = yawRotation(0)) =>
  ({ id: idOf(name), name, parent, position, rotation, scale: [1, 1, 1], components, ...extra });
const asset = (assetPath: string, kind: string) => ({ $asset: assetPath, kind });
const ref = (name: string) => ({ $entity: idOf(name) });
const box = (size: Vec3, position: Vec3, mass = 1) => ({ type: 'box', size, position, rotation: [0, 0, 0, 1], mass });

// ---- 资源：长椅（SDF：木条的座面和靠背，两边的铁脚）、材质 ----
await call('write_asset', { kind: 'material', path: 'Materials/BenchWood', content: { name: 'BenchWood', baseColor: [0.3, 0.16, 0.07, 1], metalness: 0, roughness: 0.7 } });
const slats = (y: number, z: number, tilt: number, count: number, prefix: string) => Array.from({ length: count }, (_, i) => ({
  name: `${prefix} ${i}`, kind: 'box', operation: 'add', position: [0, y + (prefix === 'Back' ? i * 0.11 : 0), z + (prefix === 'Seat' ? i * 0.11 - 0.17 : 0)],
  rotation: [Math.sin(tilt / 2), 0, 0, Math.cos(tilt / 2)], size: [1.8, 0.035, 0.09], cornerRadius: 0.012,
}));
await call('write_asset', {
  kind: 'sdf', path: 'Models/Bench', content: {
    name: 'Bench', materials: ['Materials/BenchWood', 'Materials/Steel'], resolution: 0.015,
    shapes: [
      ...slats(0.45, 0, 0, 4, 'Seat'),
      ...slats(0.6, -0.27, -0.25, 3, 'Back'),
      ...[-0.8, 0.8].flatMap((x, i) => [
        { name: `Leg ${i} front`, kind: 'box', operation: 'add', position: [x, 0.22, 0.17], size: [0.05, 0.44, 0.05], cornerRadius: 0.01, material: 1 },
        { name: `Leg ${i} back`, kind: 'box', operation: 'add', position: [x, 0.42, -0.22], size: [0.05, 0.84, 0.05], cornerRadius: 0.01, material: 1 },
        { name: `Leg ${i} rail`, kind: 'box', operation: 'add', position: [x, 0.42, -0.02], size: [0.05, 0.04, 0.46], cornerRadius: 0.01, material: 1 },
      ]),
    ],
  },
});

// ---- 预制体 ----
await call('write_asset', {
  kind: 'prefab', path: 'Prefabs/Pedestrian', content: {
    name: 'Pedestrian', entities: [entity('Pedestrian', null, [0, 0, 0], {
      model: { model: 'Shared/Characters/Mannequin', materials: [] },
      animation: { animations: [] },
      // 被撞的判定：跟着人走的运动学胶囊（接触不挡东西，Knockdown 设的处理器）
      body: { shapes: [{ type: 'capsule', radius: 0.3, length: 1.2, position: [0, 0.9, 0], rotation: [0, 0, 0, 1], mass: 1 }], layer: 0, friction: 0.5, kinematic: true, gravity: false, sleepThreshold: -1, interpolated: false },
      simulationLod: {},
      scripts: [
        { type: 'CrowdAgent', props: { radius: 0.3, maxSpeed: 1.3 } },
        { type: 'Animator', props: { graph: asset('Animations/Pedestrian', 'animationGraph'), speedParameter: 'speed' } },
        { type: 'StateTreeRunner', props: { tree: asset('AI/Pedestrian', 'stateTree') } },
        { type: 'Ragdoll', props: {} },
        { type: 'Knockdown', props: { minSpeed: 3, downTime: 5 } },
      ],
    })],
  },
});
const WHEELS: [number, number][] = [[0.78, -1.3], [-0.78, -1.3], [0.78, 1.3], [-0.78, 1.3]];
await call('write_asset', {
  kind: 'prefab', path: 'Prefabs/Car', content: {
    name: 'Car', entities: [
      entity('Car', null, [0, 0, 0], {
        model: { model: 'Models/Car', materials: [] },
        body: { shapes: [box([1.8, 1.0, 4.2], [0, 0.75, 0], 1200)], layer: 0, friction: 0.5, kinematic: false, gravity: true, sleepThreshold: 0.01, interpolated: true },
        scripts: [
          {
            type: 'Vehicle', props: {
              drive: 'front',
              wheels: WHEELS.map(([x, z], i) => ({ position: [x, 0.45, z], radius: 0.33, width: 0.22, steerAngle: i < 2 ? 32 : 0, handBrakeTorque: i < 2 ? 0 : 4000, model: ref(`Car wheel ${i}`) })),
            },
          },
          { type: 'Deformable', props: {} },
          { type: 'VehicleDriver', props: { controls: asset('Input/Driving', 'input') } },
        ],
      }),
      ...WHEELS.map(([x, z], i) => entity(`Car wheel ${i}`, idOf('Car'), [x, 0.45, z], { model: { model: 'Models/Wheel', materials: [] } })),
    ],
  },
});
await call('write_asset', {
  kind: 'prefab', path: 'Prefabs/Bench', content: {
    name: 'Bench', entities: [entity('Bench', null, [0, 0, 0], {
      model: { model: 'Models/Bench', materials: [] },
      static: { shapes: [box([1.8, 0.45, 0.5], [0, 0.225, 0]), box([1.8, 0.4, 0.08], [0, 0.75, -0.25])], layer: 0, friction: 0.5, trigger: false },
      // 两个座位：坐的人面朝长椅的 +Z（背对靠背）
      scripts: [{ type: 'SmartObject', props: { slots: [-0.45, 0.45].map((x) => ({ position: [x, 0, 0.45], yaw: 0, activity: 'sit' })) } }],
    })],
  },
});

// ---- 摆进 Valley 的常驻场景：东路上离 (500, -40) 最近的地方一带 ----
const road = await call('read_asset', { kind: 'spline', path: 'Splines/EastRoad' }) as SplineFile;
const frames = sampleSpline(road.points, false, 1);
const anchor = frames.reduce((best, frame) => (Math.hypot(frame.position[0] - 500, frame.position[2] + 40) < Math.hypot(best.position[0] - 500, best.position[2] + 40) ? frame : best));
/** 沿路离锚点 t 米（往路的方向为正）、往右 s 米的地方 (x, z)，和那里路的方向（单位向量 x, z）。 */
const onRoad = (t: number, s: number) => {
  const target = anchor.distance + t;
  const frame = frames.reduce((best, f) => (Math.abs(f.distance - target) < Math.abs(best.distance - target) ? f : best));
  const point: [number, number] = [frame.position[0] + frame.right[0] * s, frame.position[2] + frame.right[2] * s];
  return { point, along: [frame.tangent[0], frame.tangent[2]] as const, right: [frame.right[0], frame.right[2]] as const };
};
const next = random(11);
const people = Array.from({ length: 14 }, () => onRoad(-20 + next() * 50, (next() < 0.5 ? -1 : 1) * (6 + next() * 3)).point);
// 长椅在人行道上（离路中心 7.5 米），坐的人面朝路
const benchSpots = [onRoad(-8, -7.5), onRoad(12, -7.5), onRoad(4, 7.5)].map((spot, i) => ({ ...spot, toRoad: i === 2 ? -1 : 1 }));
const benches = benchSpots.map((spot) => spot.point);
// 车在右手的车道上（靠右行驶），车头顺着路
const car = onRoad(-30, 1.8);
const carAt = car.point;
const heights = await call('terrain_height', { path: 'Terrains/Valley', points: [...people, ...benches, carAt] }) as number[];
const ground = (i: number, [x, z]: [number, number], lift = 0): Vec3 => [+x.toFixed(2), +(heights[i]! + lift).toFixed(2), +z.toFixed(2)];
// 车头是 -Z：转到路的方向；长椅的 +Z 转到朝路
const roadYaw = Math.atan2(-car.along[0], -car.along[1]);
const instance = (name: string, prefab: string, position: Vec3, yaw: number) =>
  entity(name, idOf('TownLife'), position, {}, { prefab: { path: prefab, set: [], removed: [] } }, yawRotation(yaw));
const added = [
  entity('TownLife', null, [0, 0, 0], {}),
  instance('PlayerCar', 'Prefabs/Car', ground(people.length + benches.length, carAt, 0.6), roadYaw),
  ...benchSpots.map((spot, i) => instance(`Bench ${i}`, 'Prefabs/Bench', ground(people.length + i, spot.point), Math.atan2(spot.toRoad * spot.right[0], spot.toRoad * spot.right[1]))),
  ...people.map((p, i) => instance(`Pedestrian ${i}`, 'Prefabs/Pedestrian', ground(i, p), next() * Math.PI * 2)),
];
const scene = await call('read_asset', { kind: 'scene', path: 'Valley' }) as { entities: { id: string; parent: string | null }[] };
// 上一次放的：TownLife 和它的整棵子树（场景里父实体在前）
const old = new Set<string>();
for (const e of scene.entities) if (e.id === idOf('TownLife') || (e.parent !== null && old.has(e.parent))) old.add(e.id);
await call('edit_scene', {
  kind: 'scene', path: 'Valley', edits: [
    ...(old.size > 0 ? [{ type: 'remove', entities: [...old] }] : []),
    // 接在场景最后（拿掉旧的以后）
    { type: 'add', entities: added.map((e, i) => ({ entity: e, index: scene.entities.length - old.size + i })) },
  ],
});
console.log(`Valley: TownLife with PlayerCar, ${benches.length} benches, ${people.length} pedestrians`);
await mcp.stop();
