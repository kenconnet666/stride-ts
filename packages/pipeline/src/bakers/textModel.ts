/**
 * 3D 文字的烘焙（引擎 content/formats/assetFormat.ts 的 TextModelFile）：用字体资源排版、取轮廓（引擎 modeling/textOutline.ts），
 * 每个字的外轮廓挤出 depth 厚、洞挖掉（原生工具模块的 Manifold，白盒的 prism 笔刷），结果按朝向分成两个网格：朝 +Z 的字面是
 * 材质槽 0，侧面和背面是槽 1（只有一个槽时都用它）。平直的法线（字的侧面是硬边），UV 按面的朝向投影（同白盒，一米一个周期）。
 *
 * 编辑器后端在 `.text.json` 存下、或者在磁盘上改了以后调它（server/EditorBackend.ts）；字体资源（FontFile 和字形块）从内容
 * 目录读，readContent 给。
 */
import { encodeModel, VERTEX_FLOATS, type TextModelFile } from '@stride-ts/engine/content-format';
import { projectUv, textContours } from '@stride-ts/engine/modeling';
import type { Brush, StrideTools } from '@stride-ts/native/tools';
import { rigidTransform } from './brushModel.ts';
import { loadTextFont } from './textFont.ts';
import { compressMeshes, type SourceMesh } from '../mesh.ts';

/** 绕 X 转 +90°：白盒的 prism 是 XZ 平面上往 +Y 挤出，转过来是 XY 平面（文字的平面）上往 +Z 挤出，点 (x, z) 对着 (x, -y)。 */
const TO_TEXT_PLANE = [Math.SQRT1_2, 0, 0, Math.SQRT1_2] as const;

/** 烘成模型文件的字节（.model）。字体读不到、一个字都没有轮廓时报错。 */
export async function bakeTextModel(tools: StrideTools, file: TextModelFile, readContent: (path: string) => Promise<Uint8Array>, where = file.name): Promise<Uint8Array> {
  if (!file.font) throw new Error(`${where}: choose a font (a font asset; import a .ttf or .otf into the project first if there is none)`);
  if (!(file.size > 0)) throw new Error(`${where}: size must be greater than 0`);
  const font = await loadTextFont(file.font, file.text, readContent, where);
  const contours = textContours(font, file.text, {
    size: file.size,
    ...(file.align ? { align: file.align } : {}),
    ...(file.lineSpacing !== undefined ? { lineSpacing: file.lineSpacing } : {}),
    ...(file.letterSpacing !== undefined ? { letterSpacing: file.letterSpacing } : {}),
  });
  if (contours.length === 0) throw new Error(`${where}: no outlines (empty text, or the font has none of its characters)`);

  // 每个字先加外轮廓、再挖它的洞（字和字不重叠，挖的洞不会伤到别的字）；居中：厚度从 -depth/2 到 depth/2
  const depth = Math.max(file.depth, 0.0005);
  const transform = rigidTransform([0, 0, -depth / 2], TO_TEXT_PLANE);
  // 洞的柱子前后各长出去一点：和字的正面、背面共面时布尔运算会留下细条（字母 O 的洞里一道道的）
  const margin = depth * 0.05 + 1e-4;
  const holeTransform = rigidTransform([0, 0, -depth / 2 - margin], TO_TEXT_PLANE);
  const brushes: Brush[] = [];
  const glyphs = [...new Set(contours.map((contour) => contour.glyph))];
  for (const glyph of glyphs) {
    for (const hole of [false, true]) {
      for (const contour of contours) {
        if (contour.glyph !== glyph || contour.hole !== hole) continue;
        const points = contour.points.map(([x, y]) => [x, -y] as [number, number]);
        brushes.push(hole ? { kind: 'prism', operation: 'subtract', transform: holeTransform, points, height: depth + 2 * margin } : { kind: 'prism', operation: 'add', transform, points, height: depth });
      }
    }
  }
  // 第一个笔刷要是加的（洞先出现的字形不会有：外轮廓总是先放）
  let solid;
  try {
    solid = await tools.brushCsg(brushes);
  } catch (error) {
    throw new Error(`${where}: ${(error as Error).message}`, { cause: error });
  }
  if (solid.indices.length === 0) throw new Error(`${where}: the outlines leave nothing`);

  const slots = Math.max(1, Math.min(2, file.materials.length));
  const builders = Array.from({ length: slots }, () => ({ vertices: [] as number[], indices: [] as number[], weld: new Map<string, number>() }));
  const { positions, indices } = solid;
  const corner = [0, 0, 0], a = [0, 0, 0], b = [0, 0, 0];
  for (let t = 0; t < indices.length / 3; t++) {
    const i0 = indices[t * 3]! * 3, i1 = indices[t * 3 + 1]! * 3, i2 = indices[t * 3 + 2]! * 3;
    for (let k = 0; k < 3; k++) {
      a[k] = positions[i1 + k]! - positions[i0 + k]!;
      b[k] = positions[i2 + k]! - positions[i0 + k]!;
    }
    const normal = [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
    const length = Math.hypot(normal[0]!, normal[1]!, normal[2]!);
    if (length < 1e-14) continue;
    for (let k = 0; k < 3; k++) normal[k]! /= length;
    const builder = builders[normal[2]! > 0.9 || slots === 1 ? 0 : 1]!;
    for (const index of [i0, i1, i2]) {
      for (let k = 0; k < 3; k++) corner[k] = positions[index + k]!;
      const key = `${corner.map((v) => Math.round(v * 1e6)).join(',')}|${normal.map((v) => Math.round(v * 1e4)).join(',')}`;
      let vertex = builder.weld.get(key);
      if (vertex === undefined) {
        vertex = builder.vertices.length / VERTEX_FLOATS;
        builder.weld.set(key, vertex);
        builder.vertices.push(corner[0]!, corner[1]!, corner[2]!, normal[0]!, normal[1]!, normal[2]!, ...projectUv(corner, normal, 1));
      }
      builder.indices.push(vertex);
    }
  }
  const meshes: SourceMesh[] = builders.flatMap((builder, slot) => (builder.indices.length === 0 ? [] : [{
    name: slot === 0 ? 'face' : 'sides', material: slot, vertices: Float32Array.from(builder.vertices), indices: Uint32Array.from(builder.indices),
  }]));
  return encodeModel({ meshes: compressMeshes(meshes, tools), materials: file.materials.length > 0 ? file.materials.slice(0, slots) : [null] });
}
