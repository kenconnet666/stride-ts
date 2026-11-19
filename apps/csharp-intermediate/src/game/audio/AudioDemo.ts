// CSharpIntermediate 的 AudioDemo：U 从头放一次尤克里里（不做空间化的声音实例）；点鼠标右键放枪声——枪声挂在实体的
// AudioEmitterComponent 上，按实体相对听者（相机上的 AudioListenerComponent）的位置空间化，移动实体能听出方位。
import { AudioEmitterComponent, prop, SyncScript, type AudioEmitterSoundController, type SoundInstance } from '@stride-ts/engine';

export class AudioDemo extends SyncScript.props({
  ukuleleSound: prop.asset('sound').optional(),
}) {
  #ukulele: SoundInstance | undefined;
  #gun: AudioEmitterSoundController | undefined;

  override start(): void {
    this.#ukulele = this.ukuleleSound?.createInstance();
    this.#gun = this.entity.require(AudioEmitterComponent).controller('Gun');
  }

  override update(): void {
    this.game.debugText.print('U to play the Ukelele once', [200, 580]);
    if (this.game.input.isKeyPressed('U')) {
      this.#ukulele?.stop();
      this.#ukulele?.play();
    }
    this.game.debugText.print('Press right mouse button fire gun', [200, 640]);
    if (this.game.input.isMouseButtonPressed('right')) this.#gun?.play();
  }

  override cancel(): void {
    this.#ukulele?.dispose();
  }
}
