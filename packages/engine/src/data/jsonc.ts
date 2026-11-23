/**
 * 带注释的 JSON（内容文件给人看、人随时写注释用）：允许 `//` 行注释、`/* *\/` 块注释和对象、数组最后的尾逗号。
 *
 * 做法是把注释和尾逗号换成等长的空格（换行留着）再交给 JSON.parse：文字的长度、行号都不变，报错的位置就是原文的行列。
 * 写回照旧是 JSON.stringify——注释只给人看，工具存回去时不保留（用户 2026-11-23 定）。
 *
 *   parseJsonc('{ "a": 1, // 说明\n }', 'Shop/Shelves/Deli.shelf.json')  // { a: 1 }
 */

/** 解析带注释的 JSON；不对时报错，消息前面是 where 和行列（`where:3:5: invalid JSON: …`）。 */
export function parseJsonc(text: string, where = 'json'): unknown {
  const plain = stripJsonc(text);
  try {
    return JSON.parse(plain);
  } catch (error) {
    const message = (error as Error).message;
    const at = /position (\d+)/.exec(message);
    const position = at ? Number(at[1]) : undefined;
    const place = position === undefined ? '' : `:${lineColumn(plain, position).join(':')}`;
    throw new SyntaxError(`${where}${place}: invalid JSON: ${message.replace(/ in JSON at position \d+( \(line \d+ column \d+\))?/, '')}`, { cause: error });
  }
}

/** 注释、尾逗号换成空格（换行留着），其余原样：结果是标准的 JSON，长度和行号同原文。 */
export function stripJsonc(text: string): string {
  const out = text.split('');
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i++) if (out[i] !== '\n' && out[i] !== '\r') out[i] = ' ';
  };
  // 第一遍：注释（字符串里的 // 不算）
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
    } else if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      blank(i, end < 0 ? text.length : end);
      i = end < 0 ? text.length : end;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) throw new SyntaxError(`unterminated /* comment at ${lineColumn(text, i).join(':')}`);
      blank(i, end + 2);
      i = end + 1;
    }
  }
  // 第二遍：尾逗号（逗号后面跳过空白就是 } 或 ]）
  const stripped = out.join('');
  for (let i = 0; i < stripped.length; i++) {
    const c = stripped[i];
    if (c === '"') {
      for (i++; i < stripped.length && stripped[i] !== '"'; i++) if (stripped[i] === '\\') i++;
    } else if (c === ',') {
      let j = i + 1;
      while (j < stripped.length && /\s/.test(stripped[j]!)) j++;
      if (stripped[j] === '}' || stripped[j] === ']') out[i] = ' ';
    }
  }
  return out.join('');
}

/** 文字里第 position 个字符在第几行第几列（都从 1 起）。 */
function lineColumn(text: string, position: number): [number, number] {
  let line = 1, start = 0;
  for (let i = 0; i < position && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
      start = i + 1;
    }
  }
  return [line, position - start + 1];
}
