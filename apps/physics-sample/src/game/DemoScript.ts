// PhysicsSample 的 DemoScript（Constraints 场景）：立方体和球之间依次换六种约束——球窝、铰链、齿轮马达、滑轨、锥形扭转、焊接，
// 每换一种就复位两个物体、给球一个冲量看效果。画面下方是约束的名字和 Next、Previous 两个按钮。
import {
  Button, Canvas, prop, Quaternion, StartupScript, TextBlock, UIComponent, UIPage, Vector3,
  type BodyControl, type Constraint, type ConstraintSettings, type ContactHandler, type Contact,
} from '@stride-ts/engine';
import { BUTTON_BACKGROUND } from './NextSceneScript';

const WHITE = [1, 1, 1, 1] as const;
// Stride 的 new Color(200, 200, 200, 255)
const BUTTON_TEXT = [200 / 255, 200 / 255, 200 / 255, 1] as const;

/** 每种约束：名字和怎么加（加好后给球的冲量在 setup 里）。 */
interface Demo {
  readonly name: string;
  setup(demo: DemoScript): void;
}

/** 绕 Y 转 90°：扭转限位的基，把 Bepu 的扭转轴（基的 Z）转到 X。 */
const TWIST_BASIS = [0, Math.SQRT1_2, 0, Math.SQRT1_2] as const;

const DEMOS: readonly Demo[] = [
  {
    // 球右边 4 米的点停在立方体中心；没有限制，球绕着转
    name: 'Ball Socket',
    setup: (demo) => {
      demo.addConstraint({ type: 'ballSocket', localOffsetA: [0, 0, 0], localOffsetB: [4, 0, 0] });
      demo.sphereBody.applyLinearImpulse({ x: 0, y: 0, z: 18 });
    },
  },
  {
    // 冲量沿着铰链轴，被挡住
    name: 'Hinge',
    setup: (demo) => {
      demo.addConstraint({ type: 'hinge', localOffsetA: [0, 0, 0], localHingeAxisA: [0, 0, 1], localOffsetB: [4, 0, 0], localHingeAxisB: [0, 0, 1] });
      demo.sphereBody.applyLinearImpulse({ x: 0, y: 0, z: 18 });
    },
  },
  {
    // 两个都在原地转：没有重力；立方体绕 X 的速度是球的一半
    name: 'Angular Axis Gear Motor',
    setup: (demo) => {
      demo.cubeBody.kinematic = false;
      demo.cubeBody.gravity = false;
      demo.sphereBody.gravity = false;
      demo.addConstraint({ type: 'angularAxisGearMotor', localAxisA: [1, 0, 0], velocityScale: 0.5 }, true);
      demo.sphereBody.angularVelocity = { x: 25, y: 0, z: 0 };
    },
  },
  {
    // 球在立方体的 X 轴上，最多在左边 4 米；碰到立方体时再把它打出去（onStartedTouching）
    name: 'Slider',
    setup: (demo) => {
      demo.addConstraint({ type: 'pointOnLine', localOffsetA: [0, 0, 0], localOffsetB: [0, 0, 0], localDirection: [1, 0, 0] });
      demo.addConstraint({ type: 'linearAxisLimit', localOffsetA: [0, 0, 0], localOffsetB: [0, 0, 0], localAxis: [1, 0, 0], minimumOffset: -4, maximumOffset: 0 });
      demo.isSlider = true;
      demo.sphereBody.applyLinearImpulse({ x: -25, y: 0, z: 0 });
    },
  },
  {
    // 球窝，加上球的 X 轴相对立方体的摆动、扭转限位
    name: 'Cone Twist',
    setup: (demo) => {
      demo.addConstraint({ type: 'ballSocket', localOffsetA: [0, 0, 0], localOffsetB: [4, 0, 0] });
      demo.addConstraint({ type: 'swingLimit', axisLocalA: [1, 0, 0], axisLocalB: [1, 0, 0], maximumSwingAngle: 0.5 });
      demo.addConstraint({ type: 'twistLimit', localBasisA: TWIST_BASIS, localBasisB: TWIST_BASIS, minimumAngle: -0.5, maximumAngle: 0.5 });
      demo.sphereBody.applyLinearImpulse({ x: 0, y: 0, z: 18 });
    },
  },
  {
    // 球保持在立方体左边 4 米、朝向不变
    name: 'Weld',
    setup: (demo) => {
      demo.addConstraint({ type: 'weld', localOffset: [-4, 0, 0], localOrientation: [0, 0, 0, 1] });
      demo.sphereBody.applyLinearImpulse({ x: 0, y: 0, z: 18 });
    },
  },
];

type ConstraintParameters = ConstraintSettings extends infer C ? (C extends unknown ? Omit<C, 'bodyA' | 'bodyB'> : never) : never;

export class DemoScript
  extends StartupScript.props({
    cube: prop.entity(),
    sphere: prop.entity(),
    font: prop.asset('font'),
  }, { requires: [() => UIComponent] })
  implements ContactHandler
{
  cubeBody!: BodyControl;
  sphereBody!: BodyControl;
  isSlider = false;
  readonly #constraints: Constraint[] = [];
  readonly #name = new TextBlock();
  #index = 0;

  override start(): void {
    const simulation = this.game.simulation!;
    simulation.configure({ gravity: [0, -9, 0] });
    // 负的睡眠阈值让物体一直醒着
    this.cubeBody = simulation.body(this.cube);
    this.cubeBody.sleepThreshold = -1;
    this.sphereBody = simulation.body(this.sphere);
    this.sphereBody.sleepThreshold = -1;
    // 滑轨要知道球什么时候碰到立方体
    simulation.setContactHandler(this.cube, this);
    this.#createUI();
    this.#removeConstraints();
    this.#show();
  }

  /** 约束的名字在中间，Next 在右下、Previous 在左下。ConstraintName 这个名字是我们加的（冒烟脚本按它找），Stride 里没有名字。 */
  #createUI(): void {
    Object.assign(this.#name, {
      name: 'ConstraintName', font: this.font, textSize: 55, textColor: WHITE,
      canvasPinOrigin: [0.5, 0.5] as const, canvasRelativePosition: [0.5, 0.83] as const,
    });
    const root = new Canvas();
    root.children.add(this.#name);
    for (const [text, offset] of [['Next', 1], ['Previous', -1]] as const) {
      const button = Object.assign(new Button(), {
        name: text,
        padding: [15, 15, 15, 15] as const,
        horizontalAlignment: 'left' as const,
        content: Object.assign(new TextBlock(), { text, font: this.font, textSize: 35, textColor: BUTTON_TEXT }),
        backgroundColor: BUTTON_BACKGROUND,
        canvasPinOrigin: [offset > 0 ? 1 : 0, 0.5] as const,
        canvasRelativePosition: [offset > 0 ? 0.87 : 0.13, 0.93] as const,
      });
      button.onClick(() => this.#change(offset));
      root.children.add(button);
    }
    this.entity.require(UIComponent).page = new UIPage('Constraints', root);
  }

  #show(): void {
    const demo = DEMOS[this.#index]!;
    this.#name.text = demo.name;
    demo.setup(this);
  }

  override cancel(): void {
    this.#removeConstraints();
  }

  onStartedTouching({ other }: Contact): void {
    if (!this.isSlider || other !== this.sphere) return;
    this.sphereBody.linearVelocity = { x: 0, y: 0, z: 0 };
    this.sphereBody.applyLinearImpulse({ x: -25, y: 0, z: 0 });
  }

  /** 约束加在立方体（A）和球（B）之间；swap 时反过来（齿轮马达：B 是立方体）。 */
  addConstraint(parameters: ConstraintParameters, swap = false): void {
    const [bodyA, bodyB] = swap ? [this.sphere, this.cube] : [this.cube, this.sphere];
    this.#constraints.push(this.game.simulation!.addConstraint({ ...parameters, bodyA, bodyB } as ConstraintSettings));
  }

  #change(offset: number): void {
    this.#removeConstraints();
    this.#index = (this.#index + offset + DEMOS.length) % DEMOS.length;
    this.#show();
  }

  /** 去掉约束，复位：立方体不动，球落下。 */
  #removeConstraints(): void {
    for (const constraint of this.#constraints) constraint.remove();
    this.#constraints.length = 0;
    this.isSlider = false;
    const { cubeBody, sphereBody } = this;
    cubeBody.kinematic = true;
    cubeBody.gravity = true;
    sphereBody.gravity = true;
    cubeBody.teleport(new Vector3(2, 0, -9), new Quaternion());
    cubeBody.angularVelocity = cubeBody.linearVelocity = { x: 0, y: 0, z: 0 };
    sphereBody.teleport(new Vector3(-2, 0, -9), new Quaternion());
    sphereBody.angularVelocity = sphereBody.linearVelocity = { x: 0, y: 0, z: 0 };
  }
}
