/**
 * `stride gpu-calls`：数每帧的 WebGPU 调用次数和 writeBuffer 写入的字节数。在页面里（eval 命令）给 GPU* 原型的方法套一层计数，
 * 采完换回原来的方法；任何浏览器都能用，不需要 CDP。
 */

/** 装上计数（已经装着时先清零）。 */
export const INSTALL_GPU_COUNTERS = /* js */ `(() => {
  const state = globalThis.__strideGpuCalls ??= { originals: [], counts: {}, writeBytes: 0, writeSizes: {} };
  state.counts = {}; state.writeBytes = 0; state.writeSizes = {}; state.startFrame = strideGame.frames;
  if (state.originals.length > 0) return 'reset';
  const classes = [GPUDevice, GPUQueue, GPUCommandEncoder, GPURenderPassEncoder, GPUComputePassEncoder, GPUBuffer, GPUTexture];
  for (const cls of classes) {
    const proto = cls.prototype, name = cls.name.replace('GPU', '');
    for (const key of Object.getOwnPropertyNames(proto)) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, key);
      if (key === 'constructor' || typeof descriptor.value !== 'function') continue;
      const original = descriptor.value;
      state.originals.push([proto, key, original]);
      const counted = name + '.' + key;
      proto[key] = key === 'writeBuffer'
        ? function (buffer, offset, data, dataOffset, size) {
            const bytes = size ?? (data.byteLength - (dataOffset ?? 0));
            state.writeBytes += bytes;
            const bucket = bytes <= 64 ? '<=64' : bytes <= 256 ? '<=256' : bytes <= 1024 ? '<=1K' : bytes <= 16384 ? '<=16K' : '>16K';
            state.writeSizes[bucket] = (state.writeSizes[bucket] ?? 0) + 1;
            state.counts[counted] = (state.counts[counted] ?? 0) + 1;
            return original.apply(this, arguments);
          }
        : function () { state.counts[counted] = (state.counts[counted] ?? 0) + 1; return original.apply(this, arguments); };
    }
  }
  return 'installed';
})()`;

/** 读出每帧的平均，并换回原来的方法。 */
export const COLLECT_GPU_COUNTERS = /* js */ `(() => {
  const state = globalThis.__strideGpuCalls;
  if (!state) throw new Error('GPU call counters are not installed');
  for (const [proto, key, original] of state.originals) proto[key] = original;
  delete globalThis.__strideGpuCalls;
  const frames = Math.max(1, strideGame.frames - state.startFrame);
  const perFrame = (n) => Math.round((n / frames) * 10) / 10;
  const sorted = (record) => Object.fromEntries(Object.entries(record).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, perFrame(v)]));
  return { frames, callsPerFrame: sorted(state.counts), writeKBPerFrame: Math.round(state.writeBytes / frames / 102.4) / 10, writesPerFrameBySize: sorted(state.writeSizes) };
})()`;
