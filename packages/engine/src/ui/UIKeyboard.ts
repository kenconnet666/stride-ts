/**
 * 键盘事件发给有焦点的元素（Stride 的 UISystem.UpdateKeyEvents）：这一帧输入的文字发 TextInput，刚按下的键发 KeyPressed，
 * 刚松开的发 KeyReleased，按着的键每帧发 KeyDown；都从有焦点的元素往上冒泡。有焦点的元素占着键盘，脚本那边看不到这些键，
 * 所以读的是不管占用的原始状态。
 *
 * 和 Stride 不同：这一帧有文字输入时 Stride 不发 KeyPressed、KeyReleased（松开的事件就丢了），我们照发。
 */
import type { RawKeys } from '../input/capture';
import { KeyEventArgs, TextEventArgs } from './events';
import type { UIElement } from './UIElement';

export function routeKeyEvents(focused: UIElement, keys: RawKeys, text: readonly string[]): void {
  if (!focused.isHierarchyEnabled) return;
  for (const entered of text) focused.raiseTextInput(Object.assign(new TextEventArgs(), { text: entered }));
  const args = (key: string) => Object.assign(new KeyEventArgs(), { key, downKeys: keys.down });
  for (const key of keys.pressed) focused.raiseKeyPressed(args(key));
  for (const key of keys.released) focused.raiseKeyReleased(args(key));
  for (const key of keys.down) focused.raiseKeyDown(args(key));
}
