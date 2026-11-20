# stride-ts

Stride 的 TypeScript 孪生版：一个"形状像 Stride"的浏览器游戏引擎。引擎和脚本用 TypeScript，物理和导航这类重活用一个自己维护的 C++ 工程编成的 WebAssembly；编辑器也自己做（Node.js 后端加 Web 前端，视口就是运行时），不依赖 Stride Game Studio。

开工前先读：
- [README.md](README.md)：推荐方案、原型计划、组件和脚本的写法（设计草案，含和 C# 的对照）、实例化、懒加载和缓存的设计、待用户决定的事项。
- [docs/lessons.md](docs/lessons.md)：Stride C# 网页移植的经验，包括 WebGPU 的坑、浏览器环境、资源管线、性能数字和用户的工作偏好。
- [docs/architecture.md](docs/architecture.md)：**已定的架构**（用户 2026-11-17）：和 Stride 对齐的自有渲染器、数据导向、和 Jolt 共享内存，以及里程碑。2026-11-18 起不做 SWC 插件和任何编译期改写，组件 API 改为纯 TS 推导的写法（`prop` builder、数据组件加系统），见其中的"组件 API"。
- [docs/own-stack.md](docs/own-stack.md)：技术栈的组织方式（用户 2026-11-17 定的方向）：JS/TS 部分在仓库内自己维护（引擎层和渲染器都自己写），原生库合成一个 C++ 工程（运行时是核心 wasm 加按需加载的侧模块）。
- [docs/positioning.md](docs/positioning.md)：和 Babylon.js、PlayCanvas、three.js、Cocos、Unity、Godot、Needle 的对比（预估），特色和短板，要实测的性能点。
- [docs/research.md](docs/research.md)：依赖逐项替代、库选型、线程模型和 API 取舍。
- [docs/vector-assets.md](docs/vector-assets.md)：资源尽量矢量化（用户 2026-11-19 的方向）的格式讨论稿：2D 矢量图、材质图、几何、地形各用什么格式，要用户定的问题，几何实验的设计和结果。
- [docs/prefabs.md](docs/prefabs.md)：预制体在场景文件里怎么表示（2026-11-20 用户定了：场景里只存引用和差异）。
- [docs/handover.md](docs/handover.md)：**换机器的交接**（2026-11-20）：新机器上的准备、做到哪了、没收尾的。
- [docs/roadmap.md](docs/roadmap.md)：路线图（范围、原则、阶段、取舍）和末尾的"进度"；执行中自己做的决定记在 [docs/decisions.md](docs/decisions.md)，已完成各项的过程在 [docs/progress-log.md](docs/progress-log.md)。

现状（2026-11-20：P1、P2 完成；P3 编辑器的界面、场景树和资源浏览器的操作、预制体做了；P4 的底座做了大半，屏幕空间反射、接触阴影、运动模糊做了。进度、下一步、等用户定的事见 docs/roadmap.md 末尾的"进度"，只留结论，各项的过程和验收表在 docs/progress-log.md）：

- **仓库**：pnpm monorepo（见 README.md 的"开发"），`main` 分支，远程 `origin` 是公开仓库 `kenconnet666/stride-ts`（2026-11-18 建，MIT 许可证）。提交了就直接推送到 origin，不用先问，也不等全量回归（用户 2026-11-18、2026-11-20：推送是为了几处检出互相同步，回归在后台跑，失败了再修、再推）；fork 同样直接推 origin，但永远不推上游 jrouwe。
- **引擎核心**：`Game` 循环、`GraphicsDevice`、实体核心（`prop`、数据组件和列存储、系统、脚本、按模块路径登记，见 docs/architecture.md 的"实现状态"），实体克隆（`entity.clone()`）和所在的场景（`entity.scene`）；开发时有热重载（`Game.hotEntry`）；`Transform` 的数据在 stride-native 的变换存储里（层级传播、物理写回，见"共享内存的数据模型"）。
- **原生部分**：npm 包 `@stride-ts/native`（源码在 fork 的 `StrideNative/JS/`，发布到 npm 之前从 fork 的 GitHub Release 安装），运行时拆成核心模块加物理、贴图、导航三个侧模块（`Game.run` 的 `nativeFeatures` 选用，没选的不下载），第三方也能写 wasm 插件（fork 的 `StrideNative/Plugins/README.md`）；开发时用调试版原生模块（见 docs/architecture.md 的"体积"）。
- **渲染**（docs/architecture.md 的"渲染器"）：RenderSystem、MeshRenderFeature 实例化绘制、ForwardRenderer；`Light` 组件（方向光、点光、聚光、环境光、天空盒光照，Stride 的 Lambert）；和 Stride 一致的 PBR（金属度工作流、GGX）、天空盒背景、HDR 加色调映射；视锥剔除（stride-native 里）、方向光的级联阴影、点光（立方体的六个面）和聚光的阴影（照 Stride，PCF，共用一张图集）、法线贴图（MikkTSpace 切线）、材质层；后处理（FXAA、泛光、光芒、镜头光晕，`rendering/postfx`）；网格效果和 SpriteBatch 的自定义着色器；GPU 耗时用 `GpuProfiler`（WebGPU 时间戳，`stride perf`）。
- **资源管线**：`packages/pipeline` 的 Stride 工程导入器、`ContentManager`；贴图（KTX2 加 Basis，运行时转码成 BC7/ASTC/ETC2）；内容默认压缩（量化加 meshopt 的模型、可选 SVG 贴图、运行时生成的天空盒镜面贴图）；导入器带上碰撞体、角色、脚本和 GameSettings 的仿真设置。
- **物理和输入**：Stride.BepuPhysics 形状的物理（`physics/`：`Static`、`Body`、`Character` 组件、约束组件，`Simulation` 固定步长加插值，原生侧在 fork 的 `Physics.h`）；导航（Recast）；输入（`input/InputManager`，虚拟按钮；手势识别 `input/gestures.ts`：点、长按、拖动、轻扫、双指组合）。
- **动画**（`animation/`）：`AnimationComponent`、`game.animation`，ozz 在原生侧并行求值，GPU 蒙皮；形变目标（`animation/morphs.ts`：`game.animation.morphs(entity)`，剪辑里的权重曲线，顶点着色器里形变）；用代码建的属性曲线（`animation/curves.ts`：`AnimationClip.fromCurves`、`propertyCurve`，驱动数据组件的属性）。
- **文字和 UI**：矢量文字（`rendering/text`：字形轮廓按 Slug 逐像素算覆盖率，`SpriteBatch`）；UI 系统（`ui/`：.sduipage、.sduilib 导入，Stride 的布局、控件、路由事件，`game.ui` 在场景之后画全屏 UI 和放在 3D 里的 UI（和场景比深度），UI 占着的输入对脚本藏起来（`input/capture.ts`），EditText 用隐藏的 DOM 输入框编辑，实体可以跟着 UI 元素走（`UIElementLink`）；文字的描边按到轮廓的距离画；键盘事件发给 `game.ui.focusedElement`；影子 DOM `game.ui.semantics` 把全屏 UI 的文字和控件同步成透明的 DOM 节点，读屏、Tab 键、查找、复制用）；屏幕上的调试文字（`game.debugText`，CSS 像素，按游戏设置的设计分辨率摆）。
- **粒子和声音**：粒子（`particles/`：照 Stride 在 CPU 上模拟，生成器、初始化器、力场，Billboard/Quad/Hexagon、飘带和翻页）；声音（`audio/`：Web Audio，`game.audio`、Sound、SoundInstance，源文件原样用；`AudioEmitterComponent`、`AudioListenerComponent` 按实体的位置空间化）。
- **编辑器**（P3；界面用 Vue 加 vue-tsx-pro（用户 2026-11-20 定），骨架做了：样例 `pnpm dev` 以后开 `/__stride/editor/`；资源之间按路径引用，移动、删除时改写引用它的文件）：
  - 引擎里的那一半（`editor/`）：场景文档 `SceneDocument`（场景文件是真相，修改、撤销重做）和 `LiveScene`（实体跟着文档，只重建变了的组件）；游戏页面带 `?stride-edit` 打开就是编辑状态（`game.editing`：不挂脚本、仿真不走），页面里的代理 `game.editor`（`EditAgent`：编辑相机、点选、选中的框、操纵器 `TransformGizmo`）；属性面板的字段描述 `editor/fields.ts`（`checkEntity` 照描述检查）。试玩是不带 `?stride-edit` 重新打开页面。
  - 后端（`packages/editor`，说明见它的 README）：Vite 插件 `strideEditor`（`strideApp` 带着），工程清单（可以没有）、资源数据库、保存接口、按内容目录生成 `src/assets.gen.ts`（`content.load(assets.prefabs.…)`）；前端的封装 `EditorClient`。
- **P4 的底座**（docs/decisions.md 2026-11-20 的三条）：统计量和预算（`game.metrics`、`stride metrics`，显存和管线在设备上记账，每个样例的基线在 `tools/budgets.json`）；模型的管线在加载场景、预制体时后台编好（`MeshRenderFeature.warm`）；渲染图（`rendering/graph/`）：前向渲染器的一帧（阴影、渲染目标贴图的相机、主画面、后处理）都是它的通道，`ForwardRenderer.draw` 里录完当场执行；阴影图集按用到的大小建。画质档位（`rendering/Quality.ts`，`stride quality`）：低、中、高、极高，是内容要的阴影和后处理的上限。TAA 加锐化（`rendering/TemporalAntialiasing.ts`，`stride taa`，默认关），网格的运动向量（`RenderStage.velocity`；世界矩阵、蒙皮、形变的缓冲分两半，每帧轮着写，另一半是上一帧的）。GTAO（`rendering/AmbientOcclusion.ts`，`stride ao`，半分辨率，只乘环境光）。屏幕空间反射（`rendering/ScreenSpaceReflections.ts`，`stride ssr`，合成器的 LocalReflections 开）；接触阴影、运动模糊（`stride contact`、`stride blur`，默认关）。屏幕空间全局光照（`rendering/ScreenSpaceGlobalIllumination.ts`，`stride ssgi`，默认关）；次表面散射（`rendering/SubsurfaceScattering.ts`，材质的 `subsurfaceScattering`，合成器开，`stride sss`，只糊漫反射光）。后处理、GTAO、背景的管线加载时预热；绘制次数按渲染通道（`stride draws`）。
- **样例**（`apps/` 下，各自有 `import:stride` 和 `smoke`，冒烟共用的页面帮手在 `tools/smoke.ts` 的 `PAGE_HELPERS`；清单、端口和验收结果见 docs/roadmap.md 的"进度"）：P1 的七个 Stride 样例（platformer 即 TPP、animated-model、physics-sample、bepu-sample、platformer2d、topdown-rpg、first-person-shooter）都移植了，TPP 和桌面 Stride 4.4.2 的截图逐像素比对过；P2 的 sprite-fonts、game-menu、ui-element-link、ui-particles、simple-audio、particles-sample、jumpy-jet、space-escape、material-shader、custom-effect、morph-targets、csharp-beginner、csharp-intermediate。
- **工具**：调试 CLI `stride`（`packages/cli`，`pnpm exec stride --help`）查看和操作正在运行的游戏：状态、实体、改属性、暂停单步、模拟输入、截图比较、性能、CPU 剖析、日志、原生侧的计数器；游戏和原生代码通过 `game.debug`、fork 的 `Debug.h` 埋点。画面上的调试线用 `game.debugDraw`（线、盒子、球、网格、坐标轴，`simulation.showColliders` 显示碰撞体）；网格的线框 `stride wireframe`；点选 `stride pick`（网格、精灵、粒子、放在 3D 里的 UI；全屏 UI 不参加）。统计量 `stride metrics`，冒烟跑完时和 `tools/budgets.json` 的基线比（有意的变化之后在验证工作树里重记：`$env:STRIDE_UPDATE_BUDGETS = 1; pwsh tools/verify.ps1`，再把工作树里的 `tools/budgets.json` 拷回来）。`pwsh tools/regress.ps1` 把所有冒烟脚本跑一遍，`pwsh tools/measure.ps1` 测导入、构建、下载量、启动和帧时间（桌面 Stride 用截图工程的 `--benchmark`）；和桌面 Stride 的截图比对用 `tools/stride-capture`、`stride shot --diff`。
- **参考用的开源仓库**浅克隆在 `C:\code\refs`，需要时再加：
  - glTF-Transform、three.js、PlayCanvas engine；
  - WebGPU：`gpuweb`（WebGPU 和 WGSL 规范）、`dawn`（Chrome 的实现，含 WGSL 编译器 Tint）、`wgpu`（Firefox 的实现）、`webgpu-samples`、`types`（@webgpu/types）；
  - 浏览器的 WebGPU 实现（稀疏检出）：`chromium`（Blink 的 webgpu 模块、画布呈现、gpu/command_buffer 和 gpu/config）、`WebKit`（Source/WebGPU，Safari）、`firefox`（dom/webgpu、gfx/wgpu_bindings）；
  - D3D：`DirectX-Headers`、`DirectXShaderCompiler`（DXC，Chrome 在 Windows 上用它编译 Tint 生成的 HLSL）、`DirectX-Specs`（D3D12 规范）、`DirectX-Graphics-Samples`（MiniEngine）；
  - 别的引擎：`Babylon.js`、`filament`（后端、着色器、IBL）。
- 看浏览器实际生成的着色器：Chrome 加 `--enable-unsafe-webgpu --enable-dawn-features=dump_shaders,disable_symbol_renaming`，见 docs/lessons.md。

约定：
- 和用户用中文沟通。**代码注释（含文档注释、测试标题）和 git 提交信息用中文**（用户 2026-11-18 决定，覆盖全局 CLAUDE.md 的英文约定）；标识符、文件名、运行时的报错和日志文字仍用英文。Jolt 的 fork 里 Jolt 上游的文件保持英文。
- **引擎要有做 3A 开放世界的潜力，性能靠算法不靠降分辨率**（用户 2026-11-19）：选数据结构和接口时不给规模设上限（世界大小、实体数量、内容体量、团队规模）；性能优化是少做没用的功、把同样的功做得更快、不卡顿，每个系统有预算、先测再改；上采样和动态分辨率只是玩家的可选项。要用的技术和阶段见 docs/roadmap.md 第二节的"做 3A 开放世界还缺什么"。
- **没变就不做**（用户 2026-11-19，从浏览器的渲染管线学的，见 docs/roadmap.md 第二节的同名小节）：引擎要记得上一帧算过什么、哪些输入变了。新加组件、系统、渲染特性时就带上"我变了"的版本号或脏标记，上传给 GPU 的数据只传变了的部分，算过的结果（阴影、UI、程序化生成的页）缓存着；能声明的动画放进着色器或成批算，不逐个对象用脚本驱动。
- **目标是比 Stride 做得更好，不是照抄**（用户 2026-11-19）：Stride 的 bug、怪癖、难用的 API 不跟，改好并注明"和 Stride 不同：……"（改之前把受影响的情况想全，记进 docs/decisions.md）；我们比 Stride 差的限制要补掉，不能留着当完成。文档和代码边做边整理：文档只留结论，被取代的内容改写原处；整理和功能改动分开提交。见 docs/roadmap.md 的"原则"。
- wasm 那边（Jolt 的 fork 里的 StrideNative）有问题、或者我们需要新能力时，直接改那边的代码，不在 TS 里绕过去；改完重编、跑原生/Node/浏览器测试，再按下一条发新版本。
- Jolt 的 fork 是单独的仓库：`C:\code\JoltPhysics`（已加入本项目的工作目录）。远程 `origin` 是 `kenconnet666/JoltPhysics`，`upstream` 是 `jrouwe/JoltPhysics`（禁止推送）；工作分支 `stride`，基于上游发布标签。做法见 [docs/architecture.md](docs/architecture.md) 的"怎么 fork 和维护 Jolt"。原生 C++ 工程 `stride-native`/`stride-tools` 在这个仓库的 `StrideNative/` 目录（说明见其中的 README.md），按阶段提交到 `stride` 分支。
- 要读的 Stride 源码在 `~\IdeaProjects\stride`，只读，不在那边提交，除非用户要求（例如需要在那边加工具）。
- 在 Chrome 里实际跑过、看过结果，才能说某件事完成了；用调试 CLI（[packages/cli](packages/cli/README.md)）试玩和测量，其余脚本在 [tools/](tools/README.md)。应用内置浏览器的面板隐藏时 `requestAnimationFrame` 不触发，不用它看帧循环。看画面、点按钮、读控制台用用户的主 Chrome 里的 Claude in Chrome 插件（用户 2026-11-19 定：主 Chrome 一直登录着，`stride open` 起的 Chrome 一重启插件就要重新认证）：插件开游戏页面，CLI 经开发服务器的中枢连到这个页面；同一个开发服务器只留一个页面（CLI 对最后连上的页面，后台标签会被节流）。要 DevTools 协议的 `cpu-profile`、`mouse --trusted` 经主 Chrome 里装的调试桥扩展（[tools/debug-bridge](tools/debug-bridge/README.md)，`chrome.debugger`；Chrome 136 起默认配置文件不能开远程调试端口），没装扩展的浏览器里用 `stride open <url> --headless` 起的 Chrome。插件掉线、要登录这类事叫用户帮忙。
- 本仓库通过 `pnpm-workspace.yaml` 的 override 从 GitHub Release 安装 `@stride-ts/native`（各包的 package.json 照常写 `^0.1.0`）。原生部分改了以后：改 fork 的 `StrideNative/JS/package.json` 版本号 → `pwsh StrideNative/Scripts/build-wasm.ps1`（构建、测试、打包）→ 提交并推送 fork → `pwsh StrideNative/Scripts/release-native.ps1`（发布 GitHub Release `native-v<版本>`）→ 把本仓库 `pnpm-workspace.yaml` 里 override 的地址换成新版本 → `pnpm install`。不要改成 `file:` 指向本地 tgz：pnpm 给它建的目录名带 `..`，JetBrains 的 IDE 就解析不出这个包的类型（用户 2026-11-18 定用 GitHub Release，以后发布到 npm 再删掉 override）。
- **测试分三层**（用户 2026-11-20）：第 1 层每次提交前 `pnpm typecheck`、`pnpm test`（约 20 秒）；第 2 层推送前 `pwsh tools/regress.ps1 -Changed`（按和 origin/main 的改动挑样例，`tools/affected.ts`，一般 1～3 分钟；已经推送了的加 `-Base <推送前的提交>`）；第 3 层全部样例的冒烟交给 CI（`.github/workflows/ci.yml`，推送 main 后自动跑：GitHub 的运行器用 SwiftShader 的软件 WebGPU，四组并行），不等它，失败了再修。CI 验证不了的（真实显卡上的帧时间、和桌面 Stride 的截图比对、`measure.ps1`）在验证工作树里挂后台跑：先本地提交，`pwsh tools/verify.ps1`（默认槽位 3：工作树 `../stride-ts-verify-3` 切到那个提交、装依赖、联接导入的内容，再跑 `tools/regress.ps1` 或 `-Script` 给的脚本）。槽位 1、2（`../stride-ts-verify-1`、`-2`）可以拿去开发（在分支上时 verify.ps1 不碰它）；每个槽位有自己的 CLI 状态目录，端口加 10000 + 1000 × 槽位。工作树和主检出是同一个仓库，提交了就能切过去；失败就在主检出修、再提交。回归直接在主检出跑的时候，它的开发服务器会热更新工作区里的改动：跑完之前不要改 `packages/`、`apps/` 的源码。
- **后台的东西用完就停**（用户 2026-11-19）：开发服务器、无头 Chrome、主 Chrome 里开的游戏标签页，做完这个样例的验证就停掉（`pwsh tools/stop-dev.ps1`，`-Keep` 留下还在用的；标签页用插件关），不留到下一个样例。停后台任务不会带走它的 vite 子进程，要用这个脚本按进程停。忘了停的页面一直按满帧率渲染、白占显卡。**这台机器（2026-11-20 换的：Xeon 18 核 36 线程但单核慢，RX 9070 GRE）多核和显卡都够，占显卡的测试可以适当并行**（用户 2026-11-20）：回归默认 4 个样例同时跑、两个验证工作树可以同时用；只有测帧时间（`measure.ps1`、`stride perf`）要独占。
- 调研自己做，不派子代理。
- TS API 的写法参考用户自己的 easy-query-ts（`~\IdeaProjects\easy-query-ts`，只读）：带幻影类型参数的不可变 builder、类型全靠推导不做代码生成、核心零依赖并通过 Standard Schema 对接校验库、`*.check.ts` 类型测试。属性的分层合并和转发参考 vue-tsx-pro（`~\IdeaProjects\vue-tsx-pro`，只读）的 `packages/ui/src/utils/props.ts` 和 `COMPONENTS.md` §2，它是 Vue 和 DOM 的体系，只借鉴规则和类型做法。
