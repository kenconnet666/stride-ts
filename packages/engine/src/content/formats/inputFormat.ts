/**
 * 输入映射（`.input.json`，Stride 只有虚拟按钮；照虚幻的 Enhanced Input、Unity 的 Input System）：游戏里的"动作"（跳、开火、移动、
 * 视角）和绑在上面的物理输入。脚本只问动作（`game.input.actions.pressed('jump')`、`vector('move')`），换键、加手柄、开车时换一套
 * 操作都不改脚本。运行时见 input/InputActions.ts。
 *
 * - 动作的种类：button（按着、刚按下、刚松开，值 0..1）、axis（一个数，-1..1）、axis2（二维，长度一般不超过 1）。
 * - 物理输入写成字符串：`key:W`、`key:Space`、`key:ArrowLeft`（键名同 InputManager.isKeyDown：浏览器的 code 或 Stride 的名字）；
 *   `mouse:left`、`mouse:middle`、`mouse:right`、`mouse:delta`（二维，按画布归一化的移动量）、`mouse:wheel`（格数）；
 *   `pad:a`、`pad:b`、`pad:x`、`pad:y`、`pad:leftShoulder`、`pad:rightShoulder`、`pad:start`、`pad:back`、`pad:leftThumb`、
 *   `pad:rightThumb`、`pad:padUp`…`pad:padRight`、`pad:leftTrigger`、`pad:rightTrigger`（0..1）、`pad:leftStick`、`pad:rightStick`
 *   （二维，y 向上）。
 * - 绑定的种类：control（一个物理输入）、axis（两个键拼成一个数：positive 减 negative）、dpad（四个键拼成二维，斜着按长度也是 1）；
 *   每个绑定先按 deadZone 去掉死区（按长度），再乘 scale（负数是反向）。一个动作的几个绑定里取用力最大的那个。
 */
import { s, type Infer, type InputOf } from '../schema/schema.ts';

const control = () => s.string().describe('key:W, key:Space, mouse:left, mouse:delta, mouse:wheel, pad:a, pad:leftStick, pad:rightTrigger …');

export const INPUT_BINDING = s.union('type', {
  /** 一个物理输入。 */
  control: { control: control() },
  /** 两个键拼成一个数：positive 减 negative。 */
  axis: { negative: control(), positive: control() },
  /** 四个键拼成二维（右减左、上减下），斜着按也按长度 1 算。 */
  dpad: { up: control(), down: control(), left: control(), right: control() },
}, {
  /** 乘上的倍数；负数是反向（鼠标视角的上下反转）。 */
  scale: s.number({ step: 0.05 }).default(1),
  /** 长度小于它的当作 0（摇杆回不到正中），之后从 0 重新算起。 */
  deadZone: s.number({ min: 0, max: 1, step: 0.05 }).default(0),
});

export const INPUT_ACTION = s.object({
  name: s.string(),
  type: s.oneOf('button', 'axis', 'axis2'),
  bindings: s.list(INPUT_BINDING),
});

export const INPUT_MAP = s.object({
  name: s.string(),
  actions: s.list(INPUT_ACTION),
});

export type InputMapFile = InputOf<typeof INPUT_MAP>;
/** 解析过的输入映射（默认值都补上了）。 */
export type InputMap = Infer<typeof INPUT_MAP>;
export type InputAction = Infer<typeof INPUT_ACTION>;
export type InputBinding = Infer<typeof INPUT_BINDING>;
export type InputBindingFile = InputOf<typeof INPUT_BINDING>;
