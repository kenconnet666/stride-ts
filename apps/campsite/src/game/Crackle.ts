// 篝火的噼啪声：隔一会儿放一下合成的音效（每次的间隔、音量、音高随机一点，听着不像循环）。
import { prop, SyncScript, type GameTime, type SoundInstance } from '@stride-ts/engine';

export class Crackle extends SyncScript.props({
  sound: prop.asset('sound').optional(),
  /** 两次之间平均隔多久。 */
  interval: prop.number().default(0.7).unit('s'),
  volume: prop.number().default(0.5),
}) {
  #instance: SoundInstance | undefined;
  #wait = 0;

  override start(): void {
    this.#instance = this.sound?.createInstance();
    if (this.#instance) this.disposables.defer(() => this.#instance!.dispose());
  }

  override update(time: GameTime): void {
    const instance = this.#instance;
    if (!instance || (this.#wait -= time.elapsed) > 0) return;
    this.#wait = this.interval * (0.4 + Math.random() * 1.2);
    instance.stop();
    instance.volume = this.volume * (0.6 + Math.random() * 0.4);
    instance.pitch = 0.8 + Math.random() * 0.5;
    instance.play();
  }
}
