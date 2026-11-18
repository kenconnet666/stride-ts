/**
 * 贴图（对应 Stride 的 Texture）：已经是 GPU 格式的各级 mip 数据。和 Mesh、Material 一样只是数据，GPU 资源由
 * 渲染特性第一次用到时创建。资源管线产出的是 KTX2（Basis），加载时由 ktx2Decoder 按设备支持的格式转码。
 */
import type { StrideNative, TextureTarget } from '@stride-ts/native';
import type { GraphicsDevice } from '../graphics/GraphicsDevice';

export interface TextureData {
  readonly format: GPUTextureFormat;
  readonly width: number;
  readonly height: number;
  /** 各级 mip，最大的在前；压缩格式按 4x4 的块紧密排列，未压缩的按像素。 */
  readonly levels: readonly Uint8Array[];
}

export class Texture {
  readonly name: string;
  readonly data: TextureData;

  constructor(name: string, data: TextureData) {
    if (data.levels.length === 0) throw new RangeError(`texture '${name}' has no mip levels`);
    this.name = name;
    this.data = data;
  }

  /** 压缩格式（4x4 块）的块字节数；未压缩的是 0。 */
  get blockBytes(): number {
    return blockBytesOf(this.data.format);
  }
}

/** 把一个 KTX2 文件变成 TextureData。 */
export type TextureDecoder = (bytes: Uint8Array) => Promise<TextureData>;

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
