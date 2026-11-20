/**
 * 粒子曲线（Stride 的 ComputeCurveSampler + ComputeAnimationCurve，横轴是走过的寿命 0..1）的两种小编辑器：
 * - FloatCurve：折线加可以拖的关键帧点；双击空处加一帧，右键一帧删掉（至少留一帧）；
 * - ColorGradient：渐变条加下面的色标；拖色标挪位置，点色标选中、下面改颜色和透明度，双击条加一个色标，选中的可以删。
 * 值是文件里的曲线对象（`{ $type: 'computeCurveSamplerFloat' | …Vector4, curve: { keyFrames } }`），改了交出整个新对象。
 */
import { _component } from '@zerodep-dev/vue-tsx-pro-tsx';
import { css } from '@zerodep-dev/vue-tsx-pro-tsx/styles';
import { Trash2 } from '@lucide/icons';
import { ColorField, IconButton, NumberField } from '@zerodep-dev/vue-tsx-pro-ui';
import { t } from './messages';

const WIDTH = 220;
const HEIGHT = 64;

interface KeyFrame {
  readonly key: number;
  readonly value: number | readonly number[];
  readonly tangentType?: string;
}

type CurveFile = { readonly $type: string; readonly curve: { readonly $type?: string; readonly keyFrames: readonly KeyFrame[] } };

const styles = css.create({
  box: { display: 'flex', flexDirection: 'column', gap: '2px', flex: '1', minWidth: '0' },
  svg: { backgroundColor: '_surfaceMuted', borderRadius: '4px', cursor: 'crosshair', touchAction: 'none' },
  bar: { position: 'relative', height: '18px', borderRadius: '3px', cursor: 'copy' },
  stops: { position: 'relative', height: '12px' },
  stop: { position: 'absolute', top: '0', width: '10px', height: '10px', marginInlineStart: '-5px', borderWidth: '1px', borderStyle: 'solid', borderColor: '_text', cursor: 'ew-resize' },
  selected: { borderColor: '_accent', borderWidth: '2px' },
  row: { display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap' },
  alpha: { width: '6.5em' },
});

const keysOf = (file: CurveFile) => [...file.curve.keyFrames].sort((a, b) => a.key - b.key);
const withKeys = (file: CurveFile, keys: readonly KeyFrame[]): CurveFile => ({ ...file, curve: { ...file.curve, keyFrames: [...keys].sort((a, b) => a.key - b.key) } });

/** 按指针挪：pointerdown 时调，移动时交出 0..1 的横坐标和纵坐标（相对元素），松手结束。 */
function track(event: PointerEvent, element: Element, move: (x: number, y: number) => void, done?: () => void): void {
  event.preventDefault();
  event.stopPropagation();
  const rect = element.getBoundingClientRect();
  const onMove = (e: PointerEvent) => move(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)), Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)));
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    done?.();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

export const FloatCurve = _component(({ value, onChange }: { value: CurveFile; onChange: (next: CurveFile, done: boolean) => void }) => {
  let svg: SVGSVGElement | undefined;
  return () => {
    const keys = keysOf(value);
    const values = keys.map((k) => Number(k.value));
    const low = Math.min(0, ...values), high = Math.max(1, ...values) * 1.1;
    const toY = (v: number) => HEIGHT - ((v - low) / (high - low)) * HEIGHT;
    const fromY = (y: number) => low + (1 - y) * (high - low);
    const points = keys.map((k) => `${k.key * WIDTH},${toY(Number(k.value))}`).join(' ');
    const add = (event: MouseEvent) => {
      const rect = svg!.getBoundingClientRect();
      const key = (event.clientX - rect.left) / rect.width, v = fromY((event.clientY - rect.top) / rect.height);
      onChange(withKeys(value, [...keys, { key: Math.round(key * 1000) / 1000, value: Math.round(v * 1000) / 1000, tangentType: 'linear' }]), true);
    };
    return (
      <svg {...css.attrs(styles.svg)} width={WIDTH} height={HEIGHT} ref={(element: unknown) => (svg = element as SVGSVGElement)} onDblclick={add}>
        <line x1="0" x2={WIDTH} y1={toY(0)} y2={toY(0)} stroke="currentColor" stroke-opacity="0.2" />
        <polyline points={points} fill="none" stroke="#e8a33d" stroke-width="2" />
        {keys.map((frame, i) => (
          <circle cx={frame.key * WIDTH} cy={toY(Number(frame.value))} r="5" fill="#e8a33d" stroke="#000" style={{ cursor: 'move' }}
            onPointerdown={(event: PointerEvent) => {
              let latest = value;
              track(event, svg!, (x, y) => {
                latest = withKeys(value, keys.map((k, j) => (j === i ? { ...k, key: Math.round(x * 1000) / 1000, value: Math.round(fromY(y) * 1000) / 1000 } : k)));
                onChange(latest, false);
              }, () => onChange(latest, true));
            }}
            onContextmenu={(event: MouseEvent) => { event.preventDefault(); if (keys.length > 1) onChange(withKeys(value, keys.filter((_, j) => j !== i)), true); }}>
            <title>{`${frame.key}: ${Number(frame.value)}`}</title>
          </circle>
        ))}
      </svg>
    );
  };
});

const css4 = (v: readonly number[]) => `rgba(${Math.round((v[0] ?? 1) * 255)}, ${Math.round((v[1] ?? 1) * 255)}, ${Math.round((v[2] ?? 1) * 255)}, ${v[3] ?? 1})`;
const hex = (v: readonly number[]) => `#${[0, 1, 2].map((i) => Math.round(Math.min(Math.max(v[i] ?? 1, 0), 1) * 255).toString(16).padStart(2, '0')).join('')}`;

export const ColorGradient = _component(({ value, onChange }: { value: CurveFile; onChange: (next: CurveFile, done: boolean) => void }) => {
  let selected = _state(0);
  let bar: HTMLElement | undefined;
  return () => {
    const keys = keysOf(value);
    const color = (k: KeyFrame) => (Array.isArray(k.value) ? k.value : [1, 1, 1, 1]) as readonly number[];
    const gradient = `linear-gradient(to right, ${keys.map((k) => `${css4(color(k))} ${k.key * 100}%`).join(', ')}), repeating-conic-gradient(#888 0% 25%, #ccc 0% 50%) 50% / 10px 10px`;
    const current = keys[Math.min(selected, keys.length - 1)];
    const setColor = (rgba: readonly number[]) => onChange(withKeys(value, keys.map((k) => (k === current ? { ...k, value: rgba } : k))), true);
    return (
      <div {...css.attrs(styles.box)}>
        <div {...css.attrs(styles.bar)} style={{ background: gradient }} ref={(element: unknown) => (bar = element as HTMLElement)}
          title={t.particleGradientHint}
          onDblclick={(event: MouseEvent) => {
            const rect = bar!.getBoundingClientRect();
            const key = Math.round(((event.clientX - rect.left) / rect.width) * 1000) / 1000;
            const near = keys.reduce((a, b) => (Math.abs(b.key - key) < Math.abs(a.key - key) ? b : a));
            onChange(withKeys(value, [...keys, { key, value: color(near), tangentType: 'linear' }]), true);
          }} />
        <div {...css.attrs(styles.stops)}>
          {keys.map((frame, i) => (
            <span {...css.attrs(styles.stop, i === selected && styles.selected)} style={{ left: `${frame.key * 100}%`, background: css4(color(frame)) }}
              onPointerdown={(event: PointerEvent) => {
                selected = i;
                let latest = value;
                track(event, bar!, (x) => {
                  latest = withKeys(value, keys.map((k, j) => (j === i ? { ...k, key: Math.round(x * 1000) / 1000 } : k)));
                  onChange(latest, false);
                }, () => onChange(latest, true));
              }} />
          ))}
        </div>
        {current && (
          <div {...css.attrs(styles.row)}>
            <ColorField size="sm" aria-label={t.particleStopColor} _value={hex(color(current))}
              onUpdate:_value={(h: string) => setColor([1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).concat(color(current)[3] ?? 1))} />
            <NumberField {...css.attrs(styles.alpha)} size="sm" prefix={t.particleStopAlpha} aria-label={t.particleStopAlpha} min={0} max={1} step={0.05} format={{ useGrouping: false, maximumFractionDigits: 3 }}
              _value={color(current)[3] ?? 1} onUpdate:_value={(alpha: number | null) => alpha !== null && setColor([...color(current).slice(0, 3), alpha])} />
            {keys.length > 1 && <IconButton icon={Trash2} size="sm" variant="ghost" tone="neutral" aria-label={t.particleStopRemove} title={t.particleStopRemove} onClick={() => { onChange(withKeys(value, keys.filter((k) => k !== current)), true); selected = 0; }} />}
          </div>
        )}
      </div>
    );
  };
});
