/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest';
import { stubGpuGlobals } from '../fakeGpu';

/**
 * 每个源文件都能经 Vite 的转换（oxc）加载：tsc 认、oxc 不认的写法（比如类型位置的 `typeof this.#私有字段`）类型检查发现不了，
 * 开发服务器上那个模块编不出来，页面停在加载（2026-11-22 踩过）。没被别的测试引到的模块只有这里会加载。
 */
describe('源文件都能加载', () => {
  test('src 下每个 .ts 经 Vite 转换、执行模块顶层不出错', async () => {
    stubGpuGlobals();
    const modules = import.meta.glob(['../../src/**/*.ts', '!../../src/**/*.d.ts']);
    const failures: string[] = [];
    for (const [path, load] of Object.entries(modules)) {
      try {
        await load();
      } catch (error) {
        failures.push(`${path}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
      }
    }
    expect(failures).toEqual([]);
    expect(Object.keys(modules).length).toBeGreaterThan(100);
  }, 120_000);
});
