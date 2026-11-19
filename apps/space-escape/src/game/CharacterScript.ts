// SpaceEscape 的 CharacterScript：角色在三条道上跑。左右键（或横着划）换道，下键（或往下划）滑铲；换道时按动画的进度从这条道
// 移到那条道，滑铲的动画放完回到跑；撞上障碍物、掉进洞里时 GameScript 调 onDied。包围盒跟着状态换（滑铲时矮 0.7）。
import { AnimationComponent, AsyncScript, Gestures, prop, Sprite, Transform, type Bounds, type DragEvent, type PlayingAnimation } from '@stride-ts/engine';
import { modelBounds } from './background/Section';

type AgentState = 'run' | 'changeLaneLeft' | 'changeLaneRight' | 'slide' | 'die';
type InputState = 'none' | 'left' | 'right' | 'down';

const LEFT_LANE = 0;
const MIDDLE_LANE = 1;
const RIGHT_LANE = 2;
const LANE_LENGTH = 5;
/** 动画名（Stride 的 AgentAnimationKeys）。 */
const ANIMATIONS: Readonly<Record<Exclude<AgentState, 'changeLaneLeft' | 'changeLaneRight'> | 'dodgeLeft' | 'dodgeRight', string>> = {
  run: 'Active', dodgeLeft: 'DodgeLeft', dodgeRight: 'DodgeRight', slide: 'Slide', die: 'Crash',
};

/** 第几条道的 x。 */
const xOf = (lane: number) => (1 - lane) * LANE_LENGTH;

export class CharacterScript extends AsyncScript.props({
  characterShadow: prop.component(() => Sprite).optional(),
}) {
  currentLane = MIDDLE_LANE;
  #state: AgentState = 'run';
  #laneHeight = 0;
  #shouldProcessInput = false;
  #started = false;
  #playing: PlayingAnimation | undefined;
  #startX = 0;
  #targetX = 0;
  #normalBox!: Bounds;
  #slideBox!: Bounds;
  #activeBox!: Bounds;

  get isDead(): boolean {
    return this.#state === 'die';
  }

  override async execute(): Promise<void> {
    this.#normalBox = modelBounds(this.entity);
    const { min, max } = this.#normalBox;
    this.#slideBox = { min, max: [max[0], max[1] - 0.7, max[2]] };
    // 拖动手势控制角色（一指，拖过画布的 2% 算开始）
    const drag = this.game.input.gestures.add(Gestures.drag('free', { minimumDragDistance: 0.02 }));
    this.disposables.defer(() => void this.game.input.gestures.remove(drag));
    this.#started = true;
    this.#laneHeight = this.entity.require(Transform).position.y;
    this.reset();
    while (this.attached) {
      await this.nextFrame();
      const input = this.#inputFromGesture();
      this.#processInput(input === 'none' ? this.#inputFromKeyboard() : input);
      this.#updateState();
    }
  }

  activate(): void {
    this.#shouldProcessInput = true;
  }

  reset(): void {
    if (!this.#started) return;
    this.#shouldProcessInput = false;
    this.#setState('run');
    this.currentLane = MIDDLE_LANE;
    this.#setShadowTransparency(1);
    const position = this.entity.require(Transform).position;
    position.y = this.#laneHeight;
    position.x = xOf(this.currentLane);
  }

  onDied(floorHeight: number): void {
    this.#setState('die');
    this.entity.require(Transform).position.y = floorHeight;
    this.#setShadowTransparency(0);
  }

  /** 角色现在的包围盒（世界坐标：包围盒加上角色的位置）。 */
  currentBoundingBox(): Bounds {
    const { x, y, z } = this.entity.require(Transform).position;
    const { min, max } = this.#activeBox;
    return { min: [min[0] + x, min[1] + y, min[2] + z], max: [max[0] + x, max[1] + y, max[2] + z] };
  }

  #setShadowTransparency(alpha: number): void {
    const shadow = this.characterShadow;
    if (shadow) shadow.color = { r: alpha, g: alpha, b: alpha, a: alpha };
  }

  #inputFromKeyboard(): InputState {
    const input = this.game.input;
    if (input.isKeyPressed('ArrowLeft')) return 'left';
    if (input.isKeyPressed('ArrowRight')) return 'right';
    if (input.isKeyPressed('ArrowDown')) return 'down';
    return 'none';
  }

  /** 拖动手势开始的那一帧按拖的方向给输入。 */
  #inputFromGesture(): InputState {
    for (const event of this.game.input.gestureEvents) {
      if (event.type === 'drag' && event.state === 'began') return this.#inputFromDrag(event);
    }
    return 'none';
  }

  /** 拖的方向（乘上屏幕的高宽比，y 朝上）离哪个轴近：横着的是左右，往下的是滑铲，往上的不算。 */
  #inputFromDrag({ totalTranslation: [dx, dy] }: DragEvent): InputState {
    const { width, height } = this.game.graphicsDevice.canvas;
    const x = dx, y = -dy * (height / width);
    const length = Math.hypot(x, y);
    const nx = x / length, ny = y / length;
    // 和横轴、竖轴的夹角（Stride 的 FindAngleBetweenVector），夹角小的那个轴赢
    const towardsHorizontal = Math.acos(Math.abs(nx)), towardsVertical = Math.acos(Math.abs(ny));
    if (towardsHorizontal <= towardsVertical) return nx >= 0 ? 'right' : 'left';
    return ny <= 0 ? 'down' : 'none';
  }

  #processInput(input: InputState): void {
    if (!this.#shouldProcessInput) return;
    const state = this.#state;
    if (input === 'left' && this.currentLane !== LEFT_LANE && (state === 'run' || state === 'slide')) this.#setState('changeLaneLeft');
    else if (input === 'right' && this.currentLane !== RIGHT_LANE && (state === 'run' || state === 'slide')) this.#setState('changeLaneRight');
    else if (input === 'down' && state === 'run') this.#setState('slide');
  }

  /** 进入一个状态：换包围盒，放对应的动画（Stride 的 OnEnter）。 */
  #setState(state: AgentState): void {
    this.#state = state;
    this.#activeBox = state === 'slide' ? this.#slideBox : this.#normalBox;
    if (state === 'changeLaneLeft' || state === 'changeLaneRight') {
      const left = state === 'changeLaneLeft';
      this.#startX = xOf(this.currentLane);
      this.currentLane += left ? -1 : 1;
      this.#targetX = xOf(this.currentLane);
      this.#play(left ? ANIMATIONS.dodgeLeft : ANIMATIONS.dodgeRight);
    } else {
      this.#play(ANIMATIONS[state]);
    }
  }

  #updateState(): void {
    const playing = this.#playing;
    if (!playing) return;
    const progress = playing.currentTime / playing.clip.duration;
    if (this.#state === 'changeLaneLeft' || this.#state === 'changeLaneRight') {
      // 按换道动画的进度插值 x，放完回到跑
      this.entity.require(Transform).position.x = this.#startX + (this.#targetX - this.#startX) * progress;
      if (progress >= 1) this.#setState('run');
    } else if (this.#state === 'slide' && progress >= 1) {
      this.#setState('run');
    }
  }

  #play(name: string): void {
    const animation = this.entity.get(AnimationComponent);
    if (!animation) return;
    animation.play(name);
    this.#playing = animation.playingAnimations[0];
  }
}
