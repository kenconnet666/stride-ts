# stride-ts

Stride 的 TypeScript 孪生版：一个"形状像 Stride"的浏览器游戏引擎。引擎和脚本用 TypeScript，物理和导航这类重活用一个自己维护的 C++ 工程编成的 WebAssembly；编辑器也自己做（Node.js 后端加 Web 前端，视口就是运行时），不依赖 Stride Game Studio。

开工前先读：
- [README.md](README.md)：推荐方案、原型计划、组件和脚本的写法（设计草案，含和 C# 的对照）、实例化、懒加载和缓存的设计、待用户决定的事项。
- [docs/lessons.md](docs/lessons.md)：Stride C# 网页移植的经验，包括 WebGPU 的坑、浏览器环境、资源管线、性能数字和用户的工作偏好。
- [docs/architecture.md](docs/architecture.md)：**已定的架构**（用户 2026-11-17）：和 Stride 对齐的自有渲染器、数据导向、和 Jolt 共享内存，以及里程碑。2026-11-18 起不做 SWC 插件和任何编译期改写，组件 API 改为纯 TS 推导的写法（`prop` builder、数据组件加系统），见其中的"组件 API"。
- [docs/own-stack.md](docs/own-stack.md)：技术栈的组织方式（用户 2026-11-17 定的方向）：JS/TS 部分在仓库内自己维护（引擎层和渲染器都自己写），原生库合成一个 C++ 工程、产出一个 wasm 模块。
- [docs/positioning.md](docs/positioning.md)：和 Babylon.js、PlayCanvas、three.js、Cocos、Unity、Godot、Needle 的对比（预估），特色和短板，要实测的性能点。
- [docs/research.md](docs/research.md)：依赖逐项替代、库选型、线程模型和 API 取舍。

现状（2026-11-18）：工程骨架已搭好（pnpm monorepo，见 README.md 的"开发"），本地 git 仓库在 `main` 分支，还没有远程；GitHub 仓库由用户自己创建。引擎只有 `Game` 循环和 `GraphicsDevice`，渲染器还没开始写。

约定：
- 和用户用中文沟通；代码、标识符、注释、提交信息用英文。
- Jolt 的 fork 是单独的仓库：`C:\Users\Administrator\CLionProjects\jolt-native-fork`（已加入本项目的工作目录）。远程 `origin` 是 `kenconnet666/JoltPhysics`，`upstream` 是 `jrouwe/JoltPhysics`（禁止推送）；工作分支 `stride`，基于上游发布标签。做法见 [docs/architecture.md](docs/architecture.md) 的"怎么 fork 和维护 Jolt"。原生 C++ 工程 `stride-native`/`stride-tools` 在这个仓库的 `StrideNative/` 目录（说明见其中的 README.md），按阶段提交到 `stride` 分支。
- 要读的 Stride 源码在 `C:\Users\Administrator\IdeaProjects\stride`，只读，不在那边提交，除非用户要求（例如需要在那边加工具）。
- 在 Chrome 里实际跑过、看过结果，才能说某件事完成了；测试脚本在 [tools/](tools/README.md)。应用内置浏览器的面板隐藏时 `requestAnimationFrame` 不触发，看帧循环要用 `tools/play.cjs`（本机 Chrome）。
- 改了 `StrideNative` 并重新编译后，跑 `pnpm native:sync` 把产物拷进 `packages/native/dist`（`dev`、`build`、`test`、`typecheck` 会先自动同步）。
- 调研自己做，不派子代理。
- TS API 的写法参考用户自己的 easy-query-ts（`C:\code\easy-query-ts`，只读）：带幻影类型参数的不可变 builder、类型全靠推导不做代码生成、核心零依赖并通过 Standard Schema 对接校验库、`*.check.ts` 类型测试。
