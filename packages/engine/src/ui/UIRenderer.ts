/**
 * 画 UI 元素树（Stride 的 UIRenderFeature 加各元素的 DefaultXxxRenderer）：按树的顺序（面板按 ZIndex 排过）画，每个元素先画
 * 背景色，再画自己的东西（图片、九宫格的框、文字、弹窗的遮罩、滚动条、边框、滑条）。颜色是 sRGB，乘上不透明度（四个通道都乘，同 Stride）。
 *
 * 和 Stride 不同：
 * - 裁剪（ClipToBounds）用剪裁矩形（元素在屏幕上的包围盒），不用模板缓冲；转了角度的元素（包括斜放在 3D 里的 UI）裁到
 *   包围盒，而不是本身的形状。
 * - 不用深度缓冲排前后：画的顺序就是 Stride 的 DepthBias 的顺序。
 * - EditText 的文字区域按内边距放（Stride 放在元素中心，左右、上下内边距不一样时文字偏了）。
 */
import type { SpriteFrame } from '../rendering/SpriteSheet';
import type { DrawTextOptions, Quad, Rect, SpriteBatch } from '../rendering/text/SpriteBatch';
import { Border } from './controls/Border';
import { Button } from './controls/Button';
import { RichTextBlock } from './controls/RichTextBlock';
import { ScrollingText } from './controls/ScrollingText';
import { ToggleButton } from './controls/ToggleButton';
import { ContentDecorator } from './controls/ContentControl';
import { EditText } from './controls/EditText';
import { ImageElement } from './controls/ImageElement';
import { ModalElement } from './controls/ModalElement';
import { ScrollBar } from './controls/ScrollViewer';
import { Slider } from './controls/Slider';
import { TextBlock } from './controls/TextBlock';
import { spriteSize } from './sprites';
import type { Color, Matrix2D, Thickness, UIElement } from './UIElement';

export interface UIRenderContext {
  readonly batch: SpriteBatch;
  readonly virtualResolution: readonly [number, number];
  /** 真实像素 / 虚拟像素（放在 3D 里的 UI 是估计的）。 */
  readonly ratio: readonly [number, number];
  readonly snapText: boolean;
  /** 页面上的选区盖住这段文字的哪一段（影子 DOM，见 SemanticsLayer.selectionOf）。 */
  readonly selectionOf?: ((text: TextBlock) => readonly [number, number] | undefined) | undefined;
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
    clip = intersect(scissor, context.batch.screenBounds(elementQuad(element.worldMatrix, element.renderSize)));
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
  else if (element instanceof ToggleButton) drawSprite(batch, element, element.toggleButtonImage, scale(element.color, opacity));
  else if (element instanceof ScrollingText) drawScrollingText(element, context);
  else if (element instanceof RichTextBlock) drawRichTextBlock(element, context);
  else if (element instanceof TextBlock) drawTextBlock(element, context);
  else if (element instanceof EditText) drawEditText(element, context);
  else if (element instanceof ScrollBar) drawScrollBar(element, context);
  else if (element instanceof Border) drawBorder(element, context);
  else if (element instanceof Slider) drawSlider(element, context);
}

/** 四条边（Stride 的 DefaultBorderRenderer，只有前面那四条）；透明或者没有宽度时不画。 */
function drawBorder(border: Border, context: UIRenderContext): void {
  const color = scale(border.borderColor, border.renderOpacity);
  if (color.every((channel) => channel === 0)) return;
  const [w, h] = border.renderSize;
  const [left, top, right, bottom] = border.borderThickness;
  const origin = offset(border.worldMatrix, -w / 2, -h / 2);
  for (const [x, y, width, height] of [[0, 0, left, h], [w - right, 0, right, h], [0, 0, w, top], [0, h - bottom, w, bottom]] as const) {
    if (width > 0 && height > 0) context.batch.drawQuad(null, rectQuad(origin, x, y, width, height), WHOLE, color);
  }
}

/**
 * 滑条（Stride 的 DefaultSliderRenderer，水平的）：轨道背景铺满；轨道前景从起点画到当前值，图按比例裁（九宫格的边框不裁过头）；
 * 刻度；滑块。前景、刻度、滑块的高按轨道背景图的高缩放到元素的高。
 */
function drawSlider(slider: Slider, context: UIRenderContext): void {
  const { batch } = context;
  const color = scale(WHITE, slider.renderOpacity);
  const [w, h] = slider.renderSize;
  const m = slider.worldMatrix;
  const range = slider.maximum - slider.minimum;
  const ratio = range === 0 ? 0 : (slider.value - slider.minimum) / range;
  const [startOffset, endOffset] = slider.trackStartingOffsets;
  const gauge = w - startOffset - endOffset;
  const reversed = slider.isDirectionReversed;
  const track = slider.trackBackgroundSprite;
  const heightScale = track ? h / spriteSize(track)[1] : 1;
  if (track) drawSprite(batch, slider, track, color);

  const foreground = slider.trackForegroundImage?.getSprite();
  if (foreground) {
    const width = ratio * gauge;
    const leftOver = (w - width) / 2;
    const center = reversed ? leftOver - endOffset : startOffset - leftOver;
    const original = foreground.borders ?? [0, 0, 0, 0];
    const [first, last] = reversed ? [2, 0] : [0, 2];
    const borders = [...original] as [number, number, number, number];
    borders[first] = Math.min(borders[first]!, width);
    borders[last] = Math.max(0, width - gauge + borders[last]!);
    const [rx, ry, rw, rh] = foreground.region;
    const originalBorders = original[first]! + original[last]!;
    const regionWidth = borders[first]! + borders[last]! + (rw - originalBorders) * Math.min(1, (width - borders[first]!) / (gauge - originalBorders));
    const region = [reversed ? rx + rw - regionWidth : rx, ry, regionWidth, rh] as const;
    drawImage(batch, offset(m, center, 0), [width, spriteSize(foreground)[1] * heightScale], foreground.texture, region, borders, color);
  }

  const tick = slider.tickImage?.getSprite();
  if (slider.areTicksDisplayed && tick) {
    const [tw, th] = spriteSize(tick);
    const step = gauge / slider.tickFrequency;
    for (let i = 0; i <= slider.tickFrequency; i++) {
      drawImage(batch, offset(m, -gauge / 2 + i * step, slider.tickOffset * heightScale), [tw, th * heightScale], tick.texture, tick.region, tick.borders, color);
    }
  }

  const thumb = (slider.mouseOverState === 'element' ? slider.mouseOverThumbImage : slider.thumbImage)?.getSprite();
  if (thumb) {
    const [tw, th] = spriteSize(thumb);
    drawImage(batch, offset(m, ((reversed ? 1 - ratio : ratio) - 0.5) * gauge, 0), [tw, th * heightScale], thumb.texture, thumb.region, thumb.borders, color);
  }
}

function drawTextBlock(text: TextBlock, context: UIRenderContext): void {
  const font = text.font;
  if (!font) return;
  const [w, h] = text.renderSize;
  const selected = context.selectionOf?.(text);
  context.batch.drawText(font, text.textToDisplay, offset(text.worldMatrix, -w / 2, -h / 2), {
    fontSize: text.actualTextSize,
    color: scale(text.textColor, text.renderOpacity),
    alignment: text.textAlignment,
    boxWidth: w,
    snap: context.snapText && !text.doNotSnapText,
    outline: textOutline(text),
    selection: selected ? { start: selected[0], end: selected[1], color: scale(text.selectionColor, text.renderOpacity) } : undefined,
  });
}

/** 富文本：排好的样子按元素的宽对齐，颜色乘不透明度。 */
function drawRichTextBlock(text: RichTextBlock, context: UIRenderContext): void {
  const layout = text.richLayout;
  if (!layout) return;
  const [w, h] = text.renderSize;
  const opacity = text.renderOpacity;
  context.batch.drawRichText(layout, offset(text.worldMatrix, -w / 2, -h / 2), {
    colorOf: (style) => scale(text.colorOf(style), opacity),
    codeBackground: scale(text.codeBackgroundColor, opacity),
    alignment: text.textAlignment,
    boxWidth: w,
    snap: context.snapText && !text.doNotSnapText,
    outline: textOutline(text),
  });
}

/** 文字的描边（Stride 的 OutlineColor、OutlineThickness）；没设时不画。 */
function textOutline(text: TextBlock): DrawTextOptions['outline'] {
  return text.outlineThickness > 0 && text.outlineColor[3] > 0 ? { color: scale(text.outlineColor, text.renderOpacity), thickness: text.outlineThickness } : undefined;
}

/** 滚动的文字（Stride 的 DefaultScrollingTextRenderer）：那串字从左边偏 scrollingOffset 的地方画起，元素范围以外的被裁掉（clipToBounds）。 */
function drawScrollingText(text: ScrollingText, context: UIRenderContext): void {
  const font = text.font;
  if (!font || !Number.isFinite(text.scrollingOffset)) return;
  const [w, h] = text.renderSize;
  context.batch.drawText(font, text.textToDisplay, offset(text.worldMatrix, -w / 2 + text.scrollingOffset, -h / 2), {
    fontSize: text.actualTextSize,
    color: scale(text.textColor, text.renderOpacity),
    alignment: 'left',
    boxWidth: w,
    snap: context.snapText && !text.doNotSnapText,
    outline: textOutline(text),
  });
}

/** 输入框：图片，选区（或输入法拼的字）的底色，文字，光标（Stride 的 DefaultEditTextRenderer）。 */
function drawEditText(edit: EditText, context: UIRenderContext): void {
  const { batch } = context;
  drawSprite(batch, edit, edit.backgroundImage?.getSprite(), scale(WHITE, edit.renderOpacity));
  const font = edit.font;
  if (!font) return;
  const [w, h] = edit.renderSize;
  const [left, top, right] = edit.padding;
  const origin = offset(edit.worldMatrix, -w / 2 + left, -h / 2 + top);
  const boundaries = edit.isSelectionActive || edit.composition ? edit.textBoundaries() : undefined;
  if (boundaries) {
    const composing = edit.composition.length > 0;
    const start = edit.selectionStart, end = start + (composing ? [...edit.composition].length : edit.selectionLength);
    const color = scale(composing ? edit.imeSelectionColor : edit.selectionColor, edit.renderOpacity);
    // 每行一块
    for (let i = start; i < end;) {
      let j = i;
      while (j < end && boundaries.y[j + 1] === boundaries.y[i]) j++;
      const x0 = boundaries.x[i]!, x1 = boundaries.x[Math.max(j, i + 1)]!;
      if (x1 > x0) batch.drawQuad(null, rectQuad(origin, x0, boundaries.y[i]!, x1 - x0, boundaries.lineHeight), WHOLE, color);
      i = Math.max(j, i + 1);
    }
  }
  batch.drawText(font, edit.textToDisplay, origin, {
    fontSize: edit.actualTextSize,
    color: scale(edit.textColor, edit.renderOpacity),
    alignment: edit.textAlignment,
    boxWidth: w - left - right,
    snap: context.snapText && !edit.doNotSnapText,
  });
  if (boundaries && edit.isCaretVisible) {
    const caret = edit.composition ? edit.selectionStart + [...edit.composition].length : edit.caretPosition;
    const width = edit.caretWidth / context.ratio[0];
    batch.drawQuad(null, rectQuad(origin, boundaries.x[caret]!, boundaries.y[caret]!, width, boundaries.lineHeight), WHOLE, scale(edit.caretColor, edit.renderOpacity));
  }
}

/** origin 坐标系里的矩形。 */
function rectQuad(m: Matrix2D, x: number, y: number, width: number, height: number): Quad {
  return { origin: apply(m, x, y), axisX: [m[0] * width, m[1] * width], axisY: [m[2] * height, m[3] * height] };
}

/** 滚动条的大小向上取整到真实像素（同 Stride）。 */
function drawScrollBar(bar: ScrollBar, context: UIRenderContext): void {
  const size: [number, number] = [0, 1].map((d) => Math.ceil(bar.renderSize[d]! * context.ratio[d]!) / context.ratio[d]!) as [number, number];
  context.batch.drawQuad(null, elementQuad(bar.worldMatrix, size), WHOLE, bar.barColor);
}

/** 精灵铺满元素。 */
function drawSprite(batch: SpriteBatch, element: UIElement, sprite: SpriteFrame | undefined, color: Color): void {
  if (sprite) drawImage(batch, element.worldMatrix, element.renderSize, sprite.texture, sprite.region, sprite.borders, color);
}

/**
 * 贴图的 region（像素）铺满中心在 m 的原点、大小 size 的矩形；有九宫格的边框时四个角不拉伸（Stride 的 UIBatch.DrawImage 的
 * BorderRectangle）。
 */
function drawImage(batch: SpriteBatch, m: Matrix2D, size: readonly [number, number], texture: SpriteFrame['texture'], region: readonly [number, number, number, number], borders: Thickness | undefined, color: Color): void {
  const [w, h] = size;
  if (w * w + h * h < 1e-6) return;
  const { width, height } = texture.data;
  if (!borders || borders.every((border) => border === 0)) {
    batch.drawQuad(texture, elementQuad(m, size), [region[0] / width, region[1] / height, region[2] / width, region[3] / height], color);
    return;
  }
  const [left, top, right, bottom] = borders;
  // 元素里的分界（从左上角算）和贴图上的分界（像素）
  const xs = [0, left, w - right, w], ys = [0, top, h - bottom, h];
  const us = [region[0], region[0] + left, region[0] + region[2] - right, region[0] + region[2]];
  const vs = [region[1], region[1] + top, region[1] + region[3] - bottom, region[1] + region[3]];
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

function intersect(a: Rect | undefined, b: Rect): Rect {
  if (!a) return b;
  const x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[0] + a[2], b[0] + b[2]), y1 = Math.min(a[1] + a[3], b[1] + b[3]);
  return [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)];
}
