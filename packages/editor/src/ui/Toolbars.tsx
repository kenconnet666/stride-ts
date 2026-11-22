/**
 * 工作台的几条横栏（参考 JetBrains IDE）：
 * - MainToolbar：最上面，工程名、保存、撤销重做，右边是试玩（运行）；
 * - DocumentTabs：视口上面打开的文档的页签（场景；编辑预制体时再多一个预制体的页签，关掉它回到场景）；
 * - ViewportToolbar：视口上面，对选中实体的操作、吸附、画幅参考线；
 * - StatusBar：最下面，提示和出错、选中几个、界面语言。
 */
import { Activity, ArrowDownToLine, Globe, ArrowUpFromLine, Check, ClipboardPaste, Combine, Copy, CopyPlus, FlipVertical2, GitBranchPlus, Magnet, SquareDot, Merge, Package, Play, Plus, Redo2, Save, Scissors, Shapes, Square, SquareDashedBottom, Trash2, Undo2 } from '@lucide/icons';
import type { PolyOperation } from '@stride-ts/engine/modeling';
import type { SculptBrush } from '@stride-ts/engine';
import { _component } from '@zerodep-dev/vue-tsx-pro-tsx';
import { css } from '@zerodep-dev/vue-tsx-pro-tsx/styles';
import { Button, IconButton, NumberField, Select, Separator, Skeleton, Tab, TabList, Tabs } from '@zerodep-dev/vue-tsx-pro-ui';
import { LOCALES, locale, setLocale, type Locale } from './i18n';
import { SearchEverywhere } from './SearchEverywhere';
import { t } from './messages';
import type { EditorSession } from './session';

/** 画幅参考线的选项：名字和宽高比（0 是关）。 */
const FRAME_GUIDES: readonly (readonly [string, number])[] = [['', 0], ['16:9', 16 / 9], ['9:16', 9 / 16], ['2.39:1', 2.39], ['1.85:1', 1.85], ['4:3', 4 / 3], ['1:1', 1]];

const bar = { display: 'flex', alignItems: 'center', gap: '2px', flexShrink: '0', paddingInline: '_xs' } as const;

const styles = css.create({
  main: { ...bar, height: '40px', backgroundColor: '_surfaceRaised', borderBlockEndWidth: '1px', borderBlockEndStyle: 'solid', borderBlockEndColor: '_borderMuted' },
  brand: { fontWeight: '700', paddingInline: '_sm', whiteSpace: 'nowrap' },
  project: { color: '_textMuted', paddingInlineEnd: '_sm', whiteSpace: 'nowrap' },
  spacer: { flex: '1' },
  count: { whiteSpace: 'nowrap', paddingInline: '_xs' },
  tabs: { flexShrink: '0', backgroundColor: '_surfaceRaised' },
  // 骨架屏：和一个页签一样高（28px），工程名占一个名字的宽
  tabsLoading: { height: '28px', display: 'flex', alignItems: 'center', paddingInline: '10px' },
  tabSkeleton: { width: '6em', height: '1em' },
  projectSkeleton: { width: '7em' },
  viewport: { ...bar, height: '34px', backgroundColor: '_surface', borderBlockEndWidth: '1px', borderBlockEndStyle: 'solid', borderBlockEndColor: '_borderMuted' },
  step: { width: '6.5em' },
  guide: { width: '8em' },
  status: { ...bar, height: '24px', gap: '_sm', paddingInline: '_sm', fontSize: '0.75rem', color: '_textMuted', backgroundColor: '_surfaceRaised', borderBlockStartWidth: '1px', borderBlockStartStyle: 'solid', borderBlockStartColor: '_borderMuted' },
  message: { flex: '1', minWidth: '0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  notice: { color: '_dangerText' },
  language: { width: '7em' },
});

const iconProps = { size: 'sm', variant: 'ghost', tone: 'neutral' } as const;

export const MainToolbar = _component(({ session, playing, onTogglePlay }: { session: EditorSession; playing: boolean; onTogglePlay: () => void }) => {
  return () => (
    <div {...css.attrs(styles.main)} role="toolbar" aria-label={t.mainToolbar}>
      <span {...css.attrs(styles.brand)}>Stride</span>
      <span {...css.attrs(styles.project)}>{session.project.value?.name ?? <Skeleton shape="text" sx={styles.projectSkeleton} />}</span>
      <Separator orientation="vertical" />
      <IconButton {...iconProps} icon={Save} aria-label={t.save} title={`${t.save} (Ctrl+S)`} disabled={!session.dirty.value || playing} onClick={() => void session.save()} />
      <IconButton {...iconProps} icon={Undo2} aria-label={t.undo} title={`${t.undo} (Ctrl+Z)`} disabled={!session.canUndo || playing} onClick={() => session.undo()} />
      <IconButton {...iconProps} icon={Redo2} aria-label={t.redo} title={`${t.redo} (Ctrl+Y)`} disabled={!session.canRedo || playing} onClick={() => session.redo()} />
      <span {...css.attrs(styles.spacer)} />
      <SearchEverywhere session={session} playing={playing} onTogglePlay={onTogglePlay} />
      {playing
        ? <IconButton size="sm" variant="soft" tone="danger" icon={Square} aria-label={t.stopPlaying} title={t.stopPlaying} onClick={onTogglePlay} />
        : <IconButton size="sm" variant="ghost" tone="success" icon={Play} aria-label={t.play} title={t.play} onClick={onTogglePlay} />}
    </div>
  );
});

/** 文档的页签：文件名（没存的带 •），悬停看路径。 */
export const DocumentTabs = _component(({ session, playing }: { session: EditorSession; playing: boolean }) => {
  const name = (path: string) => path.slice(path.lastIndexOf('/') + 1);
  return () => {
    const opened = session.opened.value;
    const scene = session.scene.value;
    if (!opened) {
      return session.opening.value
        ? <div {...css.attrs(styles.tabs, styles.tabsLoading)} aria-busy="true"><Skeleton sx={styles.tabSkeleton} /></div>
        : <div {...css.attrs(styles.tabs)} />;
    }
    const prefab = opened.kind === 'prefab' ? opened : undefined;
    const dirty = session.dirty.value ? ' •' : '';
    const back = () => scene && !playing && void session.openAsset(scene);
    return (
      <Tabs {...css.attrs(styles.tabs)} size="sm" _value={opened.path} onUpdate:_value={(path: string) => path === scene?.path && back()}>
        <TabList aria-label={t.openDocuments}>
          {scene && scene.path !== prefab?.path && <Tab value={scene.path} title={scene.path}>{name(scene.path) + (prefab ? '' : dirty)}</Tab>}
          {prefab && <Tab value={prefab.path} title={t.prefabTitle(prefab.path)} {...(scene ? { onClose: back } : {})}>{name(prefab.path) + dirty}</Tab>}
        </TabList>
      </Tabs>
    );
  };
});

export const ViewportToolbar = _component(({ session, playing }: { session: EditorSession; playing: boolean }) => {
  /** 吸附：开关（拖操纵器时按住 Ctrl 反过来）和移动、旋转、缩放的步长。 */
  const snapControls = () => {
    const snap = session.snap.value;
    if (!snap) return undefined;
    const step = (key: 'translate' | 'rotate' | 'scale', min: number) => (
      <NumberField
        {...css.attrs(styles.step)}
        size="sm"
        prefix={t.snapStep[key].label}
        title={t.snapStep[key].title}
        aria-label={t.snapStep[key].title}
        min={min}
        step={key === 'rotate' ? 5 : 0.1}
        format={{ useGrouping: false, maximumFractionDigits: 4 }}
        _value={snap[key]}
        onUpdate:_value={(value: number | null) => value !== null && value > 0 && session.setSnap({ [key]: value })}
      />
    );
    return [
      <IconButton {...iconProps} icon={Magnet} variant={snap.enabled ? 'soft' : 'ghost'} aria-pressed={snap.enabled} aria-label={snap.enabled ? t.snapOn : t.snapOff} title={snap.enabled ? t.snapOn : t.snapOff} onClick={() => session.setSnap({ enabled: !snap.enabled })} />,
      <IconButton {...iconProps} icon={ArrowDownToLine} variant={snap.surface ? 'soft' : 'ghost'} aria-pressed={snap.surface === true} aria-label={snap.surface ? t.snapSurfaceOn : t.snapSurfaceOff} title={snap.surface ? t.snapSurfaceOn : t.snapSurfaceOff} onClick={() => session.setSnap({ surface: !snap.surface })} />,
      <IconButton {...iconProps} icon={SquareDot} variant={snap.vertex ? 'soft' : 'ghost'} aria-pressed={snap.vertex === true} aria-label={snap.vertex ? t.snapVertexOn : t.snapVertexOff} title={snap.vertex ? t.snapVertexOn : t.snapVertexOff} onClick={() => session.setSnap({ vertex: !snap.vertex })} />,
      step('translate', 0.001),
      step('rotate', 0.01),
      step('scale', 0.001),
      // 一起看着世界时：把选中的东西放进世界对应的格子
      ...(session.world.value ? [
        <Button size="sm" variant="soft" tone="neutral" icon={Globe} title={t.placeInWorldHint} disabled={session.selection.value.length === 0}
          onClick={() => void session.placeSelectionInWorld().catch((error: unknown) => (session.notice.value = (error as Error).message))}>{t.placeInWorld}</Button>,
      ] : []),
    ];
  };
  /** 挤出、内插、倒角的距离（米）：工具条上一个数，几个操作共用。 */
  let polyAmount = _state(0.25);
  /**
   * 编辑多边形网格时的工具条：选择模式（点、边、面）、操作的距离、各个操作（选的东西对得上才能点），最后是"完成"。
   */
  const polyControls = (poly: NonNullable<typeof session.polyEditing.value>) => {
    const { vertices, edges, faces } = poly.selection;
    const operation = (name: keyof typeof t.polyOps, icon: typeof Plus, enabled: boolean, build: () => PolyOperation | undefined) => (
      <Button size="sm" variant="ghost" tone="neutral" icon={icon} disabled={!enabled} onClick={() => {
        const op = build();
        if (op) session.polyOperation(op);
        else session.notice.value = t.polyConnectNeedsFace;
      }}>{t.polyOps[name]}</Button>
    );
    // 连接：两个点在同一个面上、不相邻（相邻的已经有边了）
    const connect = (): PolyOperation | undefined => {
      const [a, b] = vertices as [number, number];
      const face = poly.mesh.faces.findIndex(({ vertices: ring }) => {
        const i = ring.indexOf(a), j = ring.indexOf(b);
        return i >= 0 && j >= 0 && Math.abs(i - j) !== 1 && Math.abs(i - j) !== ring.length - 1;
      });
      return face < 0 ? undefined : { op: 'connect', face, a, b };
    };
    return [
      ...(['vertex', 'edge', 'face'] as const).map((mode, i) => (
        <Button size="sm" variant={poly.mode === mode ? 'soft' : 'ghost'} tone="neutral" aria-pressed={poly.mode === mode} title={`${t.polyModes[mode]} (${i + 1})`} onClick={() => session.setPolyMode(mode)}>{t.polyModes[mode]}</Button>
      )),
      <Separator orientation="vertical" />,
      <NumberField {...css.attrs(styles.step)} size="sm" prefix={t.polyAmount} aria-label={t.polyAmount} min={0.001} step={0.05} format={{ useGrouping: false, maximumFractionDigits: 4 }}
        _value={polyAmount} onUpdate:_value={(value: number | null) => value !== null && value > 0 && (polyAmount = value)} />,
      operation('extrude', ArrowUpFromLine, faces.length > 0, () => ({ op: 'extrude', faces, distance: polyAmount })),
      operation('inset', SquareDashedBottom, faces.length > 0, () => ({ op: 'inset', faces, amount: polyAmount })),
      operation('bevel', Combine, edges.length > 0, () => ({ op: 'bevel', edges, distance: polyAmount })),
      operation('split', Scissors, edges.length === 1, () => ({ op: 'split', edge: edges[0]! })),
      operation('merge', Merge, vertices.length >= 2, () => ({ op: 'merge', vertices })),
      operation('connect', Scissors, vertices.length === 2, connect),
      operation('flip', FlipVertical2, faces.length > 0, () => ({ op: 'flip', faces })),
      operation('delete', Trash2, faces.length > 0, () => ({ op: 'delete', faces })),
      <span {...css.attrs(styles.spacer)} />,
      <Button size="sm" variant="soft" tone="accent" icon={Check} onClick={() => session.stopPolyEdit()}>{t.polyDone}</Button>,
    ];
  };
  /** 编辑样条时的工具条：几个点（分支的也算）、从选中的点拉出分支、删除选中的点，最后是"完成"。 */
  const splineControls = (editing: NonNullable<typeof session.splineEditing.value>) => [
    <span {...css.attrs(styles.count)}>{t.splinePoints(editing.spline.points.length + (editing.spline.branches ?? []).reduce((sum, branch) => sum + branch.points.length, 0))}</span>,
    <Button size="sm" variant="ghost" tone="neutral" icon={GitBranchPlus} title={t.splineBranchHint} disabled={editing.selection.length !== 1}
      onClick={() => session.branchSpline()}>{t.splineBranch}</Button>,
    <Button size="sm" variant="ghost" tone="neutral" icon={Trash2} title={`${t.splineDeletePoints} (Delete)`} disabled={editing.selection.length === 0}
      onClick={() => session.deleteSplinePoints()}>{t.splineDeletePoints}</Button>,
    <span {...css.attrs(styles.spacer)} />,
    <Button size="sm" variant="soft" tone="accent" icon={Check} onClick={() => session.stopSplineEdit()}>{t.polyDone}</Button>,
  ];
  /** 编辑白盒时的工具条：几个笔刷、选中的那个是加减交、删除选中的，最后是"完成"。 */
  const brushControls = (editing: NonNullable<typeof session.brushEditing.value>) => {
    const shape = editing.selection === undefined ? undefined : editing.brush.brushes[editing.selection];
    return [
      <span {...css.attrs(styles.count)}>{t.brushCount(editing.brush.brushes.length)}</span>,
      ...(['add', 'subtract', 'intersect'] as const).map((operation) => (
        <Button size="sm" variant={shape?.operation === operation ? 'soft' : 'ghost'} tone="neutral" aria-pressed={shape?.operation === operation} disabled={!shape}
          onClick={() => session.setBrushOperation(operation)}>{t.brushOperations[operation]}</Button>
      )),
      <Button size="sm" variant="ghost" tone="neutral" icon={Trash2} title={`${t.brushDelete} (Delete)`} disabled={!shape || editing.brush.brushes.length <= 1}
        onClick={() => session.deleteSelectedBrush()}>{t.brushDelete}</Button>,
      <span {...css.attrs(styles.spacer)} />,
      <Button size="sm" variant="ghost" tone="neutral" icon={Shapes} title={t.brushToPolyHint} onClick={() => void session.exportBrushToPoly()}>{t.brushToPoly}</Button>,
      <Button size="sm" variant="soft" tone="accent" icon={Check} onClick={() => session.stopBrushEdit()}>{t.polyDone}</Button>,
    ];
  };
  /**
   * 雕刻地形时的工具条：先是笔刷、地物两种工具；笔刷是种类、半径（米）、强度，地物是新建、选中的那个的高度、过渡宽度、强度
   * 和删除；文件里有几笔，最后是"完成"。
   */
  const sculptControls = (sculpting: NonNullable<typeof session.sculpting.value>) => {
    const tools = (['brush', 'features'] as const).map((tool) => (
      <Button size="sm" variant={sculpting.tool === tool ? 'soft' : 'ghost'} tone="neutral" aria-pressed={sculpting.tool === tool} onClick={() => session.setSculptTool(tool)}>{t.sculptTools[tool]}</Button>
    ));
    const tail = [
      <span {...css.attrs(styles.spacer)} />,
      <span {...css.attrs(styles.count)}>{t.sculptStrokes(sculpting.file.strokes?.length ?? 0)}</span>,
      <Button size="sm" variant="soft" tone="accent" icon={Check} onClick={() => session.stopSculpt()}>{t.sculptDone}</Button>,
    ];
    if (sculpting.tool === 'features') {
      const feature = sculpting.feature === undefined ? undefined : sculpting.file.features?.[sculpting.feature];
      const field = (label: string, value: number, patch: (value: number) => Parameters<typeof session.updateTerrainFeature>[0], options: { min?: number; max?: number; step: number }) => (
        <NumberField {...css.attrs(styles.step)} size="sm" prefix={label} aria-label={label} {...options} format={{ useGrouping: false, maximumFractionDigits: 2 }}
          _value={value} onUpdate:_value={(next: number | null) => next !== null && next !== value && session.updateTerrainFeature(patch(next))} />
      );
      return [
        ...tools,
        <Separator orientation="vertical" />,
        <Button size="sm" variant="ghost" tone="neutral" icon={Plus} title={t.featureAddHint} onClick={() => session.addTerrainFeature()}>{t.featureAdd}</Button>,
        ...(feature ? [
          field(t.featureHeight, feature.height, (height) => ({ height }), { step: 1 }),
          field(t.featureFalloff, feature.falloff ?? 0, (falloff) => ({ falloff }), { min: 0, step: 5 }),
          field(t.sculptStrength, feature.strength ?? 1, (strength) => ({ strength }), { min: 0, max: 1, step: 0.1 }),
          <Button size="sm" variant="ghost" tone="neutral" icon={Trash2} onClick={() => session.deleteTerrainFeature()}>{t.featureDelete}</Button>,
        ] : []),
        ...tail,
      ];
    }
    const brush = session.sculptBrush.value;
    // 抬高、压低的强度是米；压平、磨平是 0..1：换到另一类时强度换成那一类的默认值
    const isFraction = (op: SculptBrush['op']) => op === 'flatten' || op === 'smooth';
    const fraction = isFraction(brush.op);
    return [
      ...tools,
      <Separator orientation="vertical" />,
      ...(['raise', 'lower', 'flatten', 'smooth'] as const).map((op) => (
        <Button size="sm" variant={brush.op === op ? 'soft' : 'ghost'} tone="neutral" aria-pressed={brush.op === op}
          onClick={() => session.setSculptBrush({ ...brush, op, strength: isFraction(op) === fraction ? brush.strength : isFraction(op) ? 0.5 : 4 })}>{t.sculptOps[op]}</Button>
      )),
      <Separator orientation="vertical" />,
      <NumberField {...css.attrs(styles.step)} size="sm" prefix={t.sculptRadius} aria-label={t.sculptRadius} min={0.5} step={5} format={{ useGrouping: false, maximumFractionDigits: 2 }}
        _value={brush.radius} onUpdate:_value={(value: number | null) => value !== null && value > 0 && session.setSculptBrush({ ...brush, radius: value })} />,
      <NumberField {...css.attrs(styles.step)} size="sm" prefix={t.sculptStrength} aria-label={t.sculptStrength} min={0} {...(fraction ? { max: 1 } : {})} step={fraction ? 0.1 : 1} format={{ useGrouping: false, maximumFractionDigits: 3 }}
        _value={brush.strength} onUpdate:_value={(value: number | null) => value !== null && value >= 0 && session.setSculptBrush({ ...brush, strength: value })} />,
      ...tail,
    ];
  };
  return () => {
    const selected = session.selection.value.length;
    const off = playing;
    const poly = session.polyEditing.value;
    if (poly && !off) return <div {...css.attrs(styles.viewport)} role="toolbar" aria-label={t.viewportToolbar}>{polyControls(poly)}</div>;
    const splineEditing = session.splineEditing.value;
    if (splineEditing && !off) return <div {...css.attrs(styles.viewport)} role="toolbar" aria-label={t.viewportToolbar}>{splineControls(splineEditing)}</div>;
    const brushEditing = session.brushEditing.value;
    if (brushEditing && !off) return <div {...css.attrs(styles.viewport)} role="toolbar" aria-label={t.viewportToolbar}>{brushControls(brushEditing)}</div>;
    const sculpting = session.sculpting.value;
    if (sculpting && !off) return <div {...css.attrs(styles.viewport)} role="toolbar" aria-label={t.viewportToolbar}>{sculptControls(sculpting)}</div>;
    return (
      <div {...css.attrs(styles.viewport)} role="toolbar" aria-label={t.viewportToolbar}>
        <IconButton {...iconProps} icon={Plus} aria-label={t.addEntity} title={t.addEntity} disabled={!session.agent.value || off} onClick={() => void session.addEntity(selected === 1 ? session.selection.value[0]! : null)} />
        <IconButton {...iconProps} icon={Trash2} aria-label={t.deleteSelection} title={`${t.deleteSelection} (Delete)`} disabled={selected === 0 || off} onClick={() => session.deleteSelection()} />
        <IconButton {...iconProps} icon={Copy} aria-label={t.copySelection} title={`${t.copySelection} (Ctrl+C)`} disabled={selected === 0 || off} onClick={() => void session.copyToSystem()} />
        <IconButton {...iconProps} icon={ClipboardPaste} aria-label={t.paste} title={`${t.paste} (Ctrl+V)`} disabled={!session.agent.value || off} onClick={() => void session.pasteFromSystem()} />
        <IconButton {...iconProps} icon={CopyPlus} aria-label={t.duplicate} title={`${t.duplicate} (Ctrl+D)`} disabled={selected === 0 || off} onClick={() => void session.duplicateSelection()} />
        <IconButton {...iconProps} icon={Package} aria-label={t.makePrefab} title={t.makePrefab} disabled={selected !== 1 || off} onClick={() => void session.makePrefabFromSelection()} />
        <Separator orientation="vertical" />
        {snapControls()}
        <IconButton {...iconProps} icon={Activity} variant={session.realtime.value ? 'soft' : 'ghost'} aria-pressed={session.realtime.value} aria-label={session.realtime.value ? t.realtimeOn : t.realtimeOff} title={session.realtime.value ? t.realtimeOn : t.realtimeOff} disabled={!session.agent.value || off} onClick={() => session.setRealtime(!session.realtime.value)} />
        <span {...css.attrs(styles.spacer)} />
        <Select
          {...css.attrs(styles.guide)}
          size="sm"
          aria-label={t.frameGuide}
          title={t.frameGuide}
          items={FRAME_GUIDES.map(([label, aspect]) => ({ value: String(aspect), label: aspect === 0 ? t.frameGuideOff : label }))}
          _value={String(session.frameGuide.value)}
          onUpdate:_value={(value: string | null) => (session.frameGuide.value = Number(value ?? 0))}
        />
      </div>
    );
  };
});

export const StatusBar = _component(({ session }: { session: EditorSession }) => {
  return () => {
    const notice = session.notice.value;
    const message = notice || session.status.value;
    const selected = session.selection.value.length;
    return (
      <footer {...css.attrs(styles.status)}>
        <span {...css.attrs(styles.message, notice ? styles.notice : undefined)} role="status" title={message}>{message}</span>
        {selected > 0 && <span>{t.selectedCount(selected)}</span>}
        <Select
          {...css.attrs(styles.language)}
          size="xs"
          variant="soft"
          aria-label={t.language}
          title={t.language}
          items={(Object.keys(LOCALES) as Locale[]).map((code) => ({ value: code, label: LOCALES[code] }))}
          _value={locale.value}
          onUpdate:_value={(value: string | null) => value && setLocale(value as Locale)}
        />
      </footer>
    );
  };
});
