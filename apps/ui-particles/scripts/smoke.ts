// UIParticles 的冒烟测试：对着正在运行的页面（开发服务器或 preview，`stride open` 打开的），用调试 CLI 走一遍。
//   pnpm --filter @stride-ts/ui-particles smoke [-- --hub <中枢名的一部分>]
// 检查：UI 画出来了；导火索在烧短，火在冒粒子、跟着导火索走；点"恭喜"进入结束（火停掉、大彩纸放起来，按钮上出现命中特效，
// 2 秒后移除）；点"重新开始"回到新游戏（火又点起来、彩纸停掉）；没有错误日志（finish 检查）。
// 点击用合成的指针事件，按元素的位置算坐标。
import { decodePng } from '@stride-ts/cli/png';
import { PAGE_HELPERS, startSmoke } from '../../../tools/lib/smoke.ts';

const { stride, sleep, check, finish } = startSmoke('ui-particles');
/** 命中特效的预制体里的实体。 */
const HIT = 'Hit Effect Particle System';

/** 页面里的帮手：uiButton(文字)（文字是它的按钮的中心）、particles(实体名)。 */
const HELPERS = `(() => {
  const canvas = document.querySelector('canvas');
  globalThis.uiButton = (text) => {
    const visit = (e) => e instanceof strideEngine.Button && e.content?.text === text ? e : [...e.visualChildren].map(visit).find(Boolean);
    for (const c of strideGame.ui.components) { const found = c.page?.rootElement && visit(c.page.rootElement); if (found) { const s = canvas.clientWidth / canvas.width; return [found.worldPosition[0] * s, found.worldPosition[1] * s]; } }
    throw new Error('no button ' + text);
  };
  globalThis.particles = (name) => named(name).reduce((sum, e) => sum + (e.get(strideEngine.ParticleSystemComponent)?.particleSystem.livingParticles ?? 0), 0);
  return 1;
})()`;

stride('eval', 'location.reload()');
await sleep(1500);
stride('wait');
await sleep(1500);
const status = stride('status') as { status: string; error: string | null };
check('在跑', status.status === 'running' && status.error === null, status);
stride('eval', PAGE_HELPERS);
stride('eval', HELPERS);

// 按钮的橙色
const { png } = stride('call', 'screenshot') as { png: string };
const { data } = decodePng(Buffer.from(png, 'base64'));
let orange = 0;
for (let i = 0; i < data.length; i += 4) if (data[i]! > 180 && data[i + 1]! > 60 && data[i + 1]! < 150 && data[i + 2]! < 60) orange++;
check('UI 画出来了（按钮）', orange > 5000, orange);

const fuse = () => stride('eval', `strideGame.ui.components[0].page.rootElement.findName('LifeBarBackground').source.getSprite().region[2]`) as number;
const f0 = fuse();
await sleep(1000);
const f1 = fuse();
check('导火索在烧短', f1 < f0, { f0, f1 });
const fireParticles = stride('eval', `particles('Fire')`) as number;
check('火在冒粒子', fireParticles > 0, fireParticles);
const fire0 = stride('eval', `position('Fire')`) as number[];
await sleep(1000);
const fire1 = stride('eval', `position('Fire')`) as number[];
check('火跟着导火索往左走', fire1[0]! < fire0[0]!, { fire0, fire1 });

// 命中特效只生成 0.5 秒、粒子活 1 秒：点完 0.2 秒就在页面里记下（隔几次 CLI 调用再查就晚了）
const spawned = stride('eval', `click(...uiButton('Congratulations')).then(() => new Promise((r) => setTimeout(r, 200)))
  .then(() => ({ entities: named('${HIT}').length, particles: particles('${HIT}') }))`) as { entities: number; particles: number };
await sleep(300);
const ended = stride('eval', `({ fire: particles('Fire'), confetti: particles('ConfettiBig'), confettiAt: position('ConfettiBig') })`) as { fire: number; confetti: number; confettiAt: number[] };
check('点"恭喜"：火停掉，大彩纸移到画面里放', ended.fire === 0 && ended.confetti > 0 && ended.confettiAt[0] === 0, ended);
check('按钮上出现命中特效', spawned.entities === 1 && spawned.particles > 0, spawned);
await sleep(2500);
const removed = stride('eval', `({ entities: named('${HIT}').length })`) as { entities: number };
check('命中特效 2 秒后移除', removed.entities === 0, removed);

stride('eval', `click(...uiButton('Click here to start the game over')).then(() => 1)`);
await sleep(800);
const restarted = stride('eval', `({ fire: particles('Fire'), confetti: particles('ConfettiBig') })`) as { fire: number; confetti: number };
check('点"重新开始"：火又点起来，彩纸停掉', restarted.fire > 0 && restarted.confetti === 0, restarted);

finish();
