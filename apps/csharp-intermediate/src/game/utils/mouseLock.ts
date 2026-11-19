import type { Game } from '@stride-ts/engine';

/**
 * 两个相机教程共用的鼠标锁定：点左键锁定（浏览器要求先有用户操作），Esc 解锁（锁着时浏览器自己也会解）。
 * 返回现在是不是锁着；没锁时在屏幕上提示怎么锁。
 */
export function updateMouseLock(game: Game): boolean {
  const { input } = game;
  if (input.isMouseButtonPressed('left')) input.lockMousePosition();
  if (input.isKeyPressed('Escape')) input.unlockMousePosition();
  if (!input.isMousePositionLocked) game.debugText.print('Click to look around, Escape to release the mouse', [500, 80]);
  return input.isMousePositionLocked;
}
