// ParticlesSample 的 GameProfiler：Ctrl+Shift+P 开关性能显示（Stride 的 GameProfiler）。
// 和 Stride 不同（简化）：只在画面左上角印帧率（调试文字）；CPU、GPU 的分项用调试 CLI 的 `stride perf` 看。
import { prop, SyncScript, type GameTime } from '@stride-ts/engine';

export class GameProfiler extends SyncScript.props({
  /** Stride 的 Enabled（脚本自己的 enabled 是开关脚本的，换个名字，场景里的值照样读进来）。 */
  profiling: prop.bool().default(false).renamedFrom('enabled'),
  refreshTime: prop.number().default(500),
}) {
  #frames = 0;
  #elapsed = 0;
  #text = '';

  override update(time: GameTime): void {
    const input = this.game.input;
    if (input.isKeyDown('LeftShift') && input.isKeyDown('LeftCtrl') && input.isKeyReleased('P')) this.profiling = !this.profiling;
    if (!this.profiling) return;
    this.#frames++;
    this.#elapsed += time.elapsed * 1000;
    if (this.#elapsed >= this.refreshTime) {
      this.#text = `FPS: ${((this.#frames * 1000) / this.#elapsed).toFixed(1)}  frame: ${(this.#elapsed / this.#frames).toFixed(2)} ms`;
      this.#frames = 0;
      this.#elapsed = 0;
    }
    this.game.debugText.print(this.#text, [10, 10]);
  }
}
