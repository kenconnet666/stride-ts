/// <reference types="vite/client" />
// Third Person Platformer 的移植：入口只负责启动，游戏内容在 game/ 里，开发时可以热重载。
// 场景先用 `pnpm --filter @stride-ts/platformer import:stride` 从 Stride 仓库导入。
import { Game } from '@stride-ts/engine';
import { PlatformerGame } from './game/platformer';

const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
const stats = document.querySelector<HTMLElement>('#stats')!;
const modules = import.meta.glob('./game/**/*.ts', { eager: true });

const { game, created } = Game.hotEntry(import.meta.hot, modules, PlatformerGame, stats);
if (created) {
  game.run(canvas, { modules }).catch((error: unknown) => {
    stats.textContent = `failed: ${error instanceof Error ? error.message : String(error)}`;
  });
}

import.meta.hot?.accept();
