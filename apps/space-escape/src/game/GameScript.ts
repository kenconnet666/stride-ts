// SpaceEscape 的 GameScript：把角色、关卡、UI 串起来。按钮切换主菜单、游戏中、结束；每帧看角色撞没撞上障碍物、掉没掉进洞里，
// 是的话角色倒下、显示结束页面、关卡停住；跑过的距离显示在 UI 上。
import { prop, SyncScript, Transform } from '@stride-ts/engine';
import { BackgroundScript } from './background/BackgroundScript';
import { CharacterScript } from './CharacterScript';
import { UIScript } from './UIScript';

export class GameScript extends SyncScript.props({
  characterScript: prop.component(() => CharacterScript).optional(),
  backgroundScript: prop.component(() => BackgroundScript).optional(),
  uiScript: prop.component(() => UIScript).optional(),
}) {
  override start(): void {
    const { ui, background } = this.#parts();
    background.onDistanceUpdated = (distance) => ui.setDistance(Math.trunc(distance));
    ui.startButton.onClick(() => this.#startGame());
    ui.retryButton.onClick(() => this.#restartGame());
    ui.menuButton.onClick(() => this.#goToMenu());
    this.disposables.use(this.game.debug.command('start-game', 'start playing (the "Touch to Start" button)', () => this.#startGame()));
    this.#goToMenu();
  }

  override update(): void {
    const { character, background } = this.#parts();
    if (character.isDead) return;
    if (background.detectCollisions(character.currentBoundingBox())) {
      this.#killAgent(0);
      return;
    }
    const floorHeight = background.detectHoles(character.entity.require(Transform).position);
    if (floorHeight !== undefined) this.#killAgent(floorHeight);
  }

  override cancel(): void {
    const background = this.backgroundScript;
    if (background) background.onDistanceUpdated = undefined;
  }

  #parts(): { character: CharacterScript; background: BackgroundScript; ui: UIScript } {
    const { characterScript: character, backgroundScript: background, uiScript: ui } = this;
    if (!character || !background || !ui) throw new Error('SpaceEscape: GameScript needs CharacterScript, BackgroundScript and UIScript');
    return { character, background, ui };
  }

  #killAgent(floorHeight: number): void {
    const { character, background, ui } = this.#parts();
    character.onDied(floorHeight);
    ui.startGameOverMode();
    background.stopScrolling();
  }

  #resetGame(): void {
    const { character, background } = this.#parts();
    character.reset();
    background.reset();
  }

  #restartGame(): void {
    this.#resetGame();
    this.#startGame();
  }

  #startGame(): void {
    const { character, background, ui } = this.#parts();
    ui.startPlayMode();
    background.startScrolling();
    character.activate();
  }

  #goToMenu(): void {
    this.#parts().ui.startMainMenuMode();
    this.#resetGame();
  }
}
