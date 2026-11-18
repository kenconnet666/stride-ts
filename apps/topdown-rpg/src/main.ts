/// <reference types="vite/client" />
// Stride 的 TopDownRPG 模板的移植：入口只负责启动，游戏内容在 game/ 里，开发时可以热重载。
// 场景先用 `pnpm --filter @stride-ts/topdown-rpg import:stride` 从 Stride 仓库导入。
import * as engine from '@stride-ts/engine';
import { Game } from '@stride-ts/engine';
import { physics } from '@stride-ts/native/physics';
import { TopDownRpgGame } from './game/TopDownRpgGame';

// 调试用：控制台和 stride eval 可以拿到引擎的类型
(globalThis as { strideEngine?: typeof engine }).strideEngine = engine;

const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
const stats = document.querySelector<HTMLElement>('#stats')!;
const modules = import.meta.glob('./game/**/*.ts', { eager: true });

const { game, created } = Game.hotEntry(import.meta.hot, modules, TopDownRpgGame, stats);
if (created) {
  game.run(canvas, { modules, debugNative: import.meta.env.DEV, debug: import.meta.env.DEV || undefined, nativeFeatures: [physics] }).catch((error: unknown) => {
    stats.textContent = `failed: ${error instanceof Error ? error.message : String(error)}`;
  });
}
