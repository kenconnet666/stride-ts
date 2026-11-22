/**
 * 材质的图层栏（在模型上画贴图，S2）：材质层（MaterialFile.layers）按顺序列出，每层的填充（颜色、粗糙度、金属度）在这里改，
 * "画"进入视口里的绘制模式（画选中的实体上用这个材质的网格，画的是这层的遮罩）；"加绘制层"新建一张全黑的遮罩和一层。
 * 填充也可以是一张节点图（"填充"菜单选库里带节点图的材质，比如掉漆的金属：画到哪儿，哪儿就是那种材质，磨损、脏污的规则跟着走），
 * "节点图"在下面的节点图面板里改这层的图。画的时候下面是笔刷（半径、硬度、强度、擦除）。层的别的写法（导入的、颜色树）在属性
 * 面板的"材质层"里按 JSON 改。
 */
import { _component } from '@zerodep-dev/vue-tsx-pro-tsx';
import { css } from '@zerodep-dev/vue-tsx-pro-tsx/styles';
import { Brush, Layers, Plus, Square, Workflow } from '@lucide/icons';
import type { GraphFile } from '@stride-ts/engine/node-graph';
import { Button, Checkbox, ColorField, Flex, FormSection, Menu, MenuGroup, MenuItem, NumberField, Small, Text } from '@zerodep-dev/vue-tsx-pro-ui';
import { LIBRARY_MATERIALS } from '../../library/index.ts';
import { t } from '../i18n/messages';
import type { EditorSession } from '../session/EditorSession';

const styles = css.create({
  // 正在画的那一层描一圈品牌色
  active: { outlineWidth: '1px', outlineStyle: 'solid', outlineColor: '_accent', borderRadius: '_sm', padding: '2px' },
  small: { width: '7.5em' },
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
  readonly graph?: GraphFile;
}

/** 能当填充的库材质：带节点图的，智能材质排前面。 */
const GRAPH_FILLS = LIBRARY_MATERIALS.filter((item) => item.material.graph).sort((a, b) => Number(b.category === 'smart') - Number(a.category === 'smart'));

export const PaintLayers = _component(({ session }: { session: EditorSession }) => {
  const number = (value: unknown, fallback: number) => (typeof value === 'number' ? value : fallback);

  return () => {
    const inspected = session.inspected.value;
    if (inspected?.kind !== 'material') return undefined;
    const layers = (inspected.content['layers'] as LayerFile[] | undefined) ?? [];
    const painting = session.tools.painting.value;
    const brush = session.tools.paintBrush.value;
    return (
      <FormSection density="compact" title={t.paintLayers}
        extra={<Button size="sm" variant="soft" tone="neutral" icon={Plus} onClick={() => void session.tools.addPaintLayer()}>{t.paintAddLayer}</Button>}>
        {layers.map((layer, i) => {
          const paintable = Boolean(layer.blend?.texture?.texture);
          return (
            <Flex align="center" gap="sm" wrap sx={painting?.layer === i && styles.active}>
              <Text>{t.paintLayer(i + 1)}</Text>
              <Menu trigger={(props) => <Button {...props} size="sm" variant="soft" tone="neutral" icon={Layers}>{layer.graph ? t.paintFillGraph : t.paintFill}</Button>}>
                <MenuItem onAction={() => session.setLayerFill(i, undefined)}>{t.paintFillPlain}</MenuItem>
                <MenuGroup label={t.paintFillLibrary}>
                  {GRAPH_FILLS.map((item) => <MenuItem onAction={() => session.setLayerFill(i, item.material.graph)}>{t.library.names[item.id] ?? item.id}</MenuItem>)}
                </MenuGroup>
              </Menu>
              {layer.graph && <Button size="sm" variant="soft" tone="neutral" icon={Workflow} onClick={() => session.openMaterialGraph(i)}>{t.graphOpen}</Button>}
              {!layer.graph && layer.diffuse?.$type === 'computeColor' && (
                <ColorField size="sm" aria-label={t.paintColor} title={t.paintColor} _value={toHex(layer.diffuse.value)}
                  onUpdate:_value={(hex: string) => session.editInspected(['layers', i, 'diffuse', 'value'], fromHex(hex))} />
              )}
              {!layer.graph && layer.glossiness?.tree?.$type === 'computeFloat' && (
                amount(t.paintRoughness, number(layer.glossiness.tree.value, 0.5), (value) => session.editInspected(['layers', i, 'glossiness', 'tree', 'value'], value))
              )}
              {!layer.graph && layer.metalness?.$type === 'computeFloat' && (
                amount(t.paintMetalness, number(layer.metalness.value, 0), (value) => session.editInspected(['layers', i, 'metalness', 'value'], value))
              )}
              {paintable && (painting?.layer === i
                ? <Button size="sm" variant="solid" tone="accent" icon={Square} onClick={() => session.tools.stop()}>{t.paintStop}</Button>
                : <Button size="sm" variant="soft" tone="neutral" icon={Brush} onClick={() => void session.tools.startPainting(i)}>{t.paintStart}</Button>)}
            </Flex>
          );
        })}
        {painting && (
          <Flex align="center" gap="sm" wrap>
            {amount(t.paintRadius, brush.radius, (radius) => radius > 0 && session.tools.setPaintBrush({ ...brush, radius }), { min: 0.01, max: 100 })}
            {amount(t.paintHardness, brush.hardness, (hardness) => session.tools.setPaintBrush({ ...brush, hardness }), { step: 0.1 })}
            {amount(t.paintStrength, brush.strength, (strength) => session.tools.setPaintBrush({ ...brush, strength }), { step: 0.1 })}
            <Checkbox size="sm" _checked={brush.erase} onUpdate:_checked={(erase: boolean) => session.tools.setPaintBrush({ ...brush, erase })}>{t.paintErase}</Checkbox>
          </Flex>
        )}
        {painting && <Small tone="muted">{t.paintHint}</Small>}
      </FormSection>
    );
  };
});
