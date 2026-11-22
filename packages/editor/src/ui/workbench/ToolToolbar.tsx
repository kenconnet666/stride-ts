/**
 * 开着视口的编辑工具时视口上面的工具条（换掉对实体的操作）：多边形（选择模式、操作的距离、挤出倒角……）、样条（删点、拉出
 * 分支）、白盒（加减交、删笔刷、转成多边形网格）、雕刻（笔刷的种类、半径、强度，或者地物的字段），最后是"完成"。
 */
import { Check, Combine, Slice, FlipVertical2, GitBranchPlus, Merge, Plus, Scissors, Shapes, SquareDashedBottom, Trash2, ArrowUpFromLine } from '@lucide/icons';
import type { PolyOperation } from '@stride-ts/engine/modeling';
import type { SculptBrush } from '@stride-ts/engine';
import { _component } from '@zerodep-dev/vue-tsx-pro-tsx';
import { css } from '@zerodep-dev/vue-tsx-pro-tsx/styles';
import { Button, Checkbox, Flex, Menu, MenuItem, NumberField, Separator, Text, Toolbar } from '@zerodep-dev/vue-tsx-pro-ui';
import { t } from '../i18n/messages';
import type { ViewportTools } from '../session/ViewportTools';

const styles = css.create({
  step: { width: '6.5em' },
});

export const ToolToolbar = _component(({ tools }: { tools: ViewportTools }) => {
  /** 挤出、内插、倒角的距离（米）：工具条上一个数，几个操作共用。 */
  let polyAmount = _state(0.25);
  /**
   * 编辑多边形网格时的工具条：选择模式（点、边、面）、操作的距离、各个操作（选的东西对得上才能点），最后是"完成"。
   */
  const polyControls = (poly: NonNullable<typeof tools.polyEditing.value>) => {
    const { vertices, edges, faces } = poly.selection;
    const soft = tools.polySoft.value;
    const operation = (name: keyof typeof t.polyOps, icon: typeof Plus, enabled: boolean, build: () => PolyOperation | undefined) => (
      <Button size="sm" variant="ghost" tone="neutral" icon={icon} disabled={!enabled} onClick={() => {
        const op = build();
        if (op) tools.polyOperation(op);
        else tools.report(t.polyConnectNeedsFace);
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
        <Button size="sm" variant={poly.mode === mode ? 'soft' : 'ghost'} tone="neutral" aria-pressed={poly.mode === mode} title={`${t.polyModes[mode]} (${i + 1})`} onClick={() => tools.setPolyMode(mode)}>{t.polyModes[mode]}</Button>
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
      operation('loopCut', Slice, edges.length === 1, () => ({ op: 'loopCut', edge: edges[0]! })),
      operation('flip', FlipVertical2, faces.length > 0, () => ({ op: 'flip', faces })),
      operation('delete', Trash2, faces.length > 0, () => ({ op: 'delete', faces })),
      <Separator orientation="vertical" />,
      <Checkbox size="sm" _checked={soft.enabled} title={t.polySoftHint} onUpdate:_checked={(enabled: boolean) => tools.setPolySoft({ ...soft, enabled })}>{t.polySoft}</Checkbox>,
      <NumberField {...css.attrs(styles.step)} size="sm" prefix={t.polySoftRadius} aria-label={t.polySoftRadius} disabled={!soft.enabled} min={0.01} step={0.1} format={{ useGrouping: false, maximumFractionDigits: 3 }}
        _value={soft.radius} onUpdate:_value={(radius: number | null) => radius !== null && radius > 0 && tools.setPolySoft({ ...soft, radius })} />,
      <Flex grow />,
      <Button size="sm" variant="soft" tone="accent" icon={Check} onClick={() => tools.stop()}>{t.polyDone}</Button>,
    ];
  };
  /** 编辑样条时的工具条：几个点（分支的也算）、从选中的点拉出分支、删除选中的点，最后是"完成"。 */
  const splineControls = (editing: NonNullable<typeof tools.splineEditing.value>) => [
    <Text tone="muted" numeric>{t.splinePoints(editing.spline.points.length + (editing.spline.branches ?? []).reduce((sum, branch) => sum + branch.points.length, 0))}</Text>,
    <Button size="sm" variant="ghost" tone="neutral" icon={GitBranchPlus} title={t.splineBranchHint} disabled={editing.selection.length !== 1}
      onClick={() => tools.branchSpline()}>{t.splineBranch}</Button>,
    <Button size="sm" variant="ghost" tone="neutral" icon={Trash2} title={`${t.splineDeletePoints} (Delete)`} disabled={editing.selection.length === 0}
      onClick={() => tools.deleteSplinePoints()}>{t.splineDeletePoints}</Button>,
    <Flex grow />,
    <Button size="sm" variant="soft" tone="accent" icon={Check} onClick={() => tools.stop()}>{t.polyDone}</Button>,
  ];
  /** 编辑白盒时的工具条：几个笔刷、选中的那个是加减交、删除选中的，最后是"完成"。 */
  const brushControls = (editing: NonNullable<typeof tools.brushEditing.value>) => {
    const shape = editing.selection === undefined ? undefined : editing.brush.brushes[editing.selection];
    return [
      <Text tone="muted" numeric>{t.brushCount(editing.brush.brushes.length)}</Text>,
      ...(['add', 'subtract', 'intersect'] as const).map((operation) => (
        <Button size="sm" variant={shape?.operation === operation ? 'soft' : 'ghost'} tone="neutral" aria-pressed={shape?.operation === operation} disabled={!shape}
          onClick={() => tools.setBrushOperation(operation)}>{t.brushOperations[operation]}</Button>
      )),
      <Button size="sm" variant="ghost" tone="neutral" icon={Trash2} title={`${t.brushDelete} (Delete)`} disabled={!shape || editing.brush.brushes.length <= 1}
        onClick={() => tools.deleteSelectedBrush()}>{t.brushDelete}</Button>,
      <Flex grow />,
      <Button size="sm" variant="ghost" tone="neutral" icon={Shapes} title={t.brushToPolyHint} onClick={() => void tools.exportBrushToPoly()}>{t.brushToPoly}</Button>,
      <Button size="sm" variant="soft" tone="accent" icon={Check} onClick={() => tools.stop()}>{t.polyDone}</Button>,
    ];
  };
  /** 编辑 SDF 时的工具条：几个形状、加形状（九种）、选中的那个是加减交和融合的宽度、删除，最后是"完成"。 */
  const sdfControls = (editing: NonNullable<typeof tools.sdfEditing.value>) => {
    const shape = editing.selection === undefined ? undefined : editing.sdf.shapes[editing.selection];
    return [
      <Text tone="muted" numeric>{t.sdfCount(editing.sdf.shapes.length)}</Text>,
      <Menu trigger={(props) => <Button {...props} size="sm" variant="soft" tone="neutral" icon={Plus}>{t.sdfAdd}</Button>}>
        {(Object.keys(t.sdfShapes) as (keyof typeof t.sdfShapes)[]).map((kind) => <MenuItem onAction={() => tools.addSdfShape(kind)}>{t.sdfShapes[kind]}</MenuItem>)}
      </Menu>,
      ...(['add', 'subtract', 'intersect'] as const).map((operation) => (
        <Button size="sm" variant={shape?.operation === operation ? 'soft' : 'ghost'} tone="neutral" aria-pressed={shape?.operation === operation} disabled={!shape}
          onClick={() => tools.setSdfShape({ operation })}>{t.brushOperations[operation]}</Button>
      )),
      <NumberField size="sm" prefix={t.sdfSmoothness} aria-label={t.sdfSmoothness} disabled={!shape} min={0} step={0.01} format={{ useGrouping: false, maximumFractionDigits: 3 }}
        _value={shape?.smoothness ?? 0} onUpdate:_value={(value: number | null) => value !== null && tools.setSdfShape({ smoothness: value })} />,
      <Button size="sm" variant="ghost" tone="neutral" icon={Trash2} title={`${t.sdfDelete} (Delete)`} disabled={!shape || editing.sdf.shapes.length <= 1}
        onClick={() => tools.deleteSelectedSdfShape()}>{t.sdfDelete}</Button>,
      <Flex grow />,
      <Button size="sm" variant="soft" tone="accent" icon={Check} onClick={() => tools.stop()}>{t.polyDone}</Button>,
    ];
  };
  /**
   * 雕刻地形时的工具条：先是笔刷、地物两种工具；笔刷是种类、半径（米）、强度，地物是新建、选中的那个的高度、过渡宽度、强度
   * 和删除；文件里有几笔，最后是"完成"。
   */
  const sculptControls = (sculpting: NonNullable<typeof tools.sculpting.value>) => {
    const modes = (['brush', 'features'] as const).map((tool) => (
      <Button size="sm" variant={sculpting.tool === tool ? 'soft' : 'ghost'} tone="neutral" aria-pressed={sculpting.tool === tool} onClick={() => tools.setSculptTool(tool)}>{t.sculptTools[tool]}</Button>
    ));
    const tail = [
      <Flex grow />,
      <Text tone="muted" numeric>{t.sculptStrokes(sculpting.file.strokes?.length ?? 0)}</Text>,
      <Button size="sm" variant="soft" tone="accent" icon={Check} onClick={() => tools.stop()}>{t.sculptDone}</Button>,
    ];
    if (sculpting.tool === 'features') {
      const feature = sculpting.feature === undefined ? undefined : sculpting.file.features?.[sculpting.feature];
      const field = (label: string, value: number, patch: (value: number) => Parameters<typeof tools.updateTerrainFeature>[0], options: { min?: number; max?: number; step: number }) => (
        <NumberField {...css.attrs(styles.step)} size="sm" prefix={label} aria-label={label} {...options} format={{ useGrouping: false, maximumFractionDigits: 2 }}
          _value={value} onUpdate:_value={(next: number | null) => next !== null && next !== value && tools.updateTerrainFeature(patch(next))} />
      );
      return [
        ...modes,
        <Separator orientation="vertical" />,
        <Button size="sm" variant="ghost" tone="neutral" icon={Plus} title={t.featureAddHint} onClick={() => tools.addTerrainFeature()}>{t.featureAdd}</Button>,
        ...(feature ? [
          field(t.featureHeight, feature.height, (height) => ({ height }), { step: 1 }),
          field(t.featureFalloff, feature.falloff ?? 0, (falloff) => ({ falloff }), { min: 0, step: 5 }),
          field(t.sculptStrength, feature.strength ?? 1, (strength) => ({ strength }), { min: 0, max: 1, step: 0.1 }),
          <Button size="sm" variant="ghost" tone="neutral" icon={Trash2} onClick={() => tools.deleteTerrainFeature()}>{t.featureDelete}</Button>,
        ] : []),
        ...tail,
      ];
    }
    const brush = tools.sculptBrush.value;
    // 抬高、压低的强度是米；压平、磨平是 0..1：换到另一类时强度换成那一类的默认值
    const isFraction = (op: SculptBrush['op']) => op === 'flatten' || op === 'smooth';
    const fraction = isFraction(brush.op);
    return [
      ...modes,
      <Separator orientation="vertical" />,
      ...(['raise', 'lower', 'flatten', 'smooth'] as const).map((op) => (
        <Button size="sm" variant={brush.op === op ? 'soft' : 'ghost'} tone="neutral" aria-pressed={brush.op === op}
          onClick={() => tools.setSculptBrush({ ...brush, op, strength: isFraction(op) === fraction ? brush.strength : isFraction(op) ? 0.5 : 4 })}>{t.sculptOps[op]}</Button>
      )),
      <Separator orientation="vertical" />,
      <NumberField {...css.attrs(styles.step)} size="sm" prefix={t.sculptRadius} aria-label={t.sculptRadius} min={0.5} step={5} format={{ useGrouping: false, maximumFractionDigits: 2 }}
        _value={brush.radius} onUpdate:_value={(value: number | null) => value !== null && value > 0 && tools.setSculptBrush({ ...brush, radius: value })} />,
      <NumberField {...css.attrs(styles.step)} size="sm" prefix={t.sculptStrength} aria-label={t.sculptStrength} min={0} {...(fraction ? { max: 1 } : {})} step={fraction ? 0.1 : 1} format={{ useGrouping: false, maximumFractionDigits: 3 }}
        _value={brush.strength} onUpdate:_value={(value: number | null) => value !== null && value >= 0 && tools.setSculptBrush({ ...brush, strength: value })} />,
      ...tail,
    ];
  };
  return () => {
    const poly = tools.polyEditing.value, spline = tools.splineEditing.value, brush = tools.brushEditing.value, sdf = tools.sdfEditing.value, sculpting = tools.sculpting.value;
    const controls = poly ? polyControls(poly) : spline ? splineControls(spline) : brush ? brushControls(brush) : sdf ? sdfControls(sdf) : sculpting ? sculptControls(sculpting) : [];
    return <Toolbar docked="top" aria-label={t.viewportToolbar}>{controls}</Toolbar>;
  };
});
