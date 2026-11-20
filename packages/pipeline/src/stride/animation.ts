/**
 * Stride 的骨骼动画资源导入：骨架（.sdskel）、动画剪辑（.sdanim）和模型网格的蒙皮。
 *
 * - 骨架：按 .sdskel 列出的节点（名字和深度，深度优先排）从源文件里取静止姿势；关节的局部变换在源文件里的父节点就是
 *   列表里的父关节时直接用，不是时（列表跳过了中间节点）由世界矩阵算。根关节带上骨架资源的导入变换（PivotPosition、
 *   ScaleImport），所以模型空间和导入后的网格一致。输出 `.skeleton`（关节名和父关节，加 ozz 的骨架档案）。
 * - 动画：源文件的第一个动画按 30 帧每秒烘焙成线性关键帧，按关节名对上骨架；动画没碰的关节用静止姿势；
 *   根关节的键同样带上导入变换。形变权重的曲线按目标名存（各网格同名的目标只留第一条）。ClipDuration 打开时只取那一段。
 *   输出 `.anim`（时长、重复方式、骨架、形变权重曲线，加 ozz 的动画档案；没有骨架时档案是空的）。
 * - 蒙皮：蒙皮网格的关节按名字对上骨架，逆绑定矩阵右乘导入变换的逆（网格的顶点已经变换过）；没有蒙皮、但挂在骨架节点上
 *   的网格做成只有一个关节的刚性蒙皮，跟着那个节点动（同 Stride 里按节点变换画的网格）。
 */
import { encodeAnimation, encodeSkeleton, EXTENSIONS, type AnimationRepeatMode, type MorphWeightCurve } from '@stride-ts/engine/content-format';
import { Matrix } from '@stride-ts/engine/math';
import type { BakedAnimation, JointDescription, JointTrack, MeshData, Scene, StrideTools } from '@stride-ts/native/tools';
import { INFLUENCES, type SourceSkin } from '../mesh.ts';
import { importTransform, loadSourceScene, sourceOf, type AssetEntry } from './project.ts';
import { asObject, timeSpanSeconds } from './yaml.ts';

/** 烘焙动画的采样率（每秒关键帧数，同 ufbx 和 Stride 的默认）。 */
const SAMPLE_RATE = 30;

export interface ImportedSkeleton {
  /** 内容路径。 */
  readonly path: string;
  readonly joints: readonly (JointDescription & { readonly name: string; readonly parent: number })[];
  readonly indexOf: ReadonlyMap<string, number>;
  /** 导入变换（位置' = (位置 - pivot) · scale）的矩阵。 */
  readonly transform: Float32Array;
}

/** 导入要用的东西：工具模块、写内容文件、记警告。 */
export interface AnimationImportContext {
  readonly tools: StrideTools;
  write(contentPath: string, data: Uint8Array): Promise<void>;
  warn(message: string): void;
}

/** 资源的导入变换（importTransform）的矩阵：先平移 -pivot，再缩放。 */
export function importMatrix(asset: AssetEntry): Float32Array {
  const { pivot, scale } = importTransform(asset);
  return Matrix.scaleTranslation(new Float32Array(16), scale, scale, scale, -pivot[0] * scale, -pivot[1] * scale, -pivot[2] * scale);
}

const isIdentity = (m: Float32Array) => m.every((value, i) => value === (i % 5 === 0 ? 1 : 0));

export async function importSkeleton(asset: AssetEntry, context: AnimationImportContext): Promise<ImportedSkeleton> {
  const listed = Object.values(asObject(asset.data['Nodes']) ?? {}).map((node) => {
    const object = asObject(node) ?? {};
    return { name: String(object['Name'] ?? ''), depth: Number(object['Depth'] ?? 0) };
  });
  if (listed.length === 0) throw new Error(`${asset.file}: the skeleton lists no nodes`);
  const transform = importMatrix(asset);
  const scene = await loadSourceScene(context.tools, sourceOf(asset));
  try {
    const nodeOf = nodesByName(scene);
    // 父关节：列表是深度优先的，每个深度最近的那个就是下一层的父关节
    const lastAtDepth: number[] = [];
    const joints = listed.map(({ name, depth }, index) => {
      const parent = depth > 0 ? (lastAtDepth[depth - 1] ?? -1) : -1;
      lastAtDepth[depth] = index;
      lastAtDepth.length = depth + 1;
      const node = nodeOf.get(cleanNodeName(name));
      if (node === undefined) {
        context.warn(`${asset.file}: skeleton node '${name}' is not in ${sourceOf(asset)}; using its rest pose as identity`);
        return { name, parent };
      }
      const source = scene.nodes[node]!;
      const parentNode = parent >= 0 ? nodeOf.get(cleanNodeName(listed[parent]!.name)) : undefined;
      if (parent >= 0 && source.parent === parentNode) return { name, parent, translation: source.translation, rotation: source.rotation, scale: source.scale };
      // 根关节在模型空间里（带上导入变换），否则相对列表里的父关节
      const local = new Float32Array(16);
      if (parent < 0) Matrix.multiply(local, transform, source.world);
      else {
        const parentWorld = parentNode === undefined ? Matrix.identity() : scene.nodes[parentNode]!.world;
        Matrix.invert(local, parentWorld);
        Matrix.multiply(local, local, source.world);
      }
      return { name, parent, ...Matrix.decompose(local) };
    });
    const archive = context.tools.buildSkeleton(joints);
    await context.write(asset.path + EXTENSIONS.skeleton, encodeSkeleton({ joints: joints.map(({ name, parent }) => ({ name, parent })), archive }));
    return { path: asset.path, joints, indexOf: new Map(joints.map((joint, i) => [cleanNodeName(joint.name), i])), transform };
  } finally {
    scene.destroy();
  }
}

/** skeleton 是 undefined 时只导入形变权重（.sdanim 的 Skeleton 是 null）。 */
export async function importAnimation(asset: AssetEntry, skeleton: ImportedSkeleton | undefined, context: AnimationImportContext): Promise<void> {
  const type = asObject(asset.data['Type'])?.$type;
  if (type !== undefined && type !== 'StandardAnimationAssetType') context.warn(`${asset.file}: ${type} is not supported yet; imported as a standard animation`);
  if (asset.data['RootMotion'] === true) context.warn(`${asset.file}: root motion is not supported yet; the root keeps its motion`);
  const scene = await loadSourceScene(context.tools, sourceOf(asset));
  try {
    if (scene.animations.length === 0) throw new Error(`${asset.file}: ${sourceOf(asset)} has no animation`);
    const baked = await scene.bakeAnimation(0, SAMPLE_RATE);
    let morphWeights = morphWeightCurves(baked, scene);
    if (!skeleton && morphWeights.length === 0) context.warn(`${asset.file}: the animation has no skeleton and no morph weights; it does nothing`);
    const nodeOf = nodesByName(scene);
    const animationTransform = importMatrix(asset);
    if (skeleton && !skeleton.joints.some((joint) => nodeOf.has(cleanNodeName(joint.name)))) context.warn(`${asset.file}: no node of ${sourceOf(asset)} matches a joint of ${skeleton.path}; the animation stays in the rest pose`);
    let tracks: JointTrack[] = (skeleton?.joints ?? []).map((joint) => {
      const node = nodeOf.get(cleanNodeName(joint.name));
      if (node === undefined) return restTrack(joint);
      const track = baked.tracks[node]!;
      if (joint.parent >= 0) return track;
      // 根关节在模型空间里：带上导入变换和它在源文件里的父节点的世界矩阵（根节点本身就是单位矩阵）
      const parentNode = scene.nodes[node]!.parent;
      const toModel = parentNode < 0 ? animationTransform : Matrix.multiply(new Float32Array(16), animationTransform, scene.nodes[parentNode]!.world);
      return isIdentity(toModel) ? track : transformTrack(track, toModel);
    });
    let duration = baked.duration;
    const clip = asObject(asset.data['ClipDuration']);
    if (clip?.['Enabled'] === true) {
      const start = timeSpanSeconds(clip['StartAnimationTime']), end = Math.min(duration, timeSpanSeconds(clip['EndAnimationTime']));
      if (end > start) {
        tracks = tracks.map((track) => trimTrack(track, start, end));
        morphWeights = morphWeights.map((curve) => trimCurve(curve, start, end));
        duration = end - start;
      }
    }
    const archive = skeleton ? withContext(asset.file, () => context.tools.buildAnimation(Math.max(duration, 1e-3), tracks)) : new Uint8Array(0);
    const repeatMode = REPEAT_MODES[String(asset.data['RepeatMode'] ?? 'LoopInfinite')] ?? 'loopInfinite';
    await context.write(asset.path + EXTENSIONS.animation, encodeAnimation({
      duration, repeatMode, ...(skeleton ? { skeleton: skeleton.path } : {}), ...(morphWeights.length > 0 ? { morphWeights } : {}), archive,
    }));
  } finally {
    scene.destroy();
  }
}

/** 烘焙出的形变权重曲线按目标名存；动画没碰的目标没有曲线，各网格同名的目标只留第一条。 */
export function morphWeightCurves(baked: BakedAnimation, scene: Scene): MorphWeightCurve[] {
  const names = new Map<number, string[]>();
  const nameOf = (mesh: number, target: number) => {
    let list = names.get(mesh);
    if (!list) names.set(mesh, (list = scene.mesh(mesh).morphTargets.map((morph) => morph.name)));
    return list[target]!;
  };
  const curves = new Map<string, MorphWeightCurve>();
  for (const { mesh, target, keys } of baked.morphWeights) {
    const name = nameOf(mesh, target);
    if (keys.length === 0 || curves.has(name)) continue;
    curves.set(name, { target: name, times: keys.map(([time]) => time), values: keys.map(([, value]) => value) });
  }
  return [...curves.values()];
}

/** 曲线只取 [start, end]，时间从 0 起；两端按线性插值补键。 */
function trimCurve(curve: MorphWeightCurve, start: number, end: number): MorphWeightCurve {
  const at = (time: number) => {
    const next = curve.times.findIndex((t) => t >= time);
    if (next <= 0) return curve.values[next === 0 ? 0 : curve.values.length - 1]!;
    const t0 = curve.times[next - 1]!, t1 = curve.times[next]!;
    return curve.values[next - 1]! + (curve.values[next]! - curve.values[next - 1]!) * ((time - t0) / (t1 - t0));
  };
  const inside = curve.times.map((time, k) => [time, curve.values[k]!] as const).filter(([time]) => time > start && time < end);
  const keys = [[start, at(start)] as const, ...inside, [end, at(end)] as const];
  return { target: curve.target, times: keys.map(([time]) => time - start), values: keys.map(([, value]) => value) };
}

/**
 * 模型网格的蒙皮；网格既没有蒙皮、也不挂在骨架的节点上时返回 undefined（静态网格）。transform 是模型资源的导入变换，
 * 网格顶点已经变换过，所以逆绑定矩阵右乘它的逆。
 */
export function meshSkin(mesh: MeshData, scene: Scene, skeleton: ImportedSkeleton, modelTransform: Float32Array, where: string, warn: (message: string) => void): SourceSkin | undefined {
  const untransform = new Float32Array(16);
  Matrix.invert(untransform, modelTransform);
  const vertexCount = mesh.positions.length / 3;
  const names = strideNodeNames(scene.nodes);
  if (!mesh.skin) {
    const name = names[mesh.node];
    const joint = name === undefined ? undefined : skeleton.indexOf.get(name);
    if (joint === undefined) return undefined;
    const inverseBind = new Float32Array(16);
    Matrix.invert(inverseBind, scene.nodes[mesh.node]!.world);
    Matrix.multiply(inverseBind, inverseBind, untransform);
    const vertexWeights = new Float32Array(vertexCount * INFLUENCES);
    for (let v = 0; v < vertexCount; v++) vertexWeights[v * INFLUENCES] = 1;
    return { joints: [joint], inverseBinds: Array.from(inverseBind), vertexJoints: new Uint16Array(vertexCount * INFLUENCES), vertexWeights };
  }
  const { jointNodes, inverseBinds, joints, weights } = mesh.skin;
  const mapped = Array.from(jointNodes, (node) => {
    const name = names[node] ?? '';
    const joint = skeleton.indexOf.get(name);
    if (joint === undefined) warn(`${where}: skin joint '${name}' is not in skeleton ${skeleton.path}; bound to the root`);
    return joint ?? 0;
  });
  const adjusted = new Float32Array(inverseBinds.length);
  for (let j = 0; j < jointNodes.length; j++) {
    const bind = adjusted.subarray(j * 16, (j + 1) * 16);
    Matrix.multiply(bind, inverseBinds.subarray(j * 16, (j + 1) * 16), untransform);
  }
  return { joints: mapped, inverseBinds: Array.from(adjusted), vertexJoints: joints, vertexWeights: weights };
}

/** 出错时在消息前面加上是哪个资源。 */
function withContext<T>(where: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    throw new Error(`${where}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/**
 * 源文件里的节点名换成 Stride 用的名字（Stride.Importer.3D 的 CleanNodeName）：去掉 `#`、`__` 之后的部分，FBX 的命名空间
 * （`mannequinModel:CATRigHub001`）只留最后一个 `:` 之后的名字，删掉空格。骨架、动画、蒙皮都按它对关节。
 */
export function cleanNodeName<T extends string | undefined>(name: T): T {
  if (name === undefined || name.trim() === '') return name;
  let clean: string = name;
  for (const separator of ['#', '__']) {
    const at = clean.indexOf(separator);
    if (at !== -1) clean = clean.slice(0, at);
  }
  const colon = clean.lastIndexOf(':');
  if (colon !== -1 && colon + 1 < clean.length) clean = clean.slice(colon + 1);
  return clean.replaceAll(':', '_').replaceAll(' ', '') as T;
}

/**
 * 每个节点在 Stride 里的名字（Stride.Importer.3D 的 GenerateNodeNames、GenerateUniqueNames）：按深度优先的先序数一遍，
 * cleanNodeName 之后重名的节点全都按出现的顺序加 `_1`、`_2`……（第一个也加），骨架、动画、蒙皮都按这个名字对节点。
 */
export function strideNodeNames(nodes: readonly { readonly name: string; readonly parent: number }[]): string[] {
  const children = nodes.map(() => [] as number[]);
  const roots: number[] = [];
  nodes.forEach((node, i) => (node.parent >= 0 ? children[node.parent]!.push(i) : roots.push(i)));
  const order: number[] = [];
  const visit = (i: number): void => {
    order.push(i);
    for (const child of children[i]!) visit(child);
  };
  roots.forEach(visit);
  const clean = nodes.map((node) => cleanNodeName(node.name) ?? '');
  const total = new Map<string, number>();
  for (const name of clean) total.set(name, (total.get(name) ?? 0) + 1);
  const seen = new Map<string, number>();
  const names = [...clean];
  for (const i of order) {
    const name = clean[i]!;
    if (total.get(name)! < 2) continue;
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    names[i] = `${name}_${count}`;
  }
  return names;
}

/** 节点的 Stride 名字（strideNodeNames）到下标。 */
function nodesByName(scene: Scene): Map<string, number> {
  return new Map(strideNodeNames(scene.nodes).map((name, i) => [name, i]));
}

/** 一直停在静止姿势的轨道。 */
function restTrack(joint: JointDescription): JointTrack {
  return {
    translations: [[0, ...(joint.translation ?? [0, 0, 0])]],
    rotations: [[0, ...(joint.rotation ?? [0, 0, 0, 1])]],
    scales: [[0, ...(joint.scale ?? [1, 1, 1])]],
  };
}

/** 轨道的每个时刻左乘 m：三条通道合在一起算矩阵再拆开，时刻取三条通道的所有关键帧时间。 */
function transformTrack(track: JointTrack, m: Float32Array): JointTrack {
  const times = [...new Set([track.translations, track.rotations, track.scales].flatMap((keys) => (keys ?? []).map((key) => key[0]!)))].sort((a, b) => a - b);
  const local = new Float32Array(16);
  const keys = times.map((time) => {
    Matrix.compose(local, sample(track.translations, time, 3), sample(track.rotations, time, 4), sample(track.scales, time, 3));
    return { time, ...Matrix.decompose(Matrix.multiply(local, m, local)) };
  });
  return {
    translations: keys.map(({ time, translation }) => [time, ...translation]),
    rotations: keys.map(({ time, rotation }) => [time, ...rotation]),
    scales: keys.map(({ time, scale }) => [time, ...scale]),
  };
}

/** 只取 [start, end] 这一段，时间移到从 0 开始；两头按线性插值补上关键帧。 */
function trimTrack(track: JointTrack, start: number, end: number): JointTrack {
  const trim = (keys: readonly (readonly number[])[] | undefined, width: number) => {
    if (!keys || keys.length === 0) return [];
    const inside = keys.filter((key) => key[0]! > start && key[0]! < end).map((key) => [key[0]! - start, ...key.slice(1)]);
    return [[0, ...sample(keys, start, width)], ...inside, [end - start, ...sample(keys, end, width)]];
  };
  return { translations: trim(track.translations, 3), rotations: trim(track.rotations, 4), scales: trim(track.scales, 3) };
}

/** 通道在 time 的值：关键帧之间线性插值（四元数是归一化的线性插值，烘焙的关键帧很密，和球面插值差别可以忽略）。 */
function sample(keys: readonly (readonly number[])[] | undefined, time: number, width: number): number[] {
  if (!keys || keys.length === 0) return width === 4 ? [0, 0, 0, 1] : width === 3 ? [0, 0, 0] : [];
  if (time <= keys[0]![0]!) return keys[0]!.slice(1, 1 + width) as number[];
  for (let k = 1; k < keys.length; k++) {
    const [a, b] = [keys[k - 1]!, keys[k]!];
    if (time > b[0]!) continue;
    const f = b[0]! === a[0]! ? 0 : (time - a[0]!) / (b[0]! - a[0]!);
    let sign = 1;
    if (width === 4) sign = a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]! + a[4]! * b[4]! < 0 ? -1 : 1;
    const value = Array.from({ length: width }, (_, c) => a[1 + c]! + (sign * b[1 + c]! - a[1 + c]!) * f);
    if (width === 4) {
      const length = Math.hypot(...value) || 1;
      return value.map((v) => v / length);
    }
    return value;
  }
  return keys.at(-1)!.slice(1, 1 + width) as number[];
}

const REPEAT_MODES: Readonly<Record<string, AnimationRepeatMode>> = { PlayOnce: 'playOnce', LoopInfinite: 'loopInfinite', PlayOnceHold: 'playOnceHold' };
