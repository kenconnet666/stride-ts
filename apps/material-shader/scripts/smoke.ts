// MaterialShader 的冒烟测试：对着正在运行的页面（开发服务器或 preview），用调试 CLI 看一遍。
//   pnpm --filter @stride-ts/material-shader smoke [-- --hub <中枢名的一部分>]
// 检查：在跑；水面的材质带着游戏着色器类编的法线树和位移树；水面在动（隔半秒截两张，画面不一样）；没有错误日志（finish 检查）。
import { decodePng, diffImages } from '../../../packages/cli/src/png.ts';
import { startSmoke } from '../../../tools/smoke.ts';

const { stride, sleep, check, finish } = startSmoke('material-shader');

stride('eval', 'location.reload()');
await sleep(1500);
stride('wait');
await sleep(1000);
const status = stride('status') as { status: string; error: string | null };
check('在跑', status.status === 'running' && status.error === null, status);

type Trees = { normal: boolean; displacement: boolean; classes: boolean } | null;
const trees = stride('eval', `(() => {
  const model = strideGame.entities.ids().map((id) => strideGame.entities.entity(id)).map((e) => e.get(strideEngine.Model)).find(Boolean);
  const trees = model && strideEngine.Material.byId(model.material)?.shaderTrees;
  return trees ? { normal: !!trees.normal, displacement: !!trees.displacement, classes: trees.code.includes('fn ComputeColorWave(') && trees.code.includes('fn ComputeColorWaveNormal(') } : null;
})()`) as Trees;
check('水面的材质有法线树和位移树（游戏的着色器类）', trees?.normal === true && trees.displacement && trees.classes, trees);

const shot = () => decodePng(Buffer.from((stride('call', 'screenshot') as { png: string }).png, 'base64'));
const first = shot();
await sleep(500);
const second = shot();
const diff = diffImages(first, second);
check('水面在动（隔半秒的两张画面不一样）', diff.over['8']! > 1000, diff.over);

finish();
