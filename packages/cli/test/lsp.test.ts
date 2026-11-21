import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkEval, evalScopeFile, openEvalScope, parseSourcePosition, REPO_ROOT, TypeScriptServer } from '../src/lsp.ts';

describe('类型感知：纯函数', () => {
  it('文件:行:列 的解析认 Windows 的盘符', () => {
    expect(parseSourcePosition('C:/a/b.ts:12:5')).toEqual({ file: path.resolve('C:/a/b.ts'), line: 12, column: 5 });
    expect(() => parseSourcePosition('b.ts:12')).toThrow(/<file>:<line>:<column>/);
  });

  it('eval 的虚拟文件：前言声明作用域，代码当异步函数体，记下代码从第几行开始', () => {
    const scope = evalScopeFile('return game.frames;', ['frames', 'named']);
    expect(scope.text).toContain("declare const frames: __PageHelpers['frames'];");
    expect(scope.text.split('\n')[scope.firstLine - 1]).toBe('return game.frames;');
  });
});

// 真的起一个 TypeScript 7 的语言服务器（仓库里装的），问引擎的类型
describe('类型感知：TypeScript 的语言服务器', () => {
  let server: TypeScriptServer;
  beforeAll(async () => {
    server = await TypeScriptServer.start();
  });
  afterAll(() => server.close());

  it('eval 的代码按引擎的类型查：拼错的属性报出来，行号是代码里的', async () => {
    const errors = await checkEval(server, "const t = entity('Camera').require(engine.Transform);\nt.positon.x = 3;");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ line: 2, severity: 'error', code: 2551 });
    expect(errors[0]!.message).toContain("Did you mean 'position'");
    expect(await checkEval(server, 'await seconds(1);\nreturn game.world.loaded.length;')).toEqual([]);
  });

  it('悬停、补全、定义：eval 作用域里的 game.world', async () => {
    const scope = await openEvalScope(server, 'game.world.');
    const members = await server.completion({ file: scope.file, line: scope.firstLine, column: 'game.world.'.length + 1 });
    expect(members.find((member) => member.name === 'load')?.detail).toContain('load(path: string): Promise<WorldFile>');
    const file = path.join(REPO_ROOT, 'packages/engine/src/content/worldFormat.ts');
    server.open(file);
    // cellOrigin 的定义在哪一行现找（文件改了行号会变）
    const line = readFileSync(file, 'utf8').split('\n').findIndex((text) => text.startsWith('export const cellOrigin')) + 1;
    expect(await server.hover({ file, line, column: 14 })).toMatch(/^const cellOrigin: .*\n格子的原点/);
    const refs = await server.references({ file, line, column: 14 });
    expect(refs.some((ref) => ref.file === 'packages/engine/src/world/WorldStreaming.ts')).toBe(true);
  });
});
