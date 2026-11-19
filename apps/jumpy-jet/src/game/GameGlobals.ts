// JumpyJet 的 GameGlobals：全局的事件键和游戏常量。
import { EventKey } from '@stride-ts/engine';

/** 撞到管子或地面，游戏结束。 */
export const GameOverEventKey = new EventKey<void>();
/** 第一次点击，开始。 */
export const GameStartedEventKey = new EventKey<void>();
/** 重新开始（回到开始画面）。 */
export const GameResetEventKey = new EventKey<void>();
/** 穿过一组管子，加一分。 */
export const PipePassedEventKey = new EventKey<void>();

export const GAME_SPEED = 2.9;
export const GAME_PIXEL_TO_UNIT_SCALE = 0.01;
