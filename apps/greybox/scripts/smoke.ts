// 冒烟测试：对着正在运行的页面（开发服务器或 preview，`stride open` 打开的），用调试 CLI 走一遍。
//   pnpm --filter @stride-ts/greybox smoke [-- --hub <中枢名的一部分>]
// 检查：主场景跑起来了；白盒烘出的模型（Level/Room，三个材质槽）加载了、按槽分成三个网格；碰撞体对；点选读回的表面对；没有错误日志（finish 检查）。
import { startSmoke } from '@stride-ts/devkit/smoke';

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

// 点选读回表面（编辑器拖东西吸附到表面用）：把世界里的点按主视图投到画面上再点，读回的深度换回来的点在原来的地方
const surface = stride('eval', `(async () => {
  const view = strideGame.graphicsCompositor.mainView, m = view.viewProjection, c = strideGame.graphicsDevice.canvas;
  const at = async (x, y, z) => {
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    const sx = ((m[0] * x + m[4] * y + m[8] * z + m[12]) / w + 1) / 2 * c.clientWidth, sy = (1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w) / 2 * c.clientHeight;
    const hit = await strideGame.pickSurface(sx, sy);
    return hit && { name: hit.entity?.name ?? null, point: hit.point.map((v) => Math.round(v * 100) / 100) };
  };
  return { floor: await at(0, 0, 3), platform: await at(-4.5, 1.5, -4.5) };
})()`) as Record<string, { name: string | null; point: number[] } | null>;
const near = (hit: { point: number[] } | null, [x, y, z]: number[]) => hit !== null && Math.hypot(hit.point[0]! - x!, hit.point[1]! - y!, hit.point[2]! - z!) < 0.1;
check('点选读回表面：地板、平台顶上的点（Room）', near(surface.floor!, [0, 0, 3]) && near(surface.platform!, [-4.5, 1.5, -4.5]) && surface.floor?.name === 'Room', surface);

finish();
