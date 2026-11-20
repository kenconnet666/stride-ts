/**
 * 导入一个源模型文件（glTF/GLB、FBX、OBJ）成我们的资源：模型（`.model`，量化加 meshopt）、每个材质一个 `.material.json`、
 * 材质用到的贴图（嵌在文件里的图片原样写出，PNG、JPEG、WebP 在运行时由浏览器解码）。编辑器把文件拖进资源浏览器时用（`POST /import`）；
 * 和 Stride 工程的导入器（stride/importer.ts）共用原生的场景导入、切线（MikkTSpace）和网格压缩。
 *
 * 放在哪：`<文件夹>/<名字>.model`，材质在 `<文件夹>/<名字>/Materials/`，贴图在 `<文件夹>/<名字>/Textures/`。
 *
 * 网格的顶点在模型空间（节点的世界变换已经烘进去）。有蒙皮或动画时，文件里的全部节点按深度优先排成一副骨架（`<名字>/<名字>.skeleton`，
 * 关节名同 Stride 导入时起的名字），蒙皮的网格按关节名绑上去，没蒙皮的网格刚性地挂在它所在的节点上（节点动画也带得动）；
 * 每个动画（glTF 的动画、FBX 的动画栈）按 30 帧每秒烘焙成一个剪辑（`<名字>/Animations/<动画名>.anim`），连同形变权重的曲线。
 * 形变目标照导入（按名字合成模型的目标表）。材质照 glTF 的金属度工作流：金属度粗糙度贴图进 glossinessTexture（G 通道反着读成粗糙度，B 通道是金属度、乘系数）。
 */
import { EXTENSIONS, encodeAnimation, encodeModel, encodeSkeleton, TEXTURE_EXTENSIONS, VERTEX_FLOATS, type MaterialFile, type TextureEncoding, type TextureSlot } from '@stride-ts/engine/content-format';
import type { MaterialInfo, Scene, StrideTools, TextureSlot as NativeTextureSlot } from '@stride-ts/native/tools';
import { addTangents, compressMeshes, sourceMorph, type SourceMesh } from './mesh.ts';
import { meshSkin, morphWeightCurves, strideNodeNames, type ImportedSkeleton } from './stride/animation.ts';

export interface SourceModelOptions {
  /** 拖进来的文件名（认格式、起名字）。 */
  readonly fileName: string;
  /** 放进哪个文件夹（内容路径，'' 是根）。 */
  readonly folder: string;
  /** 资源的名字（不给时取文件名，去掉不能做内容路径的字符）。 */
  readonly name?: string;
}

export interface ImportedSourceModel {
  /** 模型的内容路径。 */
  readonly model: string;
  /** 动画剪辑：名字（文件里的动画名）和内容路径；没有动画时是空的。 */
  readonly animations: readonly { readonly name: string; readonly clip: string }[];
  /** 要写的文件：相对内容目录的路径和内容。 */
  readonly files: readonly { readonly path: string; readonly content: Uint8Array | string }[];
  readonly warnings: readonly string[];
}

const FORMATS: Readonly<Record<string, 'gltf' | 'obj' | undefined>> = { '.glb': 'gltf', '.gltf': 'gltf', '.fbx': undefined, '.obj': 'obj' };

/** 这个文件名是不是能导入的源模型。 */
export function isSourceModel(fileName: string): boolean {
  return Object.hasOwn(FORMATS, extensionOf(fileName));
}

export async function importSourceModel(tools: StrideTools, bytes: Uint8Array, { fileName, folder, name }: SourceModelOptions): Promise<ImportedSourceModel> {
  const extension = extensionOf(fileName);
  if (!isSourceModel(fileName)) throw new Error(`${fileName}: not a model file (glb, gltf, fbx, obj)`);
  const base = (name ?? fileName.slice(0, fileName.length - extension.length)).replace(/[^A-Za-z0-9_-]+/g, '') || 'Model';
  const root = folder ? `${folder}/${base}` : base;
  const warnings: string[] = [];
  const files: { path: string; content: Uint8Array | string }[] = [];
  const scene = await tools.loadScene(bytes, FORMATS[extension]);
  try {
    // 图片 → 写出去的贴图（内容路径和编码）；用不了的（外部文件、不认识的格式）记 null，只警告一次
    const images = new Map<number, { readonly path: string; readonly encoding: 'png' | 'jpeg' | 'webp' } | null>();
    const imageFile = (index: number) => {
      if (images.has(index)) return images.get(index)!;
      const image = scene.image(index);
      const encoding = image.data ? imageEncoding(image.mime, image.data) : undefined;
      let written = null;
      if (!image.data) warnings.push(`${fileName}: texture '${image.uri}' is an external file; drop a GLB (textures embedded) to import it`);
      else if (!encoding) warnings.push(`${fileName}: image ${index} is not PNG, JPEG or WebP (${image.mime || 'unknown type'}); skipped`);
      else {
        written = { path: `${root}/Textures/image${index}`, encoding };
        files.push({ path: written.path + TEXTURE_EXTENSIONS[encoding], content: image.data });
      }
      images.set(index, written);
      return written;
    };
    const texture = (slot: NativeTextureSlot, srgb: boolean): TextureSlot | undefined => {
      const file = slot.image === null ? null : imageFile(slot.image);
      return file ? { texture: file.path, encoding: file.encoding, srgb, scale: slot.scale, offset: slot.offset } : undefined;
    };

    const materialPaths = scene.materials.map((materialName, i) => {
      const info = scene.materialInfos[i]!;
      const path = `${root}/Materials/${materialName.replace(/[^A-Za-z0-9_-]+/g, '') || `material${i}`}`;
      files.push({ path: path + EXTENSIONS.material, content: JSON.stringify(materialFile(materialName, info, texture), null, 1) });
      return path;
    });
    const normalMapped = scene.materialInfos.map((info) => info.normalTexture.image !== null);

    const sources = Array.from({ length: scene.meshCount }, (_, m) => scene.mesh(m));
    if (sources.length === 0) throw new Error(`${fileName}: the file has no meshes`);
    const skeleton = sources.some((data) => data.skin) || scene.animations.length > 0 ? sceneSkeleton(scene, `${root}/${base}`, tools, files) : undefined;
    const identity = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
    const morphTargets: string[] = [];
    const meshes = sources.map((data, m) => {
      const skin = skeleton ? meshSkin(data, scene, skeleton, identity, fileName, (message) => warnings.push(message)) : undefined;
      const morph = sourceMorph(data, 1, morphTargets);
      const mesh: SourceMesh = { name: `mesh${m}`, material: data.material, vertices: interleave(data.positions, data.normals, data.uvs), indices: data.indices, ...(skin ? { skin } : {}), ...(morph ? { morph } : {}) };
      return data.material !== null && normalMapped[data.material] && data.normals && data.uvs ? addTangents(mesh, tools) : mesh;
    });
    const animations = await sceneAnimations(scene, skeleton, `${root}/Animations`, files, tools);
    files.push({
      path: root + EXTENSIONS.model,
      content: encodeModel({ meshes: compressMeshes(meshes, tools), materials: materialPaths, ...(skeleton ? { skeleton: skeleton.path } : {}), ...(morphTargets.length > 0 ? { morphTargets } : {}) }),
    });
    return { model: root, animations, files, warnings };
  } finally {
    scene.destroy();
  }
}

/** 原生的材质参数换成我们的材质文件。 */
function materialFile(name: string, info: MaterialInfo, texture: (slot: NativeTextureSlot, srgb: boolean) => TextureSlot | undefined): MaterialFile {
  const baseColorTexture = texture(info.baseColorTexture, true);
  const roughness = texture(info.metallicRoughnessTexture, false);
  const normal = texture(info.normalTexture, false);
  const occlusion = texture(info.occlusionTexture, false);
  const emissiveTexture = texture(info.emissiveTexture, true);
  const emissive = info.emissive.some((c) => c > 0) || emissiveTexture;
  return {
    name,
    baseColor: info.baseColor,
    ...(baseColorTexture ? { baseColorTexture } : {}),
    metalness: info.metallic,
    roughness: info.roughness,
    // glTF 的金属度粗糙度贴图：G 是粗糙度（反着当光泽度读），B 是金属度（乘系数）
    ...(roughness ? { glossinessTexture: { ...roughness, channel: 'g', invert: true, metalnessChannel: 'b' } } : {}),
    ...(normal ? { normalMap: { ...normal, scaleAndBias: true, isXYNormal: false, invertY: false } } : {}),
    ...(occlusion ? { ambientOcclusion: { value: 1, texture: { ...occlusion, channel: 'r' }, directLighting: 0 } } : {}),
    ...(emissive ? { emissive: emissiveTexture && info.emissive.every((c) => c === 0) ? [1, 1, 1] : info.emissive } : {}),
    ...(emissiveTexture ? { emissiveTexture } : {}),
    ...(info.alphaMode === 'mask' ? { alphaCutoff: info.alphaCutoff } : {}),
    ...(info.alphaMode === 'blend' ? { transparency: { type: 'blend', alpha: 1 } } : {}),
    ...(info.doubleSided ? { doubleSided: true } : {}),
  };
}

/** 动画烘焙的采样率（每秒关键帧数，同 Stride 工程的导入）。 */
const ANIMATION_SAMPLE_RATE = 30;

/** 文件里的全部节点按深度优先排成骨架（父关节在前），写出 `.skeleton`。关节名同 Stride 导入时起的名字（strideNodeNames）。 */
function sceneSkeleton(scene: Scene, path: string, tools: StrideTools, files: { path: string; content: Uint8Array | string }[]): ImportedSkeleton & { readonly nodes: readonly number[] } {
  const names = strideNodeNames(scene.nodes);
  const children = scene.nodes.map(() => [] as number[]);
  const roots: number[] = [];
  scene.nodes.forEach((node, i) => (node.parent >= 0 ? children[node.parent]!.push(i) : roots.push(i)));
  const nodes: number[] = [];
  const visit = (i: number): void => {
    nodes.push(i);
    for (const child of children[i]!) visit(child);
  };
  roots.forEach(visit);
  const jointOf = new Map(nodes.map((node, joint) => [node, joint]));
  const joints = nodes.map((node) => {
    const { parent, translation, rotation, scale } = scene.nodes[node]!;
    return { name: names[node]!, parent: parent < 0 ? -1 : jointOf.get(parent)!, translation, rotation, scale };
  });
  files.push({ path: path + EXTENSIONS.skeleton, content: encodeSkeleton({ joints: joints.map(({ name, parent }) => ({ name, parent })), archive: tools.buildSkeleton(joints) }) });
  return { path, joints, nodes, indexOf: new Map(joints.map((joint, i) => [joint.name, i])), transform: Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1) };
}

/** 每个动画烘焙成一个剪辑（骨架的关节轨道加形变权重的曲线），写出 `.anim`；名字重复、不能做内容路径的换掉。 */
async function sceneAnimations(
  scene: Scene, skeleton: (ImportedSkeleton & { readonly nodes: readonly number[] }) | undefined, folder: string, files: { path: string; content: Uint8Array | string }[], tools: StrideTools,
): Promise<{ name: string; clip: string }[]> {
  const used = new Set<string>();
  const animations: { name: string; clip: string }[] = [];
  for (let i = 0; i < scene.animations.length; i++) {
    const baked = await scene.bakeAnimation(i, ANIMATION_SAMPLE_RATE);
    const name = scene.animations[i] || `Animation${i}`;
    let file = name.replace(/[^A-Za-z0-9_-]+/g, '') || `Animation${i}`;
    for (let k = 2; used.has(file); k++) file = `${file}${k}`;
    used.add(file);
    const duration = Math.max(baked.duration, 1e-3);
    const morphWeights = morphWeightCurves(baked, scene);
    const archive = skeleton ? tools.buildAnimation(duration, skeleton.nodes.map((node) => baked.tracks[node]!)) : new Uint8Array(0);
    const clip = `${folder}/${file}`;
    files.push({ path: clip + EXTENSIONS.animation, content: encodeAnimation({ duration, repeatMode: 'loopInfinite', ...(skeleton ? { skeleton: skeleton.path } : {}), ...(morphWeights.length > 0 ? { morphWeights } : {}), archive }) });
    animations.push({ name, clip });
  }
  return animations;
}

/** 位置、法线、UV 交错成 FLOAT_LAYOUT 的顶点（没有法线、UV 的补 0）。 */
function interleave(positions: Float32Array, normals: Float32Array | null, uvs: Float32Array | null): Float32Array {
  const count = positions.length / 3;
  const vertices = new Float32Array(count * VERTEX_FLOATS);
  for (let v = 0; v < count; v++) {
    vertices.set(positions.subarray(v * 3, v * 3 + 3), v * VERTEX_FLOATS);
    if (normals) vertices.set(normals.subarray(v * 3, v * 3 + 3), v * VERTEX_FLOATS + 3);
    if (uvs) vertices.set(uvs.subarray(v * 2, v * 2 + 2), v * VERTEX_FLOATS + 6);
  }
  return vertices;
}

/** PNG、JPEG、WebP（浏览器能直接解的）按 MIME 或文件头认；别的（KTX2、AVIF）还不认。 */
function imageEncoding(mime: string, data: Uint8Array): Extract<TextureEncoding, 'png' | 'jpeg' | 'webp'> | undefined {
  if (mime === 'image/png' || (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47)) return 'png';
  if (mime === 'image/jpeg' || (data[0] === 0xff && data[1] === 0xd8)) return 'jpeg';
  // RIFF....WEBP
  if (mime === 'image/webp' || (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50)) return 'webp';
  return undefined;
}

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot < 0 ? '' : fileName.slice(dot).toLowerCase();
}
