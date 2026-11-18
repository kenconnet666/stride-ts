// AnimatedModel 的 UIScript：角色开始跑步；Stride 里还把 UI 页面的 Idle、Run 按钮绑到淡入淡出上。
// UI 系统（P2）做好之前，按钮先用调试命令代替：`stride call idle`、`stride call run`。
import { AnimationComponent, prop, StartupScript } from '@stride-ts/engine';

/** 按钮切换动画时的淡入淡出时间（秒）。 */
const CROSSFADE = 0.25;

export class UIScript extends StartupScript.props({
  knight: prop.entity(),
}) {
  override start(): void {
    const animation = this.game.entities.entity(this.knight).require(AnimationComponent);
    for (const name of ['Idle', 'Run']) {
      this.disposables.use(this.game.debug.command(name.toLowerCase(), `crossfade the knight to ${name} (the UI button in Stride)`, () => {
        animation.crossfade(name, CROSSFADE);
        return name;
      }));
    }
    animation.play('Run');
  }
}
