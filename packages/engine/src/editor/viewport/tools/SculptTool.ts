/**
 * 雕刻地形的视口工具（W2）。两种左键：
 * - 笔刷（tool 'brush'）：光标下的地面上画出笔刷的圈；[、] 缩小、放大笔刷；左键按着时每挪过半径的四分之一落一笔（拖得快时
 *   中间补上），这一帧落的几笔换成预览的地形（马上看到，只重算改到的块）；按住 Shift 抬高、压低反过来；压平压到按下那一点的
 *   高度。松开时把这一次拖落的笔画交给 onStroke 存进文件（撤销的一步）。
 * - 地物（tool 'features'）：每个压平的地物的轮廓贴着地面画出来（选中的高亮），角上画小圈。左键按在角上拖这个角，按在多边形里
 *   拖整个地物，按在空处取消选中；在边上双击加一个角。拖的时候每帧换成预览的版本，松开交给 onFeatures 存文件。
 */
import type { Entity } from '../../../engine/Entity';
import type { DebugColor } from '../../../debug/DebugDraw';
import type { TerrainFeatureFile, TerrainFile, TerrainStrokeFile } from '../../../content/formats/terrainFormat';
import { Terrain, TerrainAsset } from '../../../world/Terrain';
import type { TerrainHit } from '../../../world/TerrainSystem';
import { Clicks, SELECTED_COLOR, type Pixel, type Point3, type ViewportFrame, type ViewportTool } from './ViewportTool';

/**
 * 雕刻的笔刷：op 是抬高、压低、压平（到按下处的高度）、磨平；半径是米；strength：抬高、压低是拖过一遍大约抬起、压下多少米，
 * 压平、磨平是 0..1（拖过一遍贴近多少）。
 */
export interface SculptBrush {
  readonly op: TerrainStrokeFile['op'];
  readonly radius: number;
  readonly strength: number;
}

export const DEFAULT_SCULPT_BRUSH: SculptBrush = { op: 'raise', radius: 40, strength: 4 };

/** 笔刷的圈：抬高是白的，压低是红的。 */
const RAISE_COLOR: DebugColor = [1, 1, 1, 0.9];
const LOWER_COLOR: DebugColor = [1, 0.3, 0.3, 0.9];
/** 笔刷的圈分几段。 */
const RING_SEGMENTS = 48;
/** 没选中的地物的轮廓。 */
const FEATURE_COLOR: DebugColor = [0.85, 0.95, 1, 0.85];
/** 点地物的角、边：光标离它在屏幕上多少像素以内。 */
const CORNER_PIXELS = 10;

export class SculptTool implements ViewportTool {
  /** 雕的地形实体（场景文件的 id）。 */
  readonly entity: string;
  brush: SculptBrush;
  /** 左键拖的是笔刷还是地物。 */
  tool: 'brush' | 'features';
  /** 选中的地物（文件里 features 的下标）。 */
  feature: number | undefined;
  /** 光标最近一次指着的地面（地形本地的 x、z 和高度）：新建的地物放这里。 */
  cursor: Point3 | undefined;
  /** 雕完一笔（松开左键）以后调：地形资源的内容路径和这一笔落下的笔画（地形本地坐标，按顺序接在文件的笔画后面）。 */
  onStroke: ((path: string, strokes: readonly TerrainStrokeFile[]) => void) | undefined;
  /** 视口里改了笔刷（[、] 改大小）以后调，编辑器的工具条跟着变。 */
  onBrush: ((brush: SculptBrush) => void) | undefined;
  /** 拖完地物（松开左键）以后调：地形资源的内容路径和改过的全部地物（编辑器存进文件、记一步撤销）。 */
  onFeatures: ((path: string, features: readonly TerrainFeatureFile[]) => void) | undefined;
  /** 点选了地物（或点空处取消，undefined）以后调，编辑器的工具条显示它的字段。 */
  onSelect: ((feature: number | undefined) => void) | undefined;
  /** 正在拖的一笔：上一笔落在哪（地形本地的 x、z），这一次拖落下的笔画，压平的目标高度（按下处）。 */
  #stroke: { last: [number, number] | undefined; strokes: TerrainStrokeFile[]; height: number } | undefined;
  /** 拖地物：拖的是哪个地物的哪个角（undefined 是整个地物），按下时光标下的地面（地形本地 x、z），按下时的地物，挪没挪过。 */
  #featureDrag: { readonly feature: number; readonly vertex: number | undefined; readonly anchor: readonly [number, number]; readonly start: readonly TerrainFeatureFile[]; moved: boolean } | undefined;
  /** 换上去的预览版本：最近两个留着（地形系统一帧之内换到新的上，上一个可能还没换过来），更早的放掉。 */
  #previews: TerrainAsset[] = [];
  readonly #clicks = new Clicks();

  constructor(entity: string, brush: SculptBrush = DEFAULT_SCULPT_BRUSH, tool: 'brush' | 'features' = 'brush') {
    this.entity = entity;
    this.brush = brush;
    this.tool = tool;
  }

  dispose(): void {
    for (const preview of this.#previews) preview.dispose();
    this.#previews = [];
  }

  update(frame: ViewportFrame): void {
    const terrain = frame.agent.live?.entity(this.entity);
    if (!terrain?.alive || !terrain.has(Terrain)) return;
    const { input } = frame;
    if (!frame.navigating) {
      const scale = input.isKeyPressed('BracketRight') ? 1.25 : input.isKeyPressed('BracketLeft') ? 0.8 : 1;
      if (scale !== 1) {
        this.brush = { ...this.brush, radius: round(Math.max(0.5, this.brush.radius * scale), 2) };
        this.onBrush?.(this.brush);
      }
    }
    const ray = frame.ray(frame.pixel);
    const hit = frame.game.terrain.raycast([ray.origin.x, ray.origin.y, ray.origin.z], [ray.direction.x, ray.direction.y, ray.direction.z]);
    const onTerrain = hit?.entity === terrain ? hit : undefined;
    if (onTerrain) this.cursor = [onTerrain.local[0], onTerrain.local[1], onTerrain.height];
    if (this.tool === 'features') this.#features(frame, terrain, onTerrain);
    else this.#sculpt(frame, terrain, onTerrain);
  }

  #sculpt(frame: ViewportFrame, terrain: Entity, hit: TerrainHit | undefined): void {
    const { radius, strength } = this.brush;
    const op = !frame.shift ? this.brush.op : this.brush.op === 'raise' ? 'lower' : this.brush.op === 'lower' ? 'raise' : this.brush.op;
    if (hit) this.#drawRing(frame, hit.point, radius, op === 'lower' ? LOWER_COLOR : RAISE_COLOR);
    if (frame.pressed && hit) this.#stroke = { last: undefined, strokes: [], height: hit.height };
    const stroke = this.#stroke;
    if (stroke && frame.down && hit) {
      const spacing = radius * 0.25;
      const [x1, z1] = hit.local;
      const [x0, z0] = stroke.last ?? hit.local;
      const gap = Math.hypot(x1 - x0, z1 - z0);
      const steps = stroke.last ? Math.floor(gap / spacing) : 1;
      const dabs: TerrainStrokeFile[] = [];
      // 一遍拖过去一个点大约被八笔盖到：每笔四分之一，拖过一遍差不多是 strength
      const amount = round(strength * 0.25, 4);
      for (let i = 1; i <= steps; i++) {
        const t = stroke.last ? (i * spacing) / gap : 1;
        const x = round(x0 + (x1 - x0) * t, 2), z = round(z0 + (z1 - z0) * t, 2);
        dabs.push({ op, x, z, radius: round(radius, 2), strength: amount, ...(op === 'flatten' ? { height: round(stroke.height, 2) } : {}) });
        stroke.last = [x, z];
      }
      if (dabs.length > 0) {
        stroke.strokes.push(...dabs);
        this.#preview(frame, terrain, (file) => ({ ...file, strokes: [...(file.strokes ?? []), ...dabs] }));
      }
    }
    if (frame.released && stroke) {
      this.#stroke = undefined;
      const path = TerrainAsset.byId(terrain.require(Terrain).terrain)?.path;
      if (path && stroke.strokes.length > 0) this.onStroke?.(path, stroke.strokes);
    }
  }

  #features(frame: ViewportFrame, terrain: Entity, hit: TerrainHit | undefined): void {
    const system = frame.game.terrain, draw = frame.game.debugDraw;
    const asset = TerrainAsset.byId(terrain.require(Terrain).terrain);
    if (!asset) return;
    const features = asset.file.features ?? [];
    // 每个角在屏幕上的位置（点选用）和画出来的轮廓
    const corners: { feature: number; vertex: number; screen: Pixel }[] = [];
    features.forEach((feature, index) => {
      const color = index === this.feature ? SELECTED_COLOR : FEATURE_COLOR;
      const outline: [number, number, number][] = [];
      feature.points.forEach(([x0, z0], vertex) => {
        const [x1, z1] = feature.points[(vertex + 1) % feature.points.length]!;
        // 边按长度分段，每段贴着地面（地形在边上的起伏也看得见）
        const segments = Math.min(32, Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 4)));
        for (let i = 0; i < segments; i++) {
          const point = system.surfacePoint(terrain, x0 + ((x1 - x0) * i) / segments, z0 + ((z1 - z0) * i) / segments);
          if (point) outline.push([point[0], point[1] + 0.2, point[2]]);
        }
        const corner = system.surfacePoint(terrain, x0, z0);
        const screen = corner && frame.project(corner);
        if (corner && screen) {
          corners.push({ feature: index, vertex, screen });
          draw.circle(corner, [0, 1, 0], Math.max(0.5, frame.distanceTo(corner) * 0.01), color, { width: 2, depthTest: false });
        }
      });
      if (outline.length > 1) draw.polyline(outline, color, { closed: true, width: 2, depthTest: false });
    });

    const press = this.#featureDrag ? undefined : this.#clicks.press(frame);
    if (press) {
      const { at } = press;
      const corner = nearestCorner(corners, at);
      if (press.double && !corner) {
        // 双击边：按屏幕上的距离找边（掠射的视角下一个像素是好几米，按米算的容差不稳），新的角放在边上对应的位置
        const edge = nearestScreenEdge(corners, at);
        if (edge) {
          const points = features[edge.feature]!.points;
          const [ax, az] = points[edge.vertex]!, [bx, bz] = points[(edge.vertex + 1) % points.length]!;
          const added = [round(ax + (bx - ax) * edge.t, 2), round(az + (bz - az) * edge.t, 2)] as const;
          const next = features.map((feature, index) => index !== edge.feature ? feature : { ...feature, points: [...feature.points.slice(0, edge.vertex + 1), added, ...feature.points.slice(edge.vertex + 1)] });
          this.#select(edge.feature);
          this.#preview(frame, terrain, (file) => ({ ...file, features: next }));
          this.onFeatures?.(asset.path, next);
          return;
        }
      }
      if (corner) {
        this.#select(corner.feature);
        this.#featureDrag = { feature: corner.feature, vertex: corner.vertex, anchor: hit?.local ?? [0, 0], start: features, moved: false };
      } else {
        const inside = hit ? features.findLastIndex((feature) => insidePolygon(feature.points, hit.local)) : -1;
        this.#select(inside >= 0 ? inside : undefined);
        if (inside >= 0) this.#featureDrag = { feature: inside, vertex: undefined, anchor: hit!.local, start: features, moved: false };
      }
    }
    // 按下以后再读：同一帧里按下又松开（点一下、快的双击）时这一帧就要结束这次拖，不然下一次按下被当成还在拖
    const drag = this.#featureDrag;
    if (drag && frame.down && hit) {
      const dx = hit.local[0] - drag.anchor[0], dz = hit.local[1] - drag.anchor[1];
      const next = drag.start.map((feature, index) => {
        if (index !== drag.feature) return feature;
        const points = feature.points.map(([x, z], vertex) =>
          drag.vertex === undefined ? [round(x + dx, 2), round(z + dz, 2)] as const
            : vertex === drag.vertex ? [round(hit.local[0], 2), round(hit.local[1], 2)] as const : [x, z] as const);
        return { ...feature, points };
      });
      // 光标挪过一厘米才换版本（按着不动时不重算）
      if (JSON.stringify(next[drag.feature]!.points) !== JSON.stringify(features[drag.feature]!.points)) {
        drag.moved = true;
        this.#preview(frame, terrain, (file) => ({ ...file, features: next }));
      }
    }
    if (drag && frame.released) {
      this.#featureDrag = undefined;
      if (drag.moved) this.onFeatures?.(asset.path, TerrainAsset.byId(terrain.require(Terrain).terrain)?.file.features ?? []);
    }
  }

  #select(feature: number | undefined): void {
    if (this.feature === feature) return;
    this.feature = feature;
    this.onSelect?.(feature);
  }

  /**
   * 地形换成 change 改过的预览版本（TerrainSystem 只重算改动范围里的块，见 changedRegions），马上看得到；松开以后编辑器存文件，
   * 热重载回来的版本和预览一样、不再重算。
   */
  #preview(frame: ViewportFrame, terrain: Entity, change: (file: TerrainFile) => TerrainFile): void {
    const component = terrain.require(Terrain);
    const current = TerrainAsset.byId(component.terrain);
    if (!current) return;
    const next = new TerrainAsset(current.path, change(current.file), current.material, current.paths);
    component.terrain = next.id;
    this.#previews.push(next);
    while (this.#previews.length > 2) this.#previews.shift()!.dispose();
    frame.game.requestFrames();
  }

  /** 笔刷的圈：贴着地面的一圈线（每段按地形的高度抬一点，不被地面挡住一半）。 */
  #drawRing(frame: ViewportFrame, center: Point3, radius: number, color: DebugColor): void {
    const points: [number, number, number][] = [];
    for (let i = 0; i < RING_SEGMENTS; i++) {
      const angle = (i / RING_SEGMENTS) * Math.PI * 2;
      const x = center[0] + Math.cos(angle) * radius, z = center[2] + Math.sin(angle) * radius;
      points.push([x, (frame.game.terrain.heightAt(x, z) ?? center[1]) + radius * 0.01, z]);
    }
    const draw = frame.game.debugDraw;
    draw.polyline(points, color, { closed: true, width: 2, depthTest: false });
    draw.line(center, [center[0], center[1] + radius * 0.2, center[2]], color, { width: 2, depthTest: false });
  }
}

/** 留 digits 位小数（笔画存进文件，留厘米、万分之一就够，文件好读；除以 10 的幂，不出 0.30000000000000004）。 */
function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/** 屏幕上离 at 最近、在 CORNER_PIXELS 以内的地物的角。 */
function nearestCorner<T extends { readonly screen: Pixel }>(corners: readonly T[], at: Pixel): T | undefined {
  let best: T | undefined, bestDistance = CORNER_PIXELS;
  for (const corner of corners) {
    const distance = Math.hypot(corner.screen[0] - at[0], corner.screen[1] - at[1]);
    if (distance < bestDistance) [best, bestDistance] = [corner, distance];
  }
  return best;
}

/**
 * 屏幕上离 at 最近、在 CORNER_PIXELS 以内的地物的边（按两个角投到屏幕上的线段算）：哪个地物、从第几个角出发的边、落在边上的比例
 * t（0 是这个角，1 是下一个角；屏幕上的比例，透视下和地面上差一点，加角够用）。
 */
function nearestScreenEdge(corners: readonly { readonly feature: number; readonly vertex: number; readonly screen: Pixel }[], at: Pixel): { feature: number; vertex: number; t: number } | undefined {
  let best: { feature: number; vertex: number; t: number } | undefined, bestDistance = CORNER_PIXELS;
  for (const a of corners) {
    // 同一个地物的下一个角（下标绕回 0）；投不到屏幕上的角没有边
    const ring = corners.filter((c) => c.feature === a.feature);
    const b = ring.find((c) => c.vertex === a.vertex + 1) ?? (a.vertex === Math.max(...ring.map((c) => c.vertex)) ? ring.find((c) => c.vertex === 0) : undefined);
    if (!b || b === a) continue;
    const ex = b.screen[0] - a.screen[0], ey = b.screen[1] - a.screen[1], length2 = ex * ex + ey * ey;
    const t = length2 > 0 ? Math.max(0, Math.min(1, ((at[0] - a.screen[0]) * ex + (at[1] - a.screen[1]) * ey) / length2)) : 0;
    const distance = Math.hypot(at[0] - a.screen[0] - ex * t, at[1] - a.screen[1] - ey * t);
    if (distance < bestDistance) [best, bestDistance] = [{ feature: a.feature, vertex: a.vertex, t }, distance];
  }
  return best;
}

/** 点在不在多边形里（射线交叉数）。 */
function insidePolygon(points: readonly (readonly [number, number])[], [x, z]: readonly [number, number]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, zi] = points[i]!, [xj, zj] = points[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
