/**
 * 泛光（Stride 的 Bloom，默认设置）：亮部图（可选先按 distortion 压扁，做变形镜头的效果）一级级缩小到 1 / 2^downScale，
 * 高斯模糊，再用 Expanded 采样放大、按 Stride 的 BlendStates.Additive 加回画面（AdditiveLayers，在色调映射里）。叠加的颜色是
 * Color4(amount)，Stride 的 ImageScaler 把它当 sRGB 颜色换到线性空间（rgb 换，alpha 不换），Additive 又乘了一次源的 alpha，
 * 所以实际的权重是 srgbToLinear(amount) · amount（默认 0.3 时是 0.022，不是 0.09），照 Stride。
 * 模糊半径按缩小后的画面算：lerp(1, 长边 · 0.25 / 2^downScale, radius / 100)，取整，至少 1。
 * 残影（Afterimage，Stride 默认关）还没做。
 */
import type { AdditiveLayer } from './AdditiveLayers';
import { srgbToLinear } from '../../data/vectors';
import type { Image, ImageEffectContext } from './ImageEffect';

export class Bloom {
  enabled = true;
  /** 0..100：模糊半径占可能的最大半径的百分比。 */
  radius = 10;
  amount = 0.3;
  sigmaRatio = 3.5;
  /** 缩小几次（每次减半）。 */
  downScale = 2;
  /** 横、竖方向的压缩比（至少 1），大于 1 时模糊在那个方向上拉长。 */
  distortion: [number, number] = [1, 1];

  /** bright 是亮部图，返回要加回画面的一层。 */
  draw({ frame, arena, scaler, blur }: ImageEffectContext, bright: Image): AdditiveLayer {
    let input = bright;
    const [dx, dy] = [Math.max(1, this.distortion[0]), Math.max(1, this.distortion[1])];
    if (dx > 1 || dy > 1) {
      const anamorphic = frame.acquire(Math.max(1, Math.trunc(input.width / dx)), Math.max(1, Math.trunc(input.height / dy)), input.format, 'Bloom anamorphic');
      scaler.draw(frame, arena, input, anamorphic, { expanded: true });
      input = anamorphic;
    }
    const blurred = frame.acquire(Math.max(1, input.width >> this.downScale), Math.max(1, input.height >> this.downScale), input.format, 'Bloom blur');
    if (this.downScale > 0) scaler.multiScale(frame, arena, input, blurred);
    const maxRadius = 0.25 * Math.max(input.width, input.height) * 2 ** -this.downScale;
    const radius = Math.max(1, Math.trunc(1 + (maxRadius - 1) * Math.max(0, this.radius / 100)));
    blur.draw(frame, arena, this.downScale > 0 ? blurred : input, blurred, radius, Math.max(1, this.sigmaRatio));
    const linear = srgbToLinear(this.amount);
    return { texture: blurred, expanded: true, color: [linear, linear, linear, this.amount] };
  }
}
