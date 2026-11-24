/**
 * UV 面板（照 Blender 的 UV Editor、ProBuilder 的 UV Editor）：编辑多边形时选中的面的 UV，画在 0..1 的棋盘格上（一格是贴图的一个
 * 周期）。拖着整块平移，滚轮缩放（绕选中的中心），工具条上平面投影（选中的面按平均法线展成一块，modeling/polyUv.ts）、转 90°、
 * 左右翻、回到自动投影。拖的时候面板里先跟着动，松开时改文件（一步撤销），视口里的模型重新烘。
 *
 * 只画选中的面（面模式）；选的是点、边或者什么都没选时提示先选面。UV 编辑的操作和 MCP 的 edit_poly（uvProject、uvTransform、
 * uvReset）是同一套。
 */
import { FlipHorizontal2, RotateCw, Scan, Undo2, ZoomIn, ZoomOut } from '@lucide/icons';
import { _component } from '@zerodep-dev/vue-tsx-pro-tsx';
import { css } from '@zerodep-dev/vue-tsx-pro-tsx/styles';
import { Button, Empty, Flex, IconButton, Text, Toolbar } from '@zerodep-dev/vue-tsx-pro-ui';
import { faceUvs } from '@stride-ts/engine/modeling';
import { t } from '../i18n/messages';
import type { EditorSession } from '../session/EditorSession';

const styles = css.create({
  panel: { height: '100%', minHeight: '0', fontSize: '0.75rem' },
  canvas: { flex: '1', minHeight: '0', position: 'relative', overflow: 'hidden', cursor: 'grab', touchAction: 'none' },
  svg: { position: 'absolute', inset: '0', width: '100%', height: '100%' },
});

/** 棋盘格的颜色和 UV 的线（领域图：在编辑器里画，跟主题的明暗走 currentColor）。 */
const CHECKER = 'color-mix(in srgb, currentColor 8%, transparent)';
const OUTLINE = '#ff9a3c';

export const UvPanel = _component(({ session }: { session: EditorSession }) => {
  const tools = _untrack(session).tools;
  /** 正在拖：按下时的 UV 坐标、现在挪了多少（UV 单位）。 */
  let drag = _state.raw<{ readonly from: readonly [number, number]; offset: [number, number] } | undefined>(undefined);
  let svg = _state.raw<SVGSVGElement | null>(null);

  const selection = () => {
    const poly = tools.polyEditing.value;
    return poly && poly.mode === 'face' && poly.selection.faces.length > 0 ? { poly, faces: poly.selection.faces } : undefined;
  };
  const op = (build: (faces: readonly number[]) => Parameters<typeof tools.polyOperation>[0]) => {
    const current = selection();
    if (current) tools.polyOperation(build(current.faces));
  };
  /** 屏幕上的点换成 UV：SVG 的坐标系 x 向右是 u、y 向下是 v（同贴图的左上角是原点）。 */
  const toUv = (event: PointerEvent | WheelEvent): [number, number] | undefined => {
    const element = svg, matrix = element?.getScreenCTM();
    if (!element || !matrix) return undefined;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return [point.x, point.y];
  };

  return () => {
    const current = selection();
    if (!current) return <Empty size="sm" icon={false} description={t.uvSelectFaces} />;
    const { poly, faces } = current;
    const islands = faces.map((f) => faceUvs(poly.mesh, f));
    const all = islands.flat();
    // 视野：选中的 UV 加上 0..1 那一格，四周留一点
    const minU = Math.min(0, ...all.map((p) => p[0])), maxU = Math.max(1, ...all.map((p) => p[0]));
    const minV = Math.min(0, ...all.map((p) => p[1])), maxV = Math.max(1, ...all.map((p) => p[1]));
    const pad = Math.max(maxU - minU, maxV - minV) * 0.08;
    const box = [minU - pad, minV - pad, maxU - minU + pad * 2, maxV - minV + pad * 2] as const;
    const shift = drag?.offset ?? [0, 0];
    const stroke = box[2] / 400;
    return (
      <Flex direction="column" sx={styles.panel}>
        <Toolbar docked="top" aria-label={t.toolWindows.uv}>
          <Button size="sm" variant="soft" tone="neutral" icon={Scan} title={t.uvProjectHint} onClick={() => op((f) => ({ op: 'uvProject', faces: f }))}>{t.uvProject}</Button>
          <IconButton size="sm" variant="ghost" tone="neutral" icon={RotateCw} aria-label={t.uvRotate} title={t.uvRotate} onClick={() => op((f) => ({ op: 'uvTransform', faces: f, rotation: -90 }))} />
          <IconButton size="sm" variant="ghost" tone="neutral" icon={FlipHorizontal2} aria-label={t.uvFlip} title={t.uvFlip} onClick={() => op((f) => ({ op: 'uvTransform', faces: f, scale: [-1, 1] }))} />
          <IconButton size="sm" variant="ghost" tone="neutral" icon={ZoomIn} aria-label={t.uvGrow} title={t.uvGrow} onClick={() => op((f) => ({ op: 'uvTransform', faces: f, scale: 1.25 }))} />
          <IconButton size="sm" variant="ghost" tone="neutral" icon={ZoomOut} aria-label={t.uvShrink} title={t.uvShrink} onClick={() => op((f) => ({ op: 'uvTransform', faces: f, scale: 0.8 }))} />
          <Button size="sm" variant="ghost" tone="neutral" icon={Undo2} title={t.uvResetHint} onClick={() => op((f) => ({ op: 'uvReset', faces: f }))}>{t.uvReset}</Button>
          <Flex grow><Text tone="muted" truncate>{t.uvHint(faces.length)}</Text></Flex>
        </Toolbar>
        <div {...css.attrs(styles.canvas)}
          onPointerdown={(event: PointerEvent) => {
            const at = toUv(event);
            if (!at) return;
            (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
            drag = { from: at, offset: [0, 0] };
          }}
          onPointermove={(event: PointerEvent) => {
            const at = drag && toUv(event);
            if (drag && at) drag = { ...drag, offset: [at[0] - drag.from[0], at[1] - drag.from[1]] };
          }}
          onPointerup={() => {
            const moved = drag?.offset;
            drag = undefined;
            if (moved && Math.hypot(moved[0], moved[1]) > 1e-4) op((f) => ({ op: 'uvTransform', faces: f, offset: [moved[0], moved[1]] }));
          }}
          onWheel={(event: WheelEvent) => {
            event.preventDefault();
            op((f) => ({ op: 'uvTransform', faces: f, scale: event.deltaY < 0 ? 1.1 : 1 / 1.1 }));
          }}>
          <svg ref={(element: unknown) => (svg = element as SVGSVGElement | null)} {...css.attrs(styles.svg)} viewBox={box.join(' ')} preserveAspectRatio="xMidYMid meet" role="img" aria-label={t.uvCanvas}>
            {/* 棋盘格铺满整个面板（面板比视野宽时两边也有），格子对齐整数的 UV */}
            <defs>
              <pattern id="uv-checker" width={2} height={2} patternUnits="userSpaceOnUse">
                <rect width={1} height={1} fill={CHECKER} />
                <rect x={1} y={1} width={1} height={1} fill={CHECKER} />
              </pattern>
            </defs>
            <rect x={box[0] - box[2] * 4} y={box[1] - box[3] * 4} width={box[2] * 9} height={box[3] * 9} fill="url(#uv-checker)" />
            <rect x={0} y={0} width={1} height={1} fill="none" stroke="currentColor" stroke-opacity="0.5" stroke-width={stroke * 1.5} />
            {islands.map((points) => (
              <polygon points={points.map(([u, v]) => `${u + shift[0]},${v + shift[1]}`).join(' ')} fill={`${OUTLINE}33`} stroke={OUTLINE} stroke-width={stroke * 2} stroke-linejoin="round" />
            ))}
          </svg>
        </div>
      </Flex>
    );
  };
});
