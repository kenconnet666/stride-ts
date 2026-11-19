/**
 * 画 UI 元素树（Stride 的 UIRenderFeature 加各元素的 DefaultXxxRenderer）：按树的顺序（面板按 ZIndex 排过）画，每个元素先画
 * 背景色，再画自己的东西（图片、九宫格的框、文字、弹窗的遮罩、滚动条）。颜色是 sRGB，乘上不透明度（四个通道都乘，同 Stride）。
 *
 * 和 Stride 不同：
 * - 裁剪（ClipToBounds）用剪裁矩形（元素在屏幕上的包围盒），不用模板缓冲；转了角度的元素裁到包围盒，而不是本身的形状。
 * - 不用深度缓冲排前后：画的顺序就是 Stride 的 DepthBias 的顺序。
 * - EditText 的文字区域按内边距放（Stride 放在元素中心，左右、上下内边距不一样时文字偏了）。
 */
import type { SpriteFrame } from '../rendering/SpriteSheet';
import type { Quad, Rect, SpriteBatch } from '../rendering/text/SpriteBatch';
import { Button } from './controls/Button';
import { ContentDecorator } from './controls/ContentControl';
import { EditText } from './controls/EditText';
import { ImageElement } from './controls/ImageElement';
import { ModalElement } from './controls/ModalElement';
import { ScrollBar } from './controls/ScrollViewer';
import { TextBlock } from './controls/TextBlock';
import type { Color, Matrix2D, UIElement } from './UIElement';

export interface UIRenderContext {
  readonly batch: SpriteBatch;
  readonly virtualResolution: readonly [number, number];
  /** 真实像素 / 虚拟像素。 */
  readonly ratio: readonly [number, number];
  readonly snapText: boolean;
}

const WHOLE: Rect = [0, 0, 1, 1];
const WHITE: Color = [1, 1, 1, 1];

/** 画一棵元素树。 */
export function drawUI(root: UIElement, context: UIRenderContext): void {
  drawElement(root, context, undefined);
  context.batch.setScissor(undefined);
}

function drawElement(element: UIElement, context: UIRenderContext, scissor: Rect | undefined): void {
  if (!element.isVisible) return;
  let clip = scissor;
  if (element.clipToBounds) {
    clip = intersect(scissor, screenBounds(element, context.ratio));
    context.batch.setScissor(clip);
  }
  drawContent(element, context);
  for (const child of element.visualChildren) drawElement(child, context, clip);
  if (element.clipToBounds) context.batch.setScissor(scissor);
}

function drawContent(element: UIElement, context: UIRenderContext): void {
  const { batch } = context;
  const opacity = element.renderOpacity;
  // 弹窗先盖住整个 UI（遮罩不乘不透明度，同 Stride）
  if (element instanceof ModalElement) {
    const [vx, vy] = context.virtualResolution;
    batch.drawQuad(null, { origin: [0, 0], axisX: [vx, 0], axisY: [0, vy] }, WHOLE, element.overlayColor);
  }
  if (element.backgroundColor.some((channel) => channel !== 0)) {
    batch.drawQuad(null, elementQuad(element.worldMatrix, element.renderSize), WHOLE, scale(element.backgroundColor, opacity));
  }
  if (element instanceof ImageElement) drawSprite(batch, element, element.sprite, scale(element.color, opacity));
  else if (element instanceof ContentDecorator) drawSprite(batch, element, element.backgroundImage?.getSprite(), scale(WHITE, opacity));
  else if (element instanceof Button) drawSprite(batch, element, element.buttonImage, scale(element.color, opacity));
  else if (element instanceof TextBlock) drawTextBlock(element, context);
  else if (element instanceof EditText) drawEditText(element, context);
  else if (element instanceof ScrollBar) drawScrollBar(element, context);
}

function drawTextBlock(text: TextBlock, context: UIRenderContext): void {
  const font = text.font;
  if (!font) return;
  const [w, h] = text.renderSize;
  context.batch.drawText(font, text.textToDisplay, offset(text.worldMatrix, -w / 2, -h / 2), {
    fontSize: text.actualTextSize,
    color: scale(text.textColor, text.renderOpacity),
    alignment: text.textAlignment,
    boxWidth: w,
    snap: context.snapText && !text.doNotSnapText,
  });
}

function drawEditText(edit: EditText, context: UIRenderContext): void {
  drawSprite(context.batch, edit, edit.backgroundImage?.getSprite(), scale(WHITE, edit.renderOpacity));
  const font = edit.font;
  if (!font) return;
  const [w, h] = edit.renderSize;
  const [left, top, right] = edit.padding;
  context.batch.drawText(font, edit.textToDisplay, offset(edit.worldMatrix, -w / 2 + left, -h / 2 + top), {
    fontSize: edit.actualTextSize,
    color: scale(edit.textColor, edit.renderOpacity),
    alignment: edit.textAlignment,
    boxWidth: w - left - right,
    snap: context.snapText && !edit.doNotSnapText,
  });
}

/** 滚动条的大小向上取整到真实像素（同 Stride）。 */
function drawScrollBar(bar: ScrollBar, context: UIRenderContext): void {
  const size: [number, number] = [0, 1].map((d) => Math.ceil(bar.renderSize[d]! * context.ratio[d]!) / context.ratio[d]!) as [number, number];
  context.batch.drawQuad(null, elementQuad(bar.worldMatrix, size), WHOLE, bar.barColor);
}

/** 精灵铺满元素；有九宫格的边框时四个角不拉伸（Stride 的 UIBatch.DrawImage 的 BorderRectangle）。 */
function drawSprite(batch: SpriteBatch, element: UIElement, sprite: SpriteFrame | undefined, color: Color): void {
  if (!sprite) return;
  const [w, h] = element.renderSize;
  if (w * w + h * h < 1e-6) return;
  const { texture, region } = sprite;
  const { width, height } = texture.data;
  const borders = sprite.borders;
  if (!borders || borders.every((border) => border === 0)) {
    batch.drawQuad(texture, elementQuad(element.worldMatrix, element.renderSize), [region[0] / width, region[1] / height, region[2] / width, region[3] / height], color);
    return;
  }
  const [left, top, right, bottom] = borders;
  // 元素里的分界（从左上角算）和贴图上的分界（像素）
  const xs = [0, left, w - right, w], ys = [0, top, h - bottom, h];
  const us = [region[0], region[0] + left, region[0] + region[2] - right, region[0] + region[2]];
  const vs = [region[1], region[1] + top, region[1] + region[3] - bottom, region[1] + region[3]];
  const m = element.worldMatrix;
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) {
      const cw = xs[column + 1]! - xs[column]!, ch = ys[row + 1]! - ys[row]!;
      if (cw === 0 || ch === 0) continue;
      const quad: Quad = {
        origin: apply(m, xs[column]! - w / 2, ys[row]! - h / 2),
        axisX: [m[0] * cw, m[1] * cw],
        axisY: [m[2] * ch, m[3] * ch],
      };
      const uv: Rect = [us[column]! / width, vs[row]! / height, (us[column + 1]! - us[column]!) / width, (vs[row + 1]! - vs[row]!) / height];
      batch.drawQuad(texture, quad, uv, color);
    }
  }
}

/** 元素的矩形（世界矩阵的原点在中心）。 */
function elementQuad(m: Matrix2D, [w, h]: readonly [number, number]): Quad {
  return { origin: apply(m, -w / 2, -h / 2), axisX: [m[0] * w, m[1] * w], axisY: [m[2] * h, m[3] * h] };
}

function apply(m: Matrix2D, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** 原点移到局部坐标 (x, y) 的矩阵。 */
function offset(m: Matrix2D, x: number, y: number): Matrix2D {
  const [ox, oy] = apply(m, x, y);
  return [m[0], m[1], m[2], m[3], ox, oy];
}

function scale(color: Color, factor: number): Color {
  return factor === 1 ? color : [color[0] * factor, color[1] * factor, color[2] * factor, color[3] * factor];
}

/** 元素在屏幕上的包围盒，真实像素，向外取整。 */
function screenBounds(element: UIElement, ratio: readonly [number, number]): Rect {
  const quad = elementQuad(element.worldMatrix, element.renderSize);
  const xs = [0, quad.axisX[0], quad.axisY[0], quad.axisX[0] + quad.axisY[0]].map((x) => (quad.origin[0] + x) * ratio[0]);
  const ys = [0, quad.axisX[1], quad.axisY[1], quad.axisX[1] + quad.axisY[1]].map((y) => (quad.origin[1] + y) * ratio[1]);
  const x0 = Math.floor(Math.min(...xs)), y0 = Math.floor(Math.min(...ys));
  return [x0, y0, Math.ceil(Math.max(...xs)) - x0, Math.ceil(Math.max(...ys)) - y0];
}

function intersect(a: Rect | undefined, b: Rect): Rect {
  if (!a) return b;
  const x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[0] + a[2], b[0] + b[2]), y1 = Math.min(a[1] + a[3], b[1] + b[3]);
  return [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)];
}
