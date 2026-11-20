// 规则和计分：开局数关卡里的金币；吃到一个加一分、放音效，吃完了开门；被撞到记一次、放音效；金币吃完以后走进终点就赢了。
// 左上角显示分数，屏幕中间短暂地显示提示。
import { Canvas, prop, SyncScript, TextBlock, UIComponent, UIPage, type GameTime, type Sound, type SoundInstance } from '@stride-ts/engine';
import { Coin } from './Coin';
import { CoinCollectedEventKey, DoorOpenEventKey, GoalReachedEventKey, PlayerHitEventKey } from './events';

const WHITE = [1, 1, 1, 1] as const;
const GOLD = [1, 0.85, 0.3, 1] as const;
/** 提示显示多少秒。 */
const MESSAGE_TIME = 2.5;

export class GameRules extends SyncScript.props({
  font: prop.asset('font'),
  coinSound: prop.asset('sound').optional(),
  hitSound: prop.asset('sound').optional(),
  doorSound: prop.asset('sound').optional(),
}, { requires: [() => UIComponent] }) {
  readonly #coins = this.receive(CoinCollectedEventKey);
  readonly #hits = this.receive(PlayerHitEventKey);
  readonly #goal = this.receive(GoalReachedEventKey);
  #total = 0;
  #collected = 0;
  #hitCount = 0;
  #won = false;
  #messageTime = 0;
  #score!: TextBlock;
  #message!: TextBlock;
  readonly #sounds = new Map<Sound, SoundInstance>();

  /** 关卡里的金币数、吃到的、被撞的次数、赢了没有（冒烟测试和调试命令读）。 */
  get state(): { readonly total: number; readonly collected: number; readonly hits: number; readonly won: boolean } {
    return { total: this.#total, collected: this.#collected, hits: this.#hitCount, won: this.#won };
  }

  override start(): void {
    const entities = this.game.entities;
    this.#total = entities.ids().filter((id) => entities.entity(id).get(Coin) !== undefined).length;
    this.#score = text(this.font, 44, WHITE, [0.03, 0.04], [0, 0]);
    this.#message = text(this.font, 72, GOLD, [0.5, 0.4], [0.5, 0.5]);
    const root = new Canvas();
    root.children.add(this.#score);
    root.children.add(this.#message);
    this.entity.require(UIComponent).page = new UIPage('Hud', root);
    this.disposables.defer(() => {
      for (const instance of this.#sounds.values()) instance.dispose();
    });
    this.disposables.use(this.game.debug.command('rules', 'coins in the level, collected, hits, won', () => this.state));
    this.#showScore();
  }

  override update(time: GameTime): void {
    const coins = this.#coins.drain().length;
    if (coins > 0 && !this.#won) {
      this.#collected = Math.min(this.#total, this.#collected + coins);
      this.#play(this.coinSound);
      if (this.#collected === this.#total) {
        DoorOpenEventKey.broadcast();
        this.#play(this.doorSound);
        this.#show('The door is open!');
      }
      this.#showScore();
    }
    if (this.#hits.drain().length > 0 && !this.#won) {
      this.#hitCount++;
      this.#play(this.hitSound);
      this.#show('Ouch!');
      this.#showScore();
    }
    if (this.#goal.drain().length > 0 && !this.#won && this.#collected === this.#total) {
      this.#won = true;
      this.#show('You win!', Infinity);
    }
    if (this.#messageTime > 0 && (this.#messageTime -= time.elapsed) <= 0) this.#message.text = '';
  }

  #showScore(): void {
    this.#score.text = `Coins ${this.#collected}/${this.#total}   Hits ${this.#hitCount}`;
  }

  #show(message: string, seconds = MESSAGE_TIME): void {
    this.#message.text = message;
    this.#messageTime = seconds;
  }

  /** 从头放一遍这个声音（同一个声音只用一个实例，连着吃金币时重新开始）。 */
  #play(sound: Sound | undefined): void {
    if (!sound) return;
    let instance = this.#sounds.get(sound);
    if (!instance) this.#sounds.set(sound, (instance = sound.createInstance()));
    instance.stop();
    instance.play();
  }
}

function text(font: TextBlock['font'], size: number, color: readonly [number, number, number, number], position: readonly [number, number], pin: readonly [number, number]): TextBlock {
  return Object.assign(new TextBlock(), { font, textSize: size, textColor: color, canvasRelativePosition: position, canvasPinOrigin: pin, text: '' });
}
