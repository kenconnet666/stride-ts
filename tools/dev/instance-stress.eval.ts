// 实例化压力测试（在开放世界页面里用 `stride eval --file tools/dev/instance-stress.eval.ts` 跑）：建 N 个共用一个盒子模型的静态实体，
// 量生成时间；之后用 `stride perf`、`stride metrics` 看帧时间、变换更新、绘制耗时和内存。改下面的 N（10 万、100 万）。
// 记录：11-24 的数字在 docs/progress-log.md 第 120、122 条。按需运行，不进回归。
const N = 100_000;
const model = await game.content.loadModel('Models/Box');
const t0 = performance.now();
const side = Math.ceil(Math.sqrt(N));
for (let i = 0; i < N; i++) {
  const e = game.entities.create({ name: 'stress', components: [engine.Transform] });
  const t = e.require(engine.Transform);
  Object.assign(t.position, { x: (i % side) * 3 - side * 1.5, y: 40, z: Math.floor(i / side) * 3 - side * 1.5 });
  game.content.addModel(e, model, { isShadowCaster: false, visibleInRayTracing: false });
}
const t1 = performance.now();
await seconds(3);
// 最后一个表达式的值是 stride eval 打出来的结果
// oxlint-disable-next-line no-unused-expressions
({ spawnMs: Math.round(t1 - t0), settleMs: Math.round(performance.now() - t1), entities: game.entities.count, transformCapacity: game.transforms.capacity });
