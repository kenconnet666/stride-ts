// 海量行人的压力（海量实体的模拟层，ai/SimulationLod.ts）：在主相机周围半径 600 米的圆里撒 2000 个行人（开放世界的
// Models/Person、行为是 AI/Pedestrian 状态树、CrowdAgent），都挂 SimulationLod；站在地形上。
//   开放世界的山谷（?world=Worlds/Valley，4K 无头 Chrome）里：stride perf（基准），stride eval --file tools/dev/pedestrians.eval.ts，
//   等几秒再 stride perf、stride call simlod（各档几个、这一帧推进几个、人群里几个）。对照不分档：页面里先
//   `globalThis.__noLod = true` 再跑（只适合几百个人：人人都进人群、都当导航网格的引子）。
// 结论见 docs/progress-log.md 的"海量实体的模拟层"。
const { Transform, CrowdAgent, StateTreeRunner, SimulationLod } = engine;
const count = Number(globalThis.__pedestrians ?? 2000);
const radius = Number(globalThis.__radius ?? 600);
const withLod = !globalThis.__noLod;
const model = await game.content.loadModel('Models/Person');
const tree = await game.content.loadStateTree('AI/Pedestrian');
const eye = game.terrain.eyeWorld();
let seed = 11;
const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
let placed = 0;
for (let i = 0; i < count; i++) {
  const angle = random() * Math.PI * 2, distance = radius * Math.sqrt(random());
  const x = eye[0] + Math.cos(angle) * distance, z = eye[2] + Math.sin(angle) * distance;
  const y = game.terrain.heightAt(x, z);
  if (y === undefined) continue;
  const person = game.entities.create({ name: `Pedestrian ${i}`, components: withLod ? [Transform.with({ position: [x, y, z] }), SimulationLod] : [Transform.with({ position: [x, y, z] })] });
  game.content.addModel(person, model);
  person.add({ script: CrowdAgent, init: { radius: 0.3, maxSpeed: 1.2 + random() * 0.4 } });
  person.add({ script: StateTreeRunner, init: { tree } });
  placed++;
}
