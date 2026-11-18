/// <reference types="vite/client" />
// Third Person Platformer 的移植：入口只负责启动，游戏内容在 game/ 里，开发时可以热重载。
// 场景先用 `pnpm --filter @stride-ts/platformer import:stride` 从 Stride 仓库导入。
import * as engine from '@stride-ts/engine';
import { Game } from '@stride-ts/engine';
import { PlatformerGame } from './game/platformer';

// 调试用：控制台和 tools/play.cjs 的 eval 步骤可以拿到引擎的类型（比如 Transform）
(globalThis as { strideEngine?: typeof engine }).strideEngine = engine;

const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
const stats = document.querySelector<HTMLElement>('#stats')!;
const modules = import.meta.glob('./game/**/*.ts', { eager: true });

const { game, created } = Game.hotEntry(import.meta.hot, modules, PlatformerGame, stats);
if (created) {
  game.run(canvas, { modules, debugNative: import.meta.env.DEV }).catch((error: unknown) => {
    stats.textContent = `failed: ${error instanceof Error ? error.message : String(error)}`;
  });
}

import.meta.hot?.accept();
