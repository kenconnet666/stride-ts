// ParticlesSample 的 NextSceneScript：画面两边的 <<、>> 按钮换到上一个、下一个场景（七个场景连成一圈）；同时登记调试命令
// `previous-scene`、`next-scene`（冒烟脚本用）。和 Stride 一样，点了以后下一帧的 update 里才换根场景。
import { Button, Grid, prop, StripDefinition, SyncScript, TextBlock, UIComponent, UIPage, type SceneReference, type SpriteFont } from '@stride-ts/engine';

export class NextSceneScript extends SyncScript.props({
  next: prop.asset('scene').optional(),
  previous: prop.asset('scene').optional(),
  font: prop.asset('font').optional(),
}) {
  #target: SceneReference | undefined;

  override start(): void {
    for (const [name, scene] of [['previous-scene', this.previous], ['next-scene', this.next]] as const) {
      if (!scene) continue;
      this.disposables.use(this.game.debug.command(name, `switch to ${scene.path} (the ${name === 'next-scene' ? '>>' : '<<'} button)`, () => {
        this.#target = scene;
        return scene.path;
      }));
    }
    const ui = this.entity.get(UIComponent);
    if (!ui || !this.font) return;
    const grid = new Grid();
    grid.children.add(this.#button('<<', 0, this.previous, this.font));
    grid.children.add(this.#button('>>', 2, this.next, this.font));
    grid.columnDefinitions.add(new StripDefinition('auto', 10));
    grid.columnDefinitions.add(new StripDefinition('star', 80));
    grid.columnDefinitions.add(new StripDefinition('auto', 10));
    ui.page = new UIPage('NextScene', grid);
  }

  override update(): void {
    if (!this.#target) return;
    const target = this.#target;
    this.#target = undefined;
    this.game.setRootScene(target).catch((error: unknown) => console.error(`[stride] failed to switch to ${target.path}`, error));
  }

  #button(text: string, column: number, scene: SceneReference | undefined, font: SpriteFont): Button {
    const label = new TextBlock();
    label.text = text;
    label.font = font;
    label.textSize = 72;
    label.textColor = [200 / 255, 200 / 255, 200 / 255, 1];
    label.verticalAlignment = 'center';
    const button = new Button();
    button.name = text;
    button.horizontalAlignment = 'center';
    button.content = label;
    // Stride 的 new Color(new Vector4(0.2, 0.2, 0.2, 0.2))：字节 51，按 sRGB 存
    button.backgroundColor = [51 / 255, 51 / 255, 51 / 255, 51 / 255];
    button.gridColumn = column;
    button.onClick(() => {
      this.#target = scene;
    });
    return button;
  }
}
