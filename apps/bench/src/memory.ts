// wasm 内存能要到多少（docs/roadmap.md 第二节"Web 上的硬限制"的"内存"）：32 位、64 位（Memory64）、各自共享不共享，
// 每次长 512 MB 直到长不动，记下最大的、最后一个字节能不能写、每次长要多久。结果打在页面上，也放在 globalThis.memoryResults。
//   pnpm -F @stride-ts/bench dev，开 http://localhost:5182/memory.html
export {};

const out = document.getElementById('out')!;
const lines: string[] = [];
const log = (line: string) => {
  lines.push(line);
  out.textContent = lines.join('\n');
};

const PAGE = 65536;
const STEP_PAGES = (512 * 1024 * 1024) / PAGE;
/**
 * 最多长到这么大就停（24 GB）：Chrome 的 64 位上限是 16 GB，再往上没意义；不封顶时一次压测提交几十 GB 内存，
 * 2026-11-21 把这台机器（内存超频不稳）压死机过。
 */
const CAP_PAGES = (24 * 1024 ** 3) / PAGE;

interface Case {
  readonly name: string;
  readonly address: 'i32' | 'i64';
  readonly shared: boolean;
  /** 页数上限（32 位 65536 页是 4 GB；64 位给到 32 GB，看引擎自己的上限卡在哪）。 */
  readonly maximum: number;
}

const CASES: readonly Case[] = [
  { name: 'wasm32', address: 'i32', shared: false, maximum: 65536 },
  { name: 'wasm32 shared', address: 'i32', shared: true, maximum: 65536 },
  { name: 'wasm64', address: 'i64', shared: false, maximum: 1 << 19 },
  { name: 'wasm64 shared', address: 'i64', shared: true, maximum: 1 << 19 },
];

/** Memory64 的描述符：引擎认 `address: 'i64'`，页数用 BigInt（JS API 的 memory64 提案）；不认时退回 Number 再试一次。 */
function createMemory(c: Case, maximum: number): WebAssembly.Memory {
  const base = { shared: c.shared } as Record<string, unknown>;
  if (c.address === 'i32') return new WebAssembly.Memory({ ...base, initial: 1, maximum } as WebAssembly.MemoryDescriptor);
  try {
    return new WebAssembly.Memory({ ...base, address: 'i64', initial: 1n, maximum: BigInt(maximum) } as unknown as WebAssembly.MemoryDescriptor);
  } catch {
    return new WebAssembly.Memory({ ...base, address: 'i64', initial: 1, maximum } as unknown as WebAssembly.MemoryDescriptor);
  }
}

function grow(memory: WebAssembly.Memory, pages: number, address: 'i32' | 'i64'): void {
  (memory.grow as (delta: number | bigint) => number)(address === 'i64' ? BigInt(pages) : pages);
}

interface Result { name: string; created: boolean; error?: string; maxBytes: number; lastByteWritable: boolean; growMs: number }

async function measure(c: Case): Promise<Result> {
  let memory: WebAssembly.Memory | undefined;
  let maximum = c.maximum;
  // 共享的内存要先保留上限那么大的地址空间：建不出来就把上限减半再试
  for (; maximum >= STEP_PAGES && !memory; maximum = Math.floor(maximum / 2)) {
    try {
      memory = createMemory(c, maximum);
    } catch (error) {
      if (maximum <= STEP_PAGES) return { name: c.name, created: false, error: String(error), maxBytes: 0, lastByteWritable: false, growMs: 0 };
    }
  }
  if (!memory) return { name: c.name, created: false, maxBytes: 0, lastByteWritable: false, growMs: 0 };
  let pages = 1;
  let growMs = 0, grows = 0;
  let error: string | undefined;
  // 512 MB 一步地长，长不动了步子减半，直到一页也长不动：得到确切的上限
  for (let step = STEP_PAGES; step >= 1;) {
    if (pages + step > CAP_PAGES) {
      error = `stopped at the ${CAP_PAGES * PAGE / 1024 ** 3} GB cap`;
      break;
    }
    const start = performance.now();
    try {
      grow(memory, step, c.address);
    } catch (reason) {
      error = String(reason);
      step = Math.floor(step / 2);
      continue;
    }
    if (step === STEP_PAGES) {
      growMs += performance.now() - start;
      grows++;
    }
    pages += step;
    // 让出去一下，页面别卡死
    if (grows % 8 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const bytes = pages * PAGE;
  // 最后一个字节：ArrayBuffer 的长度上限另有一个（V8 的 TypedArray 最大长度），超了就按 DataView 的偏移写不到
  let lastByteWritable = false;
  try {
    const buffer = memory.buffer as ArrayBuffer;
    new Uint8Array(buffer, buffer.byteLength - 1, 1)[0] = 42;
    lastByteWritable = new Uint8Array(buffer, buffer.byteLength - 1, 1)[0] === 42;
  } catch (reason) {
    error = `${error ?? ''} | last byte: ${String(reason)}`;
  }
  return { name: c.name, created: true, ...(error ? { error } : {}), maxBytes: bytes, lastByteWritable, growMs: grows ? growMs / grows : 0 };
}

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GB`;
const results: Result[] = [];
log(`${navigator.userAgent}`);
log(`deviceMemory: ${(navigator as { deviceMemory?: number }).deviceMemory ?? '?'} GB (rounded), crossOriginIsolated: ${crossOriginIsolated}`);
for (const c of CASES) {
  log(`${c.name}: growing...`);
  const result = await measure(c);
  results.push(result);
  lines.pop();
  log(`${c.name.padEnd(14)} ${result.created ? `max ${gb(result.maxBytes)}, last byte ${result.lastByteWritable ? 'ok' : 'NOT writable'}, ${result.growMs.toFixed(1)} ms per 512 MB grow` : 'cannot create'}${result.error ? `  (${result.error.slice(0, 120)})` : ''}`);
  // 放掉，下一个从头来
  await new Promise((resolve) => setTimeout(resolve, 200));
}
log('done');
(globalThis as Record<string, unknown>)['memoryResults'] = results;
