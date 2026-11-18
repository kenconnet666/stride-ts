// Platformer2D 的 PlayerController：A、D（或左右方向键）左右走，W（或上）在地面上起跳；转身是把角色绕 Y 转 180°
// （Stride 的 CharacterComponent.Orientation），精灵跟着实体翻过来。精灵表的帧按状态切：待机 0-3、跑 4-19、跳 21-27（跳只放一遍）。
import { Character, prop, Quaternion, Sprite, SyncScript, Transform, Vector3, type Entity, type GameTime } from '@stride-ts/engine';

/** 每 1/5 秒换一帧。 */
const ANIMATION_INTERVAL = 1 / 5;
const IDLE_FRAME_END = 4;
const RUN_FRAME_END = 16;
const JUMP_FRAME_END = 21;
const JUMP_FRAME_COUNT = 6;
/** 每秒几个单位（乘在 MoveVector 上，Speed 设成 1）。 */
const MOVE_SPEED = 5;

const FACING_RIGHT = new Quaternion();
const FACING_LEFT = new Quaternion().setAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI);

export class PlayerController extends SyncScript.props({
  characterComponent: prop.entity(),
  sprite: prop.entity(),
}) {
  #animationTimer = 0;
  #idleFrame = 0;
  #runFrame = 0;
  #jumpFrame = 0;
  #isFacingRight = true;

  override update(time: GameTime): void {
    this.#animate(this.#handleInput(), time.elapsed);
  }

  /** 读键盘，设角色的移动和起跳；返回有没有在走。 */
  #handleInput(): boolean {
    const input = this.game.input;
    const characterEntity = this.game.entities.entity(this.characterComponent);
    const character = characterEntity.require(Character);
    let isMoving = false;
    let moveX = 0;
    if (input.isKeyDown('A') || input.isKeyDown('Left')) {
      isMoving = true;
      if (this.#isFacingRight) this.#turn(characterEntity, false);
      moveX = -MOVE_SPEED;
    }
    if (input.isKeyDown('D') || input.isKeyDown('Right')) {
      isMoving = true;
      if (!this.#isFacingRight) this.#turn(characterEntity, true);
      moveX = MOVE_SPEED;
    }
    if ((input.isKeyPressed('W') || input.isKeyPressed('Up')) && character.grounded) character.jump = true;
    // MoveVector 在角色的朝向里：世界方向转到角色本地（同 Stride 的 Vector3.Transform(move, Invert(Orientation))）
    const local = new Vector3(moveX, 0, 0).rotate((this.#isFacingRight ? FACING_RIGHT : FACING_LEFT).clone().invert());
    character.speed = 1;
    character.moveX = local.x;
    character.moveY = local.z;
    return isMoving;
  }

  #turn(characterEntity: Entity, right: boolean): void {
    this.#isFacingRight = right;
    const world = characterEntity.require(Transform).world;
    this.game.simulation!.body(characterEntity).teleport({ x: world[12]!, y: world[13]!, z: world[14]! }, right ? FACING_RIGHT : FACING_LEFT);
  }

  #animate(isMoving: boolean, elapsed: number): void {
    this.#animationTimer += elapsed;
    const grounded = this.game.entities.entity(this.characterComponent).require(Character).grounded;
    if (grounded && !isMoving) this.#playIdle();
    if (grounded && isMoving) this.#playRun();
    if (!grounded) this.#playJump();
  }

  #nextFrame(): boolean {
    if (this.#animationTimer < ANIMATION_INTERVAL) return false;
    this.#animationTimer -= ANIMATION_INTERVAL;
    return true;
  }

  #setFrame(frame: number): void {
    this.game.entities.entity(this.sprite).require(Sprite).frame = frame;
  }

  #playIdle(): void {
    if (this.#nextFrame()) {
      this.#setFrame(this.#idleFrame);
      this.#idleFrame = (this.#idleFrame + 1) % IDLE_FRAME_END;
    }
    this.#runFrame = this.#jumpFrame = 0;
  }

  #playRun(): void {
    if (this.#nextFrame()) {
      this.#setFrame(IDLE_FRAME_END + this.#runFrame);
      this.#runFrame = (this.#runFrame + 1) % RUN_FRAME_END;
    }
    this.#idleFrame = this.#jumpFrame = 0;
  }

  /** 离开地面时放跳的帧，放到最后一帧停住，落地后从头来。 */
  #playJump(): void {
    if (this.#nextFrame()) {
      this.#setFrame(JUMP_FRAME_END + this.#jumpFrame);
      if (this.#jumpFrame < JUMP_FRAME_COUNT) this.#jumpFrame++;
    }
    this.#idleFrame = this.#runFrame = 0;
  }
}
