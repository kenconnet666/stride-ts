/**
 * 把一批矩形装进正方形的图集（贴花的贴图、货架的标签图集共用）。按行装箱、可以分页：贴图按高度从高到低排，一行一行往下放，每块四周留 padding；一页放不下时接着放下一页。返回每张贴图的
 * 页和位置（像素：页、x、y、宽、高，不含留边）；比一页还大的那张是 undefined。
 */
export function packPages(sizes: readonly (readonly [number, number])[], atlasSize: number, padding: number): ([number, number, number, number, number] | undefined)[] {
  const order = sizes.map((_, i) => i).sort((a, b) => sizes[b]![1] - sizes[a]![1]);
  const out: ([number, number, number, number, number] | undefined)[] = new Array(sizes.length);
  let page = 0, x = 0, y = 0, row = 0;
  for (const i of order) {
    const [w, h] = sizes[i]!;
    const pw = w + 2 * padding, ph = h + 2 * padding;
    if (pw > atlasSize || ph > atlasSize) continue;
    if (x + pw > atlasSize) {
      x = 0;
      y += row;
      row = 0;
    }
    if (y + ph > atlasSize) {
      page++;
      x = y = row = 0;
    }
    out[i] = [page, x + padding, y + padding, w, h];
    x += pw;
    row = Math.max(row, ph);
  }
  return out;
}
