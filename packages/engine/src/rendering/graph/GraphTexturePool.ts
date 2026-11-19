/**
 * 渲染图的临时贴图的池：描述相同的贴图轮着用，跨帧留着（每帧重建贴图太贵），连着 KEEP_FRAMES 帧没人要的才销毁
 * （画面大小变了、关掉了一个效果以后，旧的那些不会一直占着显存）。
 */
import type { GraphTextureDesc, TextureAllocator } from './RenderGraph';

/** 闲着的贴图留这么多帧。 */
const KEEP_FRAMES = 30;

const DEFAULT_USAGE = 0x10 | 0x04; // GPUTextureUsage.RENDER_ATTACHMENT | TEXTURE_BINDING（单测里没有这个全局对象）

const keyOf = ({ width, height, format, mipLevelCount = 1, sampleCount = 1, usage = DEFAULT_USAGE }: GraphTextureDesc) =>
  `${format}:${width}x${height}:${mipLevelCount}:${sampleCount}:${usage}`;

export class GraphTexturePool implements TextureAllocator {
  readonly #device: GPUDevice;
  readonly #free = new Map<string, { texture: GPUTexture; frame: number }[]>();
  #frame = 0;
  /** 池里现在有几张贴图（闲着的和借出去的）。 */
  count = 0;

  constructor(device: GPUDevice) {
    this.#device = device;
  }

  acquire(desc: GraphTextureDesc): GPUTexture {
    const free = this.#free.get(keyOf(desc))?.pop();
    if (free) return free.texture;
    this.count++;
    // 标签写描述而不是用途：同一张真的贴图一帧里先后给几个用途用
    return this.#device.createTexture({
      label: `RenderGraph ${desc.format} ${desc.width}x${desc.height}`,
      size: [desc.width, desc.height],
      format: desc.format,
      mipLevelCount: desc.mipLevelCount ?? 1,
      sampleCount: desc.sampleCount ?? 1,
      usage: desc.usage ?? DEFAULT_USAGE,
    });
  }

  release(desc: GraphTextureDesc, texture: GPUTexture): void {
    const key = keyOf(desc);
    const free = this.#free.get(key);
    if (free) free.push({ texture, frame: this.#frame });
    else this.#free.set(key, [{ texture, frame: this.#frame }]);
  }

  /** 每帧画完调一次：销毁闲了太久的。 */
  endFrame(): void {
    this.#frame++;
    for (const [key, free] of this.#free) {
      const kept = free.filter(({ texture, frame }) => {
        if (this.#frame - frame <= KEEP_FRAMES) return true;
        texture.destroy();
        this.count--;
        return false;
      });
      if (kept.length === 0) this.#free.delete(key);
      else if (kept.length !== free.length) this.#free.set(key, kept);
    }
  }

  destroy(): void {
    for (const free of this.#free.values()) for (const { texture } of free) texture.destroy();
    this.#free.clear();
    this.count = 0;
  }
}
