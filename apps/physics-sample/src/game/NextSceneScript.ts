// PhysicsSample 的 NextSceneScript：在三个场景之间换（Raycasting → Constraints → VolumeTrigger → Raycasting），画面两边的
// <<、>> 按钮。和 Stride 一样，按钮只记下要去的场景，下一帧的 update 里才换根场景。
import { Button, Grid, prop, StripDefinition, SyncScript, TextBlock, UIComponent, UIPage, type SceneReference, type SpriteFont } from '@stride-ts/engine';

// Stride 的 new Color(200, 200, 200, 255)、new Color(new Vector4(0.2f, 0.2f, 0.2f, 0.2f))
const TEXT_COLOR = [200 / 255, 200 / 255, 200 / 255, 1] as const;
export const BUTTON_BACKGROUND = [0.2, 0.2, 0.2, 0.2] as const;

export class NextSceneScript extends SyncScript.props({
  nextScene: prop.asset('scene').optional(),
  previousScene: prop.asset('scene').optional(),
  font: prop.asset('font').optional(),
}) {
  #target: SceneReference | undefined;

  override start(): void {
    const ui = this.entity.get(UIComponent);
    if (!ui || !this.font) return;
    const root = new Grid();
    root.columnDefinitions.add(new StripDefinition('auto', 10));
    root.columnDefinitions.add(new StripDefinition('star', 80));
    root.columnDefinitions.add(new StripDefinition('auto', 10));
    root.children.add(this.#button('<<', 0, this.previousScene, this.font));
    root.children.add(this.#button('>>', 2, this.nextScene, this.font));
    ui.page = new UIPage('NextScene', root);
  }

  override update(): void {
    if (!this.#target) return;
    const target = this.#target;
    this.#target = undefined;
    this.game.setRootScene(target).catch((error: unknown) => console.error(`[stride] failed to switch to ${target.path}`, error));
  }

  #button(text: string, column: number, scene: SceneReference | undefined, font: SpriteFont): Button {
    const button = Object.assign(new Button(), {
      name: text,
      horizontalAlignment: 'center' as const,
      content: Object.assign(new TextBlock(), { text, font, textSize: 72, textColor: TEXT_COLOR, verticalAlignment: 'center' as const }),
      backgroundColor: BUTTON_BACKGROUND,
      gridColumn: column,
    });
    button.onClick(() => (this.#target = scene));
    return button;
  }
}
