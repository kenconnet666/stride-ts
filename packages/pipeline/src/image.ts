/**
 * 全透明像素的颜色换成最近的不透明像素的颜色（alpha 渗色，Godot 的 fix_alpha_border、Unity 的 Alpha Is Transparency）。
 * 返回新数组，没有全透明像素、或者全都透明时原样返回。
 *
 * 为什么要做：我们的贴图存的是没预乘的值，全透明像素的颜色本来看不见，但
 * - 线性过滤会把它混进边缘（白底透明的图边缘发白、黑底的发黑）；
 * - UASTC/BC7 把颜色和 alpha 放在一个块里压，透明区里黑白相间的块 alpha 会压出误差，本来透明的地方透出一条线
 *   （Stride 用 BC3，alpha 单独压，没有这个问题）。
 * 按广度优先从不透明像素往外铺，每个透明像素取到的是（四邻接步数意义上）最近的那个的颜色。
 */
export function bleedTransparentColors(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const count = width * height;
  const queue = new Int32Array(count);
  let tail = 0;
  for (let i = 0; i < count; i++) if (pixels[i * 4 + 3] !== 0) queue[tail++] = i;
  if (tail === 0 || tail === count) return pixels;

  const result = pixels.slice();
  const filled = new Uint8Array(count);
  for (let k = 0; k < tail; k++) filled[queue[k]!] = 1;
  for (let head = 0; head < tail; head++) {
    const i = queue[head]!;
    const x = i % width;
    const visit = (j: number) => {
      if (filled[j]) return;
      filled[j] = 1;
      result.copyWithin(j * 4, i * 4, i * 4 + 3);
      queue[tail++] = j;
    };
    if (x > 0) visit(i - 1);
    if (x < width - 1) visit(i + 1);
    if (i >= width) visit(i - width);
    if (i < count - width) visit(i + width);
  }
  return result;
}

/**
 * 颜色键（Stride 贴图资源的 ColorKeyEnabled、ColorKeyColor，TextureConverter 的 ApplyColorKey）：四个分量都和 key 相等的像素
 * 变成全透明的黑。没有这样的像素时原样返回 pixels，否则返回新数组。
 */
export function applyColorKey(pixels: Uint8Array, key: readonly [number, number, number, number]): Uint8Array {
  let keyed: Uint8Array | undefined;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] !== key[0] || pixels[i + 1] !== key[1] || pixels[i + 2] !== key[2] || pixels[i + 3] !== key[3]) continue;
    keyed ??= pixels.slice();
    keyed.fill(0, i, i + 4);
  }
  return keyed ?? pixels;
}

/**
 * 1 位 alpha（Stride 贴图资源的 Alpha: Mask，桌面上压成 BC1）：alpha 不到一半的像素变成全透明的黑，其余变成不透明。
 * premultiplied（资源的 PremultiplyAlpha，默认开）时 Stride 在压之前先把颜色乘了 alpha，留下来的半透明像素是乘过的颜色，
 * 这里也先乘。alpha 本来就只有 0 和 255 时原样返回 pixels，否则返回新数组。
 */
export function maskAlpha(pixels: Uint8Array, premultiplied: boolean): Uint8Array {
  let masked: Uint8Array | undefined;
  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i + 3]!;
    if (alpha === 0 || alpha === 255) continue;
    masked ??= pixels.slice();
    if (alpha < 128) masked.fill(0, i, i + 4);
    else {
      if (premultiplied) for (let c = 0; c < 3; c++) masked[i + c] = Math.round((pixels[i + c]! * alpha) / 255);
      masked[i + 3] = 255;
    }
  }
  return masked ?? pixels;
}
