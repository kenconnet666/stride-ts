/**
 * 渲染特性共用的 GPU 资源：贴图和立方体贴图第一次用到时上传，天空盒的镜面立方体贴图第一次用到时生成，之后复用
 * （Mesh、Material 这些数据对象本身不碰 GPU），还有几个常用的默认资源和采样器。渲染系统销毁时一起释放。
 */
import { CUBEMAP_TEXEL_BYTES, type TextureSampler } from '../content/format';
import { MipmapGenerator } from './MipmapGenerator';
import type { Cubemap, Skybox } from '../rendering/lighting/Skybox';
import { CubemapPrefilter, prefilterSkybox } from '../rendering/lighting/CubemapPrefilter';
import type { Texture } from './Texture';

export class GpuResources {
  readonly device: GPUDevice;
  /** 1x1 的白图：没有贴图的材质绑它，着色器不用分支。 */
  readonly white: GPUTexture;
  /** 1x1 的黑色立方体贴图：没有天空盒时绑它。 */
  readonly blackCube: GPUTexture;
  /** 立方体贴图和查找表用（Stride 的 LinearSampler）。 */
  readonly linearClamp: GPUSampler;
  /** 线性过滤、三个方向都重复：周期的贴图（云的影子图）用。 */
  readonly linearRepeat: GPUSampler;
  /** 1x1 的深度图（值 1）：没有阴影、或者正在画阴影图集时，阴影的绑定位置绑它。 */
  readonly emptyShadowAtlas: GPUTexture;
  /** 阴影图的比较采样（Stride 的 LinearClampCompareLessEqualSampler）：参考深度 <= 图里的深度时是亮的，双线性插值比较结果。 */
  readonly shadowComparison: GPUSampler;
  readonly #textures = new Map<Texture, GPUTexture>();
  readonly #cubemaps = new Map<Cubemap, GPUTexture>();
  readonly #skyboxSpecular = new Map<Skybox, GPUTexture>();
  readonly #mipmaps: MipmapGenerator;
  /** 立方体贴图的镜面预滤波（天空盒、反射探针共用一份管线）。 */
  readonly prefilter: CubemapPrefilter;

  constructor(device: GPUDevice) {
    this.device = device;
    this.white = device.createTexture({ label: 'white', size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: this.white }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
    this.blackCube = device.createTexture({ label: 'black cube', size: [1, 1, 6], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: this.blackCube }, new Uint16Array(6 * 4), { bytesPerRow: 8, rowsPerImage: 1 }, [1, 1, 6]);
    this.linearClamp = device.createSampler({ label: 'linear clamp', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
    this.linearRepeat = device.createSampler({ label: 'linear repeat', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', addressModeW: 'repeat' });
    this.emptyShadowAtlas = device.createTexture({ label: 'empty shadow atlas', size: [1, 1], format: 'depth32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
    clearDepth(device, this.emptyShadowAtlas);
    this.shadowComparison = device.createSampler({ label: 'shadow comparison', magFilter: 'linear', minFilter: 'linear', compare: 'less-equal' });
    this.#mipmaps = new MipmapGenerator(device);
    this.prefilter = new CubemapPrefilter(device, this.linearClamp);
  }

  readonly #samplers = new Map<string, GPUSampler>();

  /**
   * 材质贴图的采样器（Stride 的 Filtering、AddressModeU/V），同样的设置共用一个。默认是重复寻址、三线性过滤、不开各向异性
   * （Filtering = Linear，和桌面 Stride 的截图一致）；各向异性同 Stride 的默认 16 倍。
   */
  sampler({ filter, addressU, addressV }: TextureSampler): GPUSampler {
    const key = `${filter ?? 'linear'}:${addressU ?? 'wrap'}:${addressV ?? 'wrap'}`;
    let sampler = this.#samplers.get(key);
    if (!sampler) {
      const mode = (address: TextureSampler['addressU']): GPUAddressMode => (address === 'clamp' ? 'clamp-to-edge' : address === 'mirror' ? 'mirror-repeat' : 'repeat');
      const linear = filter !== 'point';
      sampler = this.device.createSampler({
        label: `material ${key}`,
        addressModeU: mode(addressU),
        addressModeV: mode(addressV),
        magFilter: linear ? 'linear' : 'nearest',
        minFilter: linear ? 'linear' : 'nearest',
        mipmapFilter: linear ? 'linear' : 'nearest',
        ...(filter === 'anisotropic' ? { maxAnisotropy: 16 } : {}),
      });
      this.#samplers.set(key, sampler);
    }
    return sampler;
  }

  /**
   * 贴图的 GPU 纹理；渲染目标第一次用到时创建（内容是空的），其余的第一次用到时上传所有 mip，压缩格式按块算每行字节数，小于一个块的 mip 按整块拷贝。
   * 只给了第 0 级的（generateMipmaps）上传后在 GPU 上生成完整的 mip 链。
   */
  texture(texture: Texture): GPUTexture {
    let gpu = this.#textures.get(texture);
    if (!gpu && texture.data.renderTarget) {
      const { format, width, height } = texture.data;
      gpu = this.device.createTexture({ label: texture.name, size: [width, height], format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
      this.#textures.set(texture, gpu);
    }
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
      gpu = prefilterSkybox(this.prefilter, this.device, this.cubemap(skybox.radiance), skybox.specularSize, `${skybox.name} specular`);
      this.#skyboxSpecular.set(skybox, gpu);
    }
    return gpu;
  }

  destroy(): void {
    for (const texture of [...this.#textures.values(), ...this.#cubemaps.values(), ...this.#skyboxSpecular.values(), this.white, this.blackCube, this.emptyShadowAtlas]) texture.destroy();
    this.prefilter.destroy();
  }
}

/** 深度图写成 1（远）：深度格式不能用 writeTexture，用一次只清深度的绘制。 */
function clearDepth(device: GPUDevice, texture: GPUTexture): void {
  const encoder = device.createCommandEncoder({ label: texture.label });
  encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: texture.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } }).end();
  device.queue.submit([encoder.finish()]);
}
