# 自己维护的技术栈：JS/TS 在仓库内，原生库合成一个 C++ 工程

状态：设计，2026-11-17。用户的想法：依赖分两类。JS/TS 的部分放在仓库里自己维护、按需要改；需要 wasm 的部分 fork 过来维护成自己需要的样子，多个项目合进一个，避免同一份数据在多个库之间重复处理。

## 结论

可行，并且比"npm 依赖加一层桥接"更适合长期做一个自己的引擎：

- **原生部分合成一个 C++ 工程，产出一个运行时（`stride-native`）**：核心模块加按需加载的侧模块，共用一个堆和一个任务系统（2026-11-18 起，见下面的"拆成核心加侧模块"）。我们选的原生库都是 C/C++：Jolt、Recast/Detour、Basis Universal、meshoptimizer，以后可能要的 ozz-animation、HarfBuzz、msdfgen 也是。只要不选 Rapier（Rust），就能用同一个 Emscripten 加 CMake 工程编译。
- **JS/TS 部分整体放进 monorepo**：引擎（渲染、场景、加载、输入、音频）和 Stride 风格的 API 是同一份代码，不再是"引擎依赖加一层适配"。

## 原生部分：一个 wasm 模块

### 为什么合成一个

| 分开用现成的 wasm 包 | 合成一个模块 |
|---|---|
| 每个库各带一份 Emscripten 胶水代码、一个堆、一个分配器 | 一份胶水、一个堆、一个分配器 |
| 绑定风格各不相同：JoltPhysics.js 用 WebIDL 绑定、要手动 `destroy()`；其他库有的用 embind | 一套我们自己设计的平坦 C API，按批量处理来设计 |
| 同一份网格数据，物理和导航各自从 JS 拷贝、解析一遍 | 网格进 wasm 一次，Jolt 的形状和 Recast 的输入直接读同一块内存；导航网格直接从 Jolt 的静态几何生成 |
| 多个下载、多次编译和实例化 | 一个文件，按内容哈希命名，长期缓存 |
| 每个库各自的线程方案 | 一个线程池：Jolt 的任务系统和 Recast 的分块构建共用 |
| 只能用上游开放的功能，用不到的也得带着 | 编译时去掉用不到的功能（软体、车辆等按需开关） |

### 结构（2026-11-17 已建，放在 Jolt fork 仓库里）

用户决定原生代码放进 `jolt-native-fork`，不在 stride-ts 仓库里建 `native/`。Jolt 上游的文件留在根目录不动，我们的代码全在顶层目录 `StrideNative/`，以后 rebase 到新的 Jolt 标签不会冲突。详细说明见该目录的 `README.md`。

```
jolt-native-fork/
  Jolt/ Build/ ...          upstream Jolt, unchanged
  StrideNative/
    CMakeLists.txt          the only build file; Jolt comes in through ../Build/CMakeLists.txt
    Include/StrideNative/   C API: Core.h (init, memory, tasks), Runtime.h, Physics.h, Texture.h, Navigation.h, Plugin.h, Tools.h
    Source/Core|Runtime|Physics|Texture|Navigation|Shared|Tools
    Plugins/                how to write a wasm plugin, and the example plugin
    JS/                     TypeScript bindings (native-module.ts, stride-native.ts, stride-tools.ts)
    ThirdParty/             libraries copied once; source table in ThirdParty/README.md
    Tests/Native|JS|Browser
    Scripts/build-wasm.ps1  builds both modules and runs the Node tests
```

第三方库各编成静态库，我们的代码是 OBJECT 库，两个 wasm 模块各自最后链接一次。

### 拆成核心加侧模块（2026-11-18）

上面"合成一个模块"要的东西（一份胶水、一个堆、一个分配器、一个线程池、零拷贝共享数据）用 Emscripten 的动态链接也能得到，同时只下载用到的功能：

- `stride-native-core` 是主模块（`MAIN_MODULE=2`）：任务系统、Jolt 的 Core、变换存储、meshopt、ozz、插件 API。
- `stride-native-physics`、`-texture`、`-navigation` 是侧模块（`SIDE_MODULE=2`），启动时按 `features` 加载（每个线程一份），和核心共用内存和任务系统，跨模块的状态都经过核心里的非内联函数。
- 第三方插件也是侧模块，只用插件 C API（`Plugin.h`）；核心导出哪些符号由"ABI 探针"（示例插件，链接在核心上）决定。
- 原来"一个文件"的好处里只少了"一次编译"：多了几个文件，各自按内容哈希长期缓存，改了物理不影响核心的缓存。

细节见 fork 的 `StrideNative/README.md` 的"Core and side modules"。

### API 的设计原则

- **平坦的 C 函数，用句柄加指针**，不暴露 C++ 类。TS 包装由一个小生成器从 `stride_native.h` 生成，或者手写。
- **批量处理**：
  - `world_create(desc_ptr)`：一次传入整个场景的物理描述。
  - `world_step(dt)`：推进一步。
  - `world_poses()`：返回一块连续的 `float` 数组，里面是所有动态物体的 id、位置、朝向，JS 直接读 wasm 内存。
  - 射线检测和形状检测可以一次传一批。
- **内存所有权清楚**：wasm 里的对象全部由句柄管理，组件卸载时释放；调试版统计泄漏。
- **接触事件**：在步进中写进一个环形缓冲区，步进结束后 JS 一次读完。

### 产出：两个模块，都是多线程加 SIMD

| 模块 | 内容 | 用在哪里 |
|---|---|---|
| `stride-native` | Jolt、meshopt 解码、KTX2/Basis 转码、Recast/Detour 和群体移动、ozz 动画采样 | 游戏运行时（浏览器），页面必须跨源隔离（COOP/COEP）。只出多线程版，单线程路线已放弃（用户 2026-11-17 决定） |
| `stride-tools` | glTF/FBX 导入、切线、meshopt 优化/简化/编码、UV 展开、凸分解、Basis 编码、MSDF 字形、ozz 构建、导航网格烘焙 | 编辑器的 Node 后端（资源管线） |

原先计划的 `decode` 变体（在单独的 Worker 里解码）不再需要：只出多线程版之后，解码就是共享线程池上的任务，结果直接写进共享内存。

线程模型：每个模块一个 Jolt `JobSystemThreadPool`，物理步进和后台任务共用。长任务（解码、转码、建导航网格、管线处理）是"任务"，状态是共享内存里的一个 int32，模块完成时 `memory.atomic.notify`，JS 用 `Atomics.waitAsync` 等待，主线程不阻塞。并行的部分：meshopt 缓冲区、KTX2 的各级 mip、导航网格的各个 tile、动画实例、MSDF 字形；自带线程的库（xatlas、V-HACD、Basis 编码器）在任务里单线程运行，并行靠同时跑多个任务。实测见 [architecture.md](architecture.md) 的"wasm 构建"。

### 依赖策略：只同步 Jolt（2026-11-17 用户决定）

只有 Jolt 作为 fork 持续同步上游。其他部分要么自己写（AI 辅助），要么从别的项目复制一次后由我们维护，不再跟上游同步：

| 部分 | 做法 | 原因 |
|---|---|---|
| Jolt | 独立的 fork 仓库（`jolt-native-fork`），持续同步上游 | 求解器复杂、还在快速演进 |
| 引擎层、渲染器、编辑器、资源管线（TS 和 Node） | 自己写；设计和算法参考 Stride 源码（MIT，可以直接移植成 TS），WebGPU 的做法参考 three.js、Babylon.js、PlayCanvas | 我们是 Stride 的孪生，移植它的光照、阴影级联、后处理是对齐最直接的路 |
| meshoptimizer v1.3 | 复制一次（运行时只用解码器，管线用完整版） | 代码小，格式固定 |
| Basis Universal v2_50 | 复制一次（运行时是精简的转码器，管线用编码器） | 格式稳定 |
| Recast/Detour/DetourCrowd/DetourTileCache | 复制一次（main 分支 `9f4ce64`，最后的发布版太旧） | 成熟、很少更新，从零重写风险大 |
| ozz-animation 0.17.0 | 复制一次（运行时采样，管线构建） | 采样和混合是每帧每根骨头的循环，适合 C++ |
| 只在管线里用的：ufbx、cgltf、MikkTSpace、xatlas、V-HACD、msdfgen、stb | 复制一次，只编进 `stride-tools` | 只在离线时运行，很少需要更新 |

2026-11-17 已全部导入 `StrideNative/ThirdParty/`，版本、提交和协议见那里的 `README.md`。

复制代码的规矩：
1. 只从宽松协议复制：MIT、BSD、zlib、Apache-2.0。GPL、LGPL 一律不碰，"参考着改写"也不行。
2. 保留原文件的版权和许可头和许可文件；来源表在 `StrideNative/ThirdParty/README.md`；Apache-2.0 的代码改动时要标明。
3. 维护一张来源表：每份复制代码来自哪个项目、版本、提交，以便上游出了安全或严重修复时对照合并。
4. AI 写的代码必须有参照测试，用原始实现的输出当标准答案：解码器逐字节比对，导航网格和 Recast 原版结果比对，渲染和桌面 Stride 截图比对。

### 维护上游（Jolt）

- Jolt 是单独的 fork 仓库（本地 `C:\Users\Administrator\CLionProjects\jolt-native-fork`，远程 `origin` 为 `kenconnet666/JoltPhysics`，`upstream` 为 `jrouwe/JoltPhysics`），工作分支 `stride` 固定在上游的发布标签上（当前 `v5.7.0`）。布局和升级方式见 [architecture.md](architecture.md) 的"怎么 fork 和维护 Jolt"。
- 我们的改动尽量放在 `StrideNative/` 里，不改 Jolt；非改不可的，作为少量独立提交留在 `stride` 分支上，升级时 rebase 到新标签。
- 升级按计划做（例如跟随 Jolt 的发布），升级后跑物理和导航的回归测试。
- 代价：上游的修复不再自动到手，要自己合并。Jolt 发布频繁，这是最主要的维护成本。

### 物理放 CPU，GPU 只做视觉效果

影响玩法的物理（角色、刚体、触发器、射线检测）在 CPU 上算，用 wasm 里的 Jolt，这也是 Jolt、Havok、Bullet、Bepu 的做法：
- 脚本要在这一帧里同步拿到结果；GPU 的结果要回读，至少慢一两帧。
- 宽相位、窄相位、约束求解分支多、前后依赖强，适合 CPU。
- 一般游戏同时活跃的物体是几百到几千个，CPU 够用；放到 GPU 上反而填不满它，还要付出数据搬运的代价。
- 联网和回放要求确定性，CPU 上更容易保证。

只影响画面、不回到游戏逻辑的效果（粒子、布料、草、碎片），用 WebGPU 计算着色器在 GPU 上算。

JoltPhysics.js（Jolt 官方的 wasm 和 JS 版）不直接作为依赖使用，但它的 Emscripten 构建参数、多线程设置和绑定方式是 `stride-native` 的参考。

## JS/TS 部分：在仓库内自己维护

### 两种做法

| | 把 PlayCanvas 源码 fork 进仓库 | 从零写自己的渲染器 |
|---|---|---|
| 起点 | 已有的 WebGPU 渲染、材质、阴影、后处理、glTF 加载、输入、音频 | 什么都没有 |
| 改造 | 逐步改成 TypeScript；把它的实体组件直接改成 Stride 的形状，去掉"适配层"；可以只保留 WebGPU，删掉 WebGL 相关代码 | 按 Stride 的结构设计：RenderFeature、RenderStage、Effect |
| 到第一个能玩的游戏 | 几周量级 | 以年计 |
| 维护 | 要自己维护一个大代码库；上游的修复可以挑着合并 | 全部自己写、自己维护 |

为什么不以 three.js 为起点：它是渲染库，不是游戏引擎。渲染很强（WebGPURenderer、TSL 节点式着色语言、生态最大），但没有实体组件、脚本生命周期、资源管理，输入和音频也很少，这些都要自己写；而且它每月一个大版本，API 经常有不兼容的变化，WebGPURenderer 和 TSL 还在活跃开发中。它的 TSL 值得借鉴：Stride 的材质是一层层组合出来的，和节点式着色器的思路一致，翻译 Stride 材质到 WGSL 时可以参考。

（已被下文"渲染器的长期方向"里用户的决定取代：渲染器也自己写。）当时的建议：**渲染用 three.js，引擎层自己写**。既然 JS/TS 部分要自己维护，就要比较"维护一个 PlayCanvas 的 fork"和"自己写引擎层、渲染交给 three.js"：

| | fork PlayCanvas | three.js 加自己的引擎层 |
|---|---|---|
| 渲染 | fork 里的渲染代码要自己维护，上游修复得挑着合并 | three.js 作为锁定版本的依赖，由最大的社区维护，升级就能拿到修复和新特性 |
| 实体组件、脚本 | 已有，但要把现成的设计改成 Stride 的形状 | 从零按 Stride 的形状设计，没有历史包袱，也没有中间层 |
| 资源管理、输入、音频 | 已有，同样要改造 | 自己写；这几块本来就要按我们的方式定制 |
| 要维护的代码量 | 一个完整引擎 | 只有引擎层 |
| 加载 | 有 | GLTFLoader、KTX2Loader（自带 Basis 转码）、meshopt 解码都现成 |

要自己写的：
- 实体加组件加脚本系统。
- 场景加载：导出的 JSON 建成实体，挂上 three.js 的网格、灯光、相机。
- 资源管理：按组加载、缓存、引用计数，在 Worker 里解码。
- 输入的轮询状态。
- 在 Web Audio 之上的音频组件。
- 物理桥接（接 `stride-native` 的 Jolt）：用哪个渲染方案都得写。

three.js 的代价和对策：
- **API 变化快**：每月一个大版本，WebGPURenderer 和 TSL 还在活跃开发。锁定版本、按计划升级，用到的 three.js 接口集中在少数几个文件里，升级时只改那里。
- **场景图开销**：每个物体一个 Object3D，物体多时矩阵更新慢。大量物体用 InstancedMesh 或 BatchedMesh；变换由我们自己的结构数组驱动。
- **游戏引擎级的渲染功能**：大量光源、部分后处理在 three.js 里主要靠扩展和示例代码，可能要自己补。原型要实测。

three.js 不 fork，作为锁定版本的 npm 依赖；只有需要打补丁时才把源码放进仓库，和原生库的策略一致。如果原型发现渲染功能缺得太多，退回 fork PlayCanvas 的方案（MIT 协议，可以 fork，要保留版权声明）。

### 渲染器的长期方向：自己写，和 Jolt 共享数据

three.js 以对象为中心：每个物体一个 Object3D，每帧更新矩阵、排序渲染列表、检查材质状态。几百到一两千个物体没有问题，再多就要靠 InstancedMesh 或 BatchedMesh。浏览器里瓶颈常常是 CPU 端每次 draw 的开销（C# 移植版就是这样）。

自己写渲染器的意义在于数据的流向：Jolt 把所有物体的位姿写进 wasm 里的一块连续缓冲，整块上传成 GPU 的实例数据，在计算着色器里剔除、生成间接绘制。每帧 JS 几乎不逐个碰物体，几万个由物理驱动的物体也撑得住。另一个只有我们才有的优势：C# 移植版的内容管线已经能把 Stride 的所有效果编译成 WGSL，按 Stride 的渲染结构（RenderFeature、Effect）用 TS 实现，画面就能和桌面 Stride 一致。

代价：PBR、光照、阴影、蒙皮、后处理、粒子、UI、调试工具都要自己写。只做原型需要的部分是几个月的量级；做到和 Stride 功能对齐是长期工程。

| | three.js 加自己的引擎层 | 自己的渲染器，数据导向，和 Jolt 共享内存 |
|---|---|---|
| 第一个能玩的原型 | 最快 | 晚几个月 |
| 大量物体时的 CPU 开销 | 高，靠实例化缓解 | 最低 |
| 画面和 Stride 一致 | 不一致 | 一致（复用 Stride 的 WGSL） |
| 维护量 | 小 | 大 |

**用户的决定（2026-11-17）：直接走自己的渲染器，作为长期工程；不用 three.js，也不 fork PlayCanvas。** 设计见 [architecture.md](architecture.md)。下面的分阶段建议作为当时的分析保留。

当时的建议是分阶段：
1. 原型先用 three.js 画出来，让引擎层、导出器、Jolt 桥接尽快跑通。渲染放在我们自己定义的接口后面，游戏代码和引擎层都不直接碰 three.js。
2. 数据布局从第一天就按最终形态设计：变换存成结构数组，物理结果写进 wasm 里的共享缓冲。
3. 用原型的数字决定何时换：物体数量、CPU 帧时间、"画面要和 Stride 一致"，任何一项成为硬需求，就在接口后面换成自己的渲染器，从复用 Stride 的 WGSL 开始。

如果一开始就更看重长期性能和与 Stride 的一致性，可以跳过第 1 步直接写自己的渲染器，代价是第一个可玩原型晚几个月。这是用户要做的选择。

### monorepo 布局

2026-11-18 建了骨架，目前只有标"已建"的目录，其余等到有代码时再加：

```
stride-ts/
  packages/
    engine/        (built) our engine layer and renderer in Stride's shape: entities, components, scripts, scene loading, input, audio, RenderSystem
    content/       loading by groups, caches, reference counts
  apps/
    sandbox/       (built) smoke-test page for the whole stack
    editor/        the editor: a Web front end whose viewport is the engine itself, and a Node.js back end (project files, asset pipeline, dev server)
  tools/           (built) Playwright scripts and build scripts; later importer/ (reads a Stride project's YAML assets for migration)
  games/
    third-person-platformer/
```

用 pnpm workspaces 管理包，用 Vite 开发和构建。包内源码直接以 TS 导出（`exports` 指向 `src/index.ts`），由 Vite 和 Vitest 编译，不单独构建；类型检查是根目录一次 `tsc`。

## "一个东西不处理多次"的具体例子

- **网格**：导出器把一个网格写成一份紧凑的二进制（顶点、索引、碰撞形状的描述）。加载时这块 ArrayBuffer 只解析一次：渲染用它创建 GPU 缓冲；物理和导航用的部分只拷进 wasm 一次，Jolt 和 Recast 都从那里读。
- **导航网格**：在 wasm 内部直接从 Jolt 世界的静态几何生成，不经过 JS。
- **纹理**：Basis 转码一次，结果直接上传 GPU。
- **场景描述**：导出时就把物理部分整理成 `world_create` 能直接读的二进制布局，运行时一次调用就建完整个物理世界，不在 JS 里逐个物体创建。

## 风险

- **维护量**：fork 一个渲染引擎，加上四五个原生库，需要长期投入。要控制范围：只保留用得到的部分，补丁越少越好。
- **工具链**：Emscripten、CMake、生成绑定，都需要 CI 支持。好在原生部分很少改，平时开发只动 TS。
- **不用 Rust**：Rapier 这类 Rust 库进不了这个 C++ 模块。真需要时，可以另出一个 Rust 编的 wasm，代价是又多一个模块。
- **跨源隔离**：只出多线程版，部署必须能设 COOP/COEP，设不了的托管平台不支持。COEP 下页面引用的跨源资源（CDN、图片、iframe）要带 CORP 或 CORS 头，或者改用 `COEP: credentialless`；编辑器的 Node 后端和开发服务器也要发这两个头。
