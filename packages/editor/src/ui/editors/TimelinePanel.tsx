/**
 * 时间轴面板：资源浏览器里打开的时间轴（session.timeline）。上面是时间尺和播放头，下面每条轨道一行：属性轨道的关键帧（菱形）、
 * 相机的切点、声音和动画的片段、字幕条、事件。拖时间尺或空白处移播放头，视口跟着预览（不改场景文档）；拖关键帧改它的时刻
 * （吸附到帧）；点轨道名选中轨道，"加关键帧"按播放头处实体现在的值加一个（拖时间预览着的是曲线的值，刚用操纵器挪过的是
 * 挪到的位置）。关键帧的值、别的轨道的细节在属性面板里改（选中资源浏览器里的时间轴）。
 */
import { Camera, ChartSpline, CircleX, Clapperboard, Diamond, KeyRound, Pause, Play, Trash2 } from '@lucide/icons';
import { _component } from '@zerodep-dev/vue-tsx-pro-tsx';
import { css } from '@zerodep-dev/vue-tsx-pro-tsx/styles';
import { Button, IconButton, ScrollArea, Select } from '@zerodep-dev/vue-tsx-pro-ui';
import { onUnmounted } from 'vue';
import type { TimelineFile, TimelineTrackFile } from '@stride-ts/engine/content-format';
import { t } from '../i18n/messages';
import { TimelineCurves } from './TimelineCurves';
import { EXPORT_PRESETS, type EditorSession, type ExportPreset } from '../session/EditorSession';

const styles = css.create({
  panel: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: '0', fontSize: '0.8rem' },
  toolbar: { display: 'flex', alignItems: 'center', gap: '_xs', paddingInline: '_sm', paddingBlock: '2px', borderBlockEndWidth: '1px', borderBlockEndStyle: 'solid', borderBlockEndColor: '_border' },
  name: { fontWeight: '600', marginInlineEnd: '_sm' },
  select: { width: '9em' },
  time: { fontVariantNumeric: 'tabular-nums', color: '_textMuted', marginInline: '_sm' },
  subtitle: { flex: '1', color: '_textMuted', fontStyle: 'italic', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  scroll: { flex: '1', minHeight: '0' },
  body: { display: 'grid', gridTemplateColumns: '14em 1fr' },
  label: { height: '22px', lineHeight: '22px', paddingInline: '_sm', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', cursor: 'pointer', borderBlockEndWidth: '1px', borderBlockEndStyle: 'solid', borderBlockEndColor: '_border' },
  selectedLabel: { backgroundColor: '_accentSoft' },
  lanes: { position: 'relative', cursor: 'text', userSelect: 'none' },
  ruler: { height: '22px', position: 'relative', borderBlockEndWidth: '1px', borderBlockEndStyle: 'solid', borderBlockEndColor: '_border', color: '_textMuted' },
  tick: { position: 'absolute', top: '0', height: '100%', borderInlineStartWidth: '1px', borderInlineStartStyle: 'solid', borderInlineStartColor: '_border', paddingInlineStart: '2px', fontSize: '0.7rem' },
  lane: { height: '22px', position: 'relative', borderBlockEndWidth: '1px', borderBlockEndStyle: 'solid', borderBlockEndColor: '_border' },
  key: { position: 'absolute', top: '5px', width: '11px', height: '11px', marginInlineStart: '-6px', transform: 'rotate(45deg)', backgroundColor: '_text', cursor: 'ew-resize' },
  selectedKey: { backgroundColor: '_accent' },
  block: { position: 'absolute', top: '3px', height: '16px', borderRadius: '3px', backgroundColor: '_accentSoft', paddingInline: '3px', overflow: 'hidden', whiteSpace: 'nowrap', fontSize: '0.7rem' },
  marker: { position: 'absolute', top: '2px', width: '2px', height: '18px', backgroundColor: '_accent' },
  curves: { height: '180px', position: 'relative' },
  playhead: { position: 'absolute', top: '0', bottom: '0', width: '1px', backgroundColor: '_danger', pointerEvents: 'none' },
});

type Selected = { readonly track: number; readonly key?: number };

export const TimelinePanel = _component(({ session }: { session: EditorSession }) => {
  let selected = _state<Selected | undefined>(undefined);
  let playing = _state(false);
  /** 选中的属性轨道按曲线显示（曲线编辑器）。 */
  let curves = _state(false);
  let exportPreset = _state<ExportPreset>('landscape1080');
  let frame = 0;
  let lanes: HTMLElement | undefined;
  onUnmounted(() => cancelAnimationFrame(frame));

  const open = () => session.timeline.value!;
  /** 屏幕上的 x 换成时刻（吸附到帧）。 */
  const timeAt = (clientX: number) => {
    const { content } = open();
    const box = lanes!.getBoundingClientRect();
    const raw = ((clientX - box.left) / box.width) * content.duration;
    const fps = content.frameRate ?? 30;
    return Math.min(Math.max(Math.round(raw * fps) / fps, 0), content.duration);
  };
  const percent = (time: number) => `${(time / open().content.duration) * 100}%`;

  /** 按住拖：每次移动调 move（时刻），松开结束。 */
  const drag = (event: PointerEvent, move: (time: number) => void) => {
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    move(timeAt(event.clientX));
    const onMove = (e: PointerEvent) => move(timeAt(e.clientX));
    const onUp = () => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
  };

  const togglePlay = () => {
    playing = !playing;
    if (!playing) return cancelAnimationFrame(frame);
    if (open().time >= open().content.duration) session.seekTimeline(0);
    let last = performance.now();
    const step = (now: number) => {
      const timeline = session.timeline.value;
      if (!playing || !timeline) return;
      const next = timeline.time + (now - last) / 1000;
      last = now;
      session.seekTimeline(next);
      if (next >= timeline.content.duration) playing = false;
      else frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  };

  /** 属性轨道 index 的关键帧换成 keys（按时刻排好）。 */
  const setKeys = (index: number, keys: Extract<TimelineTrackFile, { type: 'property' }>['keys']) => session.editTimeline((file) => ({
    ...file,
    tracks: file.tracks.map((track, i) => (i === index && track.type === 'property' ? { ...track, keys: [...keys].sort((a, b) => a.time - b.time) } : track)),
  }));

  /** 拖关键帧：改它的时刻，排序以后选中跟着它。 */
  const moveKey = (index: number, key: number, time: number) => {
    const track = open().content.tracks[index];
    if (track?.type !== 'property') return;
    const moved = { ...track.keys[key]!, time };
    const keys = track.keys.map((k, i) => (i === key ? moved : k));
    setKeys(index, keys);
    const sorted = [...keys].sort((a, b) => a.time - b.time);
    selected = { track: index, key: sorted.indexOf(moved) };
  };

  /** 选中的属性轨道在播放头加一个关键帧（同一帧已经有的换掉），值是实体现在的。 */
  const addKey = () => {
    const index = selected?.track;
    const track = index === undefined ? undefined : open().content.tracks[index];
    if (index === undefined || track?.type !== 'property') return;
    const value = session.agent.value?.readProperty(track.entity, track.component, track.property);
    if (value === undefined) return void (session.notice.value = t.timelineNoValue(track.component, track.property));
    const time = open().time, half = 0.5 / (open().content.frameRate ?? 30);
    setKeys(index, [...track.keys.filter((k) => Math.abs(k.time - time) > half), { time, value }]);
  };

  /** 选中的实体：位置、旋转各一条轨道（没有就加上），在播放头各加一个关键帧。 */
  const keyTransform = () => {
    const agent = session.agent.value;
    const id = session.selection.value[0];
    if (!agent || id === undefined) return;
    const time = open().time, half = 0.5 / (open().content.frameRate ?? 30);
    session.editTimeline((file) => {
      const tracks = [...file.tracks];
      for (const property of ['position', 'rotation'] as const) {
        const value = agent.readProperty(id, 'Transform', property);
        if (value === undefined) continue;
        const index = tracks.findIndex((track) => track.type === 'property' && track.entity === id && track.component === 'Transform' && track.property === property);
        const existing = index >= 0 ? (tracks[index] as Extract<TimelineTrackFile, { type: 'property' }>) : undefined;
        const keys = [...(existing?.keys ?? []).filter((k) => Math.abs(k.time - time) > half), { time, value }].sort((a, b) => a.time - b.time);
        const track: TimelineTrackFile = { type: 'property', entity: id, component: 'Transform', property, ...(property === 'position' ? { interpolation: 'cubic' as const } : {}), keys };
        if (index >= 0) tracks[index] = { ...existing!, keys };
        else tracks.push(track);
      }
      return { ...file, tracks };
    });
  };

  /** 选中的关键帧的切线：自动（去掉写的切线）或者平的（缓入缓出）。 */
  const setTangents = (mode: 'auto' | 'flat') => {
    const current = selected;
    const track = current?.key === undefined ? undefined : open().content.tracks[current.track];
    if (!current || current.key === undefined || track?.type !== 'property') return;
    setKeys(current.track, track.keys.map((key, i) => {
      if (i !== current.key) return key;
      const { in: _in, out: _out, ...rest } = key;
      const zero = typeof key.value === 'number' ? 0 : key.value.map(() => 0);
      return mode === 'auto' ? rest : { ...rest, in: zero, out: zero };
    }));
  };

  const setInterpolation = (interpolation: 'constant' | 'linear' | 'cubic') => {
    const index = selected?.track;
    if (index === undefined) return;
    session.editTimeline((file) => ({ ...file, tracks: file.tracks.map((track, i) => (i === index && track.type === 'property' ? { ...track, interpolation } : track)) }));
  };

  const deleteKey = () => {
    const current = selected;
    const track = current?.key === undefined ? undefined : open().content.tracks[current.track];
    if (!current || current.key === undefined || track?.type !== 'property') return;
    setKeys(current.track, track.keys.filter((_, i) => i !== current.key));
    selected = { track: current.track };
  };

  const entityName = (id: string) => session.file.entities.find((entity) => entity.id === id)?.name ?? id;
  const trackLabel = (track: TimelineTrackFile) => {
    switch (track.type) {
      case 'property': return `${entityName(track.entity)} · ${track.component}.${track.property}`;
      case 'animation': return `${entityName(track.entity)} · ${t.timelineTracks.animation}`;
      default: return t.timelineTracks[track.type];
    }
  };

  /** 一条轨道的内容。 */
  const lane = (track: TimelineTrackFile, index: number) => {
    switch (track.type) {
      case 'property':
        return track.keys.map((key, k) => (
          <span
            {...css.attrs(styles.key, selected?.track === index && selected.key === k && styles.selectedKey)}
            style={{ insetInlineStart: percent(key.time) }}
            title={`${key.time.toFixed(2)} s: ${JSON.stringify(key.value)}`}
            onPointerdown={(event: PointerEvent) => {
              selected = { track: index, key: k };
              let current = k;
              drag(event, (time) => {
                moveKey(index, current, time);
                current = selected?.key ?? current;
              });
            }}
          />
        ));
      case 'camera':
        return track.cuts.map((cut) => [<span {...css.attrs(styles.marker)} style={{ insetInlineStart: percent(cut.time) }} />, <span {...css.attrs(styles.block)} style={{ insetInlineStart: percent(cut.time), background: 'transparent' }}>{entityName(cut.camera)}</span>]);
      case 'subtitle':
        return track.cues.map((cue) => <span {...css.attrs(styles.block)} style={{ insetInlineStart: percent(cue.start), width: percent(cue.end - cue.start) }} title={cue.text}>{cue.text}</span>);
      case 'sound':
        return track.clips.map((clip) => <span {...css.attrs(styles.block)} style={{ insetInlineStart: percent(clip.start) }} title={clip.sound}>♪ {clip.sound.slice(clip.sound.lastIndexOf('/') + 1)}</span>);
      case 'animation':
        return track.clips.map((clip) => <span {...css.attrs(styles.block)} style={{ insetInlineStart: percent(clip.start) }}>{clip.clip}</span>);
      case 'event':
        return track.events.map((event) => [<span {...css.attrs(styles.marker)} style={{ insetInlineStart: percent(event.time) }} />, <span {...css.attrs(styles.block)} style={{ insetInlineStart: percent(event.time), background: 'transparent' }}>{event.name}</span>]);
    }
  };

  const ticks = (file: TimelineFile) => {
    const step = file.duration <= 10 ? 1 : file.duration <= 60 ? 5 : 30;
    return Array.from({ length: Math.floor(file.duration / step) + 1 }, (_, i) => i * step);
  };

  return () => {
    const timeline = session.timeline.value;
    if (!timeline) return undefined;
    const { content, time } = timeline;
    const selectedTrack = selected ? content.tracks[selected.track] : undefined;
    return (
      <div {...css.attrs(styles.panel)}>
        <div {...css.attrs(styles.toolbar)}>
          <span {...css.attrs(styles.name)} title={timeline.path}>{content.name}</span>
          <IconButton icon={playing ? Pause : Play} aria-label={playing ? t.timelinePause : t.timelinePlay} onClick={togglePlay} />
          <span {...css.attrs(styles.time)}>{time.toFixed(2)} / {content.duration.toFixed(2)} s</span>
          <IconButton icon={Camera} variant={timeline.throughCamera ? 'soft' : 'ghost'} aria-pressed={timeline.throughCamera} aria-label={t.timelineThroughCamera} onClick={() => session.setTimelineCamera(!timeline.throughCamera)} />
          <IconButton icon={Diamond} aria-label={t.timelineAddKey} disabled={selectedTrack?.type !== 'property'} onClick={addKey} />
          <IconButton icon={KeyRound} aria-label={t.timelineKeyTransform} disabled={session.selection.value.length !== 1} onClick={keyTransform} />
          <IconButton icon={Trash2} aria-label={t.timelineDeleteKey} disabled={selected?.key === undefined} onClick={deleteKey} />
          <IconButton icon={ChartSpline} variant={curves ? 'soft' : 'ghost'} aria-pressed={curves} aria-label={t.timelineCurves} disabled={selectedTrack?.type !== 'property'} onClick={() => (curves = !curves)} />
          {curves && selectedTrack?.type === 'property' && [
            <Select {...css.attrs(styles.select)} size="sm" aria-label={t.timelineInterpolation}
              items={(['constant', 'linear', 'cubic'] as const).map((mode) => ({ value: mode, label: t.timelineInterpolations[mode] }))}
              _value={selectedTrack.interpolation ?? 'linear'} onUpdate:_value={(mode: string | null) => mode && setInterpolation(mode as 'constant' | 'linear' | 'cubic')} />,
            <Button size="sm" variant="soft" tone="neutral" disabled={selected?.key === undefined || selectedTrack.interpolation !== 'cubic'} onClick={() => setTangents('auto')}>{t.timelineAutoTangent}</Button>,
            <Button size="sm" variant="soft" tone="neutral" disabled={selected?.key === undefined || selectedTrack.interpolation !== 'cubic'} onClick={() => setTangents('flat')}>{t.timelineFlatTangent}</Button>,
          ]}
          <span {...css.attrs(styles.subtitle)}>{timeline.subtitle}</span>
          <Select {...css.attrs(styles.select)} size="sm" aria-label={t.timelineExport}
            items={EXPORT_PRESETS.map((preset) => ({ value: preset, label: t.timelineExportPresets[preset] }))}
            _value={exportPreset} onUpdate:_value={(preset: string | null) => preset && (exportPreset = preset as ExportPreset)} />
          <IconButton icon={Clapperboard} aria-label={session.exporting.value ? t.timelineExporting : t.timelineExport} disabled={session.exporting.value !== undefined} onClick={() => void session.exportTimeline(exportPreset)} />
          {session.exporting.value && <span {...css.attrs(styles.time)}>{t.timelineExporting}</span>}
          <IconButton icon={CircleX} variant="ghost" aria-label={t.timelineClose} onClick={() => session.closeTimeline()} />
        </div>
        <ScrollArea {...css.attrs(styles.scroll)} propsContent={css.attrs(styles.body)}>
          <div>
            <div {...css.attrs(styles.label)} />
            {content.tracks.map((track, index) => (
              <div {...css.attrs(styles.label, selected?.track === index && styles.selectedLabel)} title={trackLabel(track)} onClick={() => (selected = { track: index })}>{trackLabel(track)}</div>
            ))}
          </div>
          <div {...css.attrs(styles.lanes)} ref={(element: unknown) => (lanes = element as HTMLElement)} onPointerdown={(event: PointerEvent) => drag(event, (t) => session.seekTimeline(t))}>
            <div {...css.attrs(styles.ruler)}>
              {ticks(content).map((tick) => <span {...css.attrs(styles.tick)} style={{ insetInlineStart: percent(tick) }}>{tick}s</span>)}
            </div>
            {curves && selectedTrack?.type === 'property' ? (
              <div {...css.attrs(styles.curves)}>
                <TimelineCurves
                  session={session} track={selectedTrack} index={selected!.track} duration={content.duration} time={time} selectedKey={selected?.key}
                  onSelectKey={(key: number) => (selected = { track: selected!.track, key })}
                  onChangeKeys={setKeys}
                />
              </div>
            ) : content.tracks.map((track, index) => <div {...css.attrs(styles.lane)}>{lane(track, index)}</div>)}
            <span {...css.attrs(styles.playhead)} style={{ insetInlineStart: percent(time) }} />
          </div>
        </ScrollArea>
      </div>
    );
  };
});
