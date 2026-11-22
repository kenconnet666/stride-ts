import { describe, expect, test } from 'vitest';
import type { EditorClient } from '../src/client/EditorClient.ts';
import { FileEditing } from '../src/ui/session/FileEditing.ts';

/** 记下存了什么的假客户端。 */
function fakeClient(fail = false) {
  const saved: unknown[] = [];
  const client = {
    saveAsset: (_kind: string, _path: string, content: object) => {
      saved.push(content);
      return fail ? Promise.reject(new Error('bake failed')) : Promise.resolve({});
    },
  } as unknown as EditorClient;
  return { client, saved };
}

describe('视口工具编辑的文件：撤销、重做、存盘', () => {
  test('commit 记一步、存盘；同一个文件不记；撤销重做把那一步交给 restore 再存盘', () => {
    const { client, saved } = fakeClient();
    const restored: unknown[] = [];
    const a = { n: 1 }, b = { n: 2 }, c = { n: 3 };
    const editing = new FileEditing({ client, kind: 'brush', path: 'Level/Room', file: a, restore: (file) => restored.push(file), onError: () => {} });
    expect(editing.history.canUndo).toBe(false);
    editing.commit(b);
    editing.commit(b);
    editing.commit(c);
    expect(saved).toEqual([b, c]);
    expect(editing.history.canUndo).toBe(true);
    editing.history.undo();
    expect(editing.file).toBe(b);
    expect(restored).toEqual([b]);
    editing.history.undo();
    expect(editing.file).toBe(a);
    expect(editing.history.canUndo).toBe(false);
    editing.history.redo();
    expect(editing.file).toBe(b);
    // 每次换回都存盘（后端重新烘模型）；存的是同一个对象，不是拷贝
    expect(saved).toEqual([b, c, b, a, b]);
    expect(saved[4]).toBe(b);
  });

  test('撤销以后再改：丢掉能重做的；存盘失败交给 onError', async () => {
    const { client } = fakeClient(true);
    const errors: string[] = [];
    const editing = new FileEditing({ client, kind: 'poly', path: 'P', file: { n: 0 }, restore: () => {}, onError: (message) => errors.push(message) });
    editing.commit({ n: 1 });
    editing.history.undo();
    editing.commit({ n: 2 });
    expect(editing.history.canRedo).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toEqual(['bake failed', 'bake failed', 'bake failed']);
  });
});
