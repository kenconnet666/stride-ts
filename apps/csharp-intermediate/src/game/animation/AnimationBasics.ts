// CSharpIntermediate 的 AnimationBasics：一开始播 Idle；I 重播 Idle，R 用 0.5 秒淡入 Run，P 用 0.1 秒淡入 Punch 播一次、
// 播完回到 Idle；S 暂停或继续所有在播的动画，Q/E 调速度。
import { AnimationComponent, prop, SyncScript, type PlayingAnimation } from '@stride-ts/engine';

export class AnimationBasics extends SyncScript.props({
  animationSpeed: prop.f32().default(1),
}) {
  #animation!: AnimationComponent;
  #latest!: PlayingAnimation;

  override start(): void {
    this.#animation = this.entity.require(AnimationComponent);
    this.#latest = this.#animation.play('Idle');
  }

  override update(): void {
    const input = this.game.input, animation = this.#animation;
    let y = 600;
    const print = (text: string) => this.game.debugText.print(text, [800, (y += 20)]);

    print('S to pause or resume animations');
    if (input.isKeyPressed('S')) for (const playing of animation.playingAnimations) playing.enabled = !playing.enabled;

    // C# 的 {AnimationSpeed:0.0}：一位小数
    print(`Q and E for speed ${this.animationSpeed.toFixed(1)}`);
    if (input.isKeyPressed('E')) this.#setSpeed(this.animationSpeed + 0.1);
    if (input.isKeyPressed('Q')) this.#setSpeed(this.animationSpeed - 0.1);

    print('I to start playing Idle');
    if (input.isKeyPressed('I')) this.#play(animation.play('Idle'));

    print('R to crossfade to Run');
    if (input.isKeyPressed('R')) this.#play(animation.crossfade('Run', 0.5));

    print('P to crossfade to Punch and play it once');
    if (input.isKeyPressed('P') && !animation.isPlaying('Punch')) {
      this.#play(animation.crossfade('Punch', 0.1));
      this.#latest.repeatMode = 'playOnce';
    }
    // 出拳播完了：回到 Idle
    if (this.#latest.name === 'Punch' && !animation.isPlaying('Punch')) {
      this.#play(animation.play('Idle'));
      this.#latest.repeatMode = 'loopInfinite';
    }
  }

  #play(playing: PlayingAnimation): void {
    this.#latest = playing;
    playing.timeFactor = this.animationSpeed;
  }

  #setSpeed(speed: number): void {
    this.animationSpeed = Math.fround(speed);
    this.#latest.timeFactor = this.animationSpeed;
  }
}
