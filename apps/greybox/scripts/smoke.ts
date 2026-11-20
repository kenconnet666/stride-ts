// 冒烟测试：对着正在运行的页面（开发服务器或 preview，`stride open` 打开的），用调试 CLI 走一遍。
//   pnpm --filter @stride-ts/greybox smoke [-- --hub <中枢名的一部分>]
// 检查：主场景跑起来了；白盒烘出的模型（Level/Room，三个材质槽）加载了、按槽分成三个网格；碰撞体对；没有错误日志（finish 检查）。
import { startSmoke } from '../../../tools/smoke.ts';

const { stride, check, finish } = startSmoke('greybox');

stride('wait');
const status = stride('status') as { scene: string | null; error: string | null; entities: number };
check('主场景跑起来了，有实体', status.scene === 'MainScene' && status.error === null && status.entities > 0, status);

// 模型的第一个网格在实体自己身上，其余的是子实体（ModelPart）
const parts = stride('eval', `(() => {
  const room = entity('Room');
  const extra = room.get(strideEngine.Transform).children.filter((child) => child.has(strideEngine.ModelPart)).map((child) => child.name).sort();
  return [room.has(strideEngine.Model), extra];
})()`) as [boolean, string[]];
check('白盒的模型按材质槽分成三个网格（地板、墙、点缀）', parts[0] && parts[1].length === 2 && parts[1][0]!.endsWith('/slot1') && parts[1][1]!.endsWith('/slot2'), parts);

// 碰撞体是同一个模型的网格：从上往下打射线，落在各处的面上（坑挖穿了地板，打不到东西）
const heights = stride('eval', `(() => {
  const at = (x, z) => { const hit = strideGame.simulation.rayCast([x, 10, z], [0, -1, 0], 20); return hit ? Math.round(hit.point[1] * 1000) / 1000 : null; };
  return { platform: at(-4.5, -4.5), floor: at(0, 3), ramp: at(0.5, -3), tower: at(5, -5), pit: at(4, 4) };
})()`) as Record<string, number | null>;
check('碰撞：平台顶 1.5 米、地板 0、斜坡中间 0.75、圆塔里 0.2、坑是空的', heights.platform === 1.5 && heights.floor === 0 && heights.ramp === 0.75 && heights.tower === 0.2 && heights.pit === null, heights);

finish();
