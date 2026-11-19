// JumpyJet 的 JumpyJetRenderer（Stride 里是合成器根相机下面的 SceneRendererBase）：先用 SpriteBatch 画四层视差背景，再画场景的
// 不透明和透明阶段（飞机、管子这些精灵）。这里借游戏的前向渲染器画场景，背景放在它的 background 钩子里（清屏之后、不透明阶段之前，
// 同一个画面）。虚拟分辨率是第一次画时的后备缓冲大小（同 Stride 在 InitializeCore 里取 BackBuffer 的大小）。
// 合成器里的类型名是 JumpyJet.JumpyJetRenderer，属性 ParallaxBackgrounds（精灵表）随游戏设置导入，JumpyJetGame 用 create 建它。
import { SpriteBatch, type RenderContext, type SceneRenderer, type SpriteSheet, type Vec2 } from '@stride-ts/engine';
import { BackgroundSection } from './BackgroundSection';
import { GAME_SPEED } from './GameGlobals';

export class JumpyJetRenderer implements SceneRenderer {
  /** 合成器里的类型名。 */
  static readonly typeName = 'JumpyJet.JumpyJetRenderer';

  static create(props: Readonly<Record<string, unknown>>): JumpyJetRenderer {
    const backgrounds = props['parallaxBackgrounds'] as SpriteSheet | undefined;
    if (!backgrounds) throw new Error('JumpyJetRenderer needs ParallaxBackgrounds');
    return new JumpyJetRenderer(backgrounds);
  }

  readonly parallaxBackgrounds: SpriteSheet;
  #sections: BackgroundSection[] | undefined;
  #batch: SpriteBatch | undefined;

  constructor(parallaxBackgrounds: SpriteSheet) {
    this.parallaxBackgrounds = parallaxBackgrounds;
  }

  /** 四层背景，从远到近（第一次画之前是空的）。 */
  get sections(): readonly BackgroundSection[] {
    return this.#sections ?? [];
  }

  /** 背景在滚（游戏结束时停住）。 */
  get isScrolling(): boolean {
    return this.#sections?.[0]?.isUpdating ?? true;
  }

  startScrolling(): void {
    for (const section of this.#sections ?? []) section.isUpdating = true;
  }

  stopScrolling(): void {
    for (const section of this.#sections ?? []) section.isUpdating = false;
  }

  draw(context: RenderContext): void {
    const { game, time } = context;
    const forward = game.graphicsCompositor;
    forward.background = (pass, target) => {
      const resolution: Vec2 = [target.width, target.height];
      this.#sections ??= this.#createSections(resolution);
      const batch = (this.#batch ??= Object.assign(new SpriteBatch(game.graphicsDevice.device, game.renderSystem.resources), { virtualResolution: resolution }));
      batch.begin(pass, target.width, target.height, target.format, target.depthFormat);
      for (const section of this.#sections) section.draw(time.elapsed, batch);
      batch.end();
    };
    forward.draw(context);
  }

  /** 四层：远的三层按不同速度滚，最近的一层（地面）贴着屏幕底边。 */
  #createSections(resolution: Vec2): BackgroundSection[] {
    const sprites = this.parallaxBackgrounds.sprites;
    const ground = sprites[3]!;
    return [
      new BackgroundSection(sprites[0]!, resolution, (100 * GAME_SPEED) / 4),
      new BackgroundSection(sprites[1]!, resolution, (100 * GAME_SPEED) / 3),
      new BackgroundSection(sprites[2]!, resolution, (100 * GAME_SPEED) / 1.5),
      new BackgroundSection(ground, resolution, 100 * GAME_SPEED, [0, (resolution[1] - ground.region[3]) / 2]),
    ];
  }

  destroy(): void {
    this.#batch?.destroy();
  }
}
