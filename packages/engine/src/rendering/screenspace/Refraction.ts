/**
 * 屏幕空间的折射（透射材质：玻璃、水、冰、宝石；Material.transmission，glTF 的 KHR_materials_transmission 加 volume）：
 * 主画面不透明的画完（连天空、云、雾、次表面散射）、透明的画上去之前，把画面拷一份、出 mip；透明阶段里透射材质的像素沿折射
 * 光线找出射点，投到屏幕上取这份画面（粗糙的取模糊的级），着色器见 rendering/mesh/meshShader.ts 的 transmitted。参考 Filament
 * 的 screen-space refraction（薄的、实心球两种模型）和 Unity HDRP 的颜色金字塔。
 *
 * 同时拷一份深度（depthTexture）：水体（world/Water.ts）按它量水深、起岸边的泡沫。
 *
 * 只有主画面有（画进 HDR 缓冲时）；别的视图、没有这份画面时透射的光取环境（天空、反射探针）。透射材质后面的透明物体不在拷贝里，
 * 折射里看不见（同 HDRP）。反射图和这份画面共用视图的第 26 个绑定（不透明阶段是平面反射图，透明阶段是它），不多占一张贴图。
 */
import { MipmapGenerator } from '../../graphics/MipmapGenerator';
import type { RenderView } from '../RenderSystem';

const FORMAT: GPUTextureFormat = 'rgba16float';

export class Refraction {
  /** 用这份画面着色的视图（主画面）；这一帧不拷时 undefined。 */
  receiver: RenderView | undefined;
  /** 换了贴图就加一（MeshRenderFeature 据此重建绑定组）。 */
  generation = 0;

  readonly #device: GPUDevice;
  readonly #mipmaps: MipmapGenerator;
  #texture: GPUTexture | undefined;
  #depth: GPUTexture | undefined;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#mipmaps = new MipmapGenerator(device);
  }

  /**
   * 每帧开头（写视图的常量之前）：这一帧主画面要不要拷。wanted：画进 HDR 缓冲、画透明的、场景里有透射材质、设备放得下第 26 个
   * 绑定。
   */
  begin(main: RenderView | undefined, wanted: boolean): void {
    this.receiver = wanted ? main : undefined;
    if (this.receiver) this.#ensureTexture(this.receiver.width, this.receiver.height);
  }

  /** 拷贝的画面（透明阶段绑定、着色时采样）；begin 定了要拷时才有。 */
  get texture(): GPUTexture | undefined {
    return this.receiver ? this.#texture : undefined;
  }

  /** 同时拷的深度（主画面的深度格式）；copy 时给了深度才有。 */
  get depthTexture(): GPUTexture | undefined {
    return this.receiver ? this.#depth : undefined;
  }

  /** 最粗的 mip 级（着色器按粗糙度取级用）。 */
  get maxMip(): number {
    return (this.#texture?.mipLevelCount ?? 1) - 1;
  }

  /** 录进编码器：主画面（HDR，和拷贝一样大）拷进第 0 级，再出 mip；给了深度（要有 COPY_SRC）时也拷一份。 */
  copy(encoder: GPUCommandEncoder, source: GPUTexture, depth?: GPUTexture): void {
    const texture = this.#texture;
    if (!this.receiver || !texture) return;
    encoder.copyTextureToTexture({ texture: source }, { texture, mipLevel: 0 }, [texture.width, texture.height]);
    this.#mipmaps.generate(texture, encoder);
    if (!depth) return;
    if (!this.#depth || this.#depth.width !== depth.width || this.#depth.height !== depth.height || this.#depth.format !== depth.format) {
      this.#depth?.destroy();
      this.#depth = this.#device.createTexture({ label: 'Refraction scene depth', size: [depth.width, depth.height], format: depth.format, usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING });
    }
    encoder.copyTextureToTexture({ texture: depth }, { texture: this.#depth }, [depth.width, depth.height]);
  }

  destroy(): void {
    this.#texture?.destroy();
    this.#depth?.destroy();
  }

  #ensureTexture(width: number, height: number): void {
    if (this.#texture && this.#texture.width === width && this.#texture.height === height) return;
    this.#texture?.destroy();
    this.#texture = this.#device.createTexture({
      label: 'Refraction scene color', size: [width, height], format: FORMAT, mipLevelCount: Math.floor(Math.log2(Math.max(width, height))) + 1,
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.generation++;
  }
}
