// CSharpBeginner 的 VirtualButtonsDemo：虚拟按钮 Forward 绑上 W、上箭头、鼠标左键和手柄的左扳机，按着就转蓝茶壶。
import { formatFloat, prop, SyncScript, VirtualButton, VirtualButtonBinding, VirtualButtonConfig } from '@stride-ts/engine';
import { rotateY } from './rotate';

export class VirtualButtonsDemo extends SyncScript.props({
  blueTeapot: prop.entity().optional(),
}) {
  override start(): void {
    this.game.input.virtualButtonConfigSet.push(new VirtualButtonConfig(
      new VirtualButtonBinding('Forward', VirtualButton.keyboard('W')),
      new VirtualButtonBinding('Forward', VirtualButton.keyboard('Up')),
      new VirtualButtonBinding('Forward', VirtualButton.mouse('left')),
      new VirtualButtonBinding('Forward', VirtualButton.gamePad('leftTrigger')),
    ));
  }

  override update(): void {
    const forward = this.game.input.getVirtualButton(0, 'Forward');
    if (forward > 0 && this.blueTeapot !== undefined) rotateY(this.game.entities.entity(this.blueTeapot), 0.6 * forward * this.game.updateTime.elapsed);
    this.game.debugText.print('Hold down W, the Up arrow the left mouse button or the Left trigger on a gamepad', [600, 200]);
    this.game.debugText.print(`Virtual button 'Forward': ${formatFloat(forward)}`, [600, 220]);
  }
}
