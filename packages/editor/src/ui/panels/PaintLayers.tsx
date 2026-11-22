/**
 * 材质的图层栏（在模型上画贴图，S2）：材质层（MaterialFile.layers）按顺序列出，每层的填充（颜色、粗糙度、金属度）在这里改，
 * "画"进入视口里的绘制模式（画选中的实体上用这个材质的网格，画的是这层的遮罩）；"加绘制层"新建一张全黑的遮罩和一层。
 * 画的时候下面是笔刷（半径、硬度、强度、擦除）。层的别的写法（导入的、颜色树）在属性面板的"材质层"里按 JSON 改。
 */
import { _component } from '@zerodep-dev/vue-tsx-pro-tsx';
import { css } from '@zerodep-dev/vue-tsx-pro-tsx/styles';
import { Brush, Plus, Square } from '@lucide/icons';
import { Button, Checkbox, ColorField, NumberField } from '@zerodep-dev/vue-tsx-pro-ui';
import { t } from '../i18n/messages';
import type { EditorSession } from '../session/EditorSession';

const styles = css.create({
  box: { display: 'flex', flexDirection: 'column', gap: '4px', paddingBlock: '_xs', borderBlockEndWidth: '1px', borderBlockEndStyle: 'solid', borderBlockEndColor: '_border' },
  title: { fontWeight: '600' },
  row: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
  active: { outlineWidth: '1px', outlineStyle: 'solid', outlineColor: '_accent', borderRadius: '4px', padding: '2px' },
  small: { width: '7.5em' },
  hint: { color: '_textMuted', fontSize: '0.8em' },
});

/** 颜色树里的常量颜色（computeColor，sRGB）和 #rrggbb 互换。 */
const toHex = (value: unknown) => `#${((Array.isArray(value) ? value : [0.5, 0.5, 0.5]) as number[]).slice(0, 3).map((c) => Math.round(Math.min(Math.max(c, 0), 1) * 255).toString(16).padStart(2, '0')).join('')}`;
const fromHex = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).concat(1);

/** 一个 0..max 的小数输入框（前面是名字）。 */
const amount = (label: string, value: number, change: (next: number) => void, { min = 0, max = 1, step = 0.05 } = {}) => (
  <NumberField {...css.attrs(styles.small)} size="sm" prefix={label} min={min} max={max} step={step} format={{ useGrouping: false, maximumFractionDigits: 3 }}
    _value={value} onUpdate:_value={(next: number | null) => next !== null && change(next)} />
);

interface LayerFile {
  readonly diffuse?: { readonly $type?: string; readonly value?: unknown };
  readonly metalness?: { readonly $type?: string; readonly value?: unknown };
  readonly glossiness?: { readonly tree?: { readonly $type?: string; readonly value?: unknown }; readonly invert?: boolean };
  readonly blend?: { readonly texture?: { readonly texture?: string } };
}

export const PaintLayers = _component(({ session }: { session: EditorSession }) => {
  const number = (value: unknown, fallback: number) => (typeof value === 'number' ? value : fallback);

  return () => {
    const inspected = session.inspected.value;
    if (inspected?.kind !== 'material') return undefined;
    const layers = (inspected.content['layers'] as LayerFile[] | undefined) ?? [];
    const painting = session.tools.painting.value;
    const brush = session.tools.paintBrush.value;
    return (
      <div {...css.attrs(styles.box)}>
        <div {...css.attrs(styles.row)}>
          <span {...css.attrs(styles.title)}>{t.paintLayers}</span>
          <Button size="sm" variant="soft" tone="neutral" icon={Plus} onClick={() => void session.tools.addPaintLayer()}>{t.paintAddLayer}</Button>
        </div>
        {layers.map((layer, i) => {
          const paintable = Boolean(layer.blend?.texture?.texture);
          return (
            <div {...css.attrs(styles.row, painting?.layer === i && styles.active)}>
              <span>{t.paintLayer(i + 1)}</span>
              {layer.diffuse?.$type === 'computeColor' && (
                <ColorField size="sm" aria-label={t.paintColor} title={t.paintColor} _value={toHex(layer.diffuse.value)}
                  onUpdate:_value={(hex: string) => session.editInspected(['layers', i, 'diffuse', 'value'], fromHex(hex))} />
              )}
              {layer.glossiness?.tree?.$type === 'computeFloat' && (
                amount(t.paintRoughness, number(layer.glossiness.tree.value, 0.5), (value) => session.editInspected(['layers', i, 'glossiness', 'tree', 'value'], value))
              )}
              {layer.metalness?.$type === 'computeFloat' && (
                amount(t.paintMetalness, number(layer.metalness.value, 0), (value) => session.editInspected(['layers', i, 'metalness', 'value'], value))
              )}
              {paintable && (painting?.layer === i
                ? <Button size="sm" variant="solid" tone="accent" icon={Square} onClick={() => session.tools.stop()}>{t.paintStop}</Button>
                : <Button size="sm" variant="soft" tone="neutral" icon={Brush} onClick={() => void session.tools.startPainting(i)}>{t.paintStart}</Button>)}
            </div>
          );
        })}
        {painting && (
          <div {...css.attrs(styles.row)}>
            {amount(t.paintRadius, brush.radius, (radius) => radius > 0 && session.tools.setPaintBrush({ ...brush, radius }), { min: 0.01, max: 100 })}
            {amount(t.paintHardness, brush.hardness, (hardness) => session.tools.setPaintBrush({ ...brush, hardness }), { step: 0.1 })}
            {amount(t.paintStrength, brush.strength, (strength) => session.tools.setPaintBrush({ ...brush, strength }), { step: 0.1 })}
            <Checkbox size="sm" _checked={brush.erase} onUpdate:_checked={(erase: boolean) => session.tools.setPaintBrush({ ...brush, erase })}>{t.paintErase}</Checkbox>
          </div>
        )}
        {painting && <div {...css.attrs(styles.hint)}>{t.paintHint}</div>}
      </div>
    );
  };
});
