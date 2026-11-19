// CSharpBeginner 的 MouseInputDemo：按住左键转蓝茶壶，点右键转一下黄茶壶，松开中键转一下绿茶壶，滚轮转粉茶壶；鼠标的位置打印在鼠标那里。
import { formatFloat, formatVector, prop, Quaternion, SyncScript, Transform, type EntityId } from '@stride-ts/engine';
import { rotateY } from './rotate';

const UP = { x: 0, y: 1, z: 0 };

export class MouseInputDemo extends SyncScript.props({
  blueTeapot: prop.entity().optional(),
  yellowTeapot: prop.entity().optional(),
  greenTeapot: prop.entity().optional(),
  pinkTeapot: prop.entity().optional(),
}) {
  #currentScrollIndex = 0;

  override update(): void {
    const input = this.game.input;
    const teapot = (id: EntityId | undefined) => this.game.entities.entity(id!);
    const print = (text: string, position: readonly [number, number]) => this.game.debugText.print(text, position);
    print('Hold the left mouse button down to rotate the blue teapot', [400, 600]);
    if (input.isMouseButtonDown('left')) rotateY(teapot(this.blueTeapot), 0.4 * this.game.updateTime.elapsed);
    print('Click the right mouse button to rotate the yellow teapot', [400, 620]);
    if (input.isMouseButtonPressed('right')) rotateY(teapot(this.yellowTeapot), -0.4);
    print('Press and release the scrollwheel to rotate the green teapot', [400, 640]);
    if (input.isMouseButtonReleased('middle')) rotateY(teapot(this.greenTeapot), 0.4);
    this.#currentScrollIndex = Math.fround(this.#currentScrollIndex + input.mouseWheelDelta);
    print(`Scroll the mouse wheel to rotate the pink teapot. Scroll index: ${formatFloat(this.#currentScrollIndex)}`, [400, 660]);
    teapot(this.pinkTeapot).require(Transform).rotation = new Quaternion().setAxisAngle(UP, 0.02 * this.#currentScrollIndex);
    // 鼠标的位置（CSS 像素）换成调试文字的位置；Stride 的 new Int2(mousePos) 截掉小数
    const [x, y] = this.game.debugText.fromCanvas(input.absoluteMousePosition);
    print(`Mouse position: ${formatVector({ x: Math.fround(x), y: Math.fround(y) })}`, [Math.trunc(x), Math.trunc(y)]);
  }
}
