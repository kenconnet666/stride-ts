// CSharpIntermediate 的 TutorialUI：每个教程场景里都有的菜单（TutorialUI 预制体，共用同一个 UI 页面）。左上角的按钮开关菜单；
// "开始"和"完成"两列按钮照各自的占位按钮复制出 11 个，点一个就把根场景换成那个教程的场景。
// `stride call tutorial '"Raycasting"'`（按钮上的字，默认进"完成"的那个；`'["Raycasting", "start"]'` 进"开始"的）也能换，冒烟用。
import { Button, Canvas, prop, StackPanel, StartupScript, TextBlock, UIComponent } from '@stride-ts/engine';

/** 按钮上的字 → 教程场景（Scenes 下的 `<主题>/<Start 或 Completed>-<名字>`），顺序同 Stride。 */
export const TUTORIALS: readonly (readonly [label: string, topic: string, scene: string])[] = [
  ['UI interaction', '01_UI-basics', 'UI-basics'],
  ['Collision trigger', '02_CollisionTriggers', 'CollisionTriggers'],
  ['Raycasting', '03_Raycasting', 'Raycasting'],
  ['Project & Unproject', '04_ProjectUnproject', 'ProjectUnproject'],
  ['Async Scripts', '05_Async', 'AsyncScript'],
  ['Scene loading', '06_SceneLoading', 'SceneA'],
  ['Animation basics', '07_Animation-basics', 'Animations'],
  ['Audio', '08_Audio', 'Audio'],
  ['First person camera', '09_FirstPersonCamera', 'FirstPersonCamera'],
  ['Third person camera', '10_ThirdPersonCamera', 'ThirdPersonCamera'],
  ['Navigation', '11_Navigation', 'Navigation'],
];

const WHITE = [1, 1, 1, 1] as const;
type Stage = 'Start' | 'Completed';
const scenePath = (stage: Stage, topic: string, scene: string) => `CSharpIntermediate/Scenes/${topic}/${stage}-${scene}`;

export class TutorialUI extends StartupScript.props({
  showMenuOnSceneLoad: prop.bool().default(false),
}) {
  override start(): void {
    const root = this.entity.require(UIComponent).page?.rootElement;
    if (!root) throw new Error('TutorialUI needs the UI page on its entity');
    const menu = root.find(Canvas, 'TutorialMenu')!;
    const startButtons = root.find(StackPanel, 'ButtonsStart')!;
    const completedButtons = root.find(StackPanel, 'ButtonsCompleted')!;
    // 页面是各场景共用的同一个：只有占位按钮时是第一次，建按钮；之后的场景看到的是建好的
    if (startButtons.children.length === 1) {
      this.game.input.unlockMousePosition();
      root.find(Button, 'BtnTutorialMenu')!.onClick(() => {
        for (const element of [menu, startButtons, completedButtons]) element.visibility = element.isVisible ? 'hidden' : 'visible';
        if (menu.isVisible) this.game.input.unlockMousePosition();
      });
      this.#createButtons(startButtons, 'Start');
      this.#createButtons(completedButtons, 'Completed');
    } else {
      menu.visibility = 'hidden';
    }
    if (!this.showMenuOnSceneLoad) startButtons.visibility = completedButtons.visibility = 'hidden';

    this.disposables.use(this.game.debug.command('tutorial', 'load a tutorial. args: its button text, or [text, "start"] for the unfinished version', (args) => {
      const [name, stage] = (Array.isArray(args) ? args : [args]) as unknown[];
      const found = TUTORIALS.find(([label]) => label === name);
      if (!found) throw new Error(`no tutorial ${JSON.stringify(name)}`);
      return this.#load(scenePath(stage === 'start' ? 'Start' : 'Completed', found[1], found[2]));
    }));
  }

  /** 照占位按钮的样子给每个教程建一个按钮，占位的去掉。 */
  #createButtons(panel: StackPanel, stage: Stage): void {
    const placeholder = panel.children.at(0) as Button;
    const placeholderText = placeholder.visualChildren[0] as TextBlock;
    for (const [label, topic, scene] of TUTORIALS) {
      const button = Object.assign(new Button(), {
        content: Object.assign(new TextBlock(), {
          font: placeholderText.font, textSize: placeholderText.textSize, height: placeholder.content!.height, text: label,
          textColor: WHITE, horizontalAlignment: 'left' as const, verticalAlignment: 'center' as const,
        }),
        height: placeholder.height,
        notPressedImage: placeholder.notPressedImage, pressedImage: placeholder.pressedImage, mouseOverImage: placeholder.mouseOverImage,
      });
      button.onClick(() => void this.#load(scenePath(stage, topic, scene)));
      panel.children.add(button);
    }
    panel.children.remove(placeholder);
  }

  /** 把根场景换成教程的场景（Stride 的 SceneSystem.SceneInstance.RootScene = Content.Load<Scene>(…)）。 */
  async #load(scene: string): Promise<string> {
    await this.game.setRootScene(scene);
    return scene;
  }
}
