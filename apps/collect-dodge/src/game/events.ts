// 关卡里脚本之间的事件（同 Stride 的 EventKey）：金币、障碍、终点只发事件，规则（GameRules）计分、放声音、开门、显示。
import { EventKey } from '@stride-ts/engine';

/** 玩家吃到一个金币。 */
export const CoinCollectedEventKey = new EventKey<void>();
/** 玩家被障碍撞到（玩家回到出生点）。 */
export const PlayerHitEventKey = new EventKey<void>();
/** 金币吃完了，门打开。 */
export const DoorOpenEventKey = new EventKey<void>();
/** 玩家走进终点。 */
export const GoalReachedEventKey = new EventKey<void>();
