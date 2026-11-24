// 着色器的寄存器和暂存区：从 stride open --gpu-debug 的 Chrome 日志里取出 Dawn 生成的 HLSL，用 AMD 的 Radeon GPU Analyzer（RGA）
// 按这台机器的显卡（RX 9070 GRE，gfx1201）编一遍，报每个着色器用了多少 VGPR、SGPR、暂存区（scratch，寄存器不够时放到显存里的）
// 和机器码多大。VGPR 用得越多，一个 SIMD 上同时跑的波越少，等显存的时候藏不住；有暂存区说明寄存器溢出了或者动态下标取了数组。
//
//   pnpm exec stride open "http://localhost:5234/?scene=Supermarket" --headless --gpu-debug
//   node tools/dev/shader-stats.ts [--top 5] [--kind pixel|compute|all] [--device gfx1201] [--log <chrome.log>]
//
// RGA 装在 C:\code\tools\rga（GitHub 的 GPUOpen-Tools/radeon_gpu_analyzer，解压即用），别处用 STRIDE_RGA 指过去。
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    top: { type: 'string', default: '5' },
    kind: { type: 'string', default: 'pixel' },
    device: { type: 'string', default: 'gfx1201' },
    log: { type: 'string', default: path.join(os.homedir(), '.stride-ts', 'chrome-headless', 'chrome.log') },
  },
});
const rga = process.env['STRIDE_RGA'] ?? 'C:\\code\\tools\\rga\\rga.exe';
const work = path.join(os.tmpdir(), 'stride-shader-stats');
mkdirSync(work, { recursive: true });

interface Shader { readonly hlsl: string; readonly stage: 'pixel' | 'compute'; readonly entry: string; readonly output: string }

const log = readFileSync(values.log, 'utf8');
const shaders: Shader[] = [];
const seen = new Set<string>();
for (const part of log.split('/* Dumped generated HLSL */').slice(1)) {
  const hlsl = part.split('/* Dumped disassembled DXIL */')[0]!.split('/* DXC compile flags */')[0]!.trimEnd().replace(/"$/, '');
  const entry = /\n(\w+)\s+(dawn_entry_point_\w+)\(/.exec(hlsl);
  if (!entry || seen.has(hlsl)) continue;
  seen.add(hlsl);
  const stage = /\[numthreads\(/.test(hlsl) ? 'compute' : hlsl.includes('SV_Target') ? 'pixel' : undefined;
  if (!stage) continue;
  shaders.push({ hlsl, stage, entry: entry[2]!, output: entry[1]! });
}
const picked = shaders.filter((shader) => values.kind === 'all' || shader.stage === values.kind).sort((a, b) => b.hlsl.length - a.hlsl.length).slice(0, Number(values.top));
if (picked.length === 0) throw new Error(`no ${values.kind} shaders in ${values.log}: open the page with stride open --headless --gpu-debug first`);

console.log(`${'shader'.padEnd(34)} ${'stage'.padEnd(8)} ${'HLSL KB'.padStart(8)} ${'VGPR'.padStart(5)} ${'SGPR'.padStart(5)} ${'scratch B'.padStart(9)} ${'ISA KB'.padStart(7)}`);
picked.forEach((shader, i) => {
  const file = path.join(work, `shader${i}.hlsl`), out = path.join(work, `out${i}`);
  mkdirSync(out, { recursive: true });
  writeFileSync(file, shader.hlsl);
  const flag = shader.stage === 'pixel' ? 'ps' : 'cs';
  try {
    execFileSync(rga, ['-s', 'dx12', '-c', values.device!, `--${flag}`, file, `--${flag}-entry`, shader.entry, `--${flag}-model`, `${flag}_6_6`, '--dxc-opt', '-enable-16bit-types -HV 2021', '-a', path.join(out, 'stats.txt')], { stdio: 'pipe' });
  } catch (error) {
    console.log(`${shader.output.padEnd(34)} RGA failed: ${String((error as { stderr?: Buffer }).stderr ?? error).split('\n').find((line) => /error/i.test(line)) ?? ''}`);
    return;
  }
  const stats = readFileSync(path.join(out, `${values.device}_stats_${shader.stage === 'pixel' ? 'pixel' : 'comp'}.txt`), 'utf8').trim().split(/\r?\n/).map((line) => line.trim());
  const header = stats[0]!.split(','), row = stats[1]!.split(',');
  const field = (name: string) => row[header.indexOf(name)] ?? '?';
  console.log(`${shader.output.slice(0, 34).padEnd(34)} ${shader.stage.padEnd(8)} ${(shader.hlsl.length / 1024).toFixed(0).padStart(8)} ${field('USED_VGPRs').padStart(5)} ${field('USED_SGPRs').padStart(5)} ${field('SCRATCH_MEM').padStart(9)} ${(Number(field('ISA_SIZE')) / 1024).toFixed(0).padStart(7)}`);
});
