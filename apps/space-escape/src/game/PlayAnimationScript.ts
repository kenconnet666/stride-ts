// SpaceEscape 的 PlayAnimationScript（文件名叫 PlayIdleAnimationScript.cs）：启动时播一段动画（障碍物 Obstacle2 的 Idle）。
import { AnimationComponent, prop, StartupScript } from '@stride-ts/engine';

export class PlayAnimationScript extends StartupScript.props({
  animationName: prop.string().default(''),
}) {
  override start(): void {
    this.entity.get(AnimationComponent)?.play(this.animationName);
  }
}
