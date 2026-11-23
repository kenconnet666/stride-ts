/**
 * 环境查询的运行（格式见 content/formats/environmentQueryFormat.ts）：生成候选点、贴到导航网格上、按测试筛和打分、取一个。
 *
 *   const result = runEnvironmentQuery(query, { game, querier: guard.transform.position, parameter: (name) => threat });
 *   if (result.point) agent.moveTo(result.point);
 */
import type { EnvironmentQueryData, EnvironmentQueryTestData } from '../content/formats/environmentQueryFormat';
import { Vector3, type Vec3Like } from '../data/vectors';
import type { Game } from '../engine/Game';

/** 查询要的东西：游戏（导航、物理）、查询的人站在哪、位置参数怎么取。 */
export interface EnvironmentQueryInput {
  readonly game: Game;
  readonly querier: Vec3Like;
  /** 位置参数（测试、生成器里写的名字）；名字空着的不会问。 */
  readonly parameter: (name: string) => Vec3Like;
}

export interface EnvironmentQueryResult {
  /** 选中的点；一个都没留下时是 undefined。 */
  readonly point: Vector3 | undefined;
  /** 生成了几个、贴到导航网格上的几个、筛完留下几个。 */
  readonly generated: number;
  readonly onNavMesh: number;
  readonly kept: number;
  readonly milliseconds: number;
}

/** 眼睛和被看的点的高度（米）。 */
const EYE_HEIGHT = 1.6, TARGET_HEIGHT = 1;

export function runEnvironmentQuery(query: EnvironmentQueryData, input: EnvironmentQueryInput): EnvironmentQueryResult {
  const started = performance.now();
  const at = (name: string): Vec3Like => (name === '' ? input.querier : input.parameter(name));
  const center = at(query.generator.around);
  const raw = generate(query, center);
  // 贴到导航网格上（没有导航时用地形的高度，再没有就用中心的高度）
  const navigation = input.game.navigation;
  const points: Vector3[] = [];
  for (const point of raw) {
    if (navigation?.ready) {
      const snapped = navigation.nearestPoint(point);
      if (snapped && Math.hypot(snapped.x - point.x, snapped.z - point.z) < 1) points.push(snapped);
    } else {
      points.push(new Vector3(point.x, input.game.terrain.heightAt(point.x, point.z) ?? center.y, point.z));
    }
  }
  const scores = new Float64Array(points.length);
  let kept = points.map((_, i) => i);
  for (const test of query.tests) {
    const values = kept.map((i) => evaluate(test, points[i]!, input, at));
    if (test.mode === 'filter') {
      kept = kept.filter((_, k) => values[k]!.pass);
      continue;
    }
    // 打分：这个测试的分数在留下的点里归一到 0..1 再乘权重
    let min = Infinity, max = -Infinity;
    for (const value of values) {
      min = Math.min(min, value.score);
      max = Math.max(max, value.score);
    }
    kept.forEach((i, k) => {
      scores[i]! += test.weight * (max > min ? (values[k]!.score - min) / (max - min) : 1);
    });
  }
  let point: Vector3 | undefined;
  if (kept.length > 0) {
    const ranked = [...kept].sort((a, b) => scores[b]! - scores[a]!);
    const pool = query.pick === 'top25' ? ranked.slice(0, Math.max(1, Math.ceil(ranked.length / 4))) : ranked.slice(0, 1);
    point = points[pool[Math.floor(Math.random() * pool.length)]!]!.clone();
  }
  return { point, generated: raw.length, onNavMesh: points.length, kept: kept.length, milliseconds: performance.now() - started };
}

function generate(query: EnvironmentQueryData, center: Vec3Like): Vector3[] {
  const generator = query.generator;
  const points: Vector3[] = [];
  if (generator.type === 'rings') {
    for (let ring = 1; ring <= generator.rings; ring++) {
      const radius = (generator.radius * ring) / generator.rings;
      for (let i = 0; i < generator.count; i++) {
        const angle = ((i + (ring % 2) * 0.5) / generator.count) * Math.PI * 2;
        points.push(new Vector3(center.x + Math.cos(angle) * radius, center.y, center.z + Math.sin(angle) * radius));
      }
    }
  } else {
    const steps = Math.max(1, Math.floor(generator.size / generator.spacing));
    for (let z = 0; z <= steps; z++) {
      for (let x = 0; x <= steps; x++) {
        points.push(new Vector3(center.x - generator.size / 2 + x * generator.spacing, center.y, center.z - generator.size / 2 + z * generator.spacing));
      }
    }
  }
  return points;
}

/** 一个测试在一个点上：过不过（filter）、多少分（score）。 */
function evaluate(test: EnvironmentQueryTestData, point: Vector3, input: EnvironmentQueryInput, at: (name: string) => Vec3Like): { pass: boolean; score: number } {
  switch (test.type) {
    case 'distance': {
      const to = at(test.to);
      const distance = Math.hypot(point.x - to.x, point.z - to.z);
      return { pass: distance >= test.min && distance <= test.max, score: test.prefer === 'near' ? -distance : distance };
    }
    case 'visible': {
      const seen = visible(input.game, at(test.from), point);
      return { pass: seen === test.want, score: seen === test.want ? 1 : 0 };
    }
    case 'reachable': {
      const end = input.game.navigation?.findPath(input.querier, point)?.at(-1);
      const ok = end !== undefined && Math.hypot(end.x - point.x, end.z - point.z) < 0.5;
      return { pass: ok, score: ok ? 1 : 0 };
    }
    case 'random':
      return { pass: true, score: Math.random() };
  }
}

/** 从 viewer 的眼睛看 point 的身体：中间没有碰撞体。 */
function visible(game: Game, viewer: Vec3Like, point: Vec3Like): boolean {
  const simulation = game.simulation;
  if (!simulation) return true;
  const from = [viewer.x, viewer.y + EYE_HEIGHT, viewer.z] as const;
  const dx = point.x - from[0], dy = point.y + TARGET_HEIGHT - from[1], dz = point.z - from[2];
  const distance = Math.hypot(dx, dy, dz);
  if (distance < 1e-6) return true;
  const hit = simulation.rayCast([...from], [dx / distance, dy / distance, dz / distance], distance);
  return hit === undefined || hit.distance >= distance - 0.05;
}
