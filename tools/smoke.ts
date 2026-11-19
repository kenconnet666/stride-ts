// 样例冒烟脚本（apps/*/scripts/smoke.ts）共用的部分：调用调试 CLI、记录检查结果、最后看有没有错误日志。
//   const smoke = startSmoke('physics-sample');   // 命令行的 --hub 覆盖默认的中枢名
//   smoke.check('在跑', (smoke.stride('status') as { status: string }).status === 'running', ...);
//   smoke.finish();                                // 查本次运行以来的错误日志，按结果退出
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'cli', 'src', 'cli.ts');

export interface Smoke {
  /** 跑一条调试 CLI 命令，返回它输出的 JSON。 */
  stride(...args: string[]): unknown;
  sleep(ms: number): Promise<void>;
  check(name: string, ok: boolean, detail: unknown): void;
  /** 检查本次运行以来没有错误日志（中枢留着之前的页面的日志，不算），然后按结果退出。 */
  finish(): never;
}

export function startSmoke(defaultHub: string): Smoke {
  const hubIndex = process.argv.indexOf('--hub');
  const hub = hubIndex >= 0 ? process.argv[hubIndex + 1]! : defaultHub;
  // 截图的 PNG 可能有几 MB（默认的输出上限是 1 MB）
  const run = (...args: string[]) => execFileSync(process.execPath, [cli, ...args, '--hub', hub], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  // logs --json 一行一条，seq 递增
  const lastSeq = (): number => {
    const lines = run('logs', '--json').trim().split('\n').filter(Boolean);
    return lines.length > 0 ? (JSON.parse(lines.at(-1)!) as { seq: number }).seq : 0;
  };
  const since = lastSeq();
  let failed = 0;
  const check = (name: string, ok: boolean, detail: unknown): void => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: ${JSON.stringify(detail)}`}`);
    if (!ok) failed++;
  };
  return {
    stride: (...args) => JSON.parse(run(...args)),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    check,
    finish: () => {
      const errors = run('logs', '--since', String(since), '--level', 'error').trim();
      check('没有错误日志', errors === '', errors.split('\n'));
      process.exit(failed > 0 ? 1 : 0);
    },
  };
}
