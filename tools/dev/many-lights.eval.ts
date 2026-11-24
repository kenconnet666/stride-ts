// 大量局部光的压力：在主画面前面 20 × 20 米、离地 2.4～3 米的范围里撒 300 盏半径 5 米的点光（不投阴影图，颜色随机、种子固定），
// 每个像素上重叠四五十盏。量着色随重叠的灯数怎么涨（不透明那一遍、局部光的光追阴影）。
//   超市页面（?scene=Supermarket，4K 无头 Chrome）里：stride call quality '{"level":"ultra"}'、stride perf（基准），
//   stride eval --file tools/dev/many-lights.eval.ts，再 stride perf。
// 结论见 docs/progress-log.md 第 157 条（多盏灯随机挑灯推到可见性缓冲之后）。
const { Transform, Light } = engine;
let seed = 7;
const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
for (let i = 0; i < 300; i++) {
  game.entities.create({
    name: 'Stress light',
    components: [
      Transform.with({ position: [random() * 20 - 10, 2.4 + random() * 0.6, random() * 20 - 15] }),
      Light.with({ type: 'point', color: [random(), random(), random(), 1], intensity: 2, radius: 5 }),
    ],
  });
}
