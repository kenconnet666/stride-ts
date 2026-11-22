/// <reference types="vite/client" />
// 入口只负责启动，游戏内容在 game/ 里，开发时可以热重载。场景在 public/content，用编辑器（开发服务器上的 /__stride/editor/）搭。
import * as engine from '@stride-ts/engine';
import { Game } from '@stride-ts/engine';
import { physics } from '@stride-ts/native/physics';
import { texture } from '@stride-ts/native/texture';
import { PhotorealGame } from './game/PhotorealGame';

// 调试用：控制台和 stride eval 可以拿到引擎的类型
(globalThis as { strideEngine?: typeof engine }).strideEngine = engine;

const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
const stats = document.querySelector<HTMLElement>('#stats')!;
const modules = import.meta.glob('./game/**/*.ts', { eager: true });

const { game, created } = Game.hotEntry(import.meta.hot, modules, PhotorealGame);
if (created) {
  game.run(canvas, { modules, stats, debugNative: import.meta.env.DEV, debug: import.meta.env.DEV || undefined, nativeFeatures: [physics, texture] }).catch((error: unknown) => {
    stats.textContent = `failed: ${error instanceof Error ? error.message : String(error)}`;
  });
}
