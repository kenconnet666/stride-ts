// CSharpBeginner 的 TutorialUI：主场景的教程菜单。左上角的按钮开关菜单；菜单里的按钮照占位按钮的样子复制出 15 个（占位的去掉），
// 点一个就把对应的教程场景作为子场景加载进来（换掉上一个），标题换成教程名，相机在 2 秒里从现在的位置插值到教程场景里 Camera
// 实体的位置。`stride call tutorial '"Mouse input"'`（按钮上的字或场景名）也能换，冒烟用。
import {
  Button, prop, Quaternion, StackPanel, SyncScript, TextBlock, Transform, UIComponent, Vector3,
  type Entity, type SceneInstance,
} from '@stride-ts/engine';

/** 按钮上的字 → 教程场景（Scenes/Basics 下的名字），顺序同 Stride。 */
export const TUTORIAL_SCENES: readonly (readonly [string, string])[] = [
  ['Getting the entity', 'Getting the entity'],
  ['Child entities', 'Child entities'],
  ['Transform position', 'TransformPosition'],
  ['Properties', 'Properties'],
  ['Getting a component', 'Getting a component'],
  ['Adding a component', 'Adding a component'],
  ['Delta time', 'DeltaTime'],
  ['Cloning entities', 'Cloning entities'],
  ['Removing entities', 'Removing entities'],
  ['Keyboard input', 'Keyboard input'],
  ['Mouse input', 'Mouse input'],
  ['Virtual buttons', 'Virtual buttons'],
  ['Linear Interpolation', 'Linear Interpolation'],
  ['Loading content from code', 'Loading content'],
  ['Instantiating prefabs', 'Instantiating prefabs'],
];

const CAMERA_LERP_TIME = 2;
const WHITE = [1, 1, 1, 1] as const;

interface CameraPose {
  readonly position: { x: number; y: number; z: number };
  readonly rotation: { x: number; y: number; z: number; w: number };
}

export class TutorialUI extends SyncScript.props({
  camera: prop.entity().optional(),
}, { requires: [() => UIComponent] }) {
  #tutorialScene: SceneInstance | undefined;
  #pending: Promise<unknown> = Promise.resolve();
  #buttons!: StackPanel;
  #title!: TextBlock;
  #lerpTimer = 0;
  #start: CameraPose | undefined;
  #target: CameraPose | undefined;

  override start(): void {
    const root = this.entity.require(UIComponent).page?.rootElement;
    if (!root) throw new Error('TutorialUI needs the UI page on its entity');
    root.find(Button, 'BtnTutorialMenu')!.onClick(() => {
      this.#buttons.visibility = this.#buttons.isVisible ? 'hidden' : 'visible';
    });
    this.#title = root.find(TextBlock, 'tutorialTitleTxt')!;
    this.#title.text = '';
    this.#buttons = root.find(StackPanel, 'TutorialButtonsStackPanel')!;
    const placeholder = this.#buttons.children.at(0) as Button;
    const placeholderText = placeholder.visualChildren[0] as TextBlock;
    placeholder.visibility = 'hidden';
    for (const [label, scene] of TUTORIAL_SCENES) {
      const button = Object.assign(new Button(), {
        content: Object.assign(new TextBlock(), {
          font: placeholderText.font, textSize: placeholderText.textSize, height: placeholder.content!.height, text: label,
          textColor: WHITE, horizontalAlignment: 'left' as const, verticalAlignment: 'center' as const,
        }),
        height: placeholder.height,
        notPressedImage: placeholder.notPressedImage, pressedImage: placeholder.pressedImage, mouseOverImage: placeholder.mouseOverImage,
      });
      button.onClick(() => void this.#load(label, scene));
      this.#buttons.children.add(button);
    }
    this.#buttons.children.remove(placeholder);
    this.disposables.use(this.game.debug.command('tutorial', 'load a tutorial. args: its button text or scene name', (args) => {
      const name = args as unknown;
      const found = TUTORIAL_SCENES.find(([label, scene]) => label === name || scene === name);
      if (!found) throw new Error(`no tutorial ${JSON.stringify(args)}`);
      return this.#load(...found);
    }));
  }

  override update(): void {
    const camera = this.#camera;
    if (!this.#start || !this.#target || !camera || this.#lerpTimer >= CAMERA_LERP_TIME) return;
    this.#lerpTimer += this.game.updateTime.elapsed;
    // 和 Stride 不同：Stride 不封顶，最后一帧会冲过头一点（冲多少看那一帧多长）；这里到 1 为止，相机正好停在教程的 Camera 上
    const t = Math.min(1, this.#lerpTimer / CAMERA_LERP_TIME);
    const transform = camera.require(Transform);
    const { position, rotation } = this.#start;
    transform.position = new Vector3(position.x, position.y, position.z).lerp(this.#target.position, t);
    transform.rotation = new Quaternion(rotation.x, rotation.y, rotation.z, rotation.w).lerp(this.#target.rotation, t);
  }

  override cancel(): void {
    if (this.#tutorialScene) this.game.unloadScene(this.#tutorialScene);
    this.#tutorialScene = undefined;
  }

  get #camera(): Entity | undefined {
    return this.camera === undefined ? undefined : this.game.entities.entity(this.camera);
  }

  /** 换教程：卸载上一个子场景，加载新的，相机从现在的位置插值到它的 Camera 实体。 */
  #load(label: string, scene: string): Promise<string> {
    const change = this.#pending.catch(() => undefined).then(async () => {
      if (this.#tutorialScene) this.game.unloadScene(this.#tutorialScene);
      this.#tutorialScene = undefined;
      this.#title.text = label;
      this.#buttons.visibility = 'hidden';
      const camera = this.#camera?.require(Transform);
      this.#start = camera ? { position: { ...camera.position }, rotation: { ...camera.rotation } } : undefined;
      this.#tutorialScene = await this.game.loadScene(`CSharpBeginner/Scenes/Basics/${scene}`);
      const target = [...this.#tutorialScene.entities.values()].find((entity) => entity.name === 'Camera')?.require(Transform);
      this.#target = target ? { position: { ...target.position }, rotation: { ...target.rotation } } : undefined;
      this.#lerpTimer = 0;
      return scene;
    });
    this.#pending = change;
    return change;
  }
}
