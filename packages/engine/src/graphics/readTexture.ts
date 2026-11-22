/**
 * 把一张贴图（的一块）读回 CPU：拷进可映射的缓冲（每行按 WebGPU 的要求对齐到 256 字节）、等 GPU 做完、去掉每行补的对齐，
 * 返回紧凑的字节（行接着行）。贴图要有 COPY_SRC。调试命令、烘焙这类不在帧循环里的地方用；每次建一个临时缓冲，不要每帧调。
 */
export async function readTexture(device: GPUDevice, texture: GPUTexture, bytesPerPixel: number, size: readonly [width: number, height: number] = [texture.width, texture.height]): Promise<Uint8Array<ArrayBuffer>> {
  const [width, height] = size;
  const tight = width * bytesPerPixel;
  const bytesPerRow = Math.ceil(tight / 256) * 256;
  const buffer = device.createBuffer({ label: `readTexture ${texture.label}`, size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = device.createCommandEncoder({ label: 'readTexture' });
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [width, height]);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(buffer.getMappedRange());
    const out = new Uint8Array(tight * height);
    for (let y = 0; y < height; y++) out.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + tight), y * tight);
    return out;
  } finally {
    buffer.destroy();
  }
}
