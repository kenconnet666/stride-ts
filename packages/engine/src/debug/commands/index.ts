/**
 * 引擎自带的调试命令（Game.run 打开 debug 时登记）。参数和返回值都是能 JSON 的值；CLI（@stride-ts/cli）的子命令
 * 一一对应地调用它们，游戏可以用 game.debug.command 再加自己的。
 *
 * 实体参数可以是 id（数字）或名字（先按全名找，再按包含这段文字找，不唯一时报错并列出候选）。组件和脚本按登记的名字
 * （`路径#导出名`）或 # 后面的部分找。
 */
import type { Game } from '../../engine/Game';
import type { Debug } from '../Debug';
import { registerCaptureCommands } from './capture.ts';
import { registerCoreCommands } from './core.ts';
import { registerPerfCommands } from './perf.ts';
import { registerRenderingCommands } from './rendering.ts';
import { registerSceneCommands } from './scene.ts';
import { registerWorldCommands } from './world.ts';

export { withLastValue } from './core.ts';

/** 登记引擎自带的调试命令（按领域分在这个目录的几个文件里）。 */
export function registerGameCommands(debug: Debug, game: Game): void {
  for (const register of [registerCoreCommands, registerCaptureCommands, registerPerfCommands, registerRenderingCommands, registerWorldCommands, registerSceneCommands]) register(debug, game);
}
