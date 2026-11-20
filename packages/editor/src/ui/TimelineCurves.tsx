/**
 * 时间轴面板的曲线视图：一条属性轨道按分量画成曲线（x 是时间，y 是值；取样由游戏页面里的引擎算，同游戏里的求值），关键帧是
 * 曲线上的点。上下拖点改这个分量的值；选中的关键帧两侧有切线的手柄，拖它改切线（两侧一起，cubic 时才起作用）。
 * 四元数的分量也照样画（看得出转得匀不匀），一般在视口里摆好再打关键帧。
 */
import { _component } from '@zerodep-dev/vue-tsx-pro-tsx';
import { css } from '@zerodep-dev/vue-tsx-pro-tsx/styles';
import { onMounted, onUnmounted } from 'vue';
import type { TimelineTrackFile } from '@stride-ts/engine/content-format';
import type { EditorSession } from './session';

type PropertyTrack = Extract<TimelineTrackFile, { type: 'property' }>;
type Key = PropertyTrack['keys'][number];

const styles = css.create({
  wrap: { position: 'relative', height: '100%', minHeight: '120px', userSelect: 'none' },
  svg: { position: 'absolute', inset: '0', width: '100%', height: '100%' },
});

/** 分量的颜色：x 红、y 绿、z 蓝、w（a）灰。 */
const COLORS = ['#e5484d', '#30a46c', '#3e63dd', '#8b8d98'];
const SAMPLES = 160;
const PADDING = 12;
/** 切线手柄离关键帧多远（像素，沿切线方向的水平距离）。 */
const HANDLE = 40;

/** 一个关键帧的值（或切线）按分量的数组。 */
const components = (value: number | readonly number[] | undefined, size: number): number[] | undefined =>
  value === undefined ? undefined : typeof value === 'number' ? [value] : [...value].slice(0, size);

export const TimelineCurves = _component(({ session, track, index, duration, time, selectedKey, onSelectKey, onChangeKeys }: {
  session: EditorSession;
  track: PropertyTrack;
  index: number;
  duration: number;
  time: number;
  selectedKey: number | undefined;
  onSelectKey: (key: number) => void;
  onChangeKeys: (index: number, keys: readonly Key[]) => void;
}) => {
  let size = _state<[number, number]>([0, 0]);
  let element: HTMLElement | undefined;
  const observer = new ResizeObserver(() => {
    const box = element?.getBoundingClientRect();
    if (box) size = [box.width, box.height];
  });
  onMounted(() => element && observer.observe(element));
  onUnmounted(() => observer.disconnect());

  return () => {
    const [width, height] = size;
    const sampled = width > 0 ? session.agent.value?.sampleTimelineTrack(track, duration, SAMPLES) : undefined;
    const valueSize = typeof track.keys[0]?.value === 'number' ? 1 : (track.keys[0]?.value as readonly number[] | undefined)?.length ?? 1;
    // 纵轴范围：曲线和关键帧的值都看得到，上下留一点
    let min = Infinity, max = -Infinity;
    for (const values of sampled?.values ?? []) for (const v of values) [min, max] = [Math.min(min, v), Math.max(max, v)];
    for (const key of track.keys) for (const v of components(key.value, valueSize) ?? []) [min, max] = [Math.min(min, v), Math.max(max, v)];
    if (!(max > min)) [min, max] = [min - 1, max + 1];
    const margin = (max - min) * 0.1;
    [min, max] = [min - margin, max + margin];
    const x = (t: number) => PADDING + (t / duration) * (width - 2 * PADDING);
    const y = (v: number) => PADDING + ((max - v) / (max - min)) * (height - 2 * PADDING);
    const valueAt = (clientY: number) => {
      const box = element!.getBoundingClientRect();
      return max - ((clientY - box.top - PADDING) / (height - 2 * PADDING)) * (max - min);
    };
    const secondsPerPixel = duration / (width - 2 * PADDING);

    /** 按住拖：每次移动调 move（鼠标的 clientY），松开结束。 */
    const drag = (event: PointerEvent, move: (clientY: number, clientX: number) => void) => {
      event.preventDefault();
      event.stopPropagation();
      const target = event.currentTarget as Element;
      target.setPointerCapture(event.pointerId);
      const onMove = (e: PointerEvent) => move(e.clientY, e.clientX);
      const onUp = () => {
        target.removeEventListener('pointermove', onMove as EventListener);
        target.removeEventListener('pointerup', onUp);
      };
      target.addEventListener('pointermove', onMove as EventListener);
      target.addEventListener('pointerup', onUp);
    };
    const setKey = (k: number, change: (key: Key) => Key) => onChangeKeys(index, track.keys.map((key, i) => (i === k ? change(key) : key)));
    const setComponent = (values: number[] | undefined, c: number, v: number) => {
      const next = [...(values ?? new Array(valueSize).fill(0))];
      next[c] = v;
      return valueSize === 1 ? next[0]! : next;
    };

    const curves = sampled && Array.from({ length: valueSize }, (_, c) => (
      <polyline fill="none" stroke={COLORS[c]} stroke-width="1.5" points={sampled.times.map((t, i) => `${x(t)},${y(sampled.values[i]![c]!)}`).join(' ')} />
    ));
    const points = track.keys.flatMap((key, k) => (components(key.value, valueSize) ?? []).map((v, c) => (
      <circle
        cx={x(key.time)} cy={y(v)} r={k === selectedKey ? 6 : 4.5} fill={COLORS[c]} stroke={k === selectedKey ? 'white' : 'none'} stroke-width="1.5" style={{ cursor: 'ns-resize' }}
        onPointerdown={(event: PointerEvent) => {
          onSelectKey(k);
          drag(event, (clientY) => setKey(k, (current) => ({ ...current, value: setComponent(components(current.value, valueSize), c, valueAt(clientY)) })));
        }}
      />
    )));
    // 选中的关键帧：每个分量一对切线手柄（入、出一起改）
    const key = selectedKey === undefined ? undefined : track.keys[selectedKey];
    const handles = key && track.interpolation === 'cubic' && sampled && (components(key.value, valueSize) ?? []).map((v, c) => {
      const slope = components(key.out, valueSize)?.[c] ?? autoSlope(track, selectedKey!, c, valueSize);
      const dt = HANDLE * secondsPerPixel;
      const ends = [-1, 1].map((side) => [x(key.time + side * dt), y(v + side * slope * dt)] as const);
      return [
        <line x1={ends[0]![0]} y1={ends[0]![1]} x2={ends[1]![0]} y2={ends[1]![1]} stroke={COLORS[c]} stroke-dasharray="3 2" />,
        ...ends.map(([hx, hy], side) => (
          <rect
            x={hx - 3.5} y={hy - 3.5} width="7" height="7" fill="white" stroke={COLORS[c]} style={{ cursor: 'move' }}
            onPointerdown={(event: PointerEvent) => drag(event, (clientY) => {
              const next = (valueAt(clientY) - v) / ((side === 0 ? -1 : 1) * dt);
              setKey(selectedKey!, (current) => {
                const out = setComponent(components(current.out, valueSize) ?? Array.from({ length: valueSize }, (_, i) => autoSlope(track, selectedKey!, i, valueSize)), c, next);
                return { ...current, in: out, out };
              });
            })}
          />
        )),
      ];
    });

    return (
      <div {...css.attrs(styles.wrap)} ref={(e: unknown) => (element = e as HTMLElement)}>
        {width > 0 && (
          <svg {...css.attrs(styles.svg)} viewBox={`0 0 ${width} ${height}`}>
            <line x1={PADDING} x2={width - PADDING} y1={y(0)} y2={y(0)} stroke="currentColor" stroke-opacity="0.2" />
            {curves}
            <line x1={x(time)} x2={x(time)} y1="0" y2={height} stroke="#e5484d" stroke-opacity="0.8" />
            {handles}
            {points}
          </svg>
        )}
      </div>
    );
  };
});

/** 自动切线（同引擎的 curveTangent：前后两个关键帧的斜率，两端用一侧的）。 */
function autoSlope(track: PropertyTrack, key: number, c: number, size: number): number {
  const keys = track.keys, last = keys.length - 1;
  if (last === 0) return 0;
  const a = Math.max(key - 1, 0), b = Math.min(key + 1, last);
  const value = (k: number) => components(keys[k]!.value, size)?.[c] ?? 0;
  return (value(b) - value(a)) / (keys[b]!.time - keys[a]!.time);
}
