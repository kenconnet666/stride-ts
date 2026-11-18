/**
 * 贴图（对应 Stride 的 Texture）：已经是 GPU 格式的各级 mip 数据。和 Mesh、Material 一样只是数据，GPU 资源由
 * 渲染系统第一次用到时创建。资源管线产出的一般是 KTX2（Basis），加载时由 ktx2Decoder 按设备支持的格式转码；
 * 要下载小的贴图是 SVG 或 PNG/JPEG，由 browserImageDecoder 解成 RGBA8，只有第 0 级，mip 在 GPU 上生成。
 */
import type { StrideNative, TextureTarget } from '@stride-ts/native';
import type { Branded } from '../data/prop';
import { ResourceTable } from '../engine/ResourceTable';
import type { GraphicsDevice } from '../graphics/GraphicsDevice';

export type TextureId = Branded<number, 'TextureId'>;

const textures = new ResourceTable<Texture>();

export interface TextureData {
  readonly format: GPUTextureFormat;
  readonly width: number;
  readonly height: number;
  /** 各级 mip，最大的在前；压缩格式按 4x4 的块紧密排列，未压缩的按像素。 */
  readonly levels: readonly Uint8Array[];
  /** 只给了第 0 级，其余各级上传后在 GPU 上生成（格式必须能渲染，比如 rgba8unorm-srgb）。 */
  readonly generateMipmaps?: boolean;
  /** 渲染目标（Stride 的 RenderTexture）：没有 levels，内容由合成器画进去。 */
  readonly renderTarget?: boolean;
}

export class Texture {
  /** 从 1 开始；组件的列（比如 Background.image）存它。 */
  readonly id: TextureId;
  readonly name: string;
  readonly data: TextureData;

  constructor(name: string, data: TextureData) {
    if (data.levels.length === 0 && !data.renderTarget) throw new RangeError(`texture '${name}' has no mip levels`);
    this.name = name;
    this.data = data;
    this.id = textures.add(this) as TextureId;
  }

  /** 渲染目标贴图（Stride 的 RenderTexture）：一级，可以画进去，也可以采样。 */
  static renderTarget(name: string, width: number, height: number, format: GPUTextureFormat): Texture {
    return new Texture(name, { format, width, height, levels: [], renderTarget: true });
  }

  /** @internal 组件里存的 id 对应的贴图。 */
  static byId(id: number): Texture | undefined {
    return textures.get(id);
  }

  /** 压缩格式（4x4 块）的块字节数；未压缩的是 0。 */
  get blockBytes(): number {
    return blockBytesOf(this.data.format);
  }
}

/** 把一个 KTX2 文件变成 TextureData。 */
export type TextureDecoder = (bytes: Uint8Array) => Promise<TextureData>;

export interface ImageDecodeOptions {
  readonly encoding: 'svg' | 'png' | 'jpeg';
  /** 颜色贴图是 sRGB（rgba8unorm-srgb），法线这类数据贴图不是。 */
  readonly srgb: boolean;
  /** svg 栅格化的尺寸；不给时用 SVG 的 width、height。png、jpeg 忽略它。 */
  readonly size?: readonly [number, number];
}

/** 把 SVG、PNG、JPEG 文件解成 RGBA8 的 TextureData（只有第 0 级，generateMipmaps）。 */
export type ImageDecoder = (bytes: Uint8Array, options: ImageDecodeOptions) => Promise<TextureData>;

/**
 * 用浏览器解码：PNG、JPEG 用 createImageBitmap；SVG 用 Image 加 OffscreenCanvas 按目标尺寸栅格化（矢量按目标尺寸画，
 * 不是先按原尺寸画再缩放；Chrome 的 createImageBitmap 不接受 SVG）。像素按 sRGB、不预乘读出来。只能在主线程用。
 */
export function browserImageDecoder(): ImageDecoder {
  return async (bytes, { encoding, srgb, size }) => {
    const type = encoding === 'svg' ? 'image/svg+xml' : encoding === 'png' ? 'image/png' : 'image/jpeg';
    const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type });
    let source: HTMLImageElement | ImageBitmap, width: number, height: number;
    if (encoding === 'svg') {
      const image = new Image();
      const url = URL.createObjectURL(blob);
      try {
        image.src = url;
        await image.decode();
      } finally {
        URL.revokeObjectURL(url);
      }
      [width, height] = size ?? [image.naturalWidth, image.naturalHeight];
      source = image;
    } else {
      source = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      [width, height] = [source.width, source.height];
    }
    if (width === 0 || height === 0) throw new Error(`${encoding} image has no size (give the SVG width and height, or a size in the material)`);
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('OffscreenCanvas has no 2d context');
    context.drawImage(source, 0, 0, width, height);
    if (source instanceof ImageBitmap) source.close();
    const pixels = new Uint8Array(context.getImageData(0, 0, width, height, { colorSpace: 'srgb' }).data.buffer);
    return { format: srgb ? 'rgba8unorm-srgb' : 'rgba8unorm', width, height, levels: [pixels], generateMipmaps: true };
  };
}

/** 转码目标对应的 GPU 格式：[线性, sRGB]。 */
const TARGET_FORMATS: Readonly<Record<TextureTarget, readonly [GPUTextureFormat, GPUTextureFormat]>> = {
  bc7: ['bc7-rgba-unorm', 'bc7-rgba-unorm-srgb'],
  astc4x4: ['astc-4x4-unorm', 'astc-4x4-unorm-srgb'],
  etc2rgba8: ['etc2-rgba8unorm', 'etc2-rgba8unorm-srgb'],
  rgba8: ['rgba8unorm', 'rgba8unorm-srgb'],
};

/**
 * 用 stride-native 的 Basis 转码器解 KTX2：目标是设备支持的压缩格式（GraphicsDevice.textureTarget），
 * 各级 mip 在原生线程里并行转码。压缩格式要求尺寸是 4 的倍数，不是的贴图退回 RGBA8。
 */
export function ktx2Decoder(native: StrideNative, device: GraphicsDevice): TextureDecoder {
  return async (bytes) => {
    const info = native.ktx2Info(bytes);
    const target = info.width % 4 === 0 && info.height % 4 === 0 ? device.textureTarget : 'rgba8';
    const { width, height, levels } = await native.transcodeKtx2(bytes, target);
    return { format: TARGET_FORMATS[target][info.isSrgb ? 1 : 0], width, height, levels };
  };
}

function blockBytesOf(format: GPUTextureFormat): number {
  if (format.startsWith('bc7') || format.startsWith('astc-4x4') || format.startsWith('etc2-rgba8')) return 16;
  return 0;
}
