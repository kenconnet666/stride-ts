# @stride-ts/engine

浏览器里跑的引擎：帧循环、实体和组件、渲染器（WebGPU）、物理和导航的 TS 那一层、动画、粒子、声音、UI、大世界，以及编辑器
在页面里的那一半。重活（变换存储、剔除、物理、动画求值、贴图转码）在原生模块 `@stride-ts/native` 里。设计见
[docs/architecture.md](../../docs/architecture.md)，能从游戏里扩展的地方见 [docs/extending.md](../../docs/extending.md)。

## 入口

- `@stride-ts/engine`：游戏代码用的全部（`Game`、组件、脚本、`prop`、`system`、数学类型……）。
- 给 Node 用的子路径（编辑器后端、管线、MCP 服务直接加载，不经打包；这些模块里值的相对导入写 `.ts` 扩展名）：
  `content-format`（文件格式的类型和扩展名）、`content-references`（资源引用、资源种类的登记）、`content-prefabs`、
  `editor-document`（场景文档）、`editor-fields`（属性面板的字段描述）、`editor-field-schema`（字段转 JSON Schema）、
  `modeling`（程序化建模的纯函数）、`material-graph`、`node-graph`、`audio-synth`、`png`、`math`、`light-profile`、
  `color-lut`、`splats`，以及编辑器的几个帮手（`editor-prefabs`、`editor-copy`、`editor-sprites`、`editor-make-prefab`、
  `editor-particles`）。全表在 `package.json` 的 `exports`。

## 目录

| 目录 | 内容 |
|---|---|
| `engine/` | `Game`（帧循环、子系统 `GameSystem`、场景）、实体和组件（`EntityManager`、`component`、`system`、`scripts`）、`Transform`、时间、事件、命令缓冲 |
| `data/` | 和渲染无关的数据类型：属性 builder `prop`、向量和矩阵、小数、日期时间、哈希、文本、矩形装箱 |
| `content/` | `ContentManager`（加载各种资源）、场景和预制体的实例化、资源引用和种类的登记；`formats/` 是文件格式（纯类型和常量，Node 也用） |
| `graphics/` | `GraphicsDevice`、GPU 资源和显存记账、管线缓存、贴图、mipmap、着色器模块的校验、GPU 计时 |
| `rendering/` | `RenderSystem`、`ForwardRenderer`、渲染图、画质档位；`mesh/`（网格特性、着色器 `wgsl/`、材质、GPU 剔除、贴花）、`lighting/`（光源、分簇、阴影、探针、平面反射）、`screenspace/`（TAA、AO、SSR、SSGI、景深……）、`postfx/`（泛光、色调映射、调色）、`sky/`（大气、云、雾、日夜）、`raytracing/`（BVH、DDGI、路径追踪）、`splats/`、`text/`、`paint/` |
| `physics/` | 碰撞体、刚体、角色、约束、`Simulation`（固定步长加插值）、导航 |
| `animation/` | 骨骼动画、形变、属性曲线、时间轴和过场 |
| `particles/` | 粒子系统：CPU 模拟、GPU 发射器、模块（生成、初始化、更新、力场）、渲染 |
| `audio/` | Web Audio 的声音、空间化、音效合成、录音（出片用） |
| `ui/` | Stride 的 UI：布局、控件、路由事件、3D 里的 UI、读屏的影子 DOM |
| `input/` | 键盘、鼠标、手柄、虚拟按钮、手势、UI 占着的输入 |
| `world/` | 大世界：流式加载、地形、程序化摆放、城市、水体和浮力、风、天气和雨雪、天空遮挡、列车 |
| `modeling/` | 程序化建模的纯函数（建筑、城市、树、样条、多边形编辑、商品、货架、堆放……），编辑器后端烘焙时也用 |
| `offline/` | 离线渲染和出片（MP4 封装、PNG 序列）、粒子烘成序列帧 |
| `editor/` | 编辑器在页面里的一半：场景文档和跟着它的实体（`SceneDocument`、`LiveScene`）、字段描述 `fields/`、视口里的编辑代理和工具 `viewport/` |
| `debug/` | 调试中枢的连接和命令（`commands/` 按领域分）、调试线和调试文字、统计量 |

## 测试

`pnpm -F @stride-ts/engine typecheck`、`pnpm -F @stride-ts/engine test`（vitest，`test/` 大致按 `src/` 的目录分，假的 GPU 设备在 `test/fakeGpu.ts`）；类型测试是
`*.check.ts`。在浏览器里跑的验证是各样例的冒烟（`apps/*/scripts/smoke.ts`）。
