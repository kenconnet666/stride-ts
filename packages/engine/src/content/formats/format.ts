/**
 * 运行时内容的文件格式，资源管线（Node，packages/pipeline）写，ContentManager 读。这个文件不依赖别的模块，
 * 管线可以直接导入它。资源之间用相对内容根目录的路径引用（不带扩展名），比如 `models/PrototypingBlocks/Wall0x2x5`。
 *
 * - 模型 `<路径>.model`：二进制容器，或者一段 JSON 描述程序生成的形状（modelFile.ts）。二进制的开头 12 字节是 magic 'SMDL'、版本、JSON 头的字节数，接着是 JSON 头
 *   （网格表和材质槽），补齐到 4 字节，后面是数据区：每个网格的交错顶点（布局见 VertexLayout，一般是量化的 16 字节）
 *   和索引，一般是 meshopt 编码的。解码后直接上传，反量化在顶点着色器里做。
 * - 立方体贴图 `<路径>.cubemap`：同样的容器（magic 'SCUB'），JSON 头是尺寸、级数和纹素格式（RGBA16F 或 RGB9E5），
 *   数据区是各级 mip，每级 6 个面连续（+X -X +Y -Y +Z -Z，行从上到下，WebGPU 的布局），直接上传。
 * - 贴图：`<路径>.ktx2`（KTX2 加 Basis，运行时按设备转码，显存最省），或者下载最小的 `.svg`（矢量，加载时按指定尺寸
 *   栅格化）、`.png`/`.jpg`（浏览器解码），后两种在 GPU 上生成 mip。用哪种写在材质的贴图槽里（TextureSlot.encoding）。
 * - 材质 `<路径>.material.json`、天空盒 `<路径>.skybox.json`、场景 `<路径>.scene.json`、预制体 `<路径>.prefab.json`：
 *   JSON。场景以后改成二进制，物理部分直接是原生能读的布局。
 *
 * 分成三个文件，这里汇总导出：binaryFormat.ts（二进制容器和顶点布局）、assetFormat.ts（材质、贴图、精灵表、字体、UI 这些
 * JSON 的资源）、sceneFormat.ts（场景、预制体、实体的组件、场景级的设置），modelFile.ts（.model 的两种写法）。
 */
export * from './binaryFormat.ts';
export * from './assetFormat.ts';
export * from './sceneFormat.ts';
export * from './worldFormat.ts';
export * from './terrainFormat.ts';
export * from './scatterFormat.ts';
export * from './splineFormat.ts';
export * from '../modelFile.ts';
export { generateProceduralMesh, PROCEDURAL_SHAPES, proceduralTangents, type ProceduralMesh, type ProceduralModel, type ProceduralShape } from '../../rendering/mesh/procedural.ts';
export * from './treeFormat.ts';
export * from './buildingFormat.ts';
export * from './cityFormat.ts';
export * from './waterFormat.ts';
export * from './productFormat.ts';
export * from './shelfFormat.ts';
export * from './pileFormat.ts';
export * from './signFormat.ts';
