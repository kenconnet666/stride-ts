/// <reference types="vite/client" />
// 沙盒的入口：只负责启动，游戏内容都在 game/ 里。开发时这个模块自己接住热更新：game/ 里任何文件改了，
// Vite 重新执行这里，Game.hotEntry 返回正在运行的同一个游戏，把新版本的模块交给它，页面不刷新、状态保留。
import { Game } from '@stride-ts/engine';
import { SandboxGame } from './game/sandbox';

const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
const stats = document.querySelector<HTMLElement>('#stats')!;
const modules = import.meta.glob('./game/**/*.ts', { eager: true });

const { game, created } = Game.hotEntry(import.meta.hot, modules, SandboxGame, stats);
if (created) {
  game.run(canvas, { modules }).catch((error: unknown) => {
    stats.textContent = `failed: ${error instanceof Error ? error.message : String(error)}`;
  });
}

import.meta.hot?.accept();
