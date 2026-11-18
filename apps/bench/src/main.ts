import { createStrideNative } from '@stride-ts/native';
import { physics } from '@stride-ts/native/physics';
import { checkSharedUpload, createCases } from './cases';
import { createRenderCases } from './render-cases';
import { runCases, type Result } from './harness';

declare global {
  // tools/bench.cjs 读这两个值。
  var benchResults: Result[] | undefined;
  var benchError: string | undefined;
}

const out = document.getElementById('out')!;
const lines: string[] = [];
const print = (line: string) => {
  lines.push(line);
  out.textContent = lines.join('\n');
};

function format(result: Result): string {
  if (result.error) return `  ${result.name.padEnd(64)} n=${String(result.n).padStart(6)}  ERROR ${result.error}`;
  const ms = result.ms < 0.1 ? result.ms.toFixed(4) : result.ms.toFixed(3);
  return `  ${result.name.padEnd(64)} n=${String(result.n).padStart(6)}  ${ms.padStart(9)} ms  ${result.nsPerEntity.toFixed(1).padStart(8)} ns/entity`;
}

async function main(): Promise<void> {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('WebGPU is not available');
  const device = await adapter.requestDevice();
  const native = await createStrideNative({ workerThreads: 2, features: [physics] });
  const info = adapter.info;
  print(`crossOriginIsolated ${crossOriginIsolated}, ${navigator.hardwareConcurrency} cores, GPU ${info.vendor} ${info.architecture} ${info.description}`);
  print(`writeBuffer from wasm shared memory, read back: ${await checkSharedUpload({ device, native })}`);

  // ?only=render 只跑名字以这个词开头的组
  const only = new URLSearchParams(location.search).get('only');
  const cases = [...createCases({ device, native }), ...createRenderCases(device)].filter((c) => !only || c.group.startsWith(only));
  let group = '';
  const results = await runCases(cases, (result) => {
    if (result.group !== group) {
      group = result.group;
      print(`\n${group}`);
    }
    print(format(result));
  });
  native.shutdown();
  device.destroy();
  globalThis.benchResults = results;
  print('\ndone');
}

main().catch((error: unknown) => {
  globalThis.benchError = error instanceof Error ? (error.stack ?? error.message) : String(error);
  print(`failed: ${globalThis.benchError}`);
});
