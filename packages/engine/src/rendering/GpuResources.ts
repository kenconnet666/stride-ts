/**
 * 渲染特性共用的 GPU 资源：贴图和立方体贴图第一次用到时上传，天空盒的镜面立方体贴图第一次用到时生成，之后复用
 * （Mesh、Material 这些数据对象本身不碰 GPU），还有几个常用的默认资源和采样器。渲染系统销毁时一起释放。
 */
import { CUBEMAP_TEXEL_BYTES } from '../content/format';
import { MipmapGenerator } from './MipmapGenerator';
import type { Cubemap, Skybox } from './Skybox';
import { prefilterSkybox } from './SkyboxPrefilter';
import type { Texture } from './Texture';

export class GpuResources {
  readonly device: GPUDevice;
  /** 1x1 的白图：没有贴图的材质绑它，着色器不用分支。 */
  readonly white: GPUTexture;
  /** 1x1 的黑色立方体贴图：没有天空盒时绑它。 */
  readonly blackCube: GPUTexture;
  /** Stride 贴图采样的默认值：重复、线性过滤（ComputeTextureBase 的 Filtering、AddressModeU/V）；各向异性让斜看的地面不糊。 */
  readonly linearRepeat: GPUSampler;
  /** 立方体贴图和查找表用（Stride 的 LinearSampler）。 */
  readonly linearClamp: GPUSampler;
  /** 1x1 的深度图（值 1）：没有阴影、或者正在画阴影图集时，阴影的绑定位置绑它。 */
  readonly emptyShadowAtlas: GPUTexture;
  /** 阴影图的比较采样（Stride 的 LinearClampCompareLessEqualSampler）：参考深度 <= 图里的深度时是亮的，双线性插值比较结果。 */
  readonly shadowComparison: GPUSampler;
  readonly #textures = new Map<Texture, GPUTexture>();
  readonly #cubemaps = new Map<Cubemap, GPUTexture>();
  readonly #skyboxSpecular = new Map<Skybox, GPUTexture>();
  readonly #mipmaps: MipmapGenerator;

  constructor(device: GPUDevice) {
    this.device = device;
    this.white = device.createTexture({ label: 'white', size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: this.white }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
    this.blackCube = device.createTexture({ label: 'black cube', size: [1, 1, 6], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: this.blackCube }, new Uint16Array(6 * 4), { bytesPerRow: 8, rowsPerImage: 1 }, [1, 1, 6]);
    this.linearRepeat = device.createSampler({
      label: 'linear repeat',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      maxAnisotropy: 16,
    });
    this.linearClamp = device.createSampler({ label: 'linear clamp', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
    this.emptyShadowAtlas = device.createTexture({ label: 'empty shadow atlas', size: [1, 1], format: 'depth32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
    clearDepth(device, this.emptyShadowAtlas);
    this.shadowComparison = device.createSampler({ label: 'shadow comparison', magFilter: 'linear', minFilter: 'linear', compare: 'less-equal' });
    this.#mipmaps = new MipmapGenerator(device);
  }

  /**
   * 贴图的 GPU 纹理；第一次用到时上传所有 mip，压缩格式按块算每行字节数，小于一个块的 mip 按整块拷贝。
   * 只给了第 0 级的（generateMipmaps）上传后在 GPU 上生成完整的 mip 链。
   */
  texture(texture: Texture): GPUTexture {
    let gpu = this.#textures.get(texture);
    if (!gpu) {
      const { format, width, height, levels, generateMipmaps } = texture.data;
      const mipLevelCount = generateMipmaps ? Math.floor(Math.log2(Math.max(width, height))) + 1 : levels.length;
      const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | (generateMipmaps ? GPUTextureUsage.RENDER_ATTACHMENT : 0);
      const target = this.device.createTexture({ label: texture.name, size: [width, height], format, mipLevelCount, usage });
      const block = texture.blockBytes;
      levels.forEach((data, mipLevel) => {
        const w = Math.max(1, width >> mipLevel), h = Math.max(1, height >> mipLevel);
        const layout = block ? { bytesPerRow: Math.ceil(w / 4) * block, rowsPerImage: Math.ceil(h / 4) } : { bytesPerRow: w * 4 };
        const size = block ? [Math.ceil(w / 4) * 4, Math.ceil(h / 4) * 4] : [w, h];
        this.device.queue.writeTexture({ texture: target, mipLevel }, data, layout, size);
      });
      if (generateMipmaps) this.#mipmaps.generate(target);
      this.#textures.set(texture, (gpu = target));
    }
    return gpu;
  }

  /** 立方体贴图的 GPU 纹理（6 层的 2D 数组，用 'cube' 视图采样）；第一次用到时上传所有 mip。 */
  cubemap(cubemap: Cubemap): GPUTexture {
    let gpu = this.#cubemaps.get(cubemap);
    if (!gpu) {
      const { size, format, levels } = cubemap.data;
      const target = this.device.createTexture({ label: cubemap.name, size: [size, size, 6], format, mipLevelCount: levels.length, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      levels.forEach((data, mipLevel) => {
        const edge = Math.max(1, size >> mipLevel);
        this.device.queue.writeTexture({ texture: target, mipLevel }, data, { bytesPerRow: edge * CUBEMAP_TEXEL_BYTES[format], rowsPerImage: edge }, [edge, edge, 6]);
      });
      this.#cubemaps.set(cubemap, (gpu = target));
    }
    return gpu;
  }

  /** 天空盒的镜面立方体贴图；第一次用到时从 radiance 预滤波生成（SkyboxPrefilter.ts）。 */
  skyboxSpecular(skybox: Skybox): GPUTexture {
    let gpu = this.#skyboxSpecular.get(skybox);
    if (!gpu) {
      gpu = prefilterSkybox(this.device, this.cubemap(skybox.radiance), skybox.specularSize, this.linearClamp, `${skybox.name} specular`);
      this.#skyboxSpecular.set(skybox, gpu);
    }
    return gpu;
  }

  destroy(): void {
    for (const texture of [...this.#textures.values(), ...this.#cubemaps.values(), ...this.#skyboxSpecular.values(), this.white, this.blackCube, this.emptyShadowAtlas]) texture.destroy();
  }
}

/** 深度图写成 1（远）：深度格式不能用 writeTexture，用一次只清深度的绘制。 */
function clearDepth(device: GPUDevice, texture: GPUTexture): void {
  const encoder = device.createCommandEncoder({ label: texture.label });
  encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: texture.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } }).end();
  device.queue.submit([encoder.finish()]);
}
