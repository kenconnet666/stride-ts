/**
 * CPU 剖析（CDP 的 Profiler.stop 给的 Profile）的汇总：按类别（wasm、各 JS 文件、GC、空闲）和函数算每帧的自身时间、
 * 包含时间；callers 找某些函数是被谁调用的。wasm 留着函数名（--profiling-funcs），名字直接可读。
 */

/** CDP 的 Profiler.Profile 里用到的部分。 */
export interface CpuProfile {
  readonly nodes: readonly { readonly id: number; readonly callFrame: { readonly functionName: string; readonly url: string }; readonly children?: readonly number[] }[];
  readonly samples: readonly number[];
  readonly timeDeltas: readonly number[];
}

type Node = CpuProfile['nodes'][number];

function index(profile: CpuProfile): { nodes: Map<number, Node>; parent: Map<number, number> } {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parent = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
  return { nodes, parent };
}

function label({ callFrame }: Node): string {
  const where = callFrame.url.endsWith('.wasm') || callFrame.url.startsWith('wasm://') ? 'wasm' : callFrame.url.split('/').pop() ?? '';
  return `${callFrame.functionName || '(anonymous)'} [${where}]`;
}

function kind({ callFrame }: Node): string {
  if (callFrame.url.endsWith('.wasm') || callFrame.url.startsWith('wasm://')) return 'wasm';
  if (['(idle)', '(program)', '(garbage collector)', '(root)'].includes(callFrame.functionName)) return callFrame.functionName;
  return `js ${callFrame.url.split('/').pop() || '(native)'}`;
}

/** 每个采样的毫秒数（下一个时间差，同 Chrome DevTools）。 */
const sampleMs = (profile: CpuProfile, i: number) => (profile.timeDeltas[i + 1] ?? 0) / 1000;

const top = (map: Map<string, number>, count: number, frames: number) =>
  Object.fromEntries([...map].sort((a, b) => b[1] - a[1]).slice(0, count).map(([name, ms]) => [name, Math.round((ms / frames) * 1000) / 1000]));

/** 每帧的毫秒数：总时间，按类别的自身时间，最耗时的函数（自身、包含）。 */
export function summarizeProfile(profile: CpuProfile, frames: number, { selfCount = 30, inclusiveCount = 40 } = {}): unknown {
  const { nodes, parent } = index(profile);
  const self = new Map<string, number>(), inclusive = new Map<string, number>(), kinds = new Map<string, number>();
  let total = 0;
  profile.samples.forEach((id, i) => {
    const ms = sampleMs(profile, i);
    total += ms;
    const node = nodes.get(id)!;
    self.set(label(node), (self.get(label(node)) ?? 0) + ms);
    kinds.set(kind(node), (kinds.get(kind(node)) ?? 0) + ms);
    const seen = new Set<string>();
    for (let p: number | undefined = id; p !== undefined; p = parent.get(p)) {
      const name = label(nodes.get(p)!);
      if (seen.has(name)) continue;
      seen.add(name);
      inclusive.set(name, (inclusive.get(name) ?? 0) + ms);
    }
  });
  const perFrame = Math.max(1, frames);
  return {
    frames,
    sampledMs: Math.round(total),
    msPerFrame: Math.round((total / perFrame) * 1000) / 1000,
    selfByKind: top(kinds, 12, perFrame),
    self: top(self, selfCount, perFrame),
    inclusive: top(inclusive, inclusiveCount, perFrame),
  };
}

/** 调用栈上有匹配 pattern 的函数的采样：最外层匹配者的调用链（depth 层）各占每帧多少毫秒。 */
export function profileCallers(profile: CpuProfile, pattern: RegExp, frames: number, depth = 3): unknown {
  const { nodes, parent } = index(profile);
  const byChain = new Map<string, number>();
  profile.samples.forEach((id, i) => {
    let outer: number | undefined;
    for (let p: number | undefined = id; p !== undefined; p = parent.get(p)) if (pattern.test(nodes.get(p)!.callFrame.functionName)) outer = p;
    if (outer === undefined) return;
    const chain: string[] = [];
    for (let p = parent.get(outer); p !== undefined && chain.length < depth; p = parent.get(p)) chain.push(label(nodes.get(p)!));
    const key = chain.join(' <- ') || '(top)';
    byChain.set(key, (byChain.get(key) ?? 0) + sampleMs(profile, i));
  });
  return top(byChain, 25, Math.max(1, frames));
}
