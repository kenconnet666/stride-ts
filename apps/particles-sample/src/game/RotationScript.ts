// ParticlesSample 的 RotationScript：用代码建一个动画剪辑——实体的旋转绕自己的 X 轴一秒转一圈（0、90、180、270、360 度五个
// 关键帧，线性插值）——放在 AnimationComponent 上循环播放，速度乘 TimeFactor，从 0.6 秒处开始。
import { AnimationClip, AnimationComponent, prop, propertyCurve, StartupScript, Transform } from '@stride-ts/engine';

const ANIMATION = 'MyCustomAnimation';
/** 绕 X 转 angle（弧度）的四元数。 */
const rotationX = (angle: number) => [Math.sin(angle / 2), 0, 0, Math.cos(angle / 2)] as const;

export class RotationScript extends StartupScript.props({
  timeFactor: prop.number().default(1),
}) {
  override start(): void {
    const clip = AnimationClip.fromCurves(ANIMATION, 1, [
      propertyCurve(Transform, 'rotation', [
        [0, rotationX(0)], [0.25, rotationX(Math.PI / 2)], [0.5, rotationX(Math.PI)], [0.75, rotationX(-Math.PI / 2)], [1, rotationX(2 * Math.PI)],
      ]),
    ]);
    // Stride 的 Entity.GetOrCreate<AnimationComponent>()
    if (!this.entity.has(AnimationComponent)) this.entity.add(AnimationComponent);
    const animation = this.entity.require(AnimationComponent);
    animation.animations.clear();
    animation.animations.set(ANIMATION, clip);
    const playing = animation.play(ANIMATION);
    playing.repeatMode = 'loopInfinite';
    playing.timeFactor = this.timeFactor;
    playing.currentTime = 0.6;
  }
}
