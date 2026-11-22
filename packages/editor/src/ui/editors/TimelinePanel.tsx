/**
 * 时间轴面板：资源浏览器里打开的时间轴（session.timeline），画在 vue-tsx-pro 的 TrackTimeline 上。上面是时间尺和播放头，下面每条
 * 轨道一行：属性轨道的关键帧（菱形）、
 * 相机的切点、声音和动画的片段、字幕条、事件。拖时间尺或空白处移播放头，视口跟着预览（不改场景文档）；拖关键帧改它的时刻
 * （吸附到帧）；点轨道名选中轨道，"加关键帧"按播放头处实体现在的值加一个（拖时间预览着的是曲线的值，刚用操纵器挪过的是
 * 挪到的位置）。关键帧的值、别的轨道的细节在属性面板里改（选中资源浏览器里的时间轴）。
 */
import { Camera, ChartSpline, CircleX, Clapperboard, Diamond, KeyRound, Pause, Play, Trash2 } from '@lucide/icons';
import { _component } from '@zerodep-dev/vue-tsx-pro-tsx';
import { css } from '@zerodep-dev/vue-tsx-pro-tsx/styles';
import { Button, Flex, IconButton, ScrollArea, Select, Strong, Text, Toolbar, TrackTimeline, type TrackTimelineItem, type TrackTimelineSelection, type TrackTimelineTrack } from '@zerodep-dev/vue-tsx-pro-ui';
import { onUnmounted } from 'vue';
import type { TimelineTrackFile } from '@stride-ts/engine/content-format';
import { t } from '../i18n/messages';
import { TimelineCurves } from './TimelineCurves';
import { EXPORT_PRESETS, type EditorSession, type ExportPreset } from '../session/EditorSession';

const styles = css.create({
  panel: { height: '100%', minHeight: '0', fontSize: '0.8rem' },
  select: { width: '9em' },
  subtitle: { fontStyle: 'italic' },
  scroll: { flex: '1', minHeight: '0' },
  curves: { height: '180px', position: 'relative' },
});

type Selected = { readonly track: number; readonly key?: number };

export const TimelinePanel = _component(({ session }: { session: EditorSession }) => {
  let selected = _state<Selected | undefined>(undefined);
  let playing = _state(false);
  /** 选中的属性轨道按曲线显示（曲线编辑器）。 */
  let curves = _state(false);
  let exportPreset = _state<ExportPreset>('landscape1080');
  let frame = 0;
  /** 正在拖的关键帧现在在第几个（拖着改时刻会重排，序号跟着变）：轨道、开始时的序号、现在的序号 */
  let moving: { track: number; from: number; index: number } | undefined;
  onUnmounted(() => cancelAnimationFrame(frame));

  const open = () => session.timeline.value!;
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

  /** 拖关键帧：改它的时刻，排序以后选中跟着它；返回它现在的序号。 */
  const moveKey = (index: number, key: number, time: number): number => {
    const track = open().content.tracks[index];
    if (track?.type !== 'property') return key;
    const moved = { ...track.keys[key]!, time };
    const keys = track.keys.map((k, i) => (i === key ? moved : k));
    setKeys(index, keys);
    const sorted = [...keys].sort((a, b) => a.time - b.time);
    selected = { track: index, key: sorted.indexOf(moved) };
    return sorted.indexOf(moved);
  };

  /** TrackTimeline 拖了（或 Alt + 方向键挪了）一个关键帧：项的 id 是开始时的序号，拖动中按记下的现在的序号改。 */
  const onItemMove = (trackId: string, itemId: string, time: number, { phase }: { phase: 'move' | 'end' }) => {
    const track = Number(trackId), from = Number(itemId);
    if (moving?.track !== track || moving.from !== from) moving = { track, from, index: from };
    moving.index = moveKey(track, moving.index, time);
    if (phase === 'end') moving = undefined;
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

  /** 一条轨道在 TrackTimeline 上的样子：属性轨道的关键帧（id 是序号）、相机切点和事件是标记、字幕声音动画是片段。 */
  const toTrack = (track: TimelineTrackFile, index: number): TrackTimelineTrack => {
    const items = ((): TrackTimelineItem[] => {
      switch (track.type) {
        case 'property':
          return track.keys.map((key, k) => ({ kind: 'key', id: String(k), time: key.time, label: `${key.time.toFixed(2)} s: ${JSON.stringify(key.value)}` }));
        case 'camera':
          return track.cuts.map((cut, i) => ({ kind: 'marker', id: `cut${i}`, time: cut.time, label: entityName(cut.camera) }));
        case 'subtitle':
          return track.cues.map((cue, i) => ({ kind: 'clip', id: `cue${i}`, start: cue.start, end: cue.end, label: cue.text }));
        case 'sound':
          return track.clips.map((clip, i) => ({ kind: 'clip', id: `sound${i}`, start: clip.start, label: `♪ ${clip.sound.slice(clip.sound.lastIndexOf('/') + 1)}` }));
        case 'animation':
          return track.clips.map((clip, i) => ({ kind: 'clip', id: `clip${i}`, start: clip.start, label: clip.clip }));
        case 'event':
          return track.events.map((event, i) => ({ kind: 'marker', id: `event${i}`, time: event.time, label: event.name }));
      }
    })();
    return { id: String(index), label: trackLabel(track), items };
  };

  return () => {
    const timeline = session.timeline.value;
    if (!timeline) return undefined;
    const { content, time } = timeline;
    const selectedTrack = selected ? content.tracks[selected.track] : undefined;
    return (
      <Flex direction="column" sx={styles.panel}>
        <Toolbar docked="top" aria-label={content.name}>
          <Strong title={timeline.path}>{content.name}</Strong>
          <IconButton icon={playing ? Pause : Play} aria-label={playing ? t.timelinePause : t.timelinePlay} onClick={togglePlay} />
          <Text tone="muted" numeric>{time.toFixed(2)} / {content.duration.toFixed(2)} s</Text>
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
          <Flex grow>
            <Text tone="muted" truncate sx={styles.subtitle}>{timeline.subtitle}</Text>
          </Flex>
          <Select {...css.attrs(styles.select)} size="sm" aria-label={t.timelineExport}
            items={EXPORT_PRESETS.map((preset) => ({ value: preset, label: t.timelineExportPresets[preset] }))}
            _value={exportPreset} onUpdate:_value={(preset: string | null) => preset && (exportPreset = preset as ExportPreset)} />
          <IconButton icon={Clapperboard} aria-label={session.exporting.value ? t.timelineExporting : t.timelineExport} disabled={session.exporting.value !== undefined} onClick={() => void session.exportTimeline(exportPreset)} />
          {session.exporting.value && <Text tone="muted">{t.timelineExporting}</Text>}
          <IconButton icon={CircleX} variant="ghost" aria-label={t.timelineClose} onClick={() => session.closeTimeline()} />
        </Toolbar>
        <ScrollArea sx={styles.scroll}>
          <TrackTimeline
            tracks={content.tracks.map(toTrack)}
            duration={content.duration}
            frameRate={content.frameRate ?? 30}
            _time={time}
            onUpdate:_time={(next: number) => session.seekTimeline(next)}
            // 选中的项只有属性轨道的关键帧对应到文件里（序号）；别的项只选中它的轨道
            _selected={selected ? { track: String(selected.track), ...(selected.key !== undefined ? { item: String(selected.key) } : {}) } : null}
            onUpdate:_selected={(next: TrackTimelineSelection | null) => {
              const track = next ? content.tracks[Number(next.track)] : undefined;
              selected = next ? { track: Number(next.track), ...(track?.type === 'property' && next.item !== undefined ? { key: Number(next.item) } : {}) } : undefined;
            }}
            onItemMove={onItemMove}
            detail={curves && selectedTrack?.type === 'property' ? (
              <div {...css.attrs(styles.curves)}>
                <TimelineCurves
                  session={session} track={selectedTrack} index={selected!.track} duration={content.duration} time={time} selectedKey={selected?.key}
                  onSelectKey={(key: number) => (selected = { track: selected!.track, key })}
                  onChangeKeys={setKeys}
                />
              </div>
            ) : undefined}
            aria-label={content.name}
          />
        </ScrollArea>
      </Flex>
    );
  };
});
