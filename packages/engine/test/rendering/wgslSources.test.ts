import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { wgslReservedWords } from '../fakeGpu';

const SRC = join(import.meta.dirname, '../../src');

/** 源码里标了 `/* wgsl *\/` 的模板字符串（插值 `${…}` 换成空格，按花括号配对跳过）。 */
function wgslLiterals(source: string): string[] {
  const literals: string[] = [];
  const marker = '/* wgsl */';
  for (let at = source.indexOf(marker); at >= 0; at = source.indexOf(marker, at + 1)) {
    let i = source.indexOf('`', at + marker.length);
    if (i < 0) break;
    let text = '';
    for (i++; i < source.length && source[i] !== '`'; i++) {
      if (source[i] === '\\') { text += source[i + 1]; i++; continue; }
      if (source[i] === '$' && source[i + 1] === '{') {
        let depth = 0;
        for (i++; i < source.length; i++) {
          if (source[i] === '{') depth++;
          else if (source[i] === '}' && --depth === 0) break;
        }
        text += ' ';
        continue;
      }
      text += source[i];
    }
    literals.push(text);
  }
  return literals;
}

describe('WGSL 源码', () => {
  test('标了 wgsl 的模板字符串里没有 WGSL 的保留字（Chrome 编不过）', () => {
    const files = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('.ts'));
    const found: string[] = [];
    let count = 0;
    for (const file of files) {
      for (const literal of wgslLiterals(readFileSync(join(SRC, file), 'utf8'))) {
        count++;
        const reserved = wgslReservedWords(literal);
        if (reserved.length > 0) found.push(`${file}: ${reserved.join(', ')}`);
      }
    }
    expect(count).toBeGreaterThan(100);
    expect(found).toEqual([]);
  });

  test('保留字按标识符认，注释里的不算', () => {
    expect(wgslReservedWords('// active\nlet operator = 1; /* filter */ let activeCount = 2;')).toEqual(['operator']);
  });
});
