// CSharpBeginner 的 KeyboardInputDemo：按住 1 转蓝茶壶，按 F 转一下黄茶壶，松开空格转一下绿茶壶。
import { prop, SyncScript, type EntityId } from '@stride-ts/engine';
import { rotateY } from './rotate';

export class KeyboardInputDemo extends SyncScript.props({
  blueTeapot: prop.entity().optional(),
  yellowTeapot: prop.entity().optional(),
  greenTeapot: prop.entity().optional(),
}) {
  override update(): void {
    const input = this.game.input;
    const teapot = (id: EntityId | undefined) => this.game.entities.entity(id!);
    this.game.debugText.print('Hold the 1 key down to rotate the blue teapot', [340, 500]);
    if (input.isKeyDown('D1')) rotateY(teapot(this.blueTeapot), 0.3 * this.game.updateTime.elapsed);
    this.game.debugText.print('Press F to rotate the yellow teapot (and to pay respects)', [340, 520]);
    if (input.isKeyPressed('F')) rotateY(teapot(this.yellowTeapot), -0.4);
    this.game.debugText.print('Press and release the Space bar to rotate the green teapot', [340, 540]);
    if (input.isKeyReleased('Space')) rotateY(teapot(this.greenTeapot), 0.6);
  }
}
