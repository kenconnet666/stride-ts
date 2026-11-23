import { createStrideTools } from '@stride-ts/native/tools';

const tools = await createStrideTools();
const size = Number(process.argv[2] ?? 2048);
// 带细节的合成图（噪声加渐变），避免全平的图编得过快
const pixels = new Uint8Array(size * size * 4);
let seed = 1;
for (let i = 0; i < size * size; i++) {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  const x = i % size, y = (i / size) | 0;
  pixels[i * 4] = ((x ^ y) & 255) * 0.6 + (seed >>> 24) * 0.4;
  pixels[i * 4 + 1] = (x * 255) / size * 0.7 + ((seed >>> 16) & 255) * 0.3;
  pixels[i * 4 + 2] = (y * 255) / size * 0.7 + ((seed >>> 8) & 255) * 0.3;
  pixels[i * 4 + 3] = 255;
}
const time = async (label: string, run: () => Promise<unknown>) => {
  const t0 = performance.now();
  const out = await run();
  console.log(`${label}: ${((performance.now() - t0) / 1000).toFixed(1)} s`, out instanceof Uint8Array ? `${(out.byteLength / 1048576).toFixed(1)} MB` : '');
};
await time(`${size}² uastc effort 2 one`, () => tools.encodeBasis(pixels, size, size, { mode: 'uastc', srgb: true, mipmaps: true }));
await time(`${size}² uastc ×4 concurrent`, () => Promise.all([0, 1, 2, 3].map(() => tools.encodeBasis(pixels, size, size, { mode: 'uastc', srgb: true, mipmaps: true }))));
tools.dispose?.();
process.exit(0);
