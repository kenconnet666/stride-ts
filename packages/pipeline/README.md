# @stride-ts/pipeline

Node 里跑的资源管线：把 Stride 工程转成运行时的内容，导入源模型、字体、高斯泼溅，烘焙编辑器里程序化资源的模型。编辑器后端
（`@stride-ts/editor`）和各样例的 `import:stride` 脚本用它；贴图编码、Manifold、Jolt 这些原生的活走 `@stride-ts/native/tools`。

## 目录

| 路径 | 内容 |
|---|---|
| `stride/` | Stride 工程导入器 `StrideImporter`：工程和资源包（`project.ts`）、YAML、场景和实体、材质、动画、粒子、UI、合成器、字体、预制体的实例 |
| `bakers/` | 程序化资源烘成模型：白盒、SDF、多边形、样条、3D 文字、树、建筑、商品包装、货架、堆放、招牌、天花板、器具（`mergedFiles.ts` 是合成一个模型加图集、材质的那一类共用的） |
| `sourceModel.ts`、`mesh.ts`、`bvh.ts` | glTF、FBX、OBJ 的导入（骨骼、动画一起），网格的量化和 meshopt 压缩，离线用的三角网格 BVH（烘位移、量网格之间的距离） |
| `image.ts`、`hdr.ts` | 位图压成 KTX2（Basis）、mipmap；DDS 里的浮点立方体贴图（Stride 的 HDR 天空盒） |
| `font.ts`、`fontAsset.ts` | 字体：字形轮廓（矢量文字用）和字体资源 |
| `splats.ts` | 高斯泼溅：3DGS 的 .ply、Niantic 的 .spz、PlayCanvas 的 .sog 转成 `.splat` |
| `cache.ts` | 派生数据的缓存（按内容哈希，`~/.stride-ts/cache/pipeline`） |
| `cli.ts` | 命令行：`node packages/pipeline/src/cli.ts import-stride --package <包名>=<资源目录> --scene <包名>/<路径> --out <内容目录>`，参数见文件头 |

模块在 Node 里直接运行（类型剥离，不打包），相对导入写 `.ts` 扩展名。测试：`pnpm -F @stride-ts/pipeline test`。
