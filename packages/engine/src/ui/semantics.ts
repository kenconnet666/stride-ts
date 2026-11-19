/**
 * UI 的语义树：从元素树算出"读屏软件、浏览器的查找和复制该看到什么"——每段文字、每个控件一个节点，带角色、名字、状态和
 * 在虚拟坐标里的位置。这里只算描述，不碰 DOM（可以单测）；同步到页面上的是 SemanticsLayer。
 *
 * 节点是平的一列（按树的顺序，也就是阅读的顺序），不照元素树嵌套：每个节点各自按世界矩阵摆。按钮的名字取自它里面的文字，
 * 所以按钮里的文字节点对读屏软件藏起来（hidden），不读两遍；查找、复制仍然找得到它们。
 */
import { ButtonBase } from './controls/Button';
import { EditText } from './controls/EditText';
import { ModalElement } from './controls/ModalElement';
import { ScrollingText } from './controls/ScrollingText';
import { Slider } from './controls/Slider';
import { TextBlock } from './controls/TextBlock';
import { ToggleButton } from './controls/ToggleButton';
import type { Matrix2D, UIElement, Vec2 } from './UIElement';

export type SemanticsRole = 'text' | 'marquee' | 'button' | 'checkbox' | 'slider' | 'dialog' | 'textbox';

/** 文字的一行：位置相对元素左上角，虚拟像素；start 是这一行第一个字在 textToDisplay 里的位置（按码位数）。 */
export interface SemanticsLine {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly start: number;
}

export interface SemanticsNode {
  readonly element: UIElement;
  readonly role: SemanticsRole;
  /** 读屏软件读的名字（文字节点是文字本身）。 */
  readonly label: string;
  /** 元素左上角为原点的坐标 → UI 的虚拟坐标。 */
  readonly matrix: Matrix2D;
  readonly size: Vec2;
  readonly disabled: boolean;
  /** 对读屏软件藏起来（按钮里的文字：按钮的名字里已经有了）。 */
  readonly hidden: boolean;
  /** 被模态的弹窗挡住：读不到、Tab 走不到、不能操作，和指针点不到它一样。 */
  readonly blocked: boolean;
  /** 输入框里的文字（密码框是一串圆点）。 */
  readonly value?: string;
  readonly readOnly?: boolean;
  /** 开关按钮的状态。 */
  readonly checked?: 'true' | 'false' | 'mixed';
  /** 滑条的范围和值。 */
  readonly range?: { readonly min: number; readonly max: number; readonly value: number };
  readonly text?: { readonly lines: readonly SemanticsLine[]; readonly fontSize: number; readonly lineHeight: number; readonly selectable: boolean };
}

/**
 * root 这棵 UI 的语义节点，按树的顺序。看不见的元素和它的后代不算。有模态的弹窗时，最上面那个弹窗以外的节点都标成 blocked。
 */
export function collectSemantics(root: UIElement): SemanticsNode[] {
  const nodes: Mutable<SemanticsNode>[] = [];
  visit(root, false, nodes);
  const modal = nodes.findLast((node) => node.element instanceof ModalElement && node.element.isModal)?.element;
  if (modal) for (const node of nodes) node.blocked = !isInside(node.element, modal);
  return nodes;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function isInside(element: UIElement, ancestor: UIElement): boolean {
  for (let current: UIElement | null = element; current; current = current.visualParent) if (current === ancestor) return true;
  return false;
}

function visit(element: UIElement, insideControl: boolean, nodes: SemanticsNode[]): void {
  if (!element.isVisible) return;
  const [w, h] = element.renderSize;
  const [a, b, c, d, e, f] = element.worldMatrix;
  // 世界矩阵的原点在元素中心
  const base = {
    element,
    matrix: [a, b, c, d, e - (a * w + c * h) / 2, f - (b * w + d * h) / 2] as Matrix2D,
    size: [w, h] as Vec2,
    disabled: !element.isHierarchyEnabled,
    blocked: false,
  };
  if (element instanceof EditText) {
    const value = element.inputType === 'password' ? '•'.repeat([...element.text].length) : element.text;
    // 正在编辑时真的输入框（TextInputBridge）在读屏软件那里代表它，这个节点藏起来，只留着占 Tab 顺序里的位置
    nodes.push({ ...base, role: 'textbox', label: nameOf(element), hidden: element.isSelectionActive, value, readOnly: element.isReadOnly });
    return;
  }
  if (element instanceof TextBlock) {
    const marquee = element instanceof ScrollingText;
    // 滚动的文字给读屏软件的是整段，不是这一帧露出来的那几个字
    const lines = marquee ? [{ text: element.text ?? '', x: 0, y: 0, width: w, start: 0 }] : textLines(element);
    const label = lines.map((line) => line.text).join('\n');
    if (label.trim() === '') return;
    const lineHeight = marquee ? h : element.calculateTextSize()[1] / lines.length;
    nodes.push({
      ...base, role: marquee ? 'marquee' : 'text', label, hidden: insideControl,
      text: { lines, fontSize: element.actualTextSize, lineHeight, selectable: element.isSelectable && !marquee },
    });
    return;
  }
  if (element instanceof Slider) {
    nodes.push({ ...base, role: 'slider', label: nameOf(element), hidden: false, range: { min: element.minimum, max: element.maximum, value: element.value } });
    return;
  }
  if (element instanceof ModalElement) {
    nodes.push({ ...base, role: 'dialog', label: nameOf(element), hidden: false });
  } else if (element instanceof ButtonBase) {
    const checked = element instanceof ToggleButton ? ({ checked: 'true', unChecked: 'false', indeterminate: 'mixed' } as const)[element.state] : undefined;
    nodes.push({ ...base, role: checked ? 'checkbox' : 'button', label: nameOf(element, true), hidden: false, ...(checked ? { checked } : {}) });
    insideControl = true;
  }
  for (const child of element.visualChildren) visit(child, insideControl, nodes);
}

/** 元素的名字：accessibleLabel；没设时（fromContent）取里面的文字；再没有就是 name。 */
function nameOf(element: UIElement, fromContent = false): string {
  if (element.accessibleLabel !== null) return element.accessibleLabel;
  const content = fromContent ? contentText(element).join(' ').trim() : '';
  return content || element.name || '';
}

function contentText(element: UIElement, out: string[] = []): string[] {
  for (const child of element.visualChildren) {
    if (!child.isVisible) continue;
    if (child instanceof TextBlock) out.push((child.text ?? '').trim());
    else contentText(child, out);
  }
  return out;
}

/** 文字照画出来的样子分行（换行以后的），每行按对齐方式摆。 */
function textLines(text: TextBlock): SemanticsLine[] {
  const lines = text.textToDisplay.split('\n');
  const lineHeight = text.calculateTextSize()[1] / lines.length;
  const boxWidth = text.renderSize[0];
  let start = 0;
  return lines.map((line, i) => {
    const width = text.calculateTextSize(line)[0];
    const x = text.textAlignment === 'center' ? (boxWidth - width) / 2 : text.textAlignment === 'right' ? boxWidth - width : 0;
    const result = { text: line, x, y: i * lineHeight, width, start };
    start += [...line].length + 1;
    return result;
  });
}

/** 节点画到 DOM 上会用到的全部内容拼成的字符串：和上一次一样就不用动 DOM。 */
export function semanticsKey(node: SemanticsNode): string {
  const { role, label, matrix, size, disabled, hidden, blocked, checked, range, text, value, readOnly } = node;
  const numbers = [...matrix, ...size].map((value) => Math.round(value * 100) / 100).join(',');
  const lines = text ? `${text.fontSize},${text.lineHeight},${text.selectable},${text.lines.map((line) => `${line.x},${line.y},${line.width}`).join(';')}` : '';
  return `${role}|${label}|${numbers}|${disabled}|${hidden}|${blocked}|${value ?? ''}|${readOnly ?? ''}|${checked ?? ''}|${range ? `${range.min},${range.max},${range.value}` : ''}|${lines}`;
}
