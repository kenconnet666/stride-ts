# stride-ts

Stride 的 TypeScript 孪生版：一个"形状像 Stride"的浏览器游戏引擎。引擎和脚本用 TypeScript，物理和导航这类重活用一个自己维护的 C++ 工程编成的 WebAssembly；编辑器也自己做（Node.js 后端加 Web 前端，视口就是运行时），不依赖 Stride Game Studio。

开工前先读：
- [README.md](README.md)：推荐方案、原型计划、组件和脚本的写法（设计草案，含和 C# 的对照）、实例化、懒加载和缓存的设计、待用户决定的事项。
- [docs/lessons.md](docs/lessons.md)：Stride C# 网页移植的经验，包括 WebGPU 的坑、浏览器环境、资源管线、性能数字和用户的工作偏好。
- [docs/architecture.md](docs/architecture.md)：**已定的架构**（用户 2026-11-17）：和 Stride 对齐的自有渲染器、数据导向、和 Jolt 共享内存，以及里程碑。2026-11-18 起不做 SWC 插件和任何编译期改写，组件 API 改为纯 TS 推导的写法（`prop` builder、数据组件加系统），见其中的"组件 API"。
- [docs/own-stack.md](docs/own-stack.md)：技术栈的组织方式（用户 2026-11-17 定的方向）：JS/TS 部分在仓库内自己维护（引擎层和渲染器都自己写），原生库合成一个 C++ 工程（运行时是核心 wasm 加按需加载的侧模块）。
- [docs/positioning.md](docs/positioning.md)：和 Babylon.js、PlayCanvas、three.js、Cocos、Unity、Godot、Needle 的对比（预估），特色和短板，要实测的性能点。
- [docs/research.md](docs/research.md)：依赖逐项替代、库选型、线程模型和 API 取舍。

现状（2026-11-18）：工程骨架已搭好（pnpm monorepo，见 README.md 的"开发"），git 仓库在 `main` 分支，远程 `origin` 是公开仓库 `kenconnet666/stride-ts`（2026-11-18 建，MIT 许可证）。提交并验证后直接推送到 origin，不用先问（用户 2026-11-18）；fork 同样直接推 origin，但永远不推上游 jrouwe。引擎有 `Game` 循环、`GraphicsDevice` 和实体核心（`prop`、数据组件和列存储、系统、脚本、按模块路径登记，见 docs/architecture.md 的"实现状态"），开发时有热重载（`Game.hotEntry`），`Transform` 的数据在 stride-native 的变换存储里（层级传播、物理写回，见"共享内存的数据模型"）；原生部分是 npm 包 `@stride-ts/native`（源码在 fork 的 `StrideNative/JS/`，发布到 npm 之前从 fork 的 GitHub Release 安装），运行时拆成核心模块加物理、贴图、导航三个侧模块（`Game.run` 的 `nativeFeatures` 选用，没选的不下载），第三方也能写 wasm 插件（fork 的 `StrideNative/Plugins/README.md`）；渲染器有了骨架（RenderSystem、MeshRenderFeature 实例化绘制、ForwardRenderer，见 docs/architecture.md 的"渲染器"），有 `Light` 组件（方向光加环境光，Stride 的 Lambert）；资源管线有了第一段（`packages/pipeline` 的 Stride 工程导入器、`ContentManager`，`apps/platformer` 能画出 Third Person Platformer 的场景），有贴图（KTX2 加 Basis，运行时转码成 BC7/ASTC/ETC2）、和 Stride 一致的 PBR（金属度工作流、GGX）、天空盒光照和背景、HDR 加色调映射；内容默认压缩（量化加 meshopt 的模型、可选 SVG 贴图、运行时生成的天空盒镜面贴图），开发时用调试版原生模块（见 docs/architecture.md 的"体积"）；有视锥剔除（stride-native 里）、方向光的级联阴影（照 Stride，PCF）、法线贴图（MikkTSpace 切线）和 TPP 用到的后处理（FXAA、泛光、光芒、镜头光晕，`rendering/postfx`）；TPP 和桌面 Stride 4.4.2 的截图逐像素比对过（`tools/stride-capture`、`tools/compare-stride.cjs`），GPU 耗时用 `GpuProfiler`（WebGPU 时间戳，`tools/gpu-profile.cjs`）。参考用的开源仓库浅克隆在 `C:\code\refs`（glTF-Transform、three.js、PlayCanvas engine；WebGPU 的：`gpuweb`（WebGPU 和 WGSL 规范）、`dawn`（Chrome 的实现，含 WGSL 编译器 Tint）、`wgpu`（Firefox 的实现）、`webgpu-samples`、`types`（@webgpu/types）），需要时再加。

约定：
- 和用户用中文沟通。**代码注释（含文档注释、测试标题）和 git 提交信息用中文**（用户 2026-11-18 决定，覆盖全局 CLAUDE.md 的英文约定）；标识符、文件名、运行时的报错和日志文字仍用英文。jolt-native-fork 里 Jolt 上游的文件保持英文。
- wasm 那边（jolt-native-fork 的 StrideNative）有问题、或者我们需要新能力时，直接改那边的代码，不在 TS 里绕过去；改完重编、跑原生/Node/浏览器测试，再按下一条发新版本。
- Jolt 的 fork 是单独的仓库：`C:\Users\Administrator\CLionProjects\jolt-native-fork`（已加入本项目的工作目录）。远程 `origin` 是 `kenconnet666/JoltPhysics`，`upstream` 是 `jrouwe/JoltPhysics`（禁止推送）；工作分支 `stride`，基于上游发布标签。做法见 [docs/architecture.md](docs/architecture.md) 的"怎么 fork 和维护 Jolt"。原生 C++ 工程 `stride-native`/`stride-tools` 在这个仓库的 `StrideNative/` 目录（说明见其中的 README.md），按阶段提交到 `stride` 分支。
- 要读的 Stride 源码在 `C:\Users\Administrator\IdeaProjects\stride`，只读，不在那边提交，除非用户要求（例如需要在那边加工具）。
- 在 Chrome 里实际跑过、看过结果，才能说某件事完成了；测试脚本在 [tools/](tools/README.md)。应用内置浏览器的面板隐藏时 `requestAnimationFrame` 不触发，看帧循环要用 `tools/play.cjs`（本机 Chrome）。
- 本仓库通过 `pnpm-workspace.yaml` 的 override 从 GitHub Release 安装 `@stride-ts/native`（各包的 package.json 照常写 `^0.1.0`）。原生部分改了以后：改 fork 的 `StrideNative/JS/package.json` 版本号 → `pwsh StrideNative/Scripts/build-wasm.ps1`（构建、测试、打包）→ 提交并推送 fork → `pwsh StrideNative/Scripts/release-native.ps1`（发布 GitHub Release `native-v<版本>`）→ 把本仓库 `pnpm-workspace.yaml` 里 override 的地址换成新版本 → `pnpm install`。不要改成 `file:` 指向本地 tgz：pnpm 给它建的目录名带 `..`，JetBrains 的 IDE 就解析不出这个包的类型（用户 2026-11-18 定用 GitHub Release，以后发布到 npm 再删掉 override）。
- 调研自己做，不派子代理。
- TS API 的写法参考用户自己的 easy-query-ts（`C:\code\easy-query-ts`，只读）：带幻影类型参数的不可变 builder、类型全靠推导不做代码生成、核心零依赖并通过 Standard Schema 对接校验库、`*.check.ts` 类型测试。属性的分层合并和转发参考 vue-tsx-pro（`C:\Users\Administrator\IdeaProjects\vue-tsx-pro`，只读）的 `packages/ui/src/utils/props.ts` 和 `COMPONENTS.md` §2，它是 Vue 和 DOM 的体系，只借鉴规则和类型做法。
