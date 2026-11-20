/**
 * UI 富文本的源文：Markdown 的一个子集，解析成一列块（段落、标题、列表项），每块是一串带样式的文字段（RichRun），交给
 * richLayout.ts 排版。写法照 CommonMark（强调的配对规则、转义、硬换行），没有的部分照 GFM、Pandoc：
 *
 * - 块：空行分段；`#` 到 `######` 标题；`-`、`*`、`+`、`1.`、`1)` 列表，每缩进两个空格深一层；段落里的单个换行是空格（软换行），
 *   行尾两个空格或 `\` 是硬换行。
 * - 行内：`**粗**`、`__粗__`、`*斜*`、`_斜_`、`~~删除线~~`（GFM）、`` `代码` ``、`[文字](地址)`、`\` 转义标点。
 * - Markdown 没有的颜色、字号、下划线用 Pandoc（也是 Djot）的方括号属性：`[文字]{color=#ff8800 size=120% .underline}`，
 *   链接后面也可以跟 `{…}`。普通的 Markdown 阅读器把它原样显示成文字，仍然读得懂。color 是 `#rgb`、`#rrggbb`、`#rrggbbaa`
 *   或 CSS 的基本颜色名；size 是虚拟像素或相对这段文字的百分比；`.underline`（同 Pandoc）加下划线。不认识的属性忽略。
 *
 * 不做的：引用块、代码块、表格、图片、HTML、自动链接、Setext 标题、分隔线（UI 里的文字用不上，要时再加）。
 */

export type RichColor = readonly [number, number, number, number];

/** 一段文字的样式。没写的继承外层（块、控件）。 */
export interface RichStyle {
  readonly bold: boolean;
  readonly italic: boolean;
  readonly code: boolean;
  readonly underline: boolean;
  readonly strikethrough: boolean;
  /** 链接：在 RichDocument.links 里的下标。 */
  readonly link?: number;
  /** sRGB 颜色；没写时用控件的颜色（链接、代码各有自己的）。 */
  readonly color?: RichColor;
  /** 字号是 (px ?? 控件的字号) · scale：标题、百分比的倍数乘在一起；写了 px 的那一层从 1 重新乘起。 */
  readonly scale: number;
  /** 虚拟像素的字号（`{size=24}`）。 */
  readonly px?: number;
}

/** 一段同样式的文字。text 里的 `\n` 是硬换行。 */
export interface RichRun {
  readonly text: string;
  readonly style: RichStyle;
}

export interface RichBlock {
  readonly kind: 'paragraph' | 'heading' | 'item';
  /** 标题是 1 到 6；列表项是层数（从 1 起）；段落是 0。 */
  readonly level: number;
  /** 列表项的记号：`•` 或 `3.`。 */
  readonly marker?: string;
  readonly runs: readonly RichRun[];
}

export interface RichDocument {
  readonly blocks: readonly RichBlock[];
  readonly links: readonly { readonly href: string }[];
}

/** 标题的字号倍数（同 GitHub 的样式表）。 */
export const HEADING_SCALE = [2, 1.5, 1.25, 1, 0.875, 0.85] as const;

const PLAIN: RichStyle = { bold: false, italic: false, code: false, underline: false, strikethrough: false, scale: 1 };

/** 解析 Markdown 源文。 */
export function parseMarkdown(source: string): RichDocument {
  const links: { href: string }[] = [];
  const blocks: RichBlock[] = [];
  for (const block of splitBlocks(source)) {
    const style = block.kind === 'heading' ? { ...PLAIN, bold: true, scale: HEADING_SCALE[block.level - 1]! } : PLAIN;
    const runs = flatten(parseInline(block.text), style, links);
    if (runs.length === 0 && block.kind === 'paragraph') continue;
    blocks.push({ kind: block.kind, level: block.level, ...(block.marker ? { marker: block.marker } : {}), runs });
  }
  return { blocks, links };
}

/** 文档里的纯文字（块之间换行，列表项带记号）：读屏、复制、没有字体时用。 */
export function plainText(document: RichDocument): string {
  return document.blocks.map((block) => (block.marker ? `${block.marker} ` : '') + block.runs.map((run) => run.text).join('')).join('\n');
}

// ---- 块 ----

interface RawBlock {
  kind: RichBlock['kind'];
  level: number;
  marker?: string;
  text: string;
}

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*)|$)/;

function splitBlocks(source: string): RawBlock[] {
  const blocks: RawBlock[] = [];
  let open: RawBlock | undefined;
  for (const line of source.replace(/\r\n?/g, '\n').split('\n')) {
    if (line.trim() === '') {
      open = undefined;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2] ?? '' });
      open = undefined;
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      const marker = /^\d/.test(item[2]!) ? `${Number.parseInt(item[2]!, 10)}.` : '•';
      open = { kind: 'item', level: Math.min(Math.floor(item[1]!.length / 2), 8) + 1, marker, text: item[3] ?? '' };
      blocks.push(open);
      continue;
    }
    // 接着上一行（段落和列表项都可以跨行，CommonMark 的懒续行）
    if (open) open.text += `\n${line.trimStart()}`;
    else blocks.push((open = { kind: 'paragraph', level: 0, text: line.trimStart() }));
  }
  return blocks;
}

// ---- 行内 ----

type Inline =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'break' }
  | { readonly type: 'code'; readonly text: string }
  | { readonly type: 'style'; readonly style: Partial<Mutable<RichStyle>> & { href?: string }; readonly children: Inline[] };

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** 还没配对的强调符号（CommonMark 的 delimiter run）。 */
interface Delimiter {
  readonly type: 'delimiter';
  readonly char: '*' | '_' | '~';
  count: number;
  readonly canOpen: boolean;
  readonly canClose: boolean;
  /** 原来的长度（"三的倍数"规则看它）。 */
  readonly length: number;
}

type Node = Inline | Delimiter;

const PUNCTUATION = /[\p{P}\p{S}]/u;
const WHITESPACE = /\s/u;
const ESCAPABLE = /[!-/:-@[-`{-~]/;

/** 解析一块里的行内标记。 */
export function parseInline(text: string): Inline[] {
  const nodes: Node[] = [];
  let plain = '';
  const flush = () => {
    if (plain) nodes.push({ type: 'text', text: plain });
    plain = '';
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '\\' && i + 1 < text.length) {
      const next = text[i + 1]!;
      if (next === '\n') {
        flush();
        nodes.push({ type: 'break' });
        i += 2;
        continue;
      }
      if (ESCAPABLE.test(next)) {
        plain += next;
        i += 2;
        continue;
      }
    }
    if (c === '\n') {
      // 行尾两个以上空格是硬换行，否则是软换行（空格）
      const hard = / {2,}$/.test(plain);
      plain = plain.replace(/ +$/, '');
      if (hard) {
        flush();
        nodes.push({ type: 'break' });
      } else {
        plain += ' ';
      }
      i++;
      while (text[i] === ' ') i++;
      continue;
    }
    if (c === '`') {
      const code = codeSpan(text, i);
      if (code) {
        flush();
        nodes.push({ type: 'code', text: code.text });
        i = code.end;
        continue;
      }
      const run = /^`+/.exec(text.slice(i))![0];
      plain += run;
      i += run.length;
      continue;
    }
    if (c === '[') {
      const bracket = bracketed(text, i);
      if (bracket) {
        flush();
        nodes.push({ type: 'style', style: bracket.style, children: parseInline(bracket.inner) });
        i = bracket.end;
        continue;
      }
    }
    if (c === '*' || c === '_' || c === '~') {
      let end = i;
      while (text[end] === c) end++;
      const length = end - i;
      // ~ 只认两个（GFM 的删除线）
      if (c === '~' && length !== 2) {
        plain += text.slice(i, end);
        i = end;
        continue;
      }
      flush();
      nodes.push(delimiter(c, length, text[i - 1], text[end]));
      i = end;
      continue;
    }
    plain += c;
    i++;
  }
  flush();
  processEmphasis(nodes);
  return nodes.map((node) => (node.type === 'delimiter' ? { type: 'text', text: node.char.repeat(node.count) } : node));
}

/** 一串强调符号能不能开、能不能关（CommonMark 的 left/right-flanking 规则）。 */
function delimiter(char: Delimiter['char'], length: number, before: string | undefined, after: string | undefined): Delimiter {
  const beforeSpace = before === undefined || WHITESPACE.test(before), afterSpace = after === undefined || WHITESPACE.test(after);
  const beforePunct = before !== undefined && PUNCTUATION.test(before), afterPunct = after !== undefined && PUNCTUATION.test(after);
  const left = !afterSpace && (!afterPunct || beforeSpace || beforePunct);
  const right = !beforeSpace && (!beforePunct || afterSpace || afterPunct);
  const canOpen = char === '_' ? left && (!right || beforePunct) : left;
  const canClose = char === '_' ? right && (!left || afterPunct) : right;
  return { type: 'delimiter', char, count: length, canOpen, canClose, length };
}

/** 配对强调符号（CommonMark 的 process emphasis）：配上的换成 style 节点，把中间的节点包进去。 */
function processEmphasis(nodes: Node[]): void {
  for (let closer = 0; closer < nodes.length; closer++) {
    const close = nodes[closer]!;
    if (close.type !== 'delimiter' || !close.canClose) continue;
    let opener = closer - 1;
    for (; opener >= 0; opener--) {
      const open = nodes[opener]!;
      if (open.type !== 'delimiter' || open.char !== close.char || !open.canOpen) continue;
      // 三的倍数规则：一边能开又能关时，两串长度之和是 3 的倍数（而两串不都是 3 的倍数）就不配
      const oddMatch = (open.canClose || close.canOpen) && (open.length + close.length) % 3 === 0 && !(open.length % 3 === 0 && close.length % 3 === 0);
      if (!oddMatch) break;
    }
    if (opener < 0) continue;
    const open = nodes[opener] as Delimiter;
    const use = close.char === '~' ? 2 : open.count >= 2 && close.count >= 2 ? 2 : 1;
    const style: Partial<Mutable<RichStyle>> = close.char === '~' ? { strikethrough: true } : use === 2 ? { bold: true } : { italic: true };
    // 中间还没配上的符号原样当文字
    const children = nodes.slice(opener + 1, closer).map((node): Inline => (node.type === 'delimiter' ? { type: 'text', text: node.char.repeat(node.count) } : node));
    open.count -= use;
    close.count -= use;
    const replacement: Node[] = [...(open.count > 0 ? [open] : []), { type: 'style', style, children }, ...(close.count > 0 ? [close] : [])];
    nodes.splice(opener, closer - opener + 1, ...replacement);
    // 关的那串还有剩的：从它现在的位置再配一次
    closer = opener + replacement.length - (close.count > 0 ? 2 : 1);
  }
}

/** i 处开始的代码段：同样长的一串反引号结束；首尾各一个空格去掉（两头都有、内容不全是空格时）。 */
function codeSpan(text: string, i: number): { text: string; end: number } | undefined {
  const ticks = /^`+/.exec(text.slice(i))![0];
  let at = i + ticks.length;
  for (;;) {
    const found = text.indexOf(ticks, at);
    if (found < 0) return undefined;
    let end = found + ticks.length;
    // 更长的一串反引号不算结束
    if (text[end] === '`') {
      while (text[end] === '`') end++;
      at = end;
      continue;
    }
    let content = text.slice(i + ticks.length, found).replace(/\n/g, ' ');
    if (content.length > 2 && content.startsWith(' ') && content.endsWith(' ') && content.trim() !== '') content = content.slice(1, -1);
    return { text: content, end };
  }
}

/** i 处的 `[…]` 后面跟着 `(地址)`（链接）或 `{属性}`（带样式的一段），可以都有；都没有时不是。 */
function bracketed(text: string, i: number): { inner: string; style: Partial<Mutable<RichStyle>> & { href?: string }; end: number } | undefined {
  const close = matchingBracket(text, i);
  if (close < 0) return undefined;
  const inner = text.slice(i + 1, close);
  let end = close + 1;
  const style: Partial<Mutable<RichStyle>> & { href?: string } = {};
  if (text[end] === '(') {
    const link = /^\(\s*(<[^>\n]*>|[^\s()]*)\s*\)/.exec(text.slice(end));
    if (!link) return undefined;
    style.href = link[1]!.replace(/^<|>$/g, '');
    end += link[0].length;
  }
  if (text[end] === '{') {
    const attributes = /^\{([^{}\n]*)\}/.exec(text.slice(end));
    if (attributes) {
      Object.assign(style, parseAttributes(attributes[1]!));
      end += attributes[0].length;
    }
  }
  return end === close + 1 ? undefined : { inner, style, end };
}

/** 和 i 处的 `[` 配对的 `]`（跳过转义和代码段）；没有时是 -1。 */
function matchingBracket(text: string, i: number): number {
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const c = text[j]!;
    if (c === '\\') j++;
    else if (c === '`') {
      const code = codeSpan(text, j);
      if (code) j = code.end - 1;
    } else if (c === '[') depth++;
    else if (c === ']' && --depth === 0) return j;
  }
  return -1;
}

/** `{color=#f80 size=120% .underline}` 里认识的属性。 */
export function parseAttributes(source: string): Partial<Mutable<RichStyle>> {
  const style: Partial<Mutable<RichStyle>> = {};
  for (const token of source.trim().split(/\s+/)) {
    if (token === '.underline') style.underline = true;
    const pair = /^([a-z-]+)=("?)(.*)\2$/i.exec(token);
    if (!pair) continue;
    const [, key, , value] = pair;
    if (key === 'color') {
      const color = parseColor(value!);
      if (color) style.color = color;
    } else if (key === 'size') {
      const percent = /^(\d+(?:\.\d+)?)%$/.exec(value!), pixels = /^(\d+(?:\.\d+)?)(?:px)?$/.exec(value!);
      if (percent) style.scale = Number(percent[1]) / 100;
      else if (pixels) style.px = Number(pixels[1]);
    }
  }
  return style;
}

/** CSS 的基本颜色名（CSS Level 1 的 16 个加 orange）。 */
const NAMED_COLORS: Readonly<Record<string, string>> = {
  black: '000000', silver: 'c0c0c0', gray: '808080', grey: '808080', white: 'ffffff', maroon: '800000', red: 'ff0000', purple: '800080', fuchsia: 'ff00ff',
  green: '008000', lime: '00ff00', olive: '808000', yellow: 'ffff00', navy: '000080', blue: '0000ff', teal: '008080', aqua: '00ffff', orange: 'ffa500',
};

/** `#rgb`、`#rrggbb`、`#rrggbbaa` 或颜色名换成 0..1 的 sRGB；认不出时是 undefined。 */
export function parseColor(value: string): RichColor | undefined {
  let hex = value.startsWith('#') ? value.slice(1) : NAMED_COLORS[value.toLowerCase()];
  if (!hex || !/^[0-9a-f]+$/i.test(hex)) return undefined;
  if (hex.length === 3 || hex.length === 4) hex = [...hex].map((c) => c + c).join('');
  if (hex.length === 6) hex += 'ff';
  if (hex.length !== 8) return undefined;
  return [0, 2, 4, 6].map((k) => Number.parseInt(hex!.slice(k, k + 2), 16) / 255) as unknown as RichColor;
}

/** 行内节点按嵌套合并样式，摊平成一串文字段（相邻同样式的合并）。 */
function flatten(nodes: readonly Inline[], style: RichStyle, links: { href: string }[], out: RichRun[] = []): RichRun[] {
  const push = (text: string, runStyle: RichStyle) => {
    const last = out.at(-1);
    if (last && last.style === runStyle) out[out.length - 1] = { text: last.text + text, style: runStyle };
    else out.push({ text, style: runStyle });
  };
  for (const node of nodes) {
    if (node.type === 'text') push(node.text, style);
    else if (node.type === 'break') push('\n', style);
    else if (node.type === 'code') push(node.text, style.code ? style : { ...style, code: true });
    else {
      const { href, scale, ...rest } = node.style;
      const inner: Mutable<RichStyle> = { ...style, ...rest, scale: (rest.px !== undefined ? 1 : style.scale) * (scale ?? 1) };
      if (href !== undefined) {
        inner.link = links.length;
        links.push({ href });
      }
      flatten(node.children, inner, links, out);
    }
  }
  return out;
}
