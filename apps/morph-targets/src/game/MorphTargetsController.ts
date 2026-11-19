// MorphTargets 的 MorphTargetsController：甜甜圈（有骨骼）、立方体和二十面球（只有形变）的形变权重滑条，甜甜圈的剪辑加时间轴，
// 在 glTF 和 FBX 两份导入之间切换时时间和播放状态不变。三个模型开始时都在播自己的剪辑；拖滑条从剪辑手里收回权重。
// 左上角的面板见 SampleUI，F1 显示、隐藏。
import {
  AnimationComponent, Border, Grid, prop, StackPanel, StripDefinition, SyncScript, Transform, UIComponent, UniformGrid,
  type AnimationClip, type Entity, type EntityId, type LoadedModel, type ModelMorphs, type PlayingAnimation, type Slider, type TextBlock, type Thickness,
} from '@stride-ts/engine';
import { MUTED, rgba, SampleUI, WHITE } from './SampleUI';

const CLIP_NAME = 'Clip';
// 甜甜圈做的时候的帧率，时间旁边显示帧号用
const FRAMES_PER_SECOND = 30;
const MINIMUM_WEIGHT = -1;
const MAXIMUM_WEIGHT = 2;
const WEIGHT_SLIDER_WIDTH = 210;
const ANIMATED = rgba(120, 180, 245);

export class MorphTargetsController extends SyncScript.props({
  /** 场景里的甜甜圈实体（编辑器里能看它的模型和形变权重）。 */
  donut: prop.entity().optional(),
  /** 四个形变目标、没有骨架的立方体。 */
  cube: prop.entity().optional(),
  /** 四个形变目标、没有骨架的二十面球。 */
  icosphere: prop.entity().optional(),
  cubeAnimation: prop.asset('animation').optional(),
  icosphereAnimation: prop.asset('animation').optional(),
  model: prop.asset('model').optional(),
  animation: prop.asset('animation').optional(),
  /** 同一个甜甜圈的 FBX 导入，和它自己的剪辑。 */
  fbxModel: prop.asset('model').optional(),
  fbxAnimation: prop.asset('animation').optional(),
  material: prop.asset('material').optional(),
  font: prop.asset('font').optional(),
}) {
  #donut!: Entity;
  // 滑条改的模型：甜甜圈、立方体或二十面球
  #selected!: Entity;
  #animation!: AnimationComponent;
  #clip: AnimationClip | undefined;
  readonly #clipByModel = new Map<Entity, AnimationClip | undefined>();
  #ui!: SampleUI;
  #animationControls!: StackPanel;
  #sourceHost!: StackPanel;
  #sliderHost!: StackPanel;
  #sliders: Slider[] = [];
  #valueLabels: TextBlock[] = [];
  #nameLabels: TextBlock[] = [];
  #playLabel!: TextBlock;
  #timeLabel!: TextBlock;
  #timeline!: Slider;
  #updatingSliders = false;
  // 滑条按目标名对上：FBX 和 glTF 的目标顺序不一样
  #names: readonly string[] = [];

  // 正在应用：剪辑决定姿势（在播或停住）。不在应用：滑条手动设权重
  get #applied(): PlayingAnimation | undefined {
    return this.#animation.playingAnimations[0];
  }

  get #running(): boolean {
    return (this.#applied?.timeFactor ?? 0) !== 0;
  }

  get #duration(): number {
    return this.#clip?.duration ?? 0;
  }

  override start(): void {
    if (!this.model) throw new Error('Assign Model on the MorphTargetsController.');
    if (this.donut === undefined) throw new Error('Assign Donut on the MorphTargetsController.');
    const entity = (id: EntityId | undefined) => (id === undefined ? undefined : this.game.entities.entity(id));
    this.#donut = entity(this.donut)!;
    this.#clipByModel.set(this.#donut, this.animation);
    const cube = entity(this.cube), icosphere = entity(this.icosphere);
    if (cube) this.#clipByModel.set(cube, this.cubeAnimation);
    if (icosphere) this.#clipByModel.set(icosphere, this.icosphereAnimation);
    // 每个模型开始时都在播自己的剪辑
    for (const model of this.#clipByModel.keys()) {
      if (model === this.#donut) continue;
      this.#focus(model);
      this.#useClip(this.#clipByModel.get(model), undefined, false, 0);
      this.#togglePlay();
    }
    this.#focus(this.#donut);
    this.#setSource(this.model, this.animation);
    this.#createUI();
    this.#togglePlay();
  }

  override update(): void {
    const page = this.entity.get(UIComponent);
    if (page && this.game.input.isKeyPressed('F1')) page.enabled = !page.enabled;
    const applied = this.#applied;
    if (!applied) return;
    const time = this.#duration > 0 ? applied.currentTime % this.#duration : 0;
    this.#timeLabel.text = formatTime(time);

    // 剪辑决定姿势时，滑条跟着动画的权重和时间走
    this.#updatingSliders = true;
    this.#timeline.value = time;
    this.#sliders.forEach((slider, i) => {
      const weight = this.#weight(i);
      slider.value = weight;
      this.#valueLabels[i]!.text = format(weight);
      // 剪辑真的在动的目标高亮
      if (Math.abs(weight) > 0.001) this.#nameLabels[i]!.textColor = ANIMATED;
    });
    this.#updatingSliders = false;
  }

  #morphs(model: Entity): ModelMorphs | undefined {
    return this.game.animation.morphs(model);
  }

  #weight(index: number): number {
    const morphs = this.#morphs(this.#selected);
    const slot = morphs?.findMorphTarget(this.#names[index]!) ?? -1;
    return slot >= 0 ? morphs!.getMorphWeight(slot) : 0;
  }

  /** 换甜甜圈的模型和剪辑：权重按目标名、剪辑的时间和播放状态都留着。 */
  #setSource(model: LoadedModel, source: AnimationClip | undefined): void {
    const applied = this.#applied;
    const running = this.#running;
    const time = applied?.currentTime ?? 0;
    const weights = this.#names.map((_, i) => this.#weight(i));
    this.#animation.stopAll();
    this.game.content.removeModel(this.#donut);
    const material = this.material;
    const materials = material ? Array.from({ length: Math.max(1, model.materials.length) }, () => material) : [];
    this.game.content.addModel(this.#donut, model, { materials });
    const morphs = this.#morphs(this.#donut);
    this.#names.forEach((name, i) => {
      const slot = morphs?.findMorphTarget(name) ?? -1;
      if (slot >= 0) morphs!.setMorphWeight(slot, weights[i]!);
    });
    this.#useClip(source, applied, running, time);
  }

  /** 把 #animation、#clip 指向一个模型的动画组件和它的剪辑。 */
  #focus(model: Entity): void {
    this.#selected = model;
    this.#animation = model.get(AnimationComponent) ?? model.add(AnimationComponent).require(AnimationComponent);
    this.#clip = this.#animation.animations.get(CLIP_NAME);
  }

  /** 换剪辑；之前在应用剪辑时，在 time 处接着应用。 */
  #useClip(source: AnimationClip | undefined, applied: PlayingAnimation | undefined, running: boolean, time: number): void {
    this.#clip = source;
    this.#animation.animations.clear();
    if (source) this.#animation.animations.set(CLIP_NAME, source);
    if (applied && source) this.#apply(time % Math.max(this.#duration, 1e-6), running);
    if (this.#timeline) this.#timeline.maximum = this.#duration;
  }

  /** 剪辑从 time 起决定姿势，在播或者停在那里。 */
  #apply(time: number, running: boolean): void {
    const applied = this.#applied ?? this.#animation.play(CLIP_NAME);
    applied.currentTime = time;
    applied.timeFactor = running ? 1 : 0;
    if (this.#playLabel) this.#playLabel.text = running ? 'Pause' : 'Play';
  }

  #togglePlay(): void {
    if (!this.#clip) return;
    this.#apply(this.#applied?.currentTime ?? 0, !this.#running);
  }

  /** 剪辑停在时间轴的时间上。 */
  #seek(seconds: number): void {
    if (this.#clip) this.#apply(seconds, false);
  }

  /** 停掉剪辑，滑条手动设权重。 */
  #release(): void {
    this.#animation.stopAll();
    this.#playLabel.text = 'Play';
  }

  #reset(): void {
    this.#morphs(this.#selected)?.setAllMorphWeights(0);
    this.#updatingSliders = true;
    this.#release();
    this.#timeline.value = 0;
    this.#timeLabel.text = formatTime(0);
    this.#sliders.forEach((slider, slot) => {
      slider.value = 0;
      this.#valueLabels[slot]!.text = format(0);
      this.#nameLabels[slot]!.textColor = WHITE;
    });
    this.#updatingSliders = false;
  }

  /** 滑条改另一个模型；剪辑的控件只对甜甜圈。 */
  #select(model: Entity): void {
    this.#focus(model);
    this.#animationControls.visibility = this.#clipByModel.get(model) ? 'visible' : 'collapsed';
    this.#sourceHost.visibility = model === this.#donut ? 'visible' : 'collapsed';
    this.#playLabel.text = this.#running ? 'Pause' : 'Play';
    this.#timeline.maximum = this.#duration;
    this.#timeLabel.text = formatTime(this.#applied?.currentTime ?? 0);
    this.#createSliders();
  }

  #createSliders(): void {
    const ui = this.#ui;
    this.#names = this.#morphs(this.#selected)?.morphTargetNames ?? [];
    const grid = Object.assign(new UniformGrid(), { columns: 1, rows: Math.max(1, this.#names.length) });
    this.#sliders = [];
    this.#valueLabels = [];
    this.#nameLabels = [];
    this.#names.forEach((targetName, slot) => {
      const name = ui.text(targetName, 14, WHITE, [0, 0, 0, 0]);
      name.width = 80;
      const value = ui.text(format(this.#weight(slot)), 14, WHITE, [8, 0, 0, 0]);
      value.width = 52;
      value.textAlignment = 'right';
      const slider = ui.slider(MINIMUM_WEIGHT, MAXIMUM_WEIGHT, this.#weight(slot), WEIGHT_SLIDER_WIDTH, true);
      slider.step = 0.01;
      slider.margin = [0, 0, 0, 0];
      // 零点的刻度，画在滑条下面：零在三分之一处，不在开头
      const zeroTick = Object.assign(new Border(), {
        backgroundColor: MUTED, width: 2, height: 14, horizontalAlignment: 'left' as const, verticalAlignment: 'center' as const,
        margin: [(WEIGHT_SLIDER_WIDTH * -MINIMUM_WEIGHT) / (MAXIMUM_WEIGHT - MINIMUM_WEIGHT) - 1, 0, 0, 0] as Thickness, canBeHitByUser: false,
      });
      const track = Object.assign(new Grid(), { width: WEIGHT_SLIDER_WIDTH });
      track.children.add(zeroTick);
      track.children.add(slider);
      slider.onValueChanged(() => {
        if (this.#updatingSliders) return;
        // 手动改权重就从剪辑手里收回姿势，不管在播还是停住
        if (this.#applied) this.#release();
        const morphs = this.#morphs(this.#selected);
        const target = morphs?.findMorphTarget(this.#names[slot]!) ?? -1;
        if (target >= 0) morphs!.setMorphWeight(target, slider.value);
        value.text = format(slider.value);
      });
      const row = Object.assign(new StackPanel(), { orientation: 'horizontal' as const, margin: [0, 3, 0, 3] as Thickness, gridRow: slot });
      row.children.add(name);
      row.children.add(track);
      row.children.add(value);
      grid.children.add(row);
      this.#sliders.push(slider);
      this.#valueLabels.push(value);
      this.#nameLabels.push(name);
    });
    this.#sliderHost.children.clear();
    this.#sliderHost.children.add(grid);
  }

  #createUI(): void {
    if (!this.font) throw new Error('Assign Font on the MorphTargetsController.');
    const ui = (this.#ui = new SampleUI(this.font));
    const panel = Object.assign(new StackPanel(), { orientation: 'vertical' as const, width: 360 });
    panel.children.add(ui.heading('Morph targets'));
    // 从左到右，同场景里摆的顺序
    const models = [...this.#clipByModel.keys()].sort((a, b) => a.require(Transform).position.x - b.require(Transform).position.x);
    if (models.length > 1) ui.radioGroup(panel, 'Mesh', models.map((model) => model.name), models.indexOf(this.#donut), (index) => this.#select(models[index]!));

    const weightsHeader = Object.assign(new Grid(), { margin: [0, 8, 0, 0] as Thickness });
    weightsHeader.columnDefinitions.add(new StripDefinition('star'));
    weightsHeader.columnDefinitions.add(new StripDefinition('auto'));
    weightsHeader.children.add(ui.section('Weights'));
    const reset = ui.button(ui.label('Reset', 13), () => this.#reset());
    Object.assign(reset, { padding: [8, 2, 8, 2] as Thickness, margin: [0, 8, 0, 2] as Thickness, gridColumn: 1 });
    weightsHeader.children.add(reset);
    panel.children.add(weightsHeader);
    panel.children.add((this.#sliderHost = Object.assign(new StackPanel(), { orientation: 'vertical' as const })));
    this.#createSliders();

    // 选中模型的剪辑和时间轴；glTF/FBX 只有甜甜圈有
    this.#animationControls = Object.assign(new StackPanel(), { orientation: 'vertical' as const });
    this.#animationControls.children.add(ui.section('Animation'));
    const transport = Object.assign(new StackPanel(), { orientation: 'horizontal' as const });
    this.#playLabel = ui.label('Play', 14);
    const play = ui.button(this.#playLabel, () => this.#togglePlay());
    play.width = 64;
    play.margin = [0, 0, 8, 0];
    this.#playLabel.horizontalAlignment = 'center';
    transport.children.add(play);
    this.#timeline = ui.slider(0, this.#duration, 0, 200);
    this.#timeline.step = 1 / FRAMES_PER_SECOND / 10;
    this.#timeline.onValueChanged(() => {
      if (this.#updatingSliders) return;
      this.#seek(this.#timeline.value);
      this.#timeLabel.text = formatTime(this.#timeline.value);
    });
    transport.children.add(this.#timeline);
    transport.children.add((this.#timeLabel = ui.text(formatTime(0), 13, MUTED, [8, 0, 0, 0])));
    this.#animationControls.children.add(transport);
    this.#animationControls.children.add((this.#sourceHost = Object.assign(new StackPanel(), { orientation: 'vertical' as const })));
    const fbxModel = this.fbxModel, model = this.model!;
    if (fbxModel) ui.radioGroup(this.#sourceHost, 'Source', ['glTF', 'FBX'], 0, (index) => this.#setSource(index === 0 ? model : fbxModel, index === 0 ? this.animation : this.fbxAnimation));
    panel.children.add(this.#animationControls);

    panel.children.add(ui.text('F1 hides the panels', 12, MUTED, [0, 10, 0, 0]));
    SampleUI.show(this.entity, ui.panel(panel, 'left'));
  }
}

const formatTime = (seconds: number) => `${seconds.toFixed(2)} s  f${Math.round(seconds * FRAMES_PER_SECOND)}`;

/** C# 的 "+0.00;-0.00"：按原值的符号选格式，所以 -0.001 是 -0.00（toFixed 也是）。 */
function format(value: number): string {
  const rounded = value.toFixed(2);
  return rounded.startsWith('-') ? rounded : `+${rounded}`;
}
