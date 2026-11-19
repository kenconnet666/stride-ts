// JumpyJet 的 CharacterScript：飞机。开始前停在起点；开始后按重力往下掉，空格或点屏幕往上跳（高过 TopLimit 时跳得小），按速度换
// 精灵的帧（往下掉、往上飞）、转一点角度。管子、管子之间的触发器和飞机都是运动学的刚体，物理不给它们接触，所以飞机自己按碰撞体的
// 形状查重叠（simulation.overlap）：碰到层 0（管子、地面）就结束，进到层 6 的触发器就加一分（每个触发器进一次算一次）。
import { AsyncScript, Body, Collider, Matrix, Quaternion, Sprite, Transform, Vector3, type EntityId, type OverlapShape } from '@stride-ts/engine';
import { GameOverEventKey, GameResetEventKey, GameStartedEventKey, GAME_PIXEL_TO_UNIT_SCALE, PipePassedEventKey } from './GameGlobals';

const GRAVITY = -17;
const START_POSITION: [number, number, number] = [-1, 0, 0];
const START_VELOCITY = 7;
const TOP_LIMIT = (568 - 200) * GAME_PIXEL_TO_UNIT_SCALE;
const NORMAL_VELOCITY_Y = 6.5;
const VELOCITY_ABOVE_TOP_LIMIT = 2;
const FLYING_FRAME = 1;
const FALLING_FRAME = 0;
/** 管子和地面在层 0，管子之间的触发器在层 6（Stride 的 CollisionMask.Layer0、Layer6）。 */
const OBSTACLES = 1 << 0;
const PIPE_TRIGGERS = 1 << 6;
const Z = { x: 0, y: 0, z: 1 };

export class CharacterScript extends AsyncScript {
  #position: [number, number, number] = [...START_POSITION];
  #rotationZ = 0;
  #velocityY = START_VELOCITY;
  #isRunning = false;
  readonly #passedTriggers = new Set<EntityId>();

  override async execute(): Promise<void> {
    const reset = this.receive(GameResetEventKey), started = this.receive(GameStartedEventKey);
    this.#reset();
    this.addTask(() => this.#countPassedPipes());
    this.addTask(() => this.#detectGameOver());
    while (this.attached) {
      await this.nextFrame();
      if (reset.tryConsume()) this.#reset();
      if (started.tryConsume()) this.#isRunning = true;
      if (!this.#isRunning) continue;
      const elapsed = this.game.updateTime.elapsed;
      const input = this.game.input;
      if (input.isKeyPressed('Space') || input.pointerEvents.some((event) => event.eventType === 'pressed')) {
        this.#velocityY = this.#position[1] > TOP_LIMIT ? VELOCITY_ABOVE_TOP_LIMIT : NORMAL_VELOCITY_Y;
      }
      this.#velocityY += GRAVITY * elapsed;
      this.#position[1] += this.#velocityY * elapsed;
      this.#updateAnimation();
      this.#updateTransform();
    }
  }

  #reset(): void {
    this.#position[1] = 0;
    this.#rotationZ = 0;
    this.#updateTransform();
    this.#velocityY = START_VELOCITY;
    this.#isRunning = false;
    const sprite = this.entity.get(Sprite);
    if (sprite) sprite.frame = FALLING_FRAME;
  }

  async #countPassedPipes(): Promise<void> {
    while (this.attached) {
      await this.nextFrame();
      const touching = new Set(this.#overlapping(PIPE_TRIGGERS));
      for (const trigger of touching) {
        if (this.#passedTriggers.has(trigger)) continue;
        this.#passedTriggers.add(trigger);
        PipePassedEventKey.broadcast();
      }
      for (const trigger of this.#passedTriggers) if (!touching.has(trigger)) this.#passedTriggers.delete(trigger);
    }
  }

  async #detectGameOver(): Promise<void> {
    while (this.attached) {
      await this.nextFrame();
      if (this.#isRunning && this.#overlapping(OBSTACLES).length > 0) {
        this.#isRunning = false;
        GameOverEventKey.broadcast();
      }
    }
  }

  /** 碰撞体的各个形状按实体现在的位姿查重叠，去掉自己。 */
  #overlapping(mask: number): EntityId[] {
    const simulation = this.game.simulation;
    const collider = Collider.byId(this.entity.get(Body)?.collider ?? 0);
    if (!simulation || !collider) return [];
    const { translation, rotation: [qx, qy, qz, qw] } = Matrix.decompose(this.entity.require(Transform).world);
    const rotation = new Quaternion(qx, qy, qz, qw);
    const found: EntityId[] = [];
    for (const shape of collider.shapes) {
      if (shape.type !== 'box' && shape.type !== 'sphere' && shape.type !== 'capsule') continue;
      // 形状的世界位姿：本地位置按实体的旋转转过去，先转本地旋转再转实体的
      const offset = new Vector3(...(shape.position ?? [0, 0, 0])).rotate(rotation);
      const [lx, ly, lz, lw] = shape.rotation ?? [0, 0, 0, 1];
      const orientation = new Quaternion().copy(rotation).multiply({ x: lx, y: ly, z: lz, w: lw });
      const pose = {
        position: [translation[0] + offset.x, translation[1] + offset.y, translation[2] + offset.z] as [number, number, number],
        rotation: [orientation.x, orientation.y, orientation.z, orientation.w] as [number, number, number, number],
      };
      for (const entity of simulation.overlap(shape as OverlapShape, pose, { mask })) if (entity !== this.entity.id) found.push(entity);
    }
    return found;
  }

  #updateTransform(): void {
    const transform = this.entity.require(Transform);
    transform.position.x = this.#position[0];
    transform.position.y = this.#position[1];
    transform.position.z = this.#position[2];
    const rotation = new Quaternion().setAxisAngle(Z, this.#rotationZ);
    transform.rotation.x = rotation.x; transform.rotation.y = rotation.y; transform.rotation.z = rotation.z; transform.rotation.w = rotation.w;
  }

  /** 往下掉、往上飞换精灵的帧，按方向转一点，最多 18 度。 */
  #updateAnimation(): void {
    const falling = this.#velocityY < 0;
    const sign = falling ? -1 : 1;
    const sprite = this.entity.get(Sprite);
    if (sprite) sprite.frame = falling ? FALLING_FRAME : FLYING_FRAME;
    this.#rotationZ += sign * Math.PI * 0.01;
    if (sign * this.#rotationZ > Math.PI / 10) this.#rotationZ = (sign * Math.PI) / 10;
  }
}
