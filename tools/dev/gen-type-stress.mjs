// 用法：node tools/dev/gen-type-stress.mjs [组件数] [系统数] [脚本数]
// 生成 packages/engine/test/stress.check.ts：大量用到各种属性的组件、系统和脚本，
// 用 `tsc --extendedDiagnostics` 看类型推导怎么随规模增长（检查时间、实例化次数、不出 TS2589）。
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [components = 300, systems = 150, scripts = 150] = process.argv.slice(2).map(Number);
const out = fileURLToPath(new URL('../../packages/engine/test/stress.check.ts', import.meta.url));

const fields = (i) => [
  `a${i}: prop.f32().min(0).default(${i})`,
  `b${i}: ${i}`,
  `c${i}: prop.int().default(1)`,
  `d${i}: prop.enum(['x', 'y', 'z']).default('x')`,
  `e${i}: prop.bool().default(true)`,
  `f${i}: prop.entity().default(0 as EntityId)`,
  `g${i}: prop.u8()`,
];

const lines = [
  '// 由 tools/dev/gen-type-stress.mjs 生成，不要手改。只有 tsc 读它。',
  "import { component, prop, SyncScript, system, type EntityId, type GameTime } from '../src/index';",
  '',
];
for (let i = 0; i < components; i++) lines.push(`export const C${i} = component({ ${fields(i).join(', ')} });`);
for (let i = 0; i < systems; i++) {
  const a = i % components, b = (i * 7 + 3) % components, c = (i * 13 + 5) % components;
  lines.push(
    `export const s${i} = system({`,
    `  with: { p: C${a}, q: C${b}, r: C${c} },`,
    `  writes: [C${a}],`,
    `  update({ p, q, r, count }, time) {`,
    `    for (let i = 0; i < count; i++) p.a${a}[i] = q.b${b}[i]! + r.c${c}[i]! * time.elapsed + (q.e${b}[i] ? 1 : 0);`,
    `  },`,
    `});`,
  );
}
for (let i = 0; i < scripts; i++) {
  const c = i % components;
  lines.push(
    `export class S${i} extends SyncScript.props({ ${fields(i).join(', ')} }) {`,
    `  override update(time: GameTime): void {`,
    `    const v = this.entity.require(C${c});`,
    `    v.a${c} = this.a${i} + this.b${i} * time.elapsed;`,
    `    if (this.d${i} === 'y' && this.e${i}) this.g${i} = this.c${i};`,
    `  }`,
    `}`,
    `S${i}.with({ g${i}: 1, a${i}: 2 });`,
  );
}
writeFileSync(out, lines.join('\n') + '\n');
console.log(`wrote ${out}: ${components} components, ${systems} systems, ${scripts} scripts`);
