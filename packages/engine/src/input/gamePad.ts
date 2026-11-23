/** 手柄的按键和状态（InputManager、InputActions 共用；单独一个模块，两边互相引用时不会读到没初始化的值）。 */
/** 手柄按键（Stride 的 GamePadButton，同样的位）。 */
export const GamePadButton = {
  padUp: 1 << 0,
  padDown: 1 << 1,
  padLeft: 1 << 2,
  padRight: 1 << 3,
  start: 1 << 4,
  back: 1 << 5,
  leftThumb: 1 << 6,
  rightThumb: 1 << 7,
  leftShoulder: 1 << 8,
  rightShoulder: 1 << 9,
  a: 1 << 12,
  b: 1 << 13,
  x: 1 << 14,
  y: 1 << 15,
} as const;

export interface GamePadState {
  /** 按着的键，GamePadButton 的位或。 */
  buttons: number;
  /** 这一帧刚按下的键（上一帧没按着）。 */
  pressedButtons: number;
  /** 左摇杆，x 向右、y 向上，-1..1。 */
  readonly leftThumb: [number, number];
  readonly rightThumb: [number, number];
  leftTrigger: number;
  rightTrigger: number;
}
