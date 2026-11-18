// BepuSample 的 TimeControlComponent：小键盘 + - 调仿真的时间倍率，* 暂停、继续仿真，O、L 调重力。
import { prop, SyncScript } from '@stride-ts/engine';

export class TimeControlComponent extends SyncScript.props({
  /** Stride 可以有多个仿真；我们只有一个，这里只能是 0。 */
  simulationIndex: prop.int().default(0),
}) {
  override update(): void {
    const simulation = this.game.simulation;
    if (!simulation) return;
    const input = this.game.input;
    if (input.isKeyPressed('Add')) simulation.timeScale *= 1.1;
    if (input.isKeyPressed('Subtract')) simulation.timeScale /= 1.1;
    if (input.isKeyPressed('Multiply')) simulation.enabled = !simulation.enabled;
    const [x, y, z] = simulation.settings.gravity;
    if (input.isKeyPressed('O')) simulation.configure({ gravity: [x, y + 1, z] });
    if (input.isKeyPressed('L')) simulation.configure({ gravity: [x, y - 1, z] });
    const right = this.game.graphicsDevice.canvas.width - 500;
    this.game.debugText.print(`Physic Enabled : ${simulation.enabled} (Numpad *)`, [right, 225]);
    this.game.debugText.print(`Time scale : ${simulation.timeScale} (numpad + & -)`, [right, 250]);
    this.game.debugText.print(`Gravity : ${simulation.settings.gravity.join(', ')} (numpad o & l)`, [right, 275]);
  }
}
