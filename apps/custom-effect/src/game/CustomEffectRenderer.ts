// CustomEffect 的 CustomEffectRenderer（Stride 里是合成器的根渲染器 SceneRendererBase）：清成绿色，用 SpriteBatch 加自定义效果
// （WaveEffect，Stride 的 Effect.sdsl）画背景和标志，两张都铺满屏幕，水波纹从中间往外扩。混合是 NonPremultiplied。
// 和 Stride 不同：宽高比每帧按画布算（Stride 只在初始化时取一次，窗口改大小后波纹会变椭圆）。
import { SpriteBatch, type RenderContext, type SceneRenderer, type Texture } from '@stride-ts/engine';
import { createWaveEffect, setWaveAspectRatio, setWavePhase } from './WaveEffect';

// Stride 清屏用的 Color.Green（0, 128, 0），按线性值写进 sRGB 的后备缓冲
const CLEAR_COLOR: GPUColor = { r: 0, g: 128 / 255, b: 0, a: 1 };

export interface CustomEffectAssets {
  readonly background: Texture;
  readonly logo: Texture;
}

export class CustomEffectRenderer implements SceneRenderer {
  /** 合成器里的类型名（Stride 的 CustomEffect.CustomEffectRenderer）。 */
  static readonly typeName = 'CustomEffect.CustomEffectRenderer';

  readonly #assets: CustomEffectAssets;
  readonly #effect = createWaveEffect();
  #spriteBatch: SpriteBatch | undefined;

  constructor(assets: CustomEffectAssets) {
    this.#assets = assets;
  }

  draw({ game, time }: RenderContext): void {
    const device = game.graphicsDevice;
    const batch = (this.#spriteBatch ??= Object.assign(new SpriteBatch(device.device, game.renderSystem.resources), { virtualResolution: [1, 1] as const, effect: this.#effect }));
    const { width, height } = device.canvas;
    setWaveAspectRatio(this.#effect, width, height);
    setWavePhase(this.#effect, -3 * time.total);

    const encoder = device.device.createCommandEncoder({ label: 'CustomEffectRenderer' });
    const pass = encoder.beginRenderPass({
      label: 'CustomEffectRenderer',
      colorAttachments: [{ view: device.currentBackBufferView(), clearValue: CLEAR_COLOR, loadOp: 'clear', storeOp: 'store' }],
    });
    batch.begin(pass, width, height, device.backBufferViewFormat);
    // 背景：从贴图中间裁出和渲染目标同样宽高比的一块（同 Stride）
    const background = this.#assets.background.data;
    const ratio = Math.min(background.width / width, background.height / height);
    const [sw, sh] = [width * ratio, height * ratio];
    batch.draw(this.#assets.background, [0, 0, 1, 1], { source: [(background.width - sw) / 2, (background.height - sh) / 2, sw, sh] });
    batch.draw(this.#assets.logo, [0, 0, 1, 1]);
    batch.end();
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    this.#spriteBatch?.destroy();
  }
}
