/** The WebGPU device and the canvas it presents to (Stride's GraphicsDevice and GraphicsPresenter). */
export class GraphicsDevice {
  readonly device: GPUDevice;
  readonly canvas: HTMLCanvasElement;
  readonly backBufferFormat: GPUTextureFormat;
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
    // Opaque: a premultiplied canvas lets the page show through wherever alpha is below 1.
    context.configure({ device, format: this.backBufferFormat, alphaMode: 'opaque' });
    void device.lost.then((info) => {
      if (info.reason !== 'destroyed') console.error(`WebGPU device lost: ${info.message}`);
    });
  }

  get queue(): GPUQueue {
    return this.device.queue;
  }

  /** Sizes the back buffer to the canvas's displayed size in device pixels; call before drawing a frame. */
  resizeToDisplaySize(): void {
    const ratio = window.devicePixelRatio;
    const width = Math.max(1, Math.round(this.canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * ratio));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
  }

  /** The texture to draw this frame into; a new one every frame. */
  currentBackBuffer(): GPUTexture {
    return this.context.getCurrentTexture();
  }

  destroy(): void {
    this.context.unconfigure();
    this.device.destroy();
  }
}
