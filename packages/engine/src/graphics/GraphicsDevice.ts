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
  private readonly context: GPUCanvasContext;

  static async create(canvas: HTMLCanvasElement): Promise<GraphicsDevice> {
    if (!navigator.gpu) throw new Error('WebGPU is not available in this browser');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter is available');
    const device = await adapter.requestDevice();
    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('The canvas has no WebGPU context');
    return new GraphicsDevice(device, canvas, context);
  }

  private constructor(device: GPUDevice, canvas: HTMLCanvasElement, context: GPUCanvasContext) {
    this.device = device;
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
    this.context.unconfigure();
    this.device.destroy();
  }
}
