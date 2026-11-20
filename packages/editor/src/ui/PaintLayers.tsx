/**
 * 材质的图层栏（在模型上画贴图，S2）：材质层（MaterialFile.layers）按顺序列出，每层的填充（颜色、粗糙度、金属度）在这里改，
 * "画"进入视口里的绘制模式（画选中的实体上用这个材质的网格，画的是这层的遮罩）；"加绘制层"新建一张全黑的遮罩和一层。
 * 画的时候下面是笔刷（半径、硬度、强度、擦除）。层的别的写法（导入的、颜色树）在属性面板的"材质层"里按 JSON 改。
 */
import { _component } from '@zerodep-dev/vue-tsx-pro-tsx';
import { css } from '@zerodep-dev/vue-tsx-pro-tsx/styles';
import { t } from './messages';
import type { EditorSession } from './session';

const styles = css.create({
  box: { display: 'flex', flexDirection: 'column', gap: '4px', paddingBlock: '_xs', borderBlockEndWidth: '1px', borderBlockEndStyle: 'solid', borderBlockEndColor: '_border' },
  title: { fontWeight: '600' },
  row: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
  active: { outlineWidth: '1px', outlineStyle: 'solid', outlineColor: '_accent', borderRadius: '4px', padding: '2px' },
  small: { width: '4.5em' },
  hint: { color: '_textMuted', fontSize: '0.8em' },
});

/** 颜色树里的常量颜色（computeColor，sRGB）和 #rrggbb 互换。 */
const toHex = (value: unknown) => `#${((Array.isArray(value) ? value : [0.5, 0.5, 0.5]) as number[]).slice(0, 3).map((c) => Math.round(Math.min(Math.max(c, 0), 1) * 255).toString(16).padStart(2, '0')).join('')}`;
const fromHex = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).concat(1);

interface LayerFile {
  readonly diffuse?: { readonly $type?: string; readonly value?: unknown };
  readonly metalness?: { readonly $type?: string; readonly value?: unknown };
  readonly glossiness?: { readonly tree?: { readonly $type?: string; readonly value?: unknown }; readonly invert?: boolean };
  readonly blend?: { readonly texture?: { readonly texture?: string } };
}

export const PaintLayers = _component(({ session }: { session: EditorSession }) => {
  const number = (value: unknown, fallback: number) => (typeof value === 'number' ? value : fallback);
  const input = (event: Event) => (event.target as HTMLInputElement).value;

  return () => {
    const inspected = session.inspected.value;
    if (inspected?.kind !== 'material') return undefined;
    const layers = (inspected.content['layers'] as LayerFile[] | undefined) ?? [];
    const painting = session.painting.value;
    const brush = session.paintBrush.value;
    return (
      <div {...css.attrs(styles.box)}>
        <div {...css.attrs(styles.row)}>
          <span {...css.attrs(styles.title)}>{t.paintLayers}</span>
          <button type="button" onClick={() => void session.addPaintLayer()}>{t.paintAddLayer}</button>
        </div>
        {layers.map((layer, i) => {
          const paintable = Boolean(layer.blend?.texture?.texture);
          return (
            <div {...css.attrs(styles.row, painting?.layer === i && styles.active)}>
              <span>{t.paintLayer(i + 1)}</span>
              {layer.diffuse?.$type === 'computeColor' && (
                <input type="color" aria-label={t.paintColor} title={t.paintColor} value={toHex(layer.diffuse.value)}
                  onInput={(event: Event) => session.editInspected(['layers', i, 'diffuse', 'value'], fromHex(input(event)))} />
              )}
              {layer.glossiness?.tree?.$type === 'computeFloat' && (
                <label>{t.paintRoughness}<input {...css.attrs(styles.small)} type="number" min="0" max="1" step="0.05" value={number(layer.glossiness.tree.value, 0.5)}
                  onChange={(event: Event) => session.editInspected(['layers', i, 'glossiness', 'tree', 'value'], Number(input(event)))} /></label>
              )}
              {layer.metalness?.$type === 'computeFloat' && (
                <label>{t.paintMetalness}<input {...css.attrs(styles.small)} type="number" min="0" max="1" step="0.05" value={number(layer.metalness.value, 0)}
                  onChange={(event: Event) => session.editInspected(['layers', i, 'metalness', 'value'], Number(input(event)))} /></label>
              )}
              {paintable && (painting?.layer === i
                ? <button type="button" onClick={() => session.stopPainting()}>{t.paintStop}</button>
                : <button type="button" onClick={() => void session.startPainting(i)}>{t.paintStart}</button>)}
            </div>
          );
        })}
        {painting && (
          <div {...css.attrs(styles.row)}>
            <label>{t.paintRadius}<input {...css.attrs(styles.small)} type="number" min="0.01" step="0.05" value={brush.radius} onChange={(event: Event) => session.setPaintBrush({ ...brush, radius: Number(input(event)) })} /></label>
            <label>{t.paintHardness}<input {...css.attrs(styles.small)} type="number" min="0" max="1" step="0.1" value={brush.hardness} onChange={(event: Event) => session.setPaintBrush({ ...brush, hardness: Number(input(event)) })} /></label>
            <label>{t.paintStrength}<input {...css.attrs(styles.small)} type="number" min="0" max="1" step="0.1" value={brush.strength} onChange={(event: Event) => session.setPaintBrush({ ...brush, strength: Number(input(event)) })} /></label>
            <label><input type="checkbox" checked={brush.erase} onChange={(event: Event) => session.setPaintBrush({ ...brush, erase: (event.target as HTMLInputElement).checked })} />{t.paintErase}</label>
          </div>
        )}
        {painting && <div {...css.attrs(styles.hint)}>{t.paintHint}</div>}
      </div>
    );
  };
});
