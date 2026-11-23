import { describe, expect, test } from 'vitest';
import { parseJsonc, stripJsonc } from '../../src/data/jsonc';

describe('带注释的 JSON', () => {
  test('行注释、块注释、尾逗号都去掉；字符串里的 // 和 /* 照旧', () => {
    const text = `{
  // 货架的名字
  "name": "Deli", /* 熟食柜 */
  "url": "http://a/b // c /* d */",
  "levels": [0.88, 1.2,],
  "quote": "a \\" // b",
}`;
    expect(parseJsonc(text)).toEqual({ name: 'Deli', url: 'http://a/b // c /* d */', levels: [0.88, 1.2], quote: 'a " // b' });
  });

  test('去掉以后长度和行号不变', () => {
    const text = '{\n  "a": 1, // x\n  /* y\n z */ "b": 2,\n}';
    const plain = stripJsonc(text);
    expect(plain.length).toBe(text.length);
    expect(plain.split('\n').length).toBe(text.split('\n').length);
  });

  test('不对时报错带文件名和行列', () => {
    expect(() => parseJsonc('{\n  "a": 1\n  "b": 2\n}', 'X.shelf.json')).toThrow(/^X\.shelf\.json:3:3: /);
    expect(() => parseJsonc('{ /* 没有结尾 ', 'Y.json')).toThrow(/unterminated/);
  });

  test('标准的 JSON 原样解析', () => {
    const value = { a: [1, 2, { b: 'c' }], d: null, e: true };
    expect(parseJsonc(JSON.stringify(value, null, 1))).toEqual(value);
  });
});
