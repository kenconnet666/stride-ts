import { createStrideNative } from '@stride-ts/native';
import { checkSharedUpload, createCases } from './cases';
import { runCases, type Result } from './harness';

declare global {
  // Read by tools/bench.cjs.
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
  const native = await createStrideNative({ workerThreads: 2 });
  const info = adapter.info;
  print(`crossOriginIsolated ${crossOriginIsolated}, ${navigator.hardwareConcurrency} cores, GPU ${info.vendor} ${info.architecture} ${info.description}`);
  print(`writeBuffer from wasm shared memory, read back: ${await checkSharedUpload({ device, native })}`);

  let group = '';
  const results = await runCases(createCases({ device, native }), (result) => {
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
