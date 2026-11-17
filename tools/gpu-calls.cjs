// Usage: node gpu-calls.cjs <playwright> <url> [frames]
// Counts the WebGPU calls of a game a frame once its scene draws, with the bytes and the sizes of the buffer writes.
const { chromium } = require(process.argv[2]);
(async () => {
  const [url, frameCount = '120'] = process.argv.slice(3);
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.addInitScript(() => {
    globalThis.gpuCalls = { on: false, counts: {}, writeBytes: 0, writeSizes: {}, bufferSizes: {} };
    const count = k => { if (gpuCalls.on) gpuCalls.counts[k] = (gpuCalls.counts[k] ?? 0) + 1; };
    for (const proto of [GPUDevice.prototype, GPUQueue.prototype, GPUCommandEncoder.prototype, GPURenderPassEncoder.prototype, GPUComputePassEncoder.prototype, GPUBuffer.prototype]) {
      const cls = proto.constructor.name.replace('GPU', '');
      for (const k of Object.getOwnPropertyNames(proto)) {
        const d = Object.getOwnPropertyDescriptor(proto, k);
        if (typeof d.value !== 'function' || k === 'constructor') continue;
        const f = d.value;
        proto[k] = function (...a) { count(cls + '.' + k); return f.apply(this, a); };
      }
    }
    const write = GPUQueue.prototype.writeBuffer;
    GPUQueue.prototype.writeBuffer = function (buffer, offset, data, dataOffset, size) {
      if (gpuCalls.on) {
        const n = size ?? (data.byteLength - (dataOffset ?? 0));
        gpuCalls.writeBytes += n;
        const bucket = n <= 64 ? '<=64' : n <= 256 ? '<=256' : n <= 1024 ? '<=1K' : n <= 16384 ? '<=16K' : '>16K';
        gpuCalls.writeSizes[bucket] = (gpuCalls.writeSizes[bucket] ?? 0) + 1;
        const b = `${buffer.size}:${buffer.usage}`;
        gpuCalls.bufferSizes[b] = (gpuCalls.bufferSizes[b] ?? 0) + 1;
      }
      return write.call(this, buffer, offset, data, dataOffset, size);
    };
  });
  await page.goto(url);
  await page.waitForFunction(() => globalThis.strideGame && globalThis.strideGame.frames > (globalThis.strideGame.sceneFrame ?? Infinity) + 120, null, { timeout: 300000 });
  const f0 = await page.evaluate(() => { gpuCalls.on = true; return strideGame.frames; });
  await page.waitForFunction(n => strideGame.frames >= n, f0 + +frameCount, { timeout: 300000 });
  const r = await page.evaluate(() => { gpuCalls.on = false; return { ...gpuCalls, frames: strideGame.frames }; });
  const frames = r.frames - f0;
  console.log(`${frames} frames; buffer writes ${(r.writeBytes / frames / 1024).toFixed(1)} KB a frame`);
  for (const [k, v] of Object.entries(r.counts).sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log((v / frames).toFixed(1).padStart(8), k);
  console.log('-- write sizes a frame'); for (const [k, v] of Object.entries(r.writeSizes)) console.log((v / frames).toFixed(1).padStart(8), k);
  console.log('-- written buffers (size:usage) a frame'); for (const [k, v] of Object.entries(r.bufferSizes).sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log((v / frames).toFixed(1).padStart(8), k);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
