// 冒烟测试：对着正在运行的页面（开发服务器或 preview，`stride open` 打开的），用调试 CLI 走一遍。
//   pnpm --filter @stride-ts/collect-dodge smoke [-- --hub <中枢名的一部分>]
// 检查：主场景跑起来了、有实体；没有错误日志（finish 检查）。游戏搭起来以后在这里加玩法的检查。
import { startSmoke } from '../../../tools/smoke.ts';

const { stride, check, finish } = startSmoke('collect-dodge');

stride('wait');
const status = stride('status') as { scene: string | null; error: string | null; entities: number };
check('主场景跑起来了，有实体', status.scene === 'MainScene' && status.error === null && status.entities > 0, status);

finish();