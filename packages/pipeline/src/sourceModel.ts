/**
 * 导入一个源模型文件（glTF/GLB、FBX、OBJ）成我们的资源：模型（`.model`，量化加 meshopt）、每个材质一个 `.material.json`、
 * 材质用到的贴图（嵌在文件里的图片原样写出，PNG、JPEG、WebP 在运行时由浏览器解码）。编辑器把文件拖进资源浏览器时用（`POST /import`）；
 * 和 Stride 工程的导入器（stride/importer.ts）共用原生的场景导入、切线（MikkTSpace）和网格压缩。
 *
 * 放在哪：`<文件夹>/<名字>.model`，材质在 `<文件夹>/<名字>/Materials/`，贴图在 `<文件夹>/<名字>/Textures/`。
 *
 * 现在只导入静态网格（节点的世界变换已经烘进顶点）；带骨骼、形变、动画的模型先当静态导入并记一条警告。材质照 glTF 的金属度
 * 工作流：金属度粗糙度贴图进 glossinessTexture（G 通道反着读成粗糙度，B 通道是金属度、乘系数）。
 */
import { EXTENSIONS, encodeModel, TEXTURE_EXTENSIONS, VERTEX_FLOATS, type MaterialFile, type TextureEncoding, type TextureSlot } from '@stride-ts/engine/content-format';
import type { MaterialInfo, StrideTools, TextureSlot as NativeTextureSlot } from '@stride-ts/native/tools';
import { addTangents, compressMeshes, type SourceMesh } from './mesh.ts';

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

    const meshes: SourceMesh[] = [];
    let animated = scene.animations.length > 0;
    for (let m = 0; m < scene.meshCount; m++) {
      const data = scene.mesh(m);
      if (data.skin || data.morphTargets.length > 0) animated = true;
      const mesh: SourceMesh = { name: `mesh${m}`, material: data.material, vertices: interleave(data.positions, data.normals, data.uvs), indices: data.indices };
      if (data.material !== null && normalMapped[data.material] && data.normals && data.uvs) meshes.push(addTangents(mesh, tools));
      else meshes.push(mesh);
    }
    if (meshes.length === 0) throw new Error(`${fileName}: the file has no meshes`);
    if (animated) warnings.push(`${fileName}: skeletons, morph targets and animations are not imported yet; imported as a static model`);
    files.push({ path: root + EXTENSIONS.model, content: encodeModel({ meshes: compressMeshes(meshes, tools), materials: materialPaths }) });
    return { model: root, files, warnings };
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
