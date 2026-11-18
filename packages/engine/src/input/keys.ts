/**
 * Stride 的 Keys 枚举名到 KeyboardEvent.code 的对应。InputManager 的按键参数两种写法都认：
 * 'KeyW'、'ArrowLeft'（浏览器的 code）或 'W'、'Left'（Stride 的名字，从 Stride 场景导入的脚本属性就是这样存的）。
 * 两套名字没有冲突：Stride 的 'Space'、'Tab'、'Escape'、'Enter'、'Delete'、'F1' 这些和 code 同名，含义也相同。
 */

/** 和 code 不同名的 Stride 键（字母、数字、小键盘、F 键按规则换算，见 keyCode）。 */
const STRIDE_NAMES: Readonly<Record<string, string>> = {
  Back: 'Backspace',
  Return: 'Enter',
  NumPadEnter: 'NumpadEnter',
  Capital: 'CapsLock',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Prior: 'PageUp',
  Next: 'PageDown',
  PrintScreen: 'PrintScreen',
  Snapshot: 'PrintScreen',
  LeftWin: 'MetaLeft',
  RightWin: 'MetaRight',
  Apps: 'ContextMenu',
  Multiply: 'NumpadMultiply',
  Add: 'NumpadAdd',
  Separator: 'NumpadComma',
  Subtract: 'NumpadSubtract',
  Decimal: 'NumpadDecimal',
  Divide: 'NumpadDivide',
  Scroll: 'ScrollLock',
  LeftShift: 'ShiftLeft',
  RightShift: 'ShiftRight',
  LeftCtrl: 'ControlLeft',
  RightCtrl: 'ControlRight',
  LeftAlt: 'AltLeft',
  RightAlt: 'AltRight',
  OemSemicolon: 'Semicolon',
  OemPlus: 'Equal',
  OemComma: 'Comma',
  OemMinus: 'Minus',
  OemPeriod: 'Period',
  OemQuestion: 'Slash',
  OemTilde: 'Backquote',
  OemOpenBrackets: 'BracketLeft',
  OemPipe: 'Backslash',
  OemCloseBrackets: 'BracketRight',
  OemQuotes: 'Quote',
  OemBackslash: 'IntlBackslash',
  VolumeMute: 'AudioVolumeMute',
  VolumeDown: 'AudioVolumeDown',
  VolumeUp: 'AudioVolumeUp',
  MediaPreviousTrack: 'MediaTrackPrevious',
  MediaNextTrack: 'MediaTrackNext',
};

/** 按键名换成 KeyboardEvent.code：Stride 的名字照上表和规则换算，其余（已经是 code）原样返回。 */
export function keyCode(name: string): string {
  const mapped = STRIDE_NAMES[name];
  if (mapped) return mapped;
  // 'A'..'Z' → 'KeyA'；'D0'..'D9' → 'Digit0'；'NumPad0' → 'Numpad0'
  if (/^[A-Z]$/.test(name)) return `Key${name}`;
  if (/^D[0-9]$/.test(name)) return `Digit${name[1]}`;
  if (/^NumPad[0-9]$/.test(name)) return `Numpad${name[6]}`;
  return name;
}
