// 从两张截图反推色调映射前的 HDR 值（sRGB → 线性 → Hejl2 白点 5 的反函数，曝光 EV0），按画面的行分组打印
// 参考/我们 的比值（p10、中位数、p90）：处处相同说明是整体倍数（光强、反照率），随行变化说明和角度有关（高光、N·L）。
// 两边都要固定曝光 EV0、关掉 FXAA 和亮部提取（参考图用 stride-capture 的 --exposure 0 --disable fxaa,brightfilter；
// 我们这边先用 stride eval 设好，再 stride shot ours.png）。
// 用法：node tools/dev/hdr-ratio.ts <参考.png> <我们的.png> [每组的行数，默认 60]
import { readFileSync } from 'node:fs';
import { decodePng } from '../../packages/cli/src/png.ts';

const [referenceFile, oursFile, bandArg = '60'] = process.argv.slice(2);
if (!referenceFile || !oursFile) throw new Error('usage: node tools/dev/hdr-ratio.ts <reference.png> <ours.png> [rows per band]');
const reference = decodePng(readFileSync(referenceFile));
const ours = decodePng(readFileSync(oursFile));
if (reference.width !== ours.width || reference.height !== ours.height) throw new Error(`size differs: ${reference.width}x${reference.height} vs ${ours.width}x${ours.height}`);

const linear = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const hejl = (x: number) => {
  const va = 1.425 * x + 0.05;
  return (x * va + 0.004) / (x * (va + 0.55) + 0.0491) - 0.0821;
};
// 8 位值 → 色调映射前的值：在 Hejl2 上二分
const white = hejl(5);
const inverse = Float32Array.from({ length: 256 }, (_, v) => {
  const target = linear(v) * white;
  let lo = 0, hi = 50;
  for (let k = 0; k < 60; k++) {
    const mid = (lo + hi) / 2;
    if (hejl(mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
});

const band = Number(bandArg);
const { width, height } = reference;
for (let top = 0; top < height; top += band) {
  const ratios: number[] = [];
  for (let y = top; y < Math.min(height, top + band); y++) {
    for (let x = 0; x < width; x++) {
      // 绿色通道；太暗、饱和的像素反推不准
      const p = (y * width + x) * 4 + 1;
      const r = reference.data[p]!, o = ours.data[p]!;
      if (r > 20 && o > 20 && r < 250) ratios.push(inverse[r]! / inverse[o]!);
    }
  }
  ratios.sort((a, b) => a - b);
  const q = (f: number) => (ratios.length ? ratios[Math.floor(f * (ratios.length - 1))]!.toFixed(2) : '-');
  console.log(`rows ${top}-${Math.min(height, top + band) - 1}: n=${ratios.length} p10=${q(0.1)} median=${q(0.5)} p90=${q(0.9)}`);
}
