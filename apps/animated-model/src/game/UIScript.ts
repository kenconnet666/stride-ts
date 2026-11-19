// AnimatedModel 的 UIScript：角色开始跑步；UI 页面的 Idle、Run 按钮把动画淡入淡出到待机、跑步。
import { AnimationComponent, Button, prop, StartupScript, UIComponent } from '@stride-ts/engine';

/** 按钮切换动画时的淡入淡出时间（秒）。 */
const CROSSFADE = 0.25;

export class UIScript extends StartupScript.props({
  knight: prop.entity(),
}) {
  override start(): void {
    const animation = this.game.entities.entity(this.knight).require(AnimationComponent);
    const root = this.entity.require(UIComponent).page?.rootElement;
    if (!root) throw new Error('UIScript needs the UI page on its entity');
    for (const name of ['Idle', 'Run']) root.find(Button, `Button${name}`)!.onClick(() => animation.crossfade(name, CROSSFADE));
    animation.play('Run');
  }
}
