// JumpyJet 的 PipesScript：开始时按屏幕宽度建够用的几组管子（PipePrefabUrl 预制体，挂在这个实体下面），游戏开始后一起往左移；
// 移出屏幕左边的那组接到前一组后面 GapBetweenPipe 处、高度随机。结束时停住，重新开始时回到起点。
import { prop, SyncScript, Transform, type Entity, type GameTime } from '@stride-ts/engine';
import { GameOverEventKey, GameResetEventKey, GameStartedEventKey, GAME_PIXEL_TO_UNIT_SCALE, GAME_SPEED } from './GameGlobals';

const GAP_BETWEEN_PIPE = 4;
const START_PIPE_POSITION = 4;
/** 一组管子的宽度（估得宽一点）。 */
const PIPE_OVERVALUED_WIDTH = 1;

export class PipesScript extends SyncScript.props({
  pipePrefabUrl: prop.asset('prefab').optional(),
}) {
  readonly #pipeSets: Entity[] = [];
  #isScrolling = false;
  #sceneWidth = 0;
  #gameOver = this.receive(GameOverEventKey);
  #gameReset = this.receive(GameResetEventKey);
  #gameStarted = this.receive(GameStartedEventKey);

  override start(): void {
    const prefab = this.pipePrefabUrl;
    if (!prefab) return;
    this.#sceneWidth = GAME_PIXEL_TO_UNIT_SCALE * this.game.graphicsDevice.canvas.width;
    const count = Math.ceil((this.#sceneWidth + 2 * PIPE_OVERVALUED_WIDTH) / GAP_BETWEEN_PIPE);
    for (let i = 0; i < count; i++) {
      const [pipeSet] = prefab.instantiate(this.game.entities);
      pipeSet!.require(Transform).parent = this.entity;
      this.#pipeSets.push(pipeSet!);
    }
    this.#reset();
  }

  override update(time: GameTime): void {
    if (this.#gameOver.tryConsume()) this.#isScrolling = false;
    if (this.#gameStarted.tryConsume()) this.#isScrolling = true;
    if (this.#gameReset.tryConsume()) this.#reset();
    if (!this.#isScrolling) return;
    const pipeSets = this.#pipeSets;
    for (let i = 0; i < pipeSets.length; i++) {
      const position = pipeSets[i]!.require(Transform).position;
      position.x -= time.elapsed * GAME_SPEED;
      // 移出屏幕左边：接到前一组后面
      if (position.x + PIPE_OVERVALUED_WIDTH / 2 < -this.#sceneWidth / 2) {
        const previous = pipeSets[(i - 1 + pipeSets.length) % pipeSets.length]!.require(Transform).position;
        position.x = previous.x + GAP_BETWEEN_PIPE;
        position.y = randomY();
      }
    }
  }

  override cancel(): void {
    for (const pipeSet of this.#pipeSets) if (this.game.entities.isAlive(pipeSet.id)) pipeSet.destroy();
  }

  #reset(): void {
    this.#pipeSets.forEach((pipeSet, i) => {
      const position = pipeSet.require(Transform).position;
      position.x = START_PIPE_POSITION + i * GAP_BETWEEN_PIPE;
      position.y = randomY();
      position.z = 0;
    });
  }
}

/** 管子的高度：50 到 224 像素（Stride 的 Random.Next(50, 225)）。 */
function randomY(): number {
  return GAME_PIXEL_TO_UNIT_SCALE * (50 + Math.floor(Math.random() * 175));
}
