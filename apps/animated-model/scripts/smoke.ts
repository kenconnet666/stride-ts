// AnimatedModel 的冒烟测试：对着正在运行的页面（开发服务器或 preview，`stride open` 打开的），用调试 CLI 走一遍样例的玩法。
//   pnpm --filter @stride-ts/animated-model smoke [-- --hub <中枢名的一部分>]
// 每次先重新加载页面。检查：游戏在跑、没出错；开局在跑步；Idle 按钮（调试命令 idle）淡入待机、淡完只剩待机；Run 换回来；指针横向移动让角色转身。
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.resolve(app, '..', '..', 'packages', 'cli', 'src', 'cli.ts');
const hubIndex = process.argv.indexOf('--hub');
const hub = hubIndex >= 0 ? process.argv[hubIndex + 1]! : 'animated-model';

function stride(...args: string[]): unknown {
  const output = execFileSync(process.execPath, [cli, ...args, '--hub', hub], { encoding: 'utf8' });
  return JSON.parse(output);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let failed = 0;
function check(name: string, ok: boolean, detail: unknown): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
}

/** 角色正在播的动画名（权重从大到小）。 */
const playing = () => stride('eval', `const g = strideGame; const id = g.entities.ids().find((i) => g.entities.entity(i).name === 'CharacterModel');
  g.entities.entity(id).get(strideEngine.AnimationComponent).playingAnimations.map((p) => p.name)`) as string[];
const rotationY = () => (stride('inspect', 'CharacterModel') as { components: { Transform: { rotation: { y: number } } } }).components.Transform.rotation.y;

// 从刚加载的状态开始（页面要在前台：后台标签页的帧循环会停）
stride('eval', 'location.reload()');
await sleep(1000);
stride('wait');
const status = stride('status') as { status: string; error: string | null };
check('游戏在跑', status.status === 'running' && status.error === null, status);
check('开局在跑步', playing().join() === 'Run', playing());

stride('call', 'idle');
await sleep(600);
check('Idle 淡入淡出后只剩待机', playing().join() === 'Idle', playing());
stride('call', 'run');
await sleep(600);
check('Run 换回跑步', playing().join() === 'Run', playing());

const before = rotationY();
stride('mouse', 'move', '60', '0');
await sleep(500);
const after = rotationY();
check('指针横向移动让角色转身', Math.abs(after - before) > 0.1, { before, after });

const logs = execFileSync(process.execPath, [cli, 'logs', '--hub', hub], { encoding: 'utf8' });
check('没有错误日志', !/\berror\b/i.test(logs), logs.split('\n').filter((line) => /\berror\b/i.test(line)));
process.exit(failed > 0 ? 1 : 0);
