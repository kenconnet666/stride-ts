// ParticlesSample 的冒烟测试：对着正在运行的页面（开发服务器或 preview），用调试 CLI 把七个场景轮一遍（`next-scene` 命令，同 >> 按钮）。
//   pnpm --filter @stride-ts/particles-sample smoke [-- --hub <中枢名的一部分>]
// 每个场景：在跑、有粒子，加上这个场景要演示的东西：
// - MainScene：火、烟、火花（碰撞）；AnimatedParticles：曲线驱动的各列；RibbonParticles：飘带（按生成顺序连起）；
// - ChildParticles：四组子粒子都生出来了；CustomMaterials：着色器类和自定义材质的发射器在画；
// - CustomParticles：游戏自己的生成器、形状；Lasers：闪电弧，激光的网格材质是颜色树的自发光、加法透明、两面画。
// 最后回到 MainScene，没有错误日志（finish 检查）。
import { PAGE_HELPERS, startSmoke } from '@stride-ts/devkit/smoke';

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
stride('eval', PAGE_HELPERS);
stride('eval', HELPERS);
// 等待都按游戏时间和状态：CI 的软件 WebGPU 上一帧要几百毫秒，换场景（加载、编管线）要几十秒
stride('eval', 'seconds(2).then(() => 1)');

const seen: string[] = [];
for (let i = 0; i < 7; i++) {
  const { status: state, error, scene } = status();
  seen.push(scene);
  check(`${scene}：在跑`, state === 'running' && error === null, { state, error });
  const emitters = stride('eval', 'emitters()') as Emitter[];
  const total = emitters.reduce((sum, [, , n]) => sum + n, 0);
  check(`${scene}：有粒子`, total > 50, { total, emitters: emitters.length });
  switch (scene) {
    case 'ChildParticles': {
      // 子粒子由父粒子触发（Smoke 的烟在石头落地时才生），某一刻可能正好一个都没有：3 秒游戏时间内每组都出现过就算
      const most = stride('eval', `(async () => {
        const most = {}, prefixes = ['Ribbons/', 'Smoke/', 'Fireworks/', 'Colliding Particles/', 'Ribbons/Child', 'Smoke/Smoke'];
        const seen = () => prefixes.every((prefix) => Object.entries(most).some(([key, n]) => key.startsWith(prefix) && n > 0));
        const end = strideGame.updateTime.total + 3;
        do {
          for (const [e, name, n] of emitters()) most[e + '/' + name] = Math.max(most[e + '/' + name] ?? 0, n);
          if (seen()) break;
          await frame();
        } while (strideGame.updateTime.total < end);
        return most;
      })()`) as Record<string, number>;
      const groupsSeen = ['Ribbons/', 'Smoke/', 'Fireworks/', 'Colliding Particles/', 'Ribbons/Child', 'Smoke/Smoke']
        .every((prefix) => Object.entries(most).some(([key, n]) => key.startsWith(prefix) && n > 0));
      check('ChildParticles：四组子粒子都生出来了', groupsSeen, most);
      break;
    }
    case 'CustomParticles':
      check('CustomParticles：游戏自己的形状在画', emitters.length > 0 && emitters.every(([, , n, shape]) => n > 0 && shape === 'CustomParticleShape'), emitters);
      break;
    case 'RibbonParticles':
      check('RibbonParticles：飘带', emitters.some(([, , n, shape]) => n > 10 && shape === 'BuiltinShape'), emitters.length);
      break;
    case 'Lasers': {
      const material = stride('eval', `(() => {
        const found = strideGame.entities.ids().map((i) => strideGame.entities.entity(i)).flatMap((e) => { const m = e.get(strideEngine.Model); return m ? [strideEngine.Material.byId(m.material)] : []; })
          .find((m) => m?.shaderTrees?.emissive);
        return found ? [found.name, found.isTransparent, found.doubleSided, found.transparency.alpha] : null;
      })()`) as [string, boolean, boolean, number] | null;
      check('Lasers：激光的材质（颜色树的自发光、加法透明、两面画）', material !== null && material[1] && material[2] && material[3] === 0, material);
      // RotationScript 用代码建的动画剪辑（旋转的属性曲线）在转环
      const ring = `(() => { const g = strideGame, type = g.registry.scriptsNamed('RotationScript')[0];
        const e = g.entities.ids().map((i) => g.entities.entity(i)).find((e) => e.get(type));
        const r = e.require(strideEngine.Transform).rotation, a = e.get(strideEngine.AnimationComponent);
        return [a?.playingAnimations.map((p) => p.name).join() ?? '', +r.x.toFixed(3), +r.w.toFixed(3)]; })()`;
      const [before, after] = stride('eval', `(async () => { const before = ${ring}; await seconds(0.3); return [before, ${ring}]; })()`) as [[string, number, number], [string, number, number]];
      check('Lasers：环由属性曲线的动画带着转', before[0] === 'MyCustomAnimation' && (before[1] !== after[1] || before[2] !== after[2]), { before, after });
      break;
    }
    default:
      break;
  }
  stride('call', 'next-scene');
  // 换好以后等粒子生出来
  stride('eval', `sceneChanged(${JSON.stringify(scene)}).then(() => seconds(2)).then(() => 1)`);
}
check('七个场景都到过，又回到 MainScene', new Set(seen).size === 7 && status().scene === 'MainScene', seen);

// GPU 粒子（Stride 没有）：能放到 GPU 上的发射器都放上去以后照样在画、点得到，没有报错
stride('eval', 'strideGame.particles.simulation = "gpu"; 1');
// 换到 GPU 上从头模拟，管线在后台编：按游戏时间等粒子长出来（墙钟的 2 秒在 CI 上只有几帧）
stride('eval', '(async () => { await seconds(2); await frames(5); return 1; })()');
const onGpu = stride('eval', 'strideGame.particles.components.flatMap((c) => c.particleSystem.emitters).filter((e) => e.onGpu).length') as number;
check('GPU 粒子：MainScene 里火、喷泉这些发射器到了 GPU 上', onGpu >= 5, onGpu);
const picked = stride('pick', '630', '230') as { entity: { name: string } | null };
check('GPU 粒子：画出来了，点选点得到大火', picked.entity?.name === 'Big Fire', picked);
check('GPU 粒子：还在跑', status().status === 'running' && status().error === null, status());
stride('eval', 'strideGame.particles.simulation = "auto"; 1');

finish();
