// ParticlesSample 的冒烟测试：对着正在运行的页面（开发服务器或 preview），用调试 CLI 把七个场景轮一遍（`next-scene` 命令，同 >> 按钮）。
//   pnpm --filter @stride-ts/particles-sample smoke [-- --hub <中枢名的一部分>]
// 每个场景：在跑、有粒子，加上这个场景要演示的东西：
// - MainScene：火、烟、火花（碰撞）；AnimatedParticles：曲线驱动的各列；RibbonParticles：飘带（按生成顺序连起）；
// - ChildParticles：四组子粒子都生出来了；CustomMaterials：着色器类和自定义材质的发射器在画；
// - CustomParticles：游戏自己的生成器、形状；Lasers：闪电弧，激光的网格材质是颜色树的自发光、加法透明、两面画。
// 最后回到 MainScene，没有错误日志（finish 检查）。
import { startSmoke } from '../../../tools/smoke.ts';

const { stride, sleep, check, finish } = startSmoke('particles-sample');

/** 页面里的帮手：emitters()：每个发射器 [实体名, 发射器名, 活着的粒子数, 形状的类名]。 */
const HELPERS = `(() => {
  globalThis.emitters = () => strideGame.particles.components.flatMap((c) => c.particleSystem.emitters.map((e) => [c.entity.name, e.name, e.pool.living, e.shape?.constructor.name ?? null]));
  return 1;
})()`;

type Emitter = [entity: string, emitter: string, living: number, shape: string | null];
const status = () => stride('status') as { status: string; error: string | null; scene: string };

stride('eval', 'location.href = location.origin + "/"');
await sleep(1500);
stride('wait');
await sleep(2000);

const seen: string[] = [];
for (let i = 0; i < 7; i++) {
  const { status: state, error, scene } = status();
  seen.push(scene);
  check(`${scene}：在跑`, state === 'running' && error === null, { state, error });
  stride('eval', HELPERS);
  const emitters = stride('eval', 'emitters()') as Emitter[];
  const living = (entity: string, emitter?: string) =>
    emitters.filter(([e, name]) => e === entity && (emitter === undefined || name === emitter)).reduce((sum, [, , n]) => sum + n, 0);
  const total = emitters.reduce((sum, [, , n]) => sum + n, 0);
  check(`${scene}：有粒子`, total > 50, { total, emitters: emitters.length });
  switch (scene) {
    case 'ChildParticles':
      check('ChildParticles：四组子粒子都生出来了', ['Ribbons', 'Smoke', 'Fireworks', 'Colliding Particles'].every((entity) => emitters.some(([e, , n]) => e === entity && n > 0)) && living('Ribbons', 'Child') > 0 && living('Smoke', 'Smoke') > 0,
        emitters.map(([e, name, n]) => `${e}/${name}=${n}`));
      break;
    case 'CustomParticles':
      check('CustomParticles：游戏自己的形状在画', emitters.length > 0 && emitters.every(([, , n, shape]) => n > 0 && shape === 'CustomParticleShape'), emitters);
      break;
    case 'RibbonParticles':
      check('RibbonParticles：飘带', emitters.some(([, , n, shape]) => n > 10 && shape === 'BuiltinShape'), emitters.length);
      break;
    case 'Lasers': {
      const material = stride('eval', `(() => {
        const found = strideGame.entities.ids().map((i) => strideGame.entities.entity(i)).flatMap((e) => { const m = e.get(strideEngine.Model); return m ? [strideEngine.Material.byId(m.material)] : []; })
          .find((m) => m?.emissiveShader);
        return found ? [found.name, found.isTransparent, found.doubleSided, found.transparency.alpha] : null;
      })()`) as [string, boolean, boolean, number] | null;
      check('Lasers：激光的材质（颜色树的自发光、加法透明、两面画）', material !== null && material[1] && material[2] && material[3] === 0, material);
      break;
    }
    default:
      break;
  }
  stride('call', 'next-scene');
  await sleep(2500);
}
check('七个场景都到过，又回到 MainScene', new Set(seen).size === 7 && status().scene === 'MainScene', seen);

finish();
