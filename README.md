# World Engine

**浏览器里的一站式创作工作台**：同一套 WebGPU 引擎和编辑器，既能从零造出大型世界、做 3A 级的游戏，也能做短视频、动画片和剧集这类线性内容。画面以当代 3A 接近电影的效果为标准；世界、建筑、植被、材质这些资源**矢量优先**——存的是"怎么生成"的参数和规则，编辑器只为这类格式做创作工具，别的格式能导入能用。人在编辑器里做的每件事，AI agent 也能经命令行和 MCP 服务做到。

> 项目起步时是 [Stride](https://github.com/stride3d/stride) 的 TypeScript 孪生版（原名 stride-ts）：Stride 官方的 20 多个样例都移植了，导入器能直接读 Stride 工程，Third Person Platformer 和桌面 Stride 4.4.2 逐像素比对过。2026-11-22 改名 World Engine，方向是上面那段。

## 能做什么

- **大世界**：世界切成格子按相机流式加载，位置用双精度；地形存的是噪声、冲沟、压平和雕刻的笔画，不存高度图；道路、河、轨道用样条画，路口和车道自动生成；程序化摆放树木、草和石头（参数化的树、远处换卡片）；湖、海（FFT 海浪）、河和浮力；按形状文法生成的建筑和沿路网排开的城市；风、雨雪、积雪和地面湿润，日夜循环。
- **画面**：和 Stride 一致的 PBR，体积云和雾里的光柱，物理天空和星空，级联阴影、PCSS，面光源（LTC）和 IES 配光，GTAO、屏幕空间反射和光追补洞、DDGI 和路径追踪的间接光，TAA、景深、运动模糊、物理相机，高斯泼溅（.ply、.spz、.sog）和网格互相遮挡，贴花、次表面散射、各向异性和光泽材质、室内映射。
- **玩法**：实体组件加数据导向的系统（纯 TypeScript 推导的组件 API），Jolt 物理（多线程 wasm，和渲染共享变换存储）、Recast 导航、ozz 动画和 GPU 蒙皮、形变目标，粒子（CPU 和 GPU）、UI（Stride 的布局和控件、富文本、读屏）、Web Audio 的空间声音。
- **编辑器**（视口就是运行着的游戏）：场景树、属性面板、操纵器和吸附、预制体（引用加差异）、资源浏览器；白盒、SDF、多边形网格、样条、地形雕刻、在模型上画贴图、材质节点图、粒子编辑器、精灵表、音效生成器；材质库和特效库；商品包装、货架、物理堆放这类参数化的资源。
- **出片**：时间轴编排镜头、动画、声音、字幕，离线渲染（子帧抗锯齿、真运动模糊）导出 MP4 或 PNG 序列。
- **给 agent 用**：MCP 服务（资源、场景、建模、截图、出片），调试 CLI `stride`（查看和操作运行中的游戏、断点、性能、像人一样点页面）。

进度、下一步和每个阶段的验收在 [docs/roadmap.md](docs/roadmap.md)。

## 快速开始

需要 Node 26+、pnpm 10，浏览器用最新的 Chrome（WebGPU）。原生模块 `@stride-ts/native` 由 `pnpm install` 从 Jolt fork 的 GitHub Release 装，不用自己编。

```bash
git clone https://github.com/kenconnet666/world-engine
cd world-engine
pnpm install
pnpm --filter @stride-ts/open-world dev
```

然后打开开发服务器打印的地址：`/?debug` 是游戏（带 `?debug` 才连调试 CLI），`/__stride/editor/` 是编辑器。Stride 的样例（`apps/platformer` 等）要先 `pnpm --filter @stride-ts/platformer import:stride` 从 Stride 仓库导入内容；各样例的端口见 [docs/handover.md](docs/handover.md)。

新建一个工程（建在 `apps/` 下，编辑器直接打开它接着搭）：

```bash
node packages/editor/src/server/cli.ts new apps/my-game
```

## 仓库结构

| 目录 | 内容 |
|---|---|
| `packages/engine` | 引擎（`@stride-ts/engine`）：`engine/` 循环和实体、`rendering/` 渲染器、`world/` 大世界、`physics/`、`animation/`、`ui/`、`particles/`、`audio/`、`content/` 加载和文件格式、`modeling/` 程序化生成、`offline/` 出片、`debug/`、`editor/` 编辑器在游戏页面里的那一半 |
| `packages/editor` | 编辑器（`@stride-ts/editor`）：Node 后端（Vite 插件：资源数据库、存盘、烘焙、导入、MCP 服务）和界面（Vue 加 [vue-tsx-pro](https://github.com/kenconnet666/vue-tsx-pro)），见 [它的 README](packages/editor/README.md) |
| `packages/pipeline` | 资源管线（`@stride-ts/pipeline`）：Stride 工程导入、模型和贴图的导入与压缩、参数化资源的烘焙 |
| `packages/cli` | 调试 CLI `stride`，见 [它的 README](packages/cli/README.md) |
| `packages/devkit` | 工程用的开发工具（`@stride-ts/devkit`）：共用的 Vite 配置 `strideApp`、冒烟测试的帮手 |
| `apps/` | 样例：Stride 样例的移植、大世界（`open-world`）、照片级场景（`photoreal`）、短片（`short-film`）、编辑器做的小游戏等 |
| `tools/` | 回归、验证、测量、资源包的脚本，调试桥扩展，见 [tools/README.md](tools/README.md) |
| `docs/` | 设计、决定和过程的记录（见下） |

相关的仓库：

- [kenconnet666/JoltPhysics](https://github.com/kenconnet666/JoltPhysics)（`stride` 分支）：原生部分 `StrideNative`——Jolt 物理、Recast 导航、ozz 动画、贴图和模型的编解码、Manifold 建模，编成 64 位多线程的 WebAssembly（核心模块加按需加载的侧模块）。
- [kenconnet666/world-engine-assets](https://github.com/kenconnet666/world-engine-assets)：共用的二进制资源（字体、扫描材质），带来源和许可，发成 GitHub Release 的包。
- [kenconnet666/vue-tsx-pro](https://github.com/kenconnet666/vue-tsx-pro)：编辑器界面用的 Vue TSX 组件库。

## 开发

```bash
pnpm typecheck          # 每个子项目各查各的（TypeScript 7.1 原生版）；typecheck:changed 只查改了的
pnpm test               # 各子项目的 Vitest；test:changed 同理
pnpm lint               # oxlint（带类型），全仓库零警告
pwsh tools/regress.ps1  # 各样例的冒烟（开着真浏览器）；-Changed 只跑改动影响到的
pwsh tools/verify.ps1   # 在单独的 git 工作树里跑全部回归，主检出可以接着改
```

调试正在跑的游戏：`pnpm exec stride status`、`stride shot`、`stride perf`、`stride debug --break 文件:行`……，见 [packages/cli/README.md](packages/cli/README.md)。

## 文档

- [docs/roadmap.md](docs/roadmap.md)：路线图，一张总表列出做完的和要做的。
- [docs/architecture.md](docs/architecture.md)：已定的架构（自有渲染器、数据导向、和 Jolt 共享内存、组件 API）。
- [docs/principles.md](docs/principles.md)、[docs/scope.md](docs/scope.md)、[docs/stages.md](docs/stages.md)：原则、范围、各阶段的定义和验收。
- [docs/decisions.md](docs/decisions.md)、[docs/progress-log.md](docs/progress-log.md)：执行中的决定和过程。
- [docs/vector-assets.md](docs/vector-assets.md)、[docs/creation-tools.md](docs/creation-tools.md)：矢量化的资源格式、创作工具的调研。
- [docs/extending.md](docs/extending.md)：不改引擎、编辑器就能加的东西（脚本、系统、资源种类、调试命令、着色钩子、渲染特性、原生插件）。
- 各包的 README：[engine](packages/engine/README.md)、[editor](packages/editor/README.md)、[pipeline](packages/pipeline/README.md)、[cli](packages/cli/README.md)、[devkit](packages/devkit/README.md)。
- [docs/handover.md](docs/handover.md)：新机器上手、端口、约定、踩过的坑。
- [docs/design-notes.md](docs/design-notes.md)：起步时的设计笔记（组件和脚本的写法、实例化和缓存）。

## 许可证

Apache-2.0，见 [LICENSE](LICENSE)（2026-11-22 从 MIT 改过来）。原生模块在 Jolt 的 fork 里（Jolt 本身是 MIT），用到的库见 fork 的 `StrideNative/ThirdParty/README.md`。矢量文字的覆盖率计算移植自 Eric Lengyel 的 Slug 参考着色器（Copyright 2017 Eric Lengyel，MIT 或 Apache-2.0，[EricLengyel/Slug](https://github.com/EricLengyel/Slug)）。共用资源的来源和许可见 world-engine-assets 的 `CREDITS.md`。
