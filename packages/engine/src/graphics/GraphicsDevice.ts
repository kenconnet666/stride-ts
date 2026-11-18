import type { TextureTarget } from '@stride-ts/native';
import { GpuProfiler } from './GpuProfiler';

/** 贴图压缩格式的特性和对应的 Basis 转码目标，按优先级：桌面 GPU 有 BC，移动 GPU 有 ASTC 或 ETC2。 */
const COMPRESSION: readonly (readonly [GPUFeatureName, TextureTarget])[] = [
  ['texture-compression-bc', 'bc7'],
  ['texture-compression-astc', 'astc4x4'],
  ['texture-compression-etc2', 'etc2rgba8'],
];

/** WebGPU 设备和它呈现到的画布（对应 Stride 的 GraphicsDevice 和 GraphicsPresenter）。 */
export class GraphicsDevice {
  readonly device: GPUDevice;
  readonly canvas: HTMLCanvasElement;
  readonly backBufferFormat: GPUTextureFormat;
  /**
   * 渲染时用的后备缓冲视图格式：画布格式的 sRGB 版本。着色器输出线性颜色，写入时由硬件转成 sRGB，
   * 和 Stride 默认的线性颜色空间一致（画布本身不能配置成 sRGB 格式，只能在视图上用）。
   */
  readonly backBufferViewFormat: GPUTextureFormat;
  /** KTX2 贴图转码成什么：设备支持的第一个压缩格式，都不支持时是 RGBA8。 */
  readonly textureTarget: TextureTarget;
  /** 设备能关掉深度裁剪（'depth-clip-control'）：阴影投射者用它把视锥前面的物体压到近平面上（Stride 的 DepthClipEnable = false）。 */
  readonly depthClipControl: boolean;
  /** 渲染通道的 GPU 耗时（开发时测量，默认关；设备不支持 timestamp-query 时打开也不记录）。 */
  readonly profiler: GpuProfiler;
  private readonly context: GPUCanvasContext;

  static async create(canvas: HTMLCanvasElement): Promise<GraphicsDevice> {
    if (!navigator.gpu) throw new Error('WebGPU is not available in this browser');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter is available');
    const compression = COMPRESSION.filter(([feature]) => adapter.features.has(feature));
    const depthClipControl = adapter.features.has('depth-clip-control');
    const timestampQuery = adapter.features.has('timestamp-query');
    const optional = [...(depthClipControl ? ['depth-clip-control' as const] : []), ...(timestampQuery ? ['timestamp-query' as const] : [])];
    const device = await adapter.requestDevice({ requiredFeatures: [...compression.map(([feature]) => feature), ...optional] });
    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('The canvas has no WebGPU context');
    return new GraphicsDevice(device, canvas, context, compression[0]?.[1] ?? 'rgba8', depthClipControl, timestampQuery);
  }

  private constructor(device: GPUDevice, canvas: HTMLCanvasElement, context: GPUCanvasContext, textureTarget: TextureTarget, depthClipControl: boolean, timestampQuery: boolean) {
    this.device = device;
    this.textureTarget = textureTarget;
    this.depthClipControl = depthClipControl;
    this.profiler = new GpuProfiler(device, timestampQuery);
    this.canvas = canvas;
    this.context = context;
    this.backBufferFormat = navigator.gpu.getPreferredCanvasFormat();
    this.backBufferViewFormat = `${this.backBufferFormat}-srgb` as GPUTextureFormat;
    // 用 opaque：预乘 alpha 的画布在 alpha 小于 1 的地方会透出页面背景。
    context.configure({ device, format: this.backBufferFormat, alphaMode: 'opaque', viewFormats: [this.backBufferViewFormat] });
    void device.lost.then((info) => {
      if (info.reason !== 'destroyed') console.error(`WebGPU device lost: ${info.message}`);
    });
  }

  get queue(): GPUQueue {
    return this.device.queue;
  }

  /**
   * 把后备缓冲调成画布显示尺寸对应的设备像素；每帧绘制前调用。超过 GPU 纹理尺寸上限时截断，
   * 否则在超大或高缩放比的屏幕上 getCurrentTexture 会失败。
   */
  resizeToDisplaySize(): void {
    const ratio = window.devicePixelRatio;
    const limit = this.device.limits.maxTextureDimension2D;
    const width = Math.min(limit, Math.max(1, Math.round(this.canvas.clientWidth * ratio)));
    const height = Math.min(limit, Math.max(1, Math.round(this.canvas.clientHeight * ratio)));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
  }

  /** 这一帧要画进去的纹理；每帧都是新的。 */
  currentBackBuffer(): GPUTexture {
    return this.context.getCurrentTexture();
  }

  /** 这一帧后备缓冲的 sRGB 视图（backBufferViewFormat），渲染目标用它。 */
  currentBackBufferView(): GPUTextureView {
    return this.context.getCurrentTexture().createView({ format: this.backBufferViewFormat });
  }

  destroy(): void {
    this.profiler.destroy();
    this.context.unconfigure();
    this.device.destroy();
  }
}
