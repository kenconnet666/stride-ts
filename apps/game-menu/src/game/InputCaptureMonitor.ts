// GameMenu 的 InputCaptureMonitor：在左上角印出脚本看到的输入。UI 占着的输入（点按钮、在输入框里打字）脚本看不到；F9 关掉
// 屏蔽对比。
import { SyncScript, type InputManager } from '@stride-ts/engine';

export class InputCaptureMonitor extends SyncScript {
  #leftClicks = 0;
  #wheelTotal = 0;

  override update(): void {
    const input = this.game.input;
    if (input.isKeyPressed('F9')) input.maskCapturedInput = !input.maskCapturedInput;
    if (input.isMouseButtonPressed('left')) this.#leftClicks++;
    this.#wheelTotal += input.mouseWheelDelta;

    const [x, y] = [10, 10];
    const text = this.game.debugText;
    text.print(`What scripts see (F9: masking ${input.maskCapturedInput ? 'on' : 'off'})`, [x, y]);
    text.print(`Keys down: ${input.downKeys.join(', ')}`, [x, y + 20]);
    text.print(`Left clicks: ${this.#leftClicks}   Wheel: ${Number(this.#wheelTotal.toFixed(2))}`, [x, y + 40]);
    text.print(`Mouse held by: ${ownerName(input, 'mouse')}   Keyboard held by: ${ownerName(input, 'keyboard')}`, [x, y + 60]);
  }
}

function ownerName(input: InputManager, device: 'mouse' | 'keyboard'): string {
  return input.captureOwner(device)?.constructor.name ?? 'nobody';
}
