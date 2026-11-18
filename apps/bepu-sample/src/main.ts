/// <reference types="vite/client" />
// Stride 的 BepuSample 的移植：入口只负责启动，游戏内容在 game/ 里，开发时可以热重载。
// 场景先用 `pnpm --filter @stride-ts/bepu-sample import:stride` 从 Stride 仓库导入。
import * as engine from '@stride-ts/engine';
import { Game } from '@stride-ts/engine';
import { physics } from '@stride-ts/native/physics';
import { texture } from '@stride-ts/native/texture';
import { BepuSampleGame } from './game/BepuSampleGame';

// 调试用：控制台和 stride eval 可以拿到引擎的类型（比如 Body）
(globalThis as { strideEngine?: typeof engine }).strideEngine = engine;

const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
const stats = document.querySelector<HTMLElement>('#stats')!;
const modules = import.meta.glob('./game/**/*.ts', { eager: true });
// Cube Fountain 的生成器最多生成 100000 个方块（每秒 50 个），Jolt 的物理世界容量是固定的：比默认的 4096 放大一些，
// 每秒 50 个能跑十来分钟（Bepu 没有上限）
const MAX_BODIES = 32768;
// 贴图大多原样用 PNG；Github.png 是 1015x1015，照 Stride 缩放到 4 的倍数后编成 KTX2，要转码模块

const { game, created } = Game.hotEntry(import.meta.hot, modules, BepuSampleGame, stats);
if (created) {
  game.run(canvas, { modules, debugNative: import.meta.env.DEV, debug: import.meta.env.DEV || undefined, nativeFeatures: [physics, texture], maxBodies: MAX_BODIES }).catch((error: unknown) => {
    stats.textContent = `failed: ${error instanceof Error ? error.message : String(error)}`;
  });
}

import.meta.hot?.accept();
