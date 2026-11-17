# 架构：和 Stride 对齐的自有渲染器，数据导向，和 Jolt 共享内存

状态：设计，2026-11-17。用户的决定："我们就是要做长期工程，和 Stride 对齐的自己的渲染器，数据导向，和 Jolt 共享内存。"不使用 three.js，也不 fork PlayCanvas。

## 目标

1. **画面和桌面 Stride 一致**：同一个场景，截图逐项可比。
2. **数据导向**：每帧的热数据（变换、包围盒、实例数据）存成结构数组，批量处理，不按对象逐个调用。
3. **和 Jolt 共享内存**：物理结果直接写进渲染要用的数组，中间不经过 JS 拷贝。
4. **开发体验**：引擎逻辑和游戏脚本是 TypeScript，可以热重载；热循环放在 C++ 里，用 SIMD。

## 分层

```
游戏脚本（TS，Stride 风格的 API）
引擎层（TS）：实体、组件、脚本调度、场景加载、内容管理、输入、音频
渲染器（TS 负责组织，WGSL 来自 Stride 的效果）：RenderSystem、RenderFeature、RenderStage、Compositor
stride-native（C++，一个 wasm 模块）：变换数组、层级传播、剔除、动画求值、Jolt、Recast、解码
浏览器：WebGPU、Web Audio、Gamepad、Worker
```

分工原则：**TS 负责组织和决策**（哪些东西要画、按什么顺序、用什么效果），**C++ 负责每帧对每个对象都要做的循环**（层级传播、剔除、动画、物理）。

## 共享内存的数据模型

- **变换数组放在 stride-native 的线性内存里**，按结构数组布局：本地位置、旋转、缩放、父节点下标、世界矩阵。每个实体用一个稳定的下标（句柄）指向自己的那一格。
- **Jolt 直接写这些数组**：动态物体步进后，位姿写进对应实体的本地变换；运动学物体反过来从数组读。不再有"从 Jolt 读出来、再写进场景"的步骤。
- **TS 看到的是视图**：`transform.position` 是一个对象形式的访问器，背后读写的就是 wasm 内存里的那一格，不另存一份。
- **上传 GPU 不经过中间拷贝**：`queue.writeBuffer(instanceBuffer, 0, wasmMemory.buffer, worldMatrixPtr, byteLength)` 直接从 wasm 内存上传整段世界矩阵。
- **wasm 内存增长会让 TypedArray 视图失效**。两种做法：预先申请足够大的固定内存，关闭增长；或者每帧检查 `memory.buffer` 有没有换，换了就重建视图。原型先用固定内存，简单可靠。

## 渲染器：按 Stride 的结构

| Stride | 这里 |
|---|---|
| `RenderSystem`、`RenderView`、`RenderStage` | 同名，同样的分阶段流程：收集（Collect）、提取（Extract）、准备（Prepare）、绘制（Draw） |
| `RenderFeature`（MeshRenderFeature 及其子特性：变换、蒙皮、材质、前向光照、阴影） | 同样拆成子特性；每帧对象级的循环调用 stride-native |
| Effect 加排列组合（permutation） | 自己的 WGSL 着色器系统（见下文"编辑器和资源管线"）：着色器模块可以组合（类似 SDSL 的 mixin），排列组合由 Node 端的管线预编译并生成绑定的反射数据；运行时按效果名和排列组合键取用 |
| `ParameterCollection`、`ResourceGroup` | 按反射数据生成 bind group 布局；常量写进环形缓冲，用动态偏移，不必每个 draw 一个 bind group |
| Graphics Compositor（ForwardRenderer、后处理） | 移植它的结构，先做前向渲染器 |

GPU 驱动：
- 每帧把可见物体的世界矩阵整段上传成实例数据。
- 剔除先在 stride-native 里用 SIMD 做，以后可以移到计算着色器。
- 同网格加同材质的物体合成一次实例化绘制。

WebGPU 核心规范没有 multi-draw-indirect，所以合批以"网格加材质"为单位。

C# 移植版踩过的 WebGPU 坑，全部适用，见 [lessons.md](lessons.md)：`writeBuffer` 的生效时机、pass 内的状态去重、scissor 一直有效、调试组会切断 pass、没写的颜色目标要设 writeMask 0。

## TS 端的高性能写法和构建（2026-11-17）

TS 加 C++ wasm 做高帧率可行。性能来自代码形态和数据流向，不来自转译工具：Babel 只是编译期改写源码，本身不让代码变快。

| 层面 | 做法 |
|---|---|
| JS 代码形态 | 对象结构固定，让 JIT 生成快速路径；热路径用 TypedArray；引擎路径每帧不分配内存；热循环里不用闭包和多态调用 |
| JS 和 wasm 的边界 | 粗粒度的批量调用；数据放在 wasm 内存里，JS 直接读视图，不拷贝 |
| 每个对象都要跑的循环 | 放进 C++：变换传播、剔除、动画求值、物理，用 SIMD |
| 渲染 | 实例化、整段上传；pass 内状态去重；管线在加载时预热 |
| 帧节奏 | `requestAnimationFrame` 跟随屏幕刷新率；165 Hz 每帧预算约 6 ms，CPU 端目标 2–4 ms |
| 主线程 | 只跑游戏循环；加载和解码放进 Worker；需要时整个引擎可以搬进 Worker（OffscreenCanvas） |

构建（2026-11-17 定：用 SWC 插件）。2026-11-18 的骨架还没有插件，用的是 Vite 8 自带的 Oxc 转译 TS；开始写插件时再把 TS 转译换成 SWC：
- **开发和正式版都走 SWC**：组件 API 依赖插件做编译期改写，两边必须一致。SWC 是 Rust 写的，和 esbuild 同一速度量级，热重载仍是几百毫秒。Vite 里用 SWC 取代 esbuild 处理 TS。
- **插件用 Rust 写，编成 wasm 给 SWC 加载**，和 `swc_core` 的版本绑定，升级 SWC 时一起升级、一起测试。
- **插件做的事**：
  - 数据组件生成结构数组存储和元数据（见下文"组件 API"）。
  - 系统的查询循环改写成按下标遍历 TypedArray。
  - 向量运算内联：`a.add(b).scale(s)` 展开成标量运算，变换直接读写 wasm 内存里的数组。
  - 从 `@property` 和字段类型生成序列化和编辑器面板用的描述，运行时不靠反射。
  - 只在正式版：删掉断言、日志、统计。
- **约束**：
  - 插件只认识固定的写法，认不出来的退回运行时实现照样能跑，编译时提示哪里没被优化。
  - 同一套测试在"改写"和"不改写"两种模式下跑，结果必须相同。
  - 生成 source map，断点和报错指向源码。

插件对性能的影响（预估，要实测）：
- SWC 编译器本身不带来运行时性能，收益全部来自插件的改写。
- **系统循环改写**收益最大：和"每个实体一个对象"的写法比，热循环快几倍（常见 2–10 倍），实体越多越明显。
- **向量内联**主要减少 GC 造成的偶发卡顿，平均帧时间改善有限（V8 的逃逸分析有时已经能消掉临时对象）。
- **删调试代码、生成元数据**：每帧影响小，后者主要改善加载。
- 对 GPU、wasm 里的工作（物理、变换、剔除、动画）、WebGPU 调用开销、一般游戏脚本没有影响。
- TPP 规模的场景里 JS 游戏逻辑约占每帧 1 ms，帧率变化不明显；成千上万个实体每帧都有逻辑时，收益最大。
- 插件的目标是"易读的对象式写法，跑出接近手写 TypedArray 循环的速度"，不是比手写更快。
- 验证：同一个系统写三份（朴素对象写法、插件编译后、手写 TypedArray），在 1 千、1 万、10 万个实体下比较帧时间和 GC 次数。收益不明显时，插件只保留元数据生成和删调试代码，降低复杂度。

## 组件 API：脚本、数据组件、系统（2026-11-17 设计草案）

| 写法 | 用途 | 数据存在哪里 |
|---|---|---|
| 脚本（`SyncScript`、`AsyncScript`） | 游戏玩法：角色控制、关卡流程、UI 逻辑，数量少，写起来要顺手 | 普通对象 |
| 数据组件（`@component` 加带类型的字段） | 大量实体共有的数据：血量、速度、AI 状态 | 插件生成的结构数组（每个字段一个 TypedArray） |
| 系统（`system` 加查询） | 每帧对大量实体做的事：回血、移动、冷却计时 | 直接遍历那些 TypedArray |

```ts
@component('Gameplay.Health')
export class Health {
  @f32({ min: 0 }) max = 100;
  @f32 current = 100;
}

@component('Gameplay.Regen')
export class Regen {
  @f32 rate = 5;          // per second
}

export const regen = system({
  query: [Health, Regen],
  update(q, time) {
    for (const e of q) {
      e.health.current = Math.min(e.health.max, e.health.current + e.regen.rate * time.dt);
    }
  },
});

// What the plugin makes of update(), roughly
function updateCompiled(q, time) {
  const n = q.count, idx = q.indices;
  const cur = Health.current, max = Health.max, rate = Regen.rate, dt = time.dt;
  for (let k = 0; k < n; k++) {
    const i = idx[k];
    cur[i] = Math.min(max[i], cur[i] + rate[i] * dt);
  }
}

// Transforms live in the wasm memory that Jolt and the renderer share:
//   e.transform.position.addScaled(e.velocity.value, time.dt)
// becomes px[i] += vx[i] * dt; py[i] += vy[i] * dt; pz[i] += vz[i] * dt;
```

- 脚本保持 Stride 的手感（`@property`、`update()`、`async execute()`），插件在脚本里只做向量内联、元数据和删调试代码。
- 事件用带类型的 `EventKey<T>`，不用字符串。
- 数据组件之间用实体句柄（整数）互相引用；脚本可以持有组件的视图对象。

## 物理：Jolt 作为内核，Stride 风格的那一层自己用 C++ 写

不从零写物理引擎，也不把 Bepu 移植成 C++（2026-11-17 讨论后的建议）：
- **从零写**：稳定堆叠、连续碰撞检测、约束求解、鲁棒的碰撞几何，每一项都是专门的难题，以年计，而且很难做到 Jolt 的水平。
- **移植 Bepu**：代码量大，SIMD 宽向量布局要重新实现，上游继续用 C# 演进。即使求解器同源，不同编译器的浮点结果也不会逐位相同，"和桌面完全一致"依然做不到。

"像 Stride"落在游戏代码看得到的那一层，这一层在 `stride-native` 里用 C++ 写，内核是 fork 进来的 Jolt：

| Stride 的物理 | 我们的实现 |
|---|---|
| `BodyComponent`、`StaticComponent` | 场景加载时一次建好 Jolt 物体，位姿直接写进共享的变换数组 |
| 32 个碰撞层的矩阵 | Jolt 的对象层加层对过滤表 |
| 触发器 | Jolt 的传感器（sensor） |
| 接触事件处理器 | 步进中缓存，结束后批量交给 TS，语义和 Stride 一致 |
| `CharacterComponent`（Bepu：动态刚体加支撑约束） | 在 Jolt 的刚体角色 `JPH::Character` 之上，照 Stride 的行为用 C++ 实现，参数名一致；手感最容易不同，值得自己做 |
| 材质参数：摩擦、弹性、弹簧（频率、阻尼比） | 摩擦和弹性直接对应；弹簧参数换算到 Jolt 的对应概念，再逐个游戏调参 |
| 射线、扫掠、范围查询 | 同名接口，支持批量 |
| 仿真设置：固定步长、子步数、插值 | 和 Stride 一致 |

只有当 Stride 依赖的某个特性 Jolt 的模型做不到、而且这个需求很重要时，才评估局部替换或扩展。

### 怎么 fork 和维护 Jolt（2026-11-17 定）

- **引入**（2026-11-17 用户改为独立 fork 仓库，取代原先的 git subtree 方案）：Jolt 的 fork 是单独的 git 仓库，本地在 `C:\Users\Administrator\CLionProjects\jolt-native-fork`。远程 `upstream` 指向 `jrouwe/JoltPhysics`（禁止推送）；`master` 只跟踪上游；我们的工作分支 `stride` 固定在上游发布标签上（当前 `v5.7.0`），补丁提交在它上面。远程 `origin` 是 GitHub 上的 fork `kenconnet666/JoltPhysics`，`stride` 分支推送到这里。`stride-native` 的源码就放在这个仓库的 `StrideNative/` 目录（2026-11-17 用户决定），见 [own-stack.md](own-stack.md) 的"结构"。
- **Jolt 本体尽量不改**：我们的代码放在 `StrideNative/Source/`，通过 Jolt 的公开 API 和扩展点接入（对象层过滤、接触监听器、自定义形状）。非改不可的，作为少量独立提交留在 Jolt 代码之上，每个提交写明原因，升级时重新应用。
- **构建选项**：
  - 按需关掉用不到的功能，调试渲染器只在调试版开启。
  - 只出多线程版（`-pthread`，Jolt 自带任务系统），开 SIMD（`-msimd128`）。单线程路线已放弃（用户 2026-11-17 决定）：部署必须带 COOP/COEP 响应头。
  - 单精度。跨平台确定性（`JPH_CROSS_PLATFORM_DETERMINISTIC`）有性能代价，等需要联网同步或回放时再开。
  - Emscripten 参数、内存和多线程配置参考 JoltPhysics.js 的构建脚本。
- **测试**：物理层是纯 C++，先原生编译，在桌面上跑单元测试（编译快，能用 IDE 断点）；同一套测试编成 wasm 用 Node 再跑一遍，确认两边一致。大部分调试不用进浏览器。
- **wasm 构建（2026-11-17 在本机跑通）**：
  - Jolt 自带 Emscripten 支持：`Build/CMakeLists.txt` 加 Emscripten 的 CMake 工具链文件即可，上游 CI 用 emsdk 6.0.8 编 `UnitTests`，再用 `node UnitTests.js` 跑。SIMD 由 `USE_WASM_SIMD` 控制（`-msimd128 -msse4.2`：Jolt 写的是 SSE 指令，由 Emscripten 翻译成 wasm SIMD）；Jolt 的构建不带 `-pthread`，多线程要我们自己加。
  - JoltPhysics.js 在 Jolt 之上用 WebIDL 生成绑定（`webidl_binder.py`），关掉 RTTI、异常、自定义分配器和 ObjectStream，链接参数有 `MODULARIZE`、`EXPORT_ES6`、`INITIAL_MEMORY=128MB`、`STACK_SIZE=1MB`，多线程版加 `-pthread`、`SHARED_MEMORY`、`PTHREAD_POOL_SIZE`。`stride-native` 不用 WebIDL，其余参数可以照搬。
  - 我们的构建（只出多线程版）：在 Jolt 的 CMake 之外加 `-DCMAKE_CXX_FLAGS=-pthread`，链接加 `-pthread -sPTHREAD_POOL_SIZE=navigator.hardwareConcurrency`，并开 `USE_WASM_SIMD`。Worker 池必须预先开好：Jolt 默认开"核数 − 1"个工作线程，而且是同步创建的，池不够大时主线程会死锁。共享内存要求最大内存固定，UnitTests 用的是 128 MB 初始内存、不扩容。
  - 本机工具链：emsdk 在 `C:\Users\Administrator\emsdk`（6.0.8，和上游 CI 一致）；CMake 和 Ninja 用 CLion 自带的。一条命令编译并测试：`tools/build-jolt-wasm.ps1 [-Config Debug|Release|Distribution]`。
  - 结果：多线程加 SIMD 的 Distribution 版，644 个用例在 Node 里全部通过（比当初的单线程版多出的 1 个是多线程测试 `TestMultithreadedAddRemoveAndQuery`）；12 核首次全量编译约 2 分钟。原生 MinGW Debug 版 648 个用例全部通过，多出的是 GPU 计算（DX12）相关的测试。
  - Jolt 自己的单元测试仍然从 `Build/` 编（上面的脚本）。
- **StrideNative 两个模块（2026-11-17 跑通）**：`StrideNative/Scripts/build-wasm.ps1` 编出 `stride-native` 和 `stride-tools` 两个多线程加 SIMD 的模块，再在 Node 里跑 8 个端到端测试（管线产出资源、运行时消费）；原生 MinGW 下两个 doctest 可执行文件（运行时 4 个、管线 6 个用例）全部通过。浏览器测试页（`Tests/Browser/serve.mjs`，带 COOP/COEP）在 Chromium 里 6 项全部通过：11 个工作线程，100 个箱子每步 0.17 ms，8 份 2 万顶点的 meshopt 并行解码，256×256 KTX2 的 9 级 mip 并行转码，分块并行建导航网格加 16 个代理的群体移动，256 个角色并行采样动画。
  - CLion 里打开 `jolt-native-fork`，CMake 根目录现在是 `StrideNative/`，两个配置：`Debug`（MinGW，跑 `StrideNativeRuntimeTests`/`StrideNativeToolsTests`，可下断点）和 `WASM-Release`（emsdk 工具链），构建目录都在被忽略的 `StrideNative/Build/` 下。
- **升级**：跟随 Jolt 的发布按计划进行：`git fetch upstream --tags`，把 `stride` 分支 rebase 到新标签上（补丁自然重新应用）、跑原生和 wasm 两套测试，再跑游戏的回归截图。

只有 Jolt 这样持续同步上游。Recast、Basis、meshopt 等是复制一次后由我们维护，或者自己写（2026-11-17 用户决定），见 [own-stack.md](own-stack.md) 的"依赖策略"。它们和 Jolt 一样编进同一个模块、走同一套 C API；2026-11-17 已全部导入 `StrideNative/ThirdParty/`。

## 编辑器和资源管线：自己做，Node.js 加 Web（2026-11-17 用户决定）

不依赖 Stride Game Studio。编辑器和资源管线都是我们自己的：
- **编辑器前端在浏览器里**，视口用的就是游戏运行时的同一套引擎和渲染器，所见即所得，编辑器里看到的就是游戏里的画面。场景树、属性面板、资源浏览器都是 Web UI。以后可以用 Electron 或 Tauri 打包成桌面应用。
- **Node.js 后端**：
  - 管理工程文件。工程用文本格式（JSON 或 YAML），方便 diff 和合并。
  - 运行资源管线。
  - 提供开发服务器：Vite，负责脚本热重载。
  - 编辑器里点"播放"，就在同一个页面里运行游戏。
- **资源管线在 Node 端**，输入是通用格式，输出是运行时的二进制：
  - 模型：glTF（cgltf）和 FBX（ufbx）直接导入，不经过 Assimp 或 FBX2glTF。
  - 纹理：编码成 KTX2 加 Basis（Basis 的编码器）。
  - 网格：meshoptimizer 做优化和简化，碰撞用的凸包分解用 VHACD。
  - 字体：msdfgen 生成 MSDF 图集。
  - 导航网格：离线可以预烘焙。
  - 音频：用 ffmpeg 转成 Opus。
- **工具用的原生库进同一个 C++ 工程**：Basis 编码器、meshoptimizer 的简化和编码、VHACD、msdfgen 这些只在编辑和构建时用。它们编成第二个 wasm 模块 `stride-tools`，给 Node 用，和运行时模块 `stride-native` 在同一个 CMake 工程里，共享核心代码和导航网格构建。
- **着色器系统**：用 WGSL 写，自己做模块组合、条件编译和排列组合，思路参考 Stride 的 SDSL（mixin 加组合）。排列组合在 Node 端预编译，并做绑定的反射。起点是把 C# 移植版编出来的 Stride 效果（WGSL）作为参考移植进来，所以画面能和 Stride 对齐；之后就在我们自己的系统里维护。
- **Stride 工程导入器**（迁移工具，不是主要的创作路径）：读取 Stride 工程的 YAML 资源（场景、预制体、材质、组件参数），源素材（FBX、PNG、WAV）交给我们的管线重新导入。用于把 Stride 的样例和游戏的内容搬过来。

## 内容：为这个运行时量身定制的格式

渲染器是我们自己的，内容就不必绕道 glTF 运行。资源管线直接写运行时要的二进制：
- **网格**：顶点和索引按 GPU 布局排好，加载后直接上传；碰撞形状的数据放在同一个文件里，进 wasm 一次，Jolt 和 Recast 共用。
- **材质**：效果名、排列组合键、按 WGSL 反射布局排好的参数块和纹理引用。
- **纹理**：KTX2 加 Basis。
- **场景**：实体、组件和参数；物理部分直接是 `world_create` 能读的布局。
- **动画**：压缩曲线格式（参考 Stride 的），在 stride-native 里求值。

这正是"一个东西不处理多次"：导入时一次转换到位，运行时只做上传和拷贝。

## 对齐的验证方法

- **截图比对**：同一场景、同一相机位置，用桌面 Stride、C# 移植版和这里各截一张，算差异图。
- **复用 Stride 的图形测试**：`Stride.Graphics.Tests` 的场景和 gold 图可以作为渲染器的回归测试，从最基本的开始（几何体、精灵、字体）。
- **样例清单**：沿用 C# 移植版验证过的那批（SpriteFonts、AnimatedModel、GameMenu、MaterialShader、Third Person Platformer……），C# 版可以当参考实现。

## 里程碑

1. **静态场景**：用 Stride 工程导入器和资源管线，把 Third Person Platformer 的场景搬过来并渲染出来。包括前向渲染器、PBR 材质（复用 Stride 的 WGSL）、方向光和阴影、天空盒、相机，以及共享内存的变换数组。截图和桌面 Stride 比对。
2. **可以玩**：Jolt 世界从场景建立，角色控制器，输入，脚本系统和热重载，角色控制脚本从 C# 翻译过来。
3. **动起来**：骨骼动画（stride-native 求值，GPU 蒙皮）、动画混合。
4. **编辑器的最小可用版本**：工程浏览、场景树、属性面板、视口（同一个渲染器）、资源导入、播放和热重载。
5. **界面和声音**：字体（MSDF）、UI 系统、音频。
6. **效果**：粒子、后处理。
7. **铺开**：按样例清单逐个对齐，每个都有截图比对。

## 风险

- **工作量**：这是长期工程，要守住范围，按里程碑推进，每个里程碑都要有可量化的验证。
- **编辑器是另一个大工程**：场景编辑、属性面板、资源浏览、撤销重做、预制体，这些要和引擎并行建设；按里程碑先做最小可用的版本。
- **着色器系统要自己做**：从移植 Stride 的 WGSL 起步，组合和排列组合系统要自己设计。
- **只支持 WebGPU**：不做 WebGL 兜底。
- **TS 和 C++ 之间的边界**：每加一个热循环都要判断该放哪边；原则是只把"每帧对每个对象都做"的循环放进 C++。
