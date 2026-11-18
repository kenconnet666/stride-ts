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
stride-native（C++，核心 wasm 模块加按需加载的侧模块和第三方插件）：变换数组、层级传播、剔除、动画求值、Jolt、Recast、解码
浏览器：WebGPU、Web Audio、Gamepad、Worker
```

分工原则：**TS 负责组织和决策**（哪些东西要画、按什么顺序、用什么效果），**C++ 负责每帧对每个对象都要做的循环**（层级传播、剔除、动画、物理）。

## 共享内存的数据模型

- **变换数组放在 stride-native 的线性内存里**，按结构数组布局：本地位置、旋转、缩放、父节点下标、世界矩阵。每个实体用一个稳定的下标（句柄）指向自己的那一格。
- **Jolt 直接写这些数组**：动态物体步进后，位姿写进对应实体的本地变换；运动学物体反过来从数组读。不再有"从 Jolt 读出来、再写进场景"的步骤。
- **TS 看到的是视图**：`transform.position` 是一个对象形式的访问器，背后读写的就是 wasm 内存里的那一格，不另存一份。
- **上传 GPU 不经过中间拷贝**：`queue.writeBuffer(instanceBuffer, 0, wasmMemory.buffer, worldMatrixPtr, byteLength)` 直接从 wasm 内存上传整段世界矩阵。
- **内存增长和视图**：stride-native 是多线程模块，内存是 SharedArrayBuffer。共享内存增长时旧的 buffer 不会失效，只是长度不变，所以在增长前建的视图（变换存储、物理位置缓冲的列）一直有效；之后新分配的内存要从当前的 `memory.buffer` 建视图，绑定层每次都现取。（原先以为要关掉增长，那是非共享内存的行为。）

**实现（2026-11-18）**：
- stride-native 的变换存储 `sn_transforms_*`：本地位置、旋转、缩放、父槽位、列主序世界矩阵各一列，槽位从 1 开始（0 表示空，父槽位为 0 就是根），列在创建时一次分配好。分配、释放成批进行；释放时检查子节点，挂接时检查环。层级变了才按深度计数排序重排计算顺序，平时一遍顺序扫描，世界矩阵用 Jolt 的 `Mat44`（SIMD）。Chrome 里 1 万个变换（每 10 个一条 9 层的链）每次更新 0.106 ms。
- 物理世界创建时可以绑定变换存储，`sn_box` 带一个变换槽位：物体从槽位当前的世界位姿出发，动态物体每步结束把位姿写回槽位的本地位置和旋转，有父节点时换算到父节点空间。运动学物体从数组读位姿还没做（现在只有静态和动态）。
- 引擎里是数据组件 `Transform`（`packages/engine/src/engine/transform.ts`）：表里只存一列槽位，值按槽位存在原生列里。组件类型多了一个 `external` 存取方式（以后刚体也用它），写入、默认值、校验、视图都复用普通数据组件的代码：`schema.writeRow` 直接以槽位为行号写进原生列。系统里写 `transform.position[transform.slot[i] * 3 + 1]`；视图另有 `world`、`parent`、`children`。销毁实体时子实体跟着销毁（同 Stride 把实体移出场景）；只去掉 `Transform` 时如果还有子实体就报错。
- `Game` 在加载原生模块后创建变换存储（`maxTransforms`，默认 65536 个槽位），每帧在 `update` 之后、`draw` 之前调用一次 `transforms.update()`，所以 `update` 里读到的世界矩阵是上一帧的。和 Stride 不同，实体不会自动带 `Transform`：只有数据的实体（粒子之类）用不着。

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

**骨架（2026-11-18 已实现，`packages/engine/src/rendering`）**：
- `RenderSystem`（特性、视图、光照占位）、`RenderView`、`RenderStage`、`RootRenderFeature`，阶段照 Stride：合成器先 Collect（相机变成视图），然后各特性 Extract（从实体按列取这一帧要画的东西，只在 CPU 上）、Prepare（上传）、按视图和阶段 Draw。和 Stride 不同：没有通用的 RenderObject / RenderNode 列表，特性直接用系统按列遍历实体（`entities.run(system, time)`，不加入每帧的阶段）；还没有剔除、排列组合和效果系统。
- `MeshRenderFeature`：按（网格，材质）分批，每批一次实例化绘制。世界矩阵不进实例缓冲：每帧把变换存储的世界矩阵列整段上传（直接从 wasm 共享内存，只传到 `slotLimit`），实例缓冲里只有每个实体的变换槽位（4 字节），着色器取 `worlds[slots[instance_index]]`，批次用 `firstInstance` 起步。上传每帧各写一次、都在提交之前，pass 内只在网格或材质变化时重设状态。
- `ForwardRenderer`（图形合成器，`game.graphicsCompositor`）：第一个带 `Camera` 和 `Transform` 的实体当主相机，一个不透明阶段，深度 `depth24plus`，画进后备缓冲的 sRGB 视图（着色器输出线性颜色，和 Stride 默认的线性颜色空间一致）。没有相机时只清屏。`Game.draw` 默认交给它，帧顺序是 update → 变换更新 → draw。
- `Camera`（Stride 的默认值：竖直视角 45°、近 0.1、远 1000，看向本地 -Z）、`Model`（`mesh`、`material` 存 `Mesh.id`、`Material.id`，内容管线做好后换成资源引用）；`Mesh.cube`、`Mesh.plane` 对应 Stride 的程序化模型；`Material` 暂时只有基础色；光照暂时是 `renderSystem.lighting` 里的一个方向光加环境光，着色是 Lambert。`Matrix`（`mathematics/Matrix.ts`）在 Float32Array 上做乘法、求逆、`perspectiveFovRH`，布局和 Stride 的 Matrix 一样。
- 沙盒里 100 个由 Jolt 驱动的箱子加地面：101 个实例、6 次绘制，CPU 上整个 draw（找相机、提取、上传、编码、提交）0.13 ms，165 fps。
- **剔除（2026-11-18）**：特性在 Cull 阶段把这一帧所有批次的槽位连着写进 stride-native 的剔除工作区（`FrustumCuller`，原生内存上的常驻视图），一次 `sn_transforms_cull` 剔除一组视图：每批用网格的包围盒，按槽位的世界矩阵变换（同 Stride 的 BoundingBoxExt.Transform），和视图的平面比较（同 VisibilityGroup），每批可见的槽位紧凑写出，实例缓冲直接从 wasm 内存上传。主视图顺带量出可见物体到近平面的最近、最远距离（Stride 的 MinimumDistance、MaximumDistance）。一帧剔除两次：主视图，然后按它的距离范围算出的阴影级联（忽略近、远平面）。
- **方向光阴影（2026-11-18，`rendering/shadows`）**：照 Stride 的 LightDirectionalShadowMapRenderer 和 ShadowMapReceiverDirectional。`Light` 组件的 shadow 开头的列是设置（大小、过滤、级联数、深度偏移、法线偏移、稳定化、对数划分、深度范围、级联混合，默认值同 Stride），导入器从 Stride 的 YAML 读出来。级联按可见范围（带 1.1 / 2 倍的滞后）对数划分，外接球定大小、投影对齐到整像素；4096² 的 depth32float 图集，每个级联一块（xlarge 是 2048），投射阶段只写深度、不剔背面、不做深度裁剪（`depth-clip-control`）。着色器按视图深度选级联，法线偏移、深度偏移后比较采样（一次或 3/5/7 的 PCF，核同 Stride），相邻级联在交界处混合，阴影乘在直射光上。`Model.isShadowCaster` 控制投不投（批次按它分）。TPP 的主视图加 4 个级联一帧 134 次绘制，CPU 上整个 draw 0.41 ms，164 fps。
- **后处理（2026-11-18，`rendering/postfx`）**：照 Stride 的 PostProcessingEffects（`ForwardRenderer.postEffects`），默认值和顺序同它的 DrawCore：FXAA（3.11 PC Quality，预设 23，在 HDR 上做，前后各一次 Karis 范围压缩/解压，因为 Stride 的 Bloom 默认 StableConvolution）→ 量平均亮度 → 亮部提取（BrightFilter）→ 泛光（多级 Expanded 缩小、可分离高斯、Additive 叠加，实际权重是 amount²）、光芒（LightStreak，4 个方向 × 5 轮）、镜头光晕（LensFlare，8 个鬼影加光环）依次叠加 → 色调映射（ToneMap 拆成 measure 和 draw，平均亮度在叠加之前量）。公共部分（ImageEffect.ts）：每帧复用的临时渲染目标池、一帧的 uniform 各占一段（避开 writeBuffer 的生效时机）、全屏通道按资源缓存绑定组和视图。**后处理的开销**（2026-11-18，`GpuProfiler` 的时间戳，RTX 3050 笔记本，TPP 1400x900）：全分辨率的通道最贵，1/4 的小图上的通道主要是固定开销（光芒每个方向每轮约 0.027 ms）。在结果不变的前提下改了三处（和改之前的实现逐像素比对，各种光芒参数下最大差 1/255）：光芒和镜头光晕共用缩到 1/2 的亮部图；泛光、光芒、镜头光晕不再各自叠加，一次加回画面；光芒一个通道同时算 4 个方向（4 个渲染目标，最后一轮直接求和写进累加缓冲），30 个通道变 9 个。三个效果加亮部提取从 4.1 ms 变成 2.7 ms（光芒 1.41 → 0.68，镜头光晕 1.67 → 0.62，泛光 0.83 → 0.34，合成 0.70）；FXAA 1.07 ms、色调映射 0.30 ms 没动。整帧通道的 GPU 时间：不透明 3.0 ms、阴影图 1.1 ms、后处理 4.0 ms。**4K 原生分辨率**（2026-11-18，用户的 4K 屏，dpr 2，画布 3840x1810，同一台 RTX 3050 笔记本；**下面这段的数字都是在笔记本的静谧模式下测的**，GPU 被压了功耗，换成均衡模式后同一个画面是 110 fps、每帧 9.1 ms、各通道 GPU 合计 6.9 ms，关掉后处理 165 fps，阴影图 0.75 ms。测性能前先确认电源模式）：起初 27.5 fps（每帧 36.4 ms），关掉后处理是 63.8 fps，后处理占了一半以上。不降渲染分辨率（用户定的：封顶分辨率是限制，不是优化），又省了两个全分辨率的通道：叠加不再单独画，在色调映射里加上，泛光的 Expanded 放大先在 1/4 小图上做 9 点卷积（`AdditiveLayers.ts`，3.5 ms 变成 1.4 ms）；FXAA 输出时当场范围解压（省 1.3 ms）。合计 27.5 → 30 fps（36.4 → 33.4 ms）。试过把范围压缩也并进 FXAA（每个采样点现算、手动插值），FXAA 从 2.6 ms 涨到 9.6 ms，放弃。剩下的大头：不透明 7.3 ms（按像素算）、阴影图 4.2 ms（xlarge、4 级联，只有约 50 万三角形、234 次绘制，和分辨率无关；均衡模式下只有 0.75 ms，静谧模式下的高耗时是降频造成的）、亮部提取和三个效果约 11 ms（分辨率是 Stride 定的比例）。残影（Afterimage）、Stride 默认关的效果（环境光遮蔽、景深、局部反射、雾、轮廓）还没做。
- **调试 CLI（2026-11-19，`packages/cli`、`engine/src/debug`、fork 的 `Debug.h`）**：给 agent 和开发者用的 `stride` 命令。页面里的 `game.debug`（命令、计数器、观察项、事件、console 和异常的转发、帧耗时）连开发服务器上的调试中枢（Vite 插件，同源 WebSocket；CLI 走带令牌的 HTTP，拒绝带 Origin 的请求），开发服务器上默认连，部署的页面加 `?debug`。自带的命令：状态、实体列表和查看、改组件字段和脚本属性、暂停单步和固定步长（`Game.paused`、`step`、`timeScale`、`fixedTimeStep`）、合成输入、截后备缓冲并逐像素比较、性能采样（帧时间分布、按系统的 CPU 时间 `EntityManager.timings`、原生计时、各通道 GPU 时间、渲染特性的 `stats()`）、物理射线、eval；CLI 自己还有 `open`（独立的 Chrome，开着 CDP 端口）、`cpu-profile`、`gpu-calls`、`logs`。原生侧的埋点默认关（关着时只读一个原子量），连上后打开：物理步进、变换更新和剔除、动画采样、导航人群的计时和计数，Jolt 的 Trace 和断言、物理出错进日志，wasm 堆内存。C 函数的 TS 签名从头文件生成（fork 的 `JS/scripts/generate-exports.mjs`），参数个数写错在编译期就报。用法见 packages/cli/README.md。
- **骨骼动画和 GPU 蒙皮（2026-11-19，`engine/src/animation`、fork 的 `ImportApi.cpp`、`AnimationApi.cpp`）**：
  - 导入：ufbx 读出节点（深度优先，根叫 `RootNode`）、蒙皮（绑定时的几何到骨骼矩阵）和烘焙的动画（30 fps 线性关键帧，只取播放范围）；没有蒙皮、挂在骨架节点上的网格做成一个关节的刚性蒙皮。管线按 .sdskel 的节点表建 ozz 骨架（`.skeleton`），按关节名对上动画轨道（`.anim`），模型的网格带上关节下标（uint8x4 或 uint16x4）和权重（unorm8x4），逆绑定矩阵右乘导入变换的逆。
  - 运行时：`ContentManager.loadSkeleton`、`loadAnimation`，`prop.asset('animation')`；`AnimationComponent`（Stride 的 API：`play`、`crossfade`、`blend`、`add`、`ended`、`blendTreeBuilder`，时间用秒）；`AnimationSystem`（`game.animation`，物理之后的系统）把所有带骨架的模型的混合栈写进一个原生的 `AnimationBatch`，ozz 在工作线程上并行采样、混合（同 Stride 的 AnimationBlender：线性、叠加、相减）、求模型空间矩阵，再算蒙皮矩阵（关节矩阵乘逆绑定），结果留在 wasm 内存里。
  - 渲染：蒙皮网格的实体带 `Skinned`（蒙皮矩阵在连起来的缓冲里的起点），`MeshRenderFeature` 给它们单独分批、用 `vsSkinned` 管线，每帧把蒙皮矩阵直接从 wasm 内存上传；顶点乘 4 个蒙皮矩阵的加权和再乘世界矩阵（阴影投射同样）。剔除用整个模型的包围盒放大一半（和 Stride 不同，Stride 每帧按骨骼算包围盒）。
  - TPP 的 mannequin（16 个网格、92 个节点）待机、走跑混合、起跳、空中、落地都对；动画系统每帧 0.12 ms（原生蒙皮 0.06 ms、求值 0.04 ms）。
  - 还没做：挂到骨骼节点（ModelNodeLink）、根运动、动画曲线（非骨骼的属性动画）、每帧按骨骼算的包围盒；原生求值失败时只有错误码，没有原因。
- **合成器、渲染目标贴图、精灵（2026-11-19，AnimatedModel 用到的）**：
  - 合成器的最小数据化：导入器读 GameSettings 引用的 .sdgfxcomp，相机槽位按 Cameras 列表编号（Camera.slot），主画面是槽位 0 的相机下第一个前向渲染器（清屏色、后处理和其中各效果的开关（`ScenePostEffects`，色调映射在颜色变换组里，关掉时直接输出）、透明阶段开关），"相机画进渲染目标贴图"的分支（SceneCameraRenderer 加 RenderTextureSceneRenderer）写进场景的 `compositor.textureCameras`。`ForwardRenderer` 先画各个渲染目标贴图（一样的深度预通道、不透明、透明阶段，画完原样拷进贴图），再画主画面；所有相机的视图一起提取、剔除。
  - 渲染目标贴图（Stride 的 RenderTexture）：`Texture.renderTarget`，没有 CPU 数据，GPU 纹理第一次用到时建，能画也能采样；内容管理按内容路径只建一次。
  - 精灵（Stride 的 SpriteComponent 加 SpriteFromTexture）：`Sprite` 数据组件，`SpriteRenderFeature` 在透明阶段画，矩形照 Stride 在 CPU 上算（`spriteQuad`：billboard 用相机的轴、实体的缩放，center 偏移），每个视图从远到近排，一个精灵一次绘制，混合方式照 Stride 的 SpriteBlend。
  - 点光和聚光（2026-11-19，BepuSample 的 Cube Mixer）：`Light` 的 point（radius）、spot（range、angleInner、angleOuter，度、整个锥的张角），衰减照 Stride 的 LightUtil（距离：1/d² 乘平滑的截断；聚光：saturate(cos θ · scale + offset)²，见 `spotAngleAttenuation`）。每帧最多 MAX_LOCAL_LIGHTS（256）个，放在存储缓冲里，所有视图共用，逐像素遍历。和 Stride 不同（暂时）：不分簇、不投阴影。
  - 相机有透视和正交两种投影（`Camera.projection`、`orthographicSize`，Stride 的 PerspectiveFovRH、OrthoRH），投影矩阵由 `cameraProjectionMatrix` 统一算（前向渲染器和 `screenToWorldRaySegment` 共用）；正交相机的阴影只用一级级联（同 Stride）。
  - 背景支持平面图片（Is2D，铺满视图）；背景、精灵的常量按视图分块，渲染目标贴图的相机也画得到。
  - 和 Stride 不同（暂时）：画进渲染目标贴图的相机不用阴影（级联按主视图算）、不做后处理；一个视图最多 4 个方向光、只有一个投阴影。
- 接下来：Stride 的 WGSL 和效果系统（等着色器系统）、透明材质、点光源和聚光灯（及其阴影）、render bundle 缓存静态批次、非均匀缩放的法线（逆转置）。

C# 移植版踩过的 WebGPU 坑，全部适用，见 [lessons.md](lessons.md)：`writeBuffer` 的生效时机、pass 内的状态去重、scissor 一直有效、调试组会切断 pass、没写的颜色目标要设 writeMask 0。

## TS 端的高性能写法和构建（2026-11-17；2026-11-18 改为不做编译期改写）

TS 加 C++ wasm 做高帧率可行。性能来自代码形态和数据流向，不来自转译工具：Babel 只是编译期改写源码，本身不让代码变快。

| 层面 | 做法 |
|---|---|
| JS 代码形态 | 对象结构固定，让 JIT 生成快速路径；热路径用 TypedArray；引擎路径每帧不分配内存；热循环里不用闭包和多态调用 |
| JS 和 wasm 的边界 | 粗粒度的批量调用；数据放在 wasm 内存里，JS 直接读视图，不拷贝 |
| 每个对象都要跑的循环 | 放进 C++：变换传播、剔除、动画求值、物理，用 SIMD |
| 渲染 | 实例化、整段上传；pass 内状态去重；管线在加载时预热 |
| 帧节奏 | `requestAnimationFrame` 跟随屏幕刷新率；165 Hz 每帧预算约 6 ms，CPU 端目标 2–4 ms |
| 主线程 | 只跑游戏循环；加载和解码放进 Worker；需要时整个引擎可以搬进 Worker（OffscreenCanvas） |

构建：**不做 SWC 插件，也不做任何编译期改写**（用户 2026-11-18 决定，取代 11-17 的 SWC 插件方案）。Vite 8 自带的 Oxc 只做 TS 类型擦除，开发版和正式版跑同一份代码。原先打算交给插件的事改成这样：

| 原计划由插件做 | 现在 |
|---|---|
| 数据组件生成结构数组存储和元数据 | `component()` 在运行时按属性 schema 建列（TypedArray），元数据就是 schema 对象本身 |
| 系统的查询循环改写成按下标遍历 TypedArray | 系统直接拿到按块切好的列，自己写 `for` 循环，列的类型由 schema 推导 |
| 向量运算内联 | 不做。脚本里的向量运算保持方法调用，临时向量预分配或从池里取（见下文）；大量实体的数学在系统里直接写标量 |
| 从 `@property` 生成序列化和编辑器面板的描述 | 属性用 `prop` builder 声明，序列化、校验、编辑器面板都读同一份 schema |
| 正式版删掉断言、日志、统计 | 写在 `if (import.meta.env.DEV)` 里，Vite 正式构建时替换成常量，死分支被删掉 |

不做的理由：
- 插件和 `swc_core` 的版本绑定，Rust 加 wasm 的维护成本高。
- "认不出来就退回运行时实现"意味着同一段代码有两种行为，要跑两套测试；source map 和断点也会变差。
- 类型推导已经够用：easy-query-ts（`C:\code\easy-query-ts`）的结果类型全靠 TS 推导，不做代码生成，运行时的 schema 对象是唯一的事实来源。这里照同样的路子做。

性能验证：同一个系统写成"每个实体一个对象"和"列加 `for` 循环"两种，在 1 千、1 万、10 万个实体下比较帧时间和 GC 次数。

### 实测：数据放在哪里、跨边界的代价（2026-11-18）

问题（用户提出）：组件的数据在 JS 堆里，要交给 wasm、再回到主线程交给 WebGPU，创建和生命周期会不会损失性能；要不要把组件直接建在共享内存里，或者改成调用 wasm 的 API。

先澄清数据流：wasm 是在主线程上同步调用的，工作线程只跑 Jolt 的任务；内存是同一块 `SharedArrayBuffer`。JS 通过 TypedArray 视图直接读写 wasm 内存，`writeBuffer` 也能直接从这个视图上传。**没有线程之间的交换**，代价只有两种：调用的开销、我们自己选择做的拷贝。

基准在 `apps/bench`，用 `tools/bench.cjs` 在本机无头 Chrome 157 里跑（12 核，适配器报告 NVIDIA Ampere），跑了三次，数字稳定在 ±20% 以内。每项是中位数：

| 项目 | 1 万个实体 | 10 万个实体 | 每个实体 |
|---|---|---|---|
| **每帧：移动并上传实例矩阵（每个 64 B）** | | | |
| JS 堆里的 Float32Array，一次 `writeBuffer` | 0.30 ms | 0.30 ms | 3 ns（10 万时） |
| wasm 共享内存的视图，直接 `writeBuffer`（读回 GPU 数据核对过，正确） | 0.26 ms | 0.27–0.39 ms | 3–4 ns |
| JS 对象，每帧打包进 Float32Array | 0.29 ms | 0.70–0.89 ms | 7–9 ns |
| wasm 共享内存先拷进 JS 数组再上传 | 0.28 ms | 0.92–1.1 ms | 9–11 ns |
| 只有 `writeBuffer`（不跑 JS 循环） | 0.25 ms | 0.16 ms | |
| **每个实体单独调一次 `writeBuffer`** | **1.96 ms** | **24.8 ms** | **200–250 ns** |
| **调用开销** | | | |
| JS 方法调用 | | | 0.3–0.5 ns |
| JS 调 wasm（什么都不做的导出函数） | | | 4–6 ns |
| **读物理结果（每帧）** | | | |
| 旧的 `positions()`：分配、拷贝、`slice()`、释放（已改，见结论 5） | 0.11 ms | | 11–13 ns |
| 原生写进一块常驻缓冲，JS 读视图 | 0.05 ms | | 5 ns |
| **创建（6 个属性，默认值加一项覆盖）** | | | |
| 脚本对象，按键名循环合并属性 | 1.4–1.7 ms | 14–15 ms | 130–170 ns |
| 脚本对象，按固定代码逐项赋值 | 0.08 ms | 0.83 ms | 8 ns |
| 写进 Float32Array 的列 | 0.12 ms | 1.2 ms | 10–12 ns |
| 每个实体在 wasm 里单独分配一块（分配、写、释放） | 1.0 ms | 10.5 ms | 105 ns |
| 物理体，旧的包装（每次 `addBox` 都分配临时内存；已改，见结论 5） | 21 ms | | 2.1 µs |
| 物理体，直接调导出函数、参数缓冲复用 | 6.3 ms | | 0.6 µs（Jolt 本身） |
| **每帧更新** | | | |
| 脚本 `update()`，4 个类混在一起（多态调用） | 0.03 ms | 0.30 ms | 3 ns |
| 脚本 `update()`，每次 new 一个临时向量 | 0.03 ms | 0.26 ms | 2.5 ns（V8 的逃逸分析把临时对象消掉了） |
| 系统遍历 JS 堆里的列 | 0.01 ms | 0.10 ms | 1 ns |
| 系统遍历 wasm 共享内存里的列 | 0.01 ms | 0.10 ms | 1 ns |

结论：

1. **数据放在 JS 堆还是 wasm 共享内存，读写速度一样**（每个实体 1 ns），从共享内存直接上传 GPU 也不比 JS 堆慢。所以位置按"谁要用"决定，不按速度决定：
   - wasm 也要读写的每帧数据（变换、物理位姿、动画矩阵、实例数据）**放在 wasm 共享内存里**，按结构数组布局；JS 用视图读写，C++ 用指针，GPU 直接从这里上传，全程不拷贝。
   - 只有 JS 用的数据组件放在 JS 堆的 TypedArray 里，速度相同，还免去原生内存的增长和碎片问题。C++ 的系统要读时，单独把这个组件声明成原生存储。
   - 脚本保持普通的 JS 对象：每帧 `update()` 一万个才 0.03 ms，不是瓶颈。
2. **不要改成"每个实体调一次 wasm"**：一次调用 4–6 ns，是 JS 调用的十倍；设位置这类每帧、每实体的操作一律走视图。wasm 调用只用在按批、按帧的粗粒度操作上。
3. **真正贵的是拷贝和逐个分配，要改**：
   - 上传：每个缓冲每帧一次 `writeBuffer`。逐实体上传 1 万个就要 2 ms。
   - 中转拷贝：不要先从共享内存拷到 JS 数组再上传，10 万个实体时多 0.6 ms。
   - 原生内存：不要每个实体单独分配（105 ns），用大块的槽位池。
4. **创建的开销主要来自写法，不是对象本身**：
   - 按键名循环合并属性比固定代码逐项赋值慢 17 倍（139 对 8 ns），原因是动态键名的读写。
   - 所以每个组件在登记时生成一个初始化函数，用 `new Function` 在运行时生成，和 zod 4 的 `z.compile` 同一做法；页面没有 CSP 限制，失败时退回循环。
   - 同一个预制体的覆盖只合并一次，所有实例共用合并结果。
5. **原生 API 已改（2026-11-18 同日，fork 的提交见 `StrideNative/`）**：
   - 物理世界和人群各有一块常驻的位置缓冲，`step()`、`update()` 在原生里直接写进去；`positions()` 返回同一个视图，每帧不再分配和拷贝。读 1 万个物体的 y 坐标从 0.11 ms 降到 0.008 ms（每个 0.8 ns）。之后（同日）绑定了变换槽位的物体由步进直接写回变换存储，见上文"共享内存的数据模型"。
   - C API 换成批量添加 `sn_physics_add_boxes`（一块 `sn_box` 表，C++ 里用 Jolt 的 `AddBodiesPrepare`/`AddBodiesFinalize`，相同尺寸的连续箱子共用一个形状），删除逐个添加和拷出位置的旧接口。JS 的 `addBox({ position, halfExtent, motion })` 复用一块参数缓冲，`addBoxes([...])` 一次调用。
   - 实测（建世界、加 1 万个物体、销毁）：旧包装 21 ms（2.1 µs 每个），逐个 `addBox` 6.8 ms（0.68 µs），一次 `addBoxes` 4.0 ms（0.40 µs）。
6. **按帧预算看**（165 Hz 每帧约 6 ms）：1 万个实体的移动、上传、脚本、系统合计不到 0.5 ms。生成高峰原来一次 1 万个物理体要 21 ms、会卡一帧，现在批量 4 ms，更大的批量可以分到几帧里做。改完后在 Chrome 里跑沙盒：99% 的帧间隔是 6.06 ms，物理步进中位 0.27 ms、最长约 4 ms（工作线程调度的抖动）。

没测到的：Jolt 步进在大场景下的耗时（StrideNative 的测试里 100 个箱子每步 0.17–0.27 ms）、GPU 端的耗时。GC 和渲染提交见下一节。

### 实测：渲染提交和 GC（2026-11-18）

**渲染提交**（`apps/bench` 的 `?only=render`）：主线程上编码并提交一帧 n 个立方体的 CPU 时间。GPU 的活很少，所以测到的是提交开销；Chrome 把命令序列化后交给 GPU 进程并行执行，GPU 进程那一侧的耗时不在其中。

| 写法 | 1 千个 | 1 万个 | 每个 |
|---|---|---|---|
| 逐个 draw，管线只设一次，每个 draw 用动态偏移换 bind group | 0.32 ms | 3.7 ms | 0.32–0.37 µs |
| 逐个 draw，每次都重设管线和 bind group | 0.40 ms | 4.1 ms | 0.39–0.41 µs |
| 录进 render bundle，每帧重放 | 0.18 ms | 1.4 ms | 0.14–0.19 µs |
| 一次实例化 draw（矩阵在 storage buffer 里） | 0.06 ms | 0.33 ms | 0.03–0.06 µs |

**GC**（`apps/bench/gc.html`，`tools/gc-trace.cjs` 开着 Chrome 的 tracing 跑，停顿时长取自 V8 自己记录的 `MinorGC`、`MajorGC` 事件；帧节奏 165 Hz，每帧本身的工作很少）：

| 场景 | 分配速度 | 主线程 GC 占时 | 最长一次停顿 | 超过 20 ms 的帧 |
|---|---|---|---|---|
| 不分配（10 万个实体的列更新） | 0 | 约 0 | 0.6 ms | 0 |
| 每帧 1 千个临时对象（当帧就死） | 7 MB/s | 0.13% | 0.6 ms | 0 |
| 每帧 1 万个临时对象 | 66 MB/s | 0.5% | 0.7 ms | 0 |
| 每帧 10 万个临时对象 | 660 MB/s | 3–3.4% | 3.8–8 ms | 0 |
| 常驻 100 万个对象，不再分配 | 0 | 0 | 0 | 0 |
| 常驻 100 万个 + 每帧 1 万个临时对象 | 66 MB/s | 0.08% | 0.7 ms | 0 |
| **每帧 1 千个、每个活约 2 秒** | 7 MB/s | 0.23% | **10.4 ms** | 0 |
| **每帧 5 千个、每个活约 2 秒，常驻 100 万个** | 32 MB/s | **4.9%** | **39.9 ms** | **20 帧 / 15 秒** |

结论：

1. **当帧就死的临时对象很便宜**：每帧 1 万个，GC 只占 0.5%，单次停顿不到 1 ms。V8 的新生代回收只处理活着的对象，死掉的不花时间。
2. **常驻的大堆本身不花时间**：100 万个对象一直活着，没有新分配就没有回收；老生代回收是并发标记，主线程上的收尾只有 3–5 ms。
3. **真正的问题是"活几秒的对象"**：子弹、特效、粒子、排队的事件，如果每帧新建、几秒后才丢，它们会在新生代回收时被一次次复制、再晋升到老生代。每帧 5 千个这样的对象，单次停顿就到 40 ms，平均一秒多卡一帧。规则：
   - 这类东西一律用对象池或数据组件的列（结构数组），不每帧 new。
   - 脚本里的临时向量照常用就行，它们当帧就死；但不要把它们存进数组、事件里留到以后。
   - 事件对象用池（见"事件"一节），处理函数不能保存事件对象，开发版会检查。
4. 实际游戏里一帧的工作会占掉大部分预算，所以剩下的空隙装不下的停顿就会表现为掉帧：165 Hz 时空隙可能只有 1–2 ms，60 Hz 时有几毫秒。

### 复杂场景的帧预算估算（2026-11-18，渲染器还没写，按上面的实测数字推算）

假设一个比 Third Person Platformer 更重的场景：剔除后 3 千个可见物体，按"网格加材质"合批后 800 个 draw，阴影两级级联再加约 800 个 draw；2 万个实例化的草和小物件；1 千个活动的物理体；50 个蒙皮角色；500 个脚本；1 万个实体的系统逻辑。主线程每帧：

| 部分 | 估算 | 依据 |
|---|---|---|
| 提交 1600 个 draw | 0.6 ms（静态部分用 render bundle 约 0.3 ms） | 每个 draw 0.35 µs，实测 |
| 2 万个实例的数据（会动的部分才上传） | 0.1–0.6 ms | 每个实例 0.03 µs，实测 |
| 1 万个实体的变换整段上传 | 0.3 ms | 实测 |
| 系统逻辑（1 万个实体） | 0.01–0.1 ms | 实测 |
| 脚本 | 0.5–1 ms | 调用本身可以忽略（500 个 0.002 ms），时间花在脚本做的事上（射线检测、寻路请求），估计 |
| 物理步进（1 千个物体，11 个工作线程） | 1–2 ms | 估计：100 个箱子实测 0.2–0.3 ms，按 Jolt 的伸缩性推算，要实测 |
| 动画采样和蒙皮矩阵（50 个角色，并行） | 0.2–0.5 ms | 估计，要实测 |
| 剔除和变换传播（stride-native，SIMD） | 0.2–0.5 ms | 估计 |
| GC（按上面的规则写） | 低于 1% | 实测 |
| **合计** | **约 3–5 ms** | |

- **按本机的 CPU 算，能到 165 fps**（每帧约 6 ms）。CPU 慢 3 倍的笔记本约 9–15 ms，仍在 60 fps 的 16.7 ms 以内，但余量不大。对比：C# 移植版的 FPS 枪战样例在本机 AOT 下要 10–13 ms 一帧。
- **最终帧率还取决于 GPU**：PBR、阴影、分辨率、后处理，这部分和 C# 版、桌面 Stride 用同一套着色器，GPU 时间应该接近桌面 Stride 在同一块显卡上的表现，要等渲染器写出来后实测。
- **会让帧率崩掉的写法**（都已在上面测过）：
  - 不合批的 draw 到 1 万个：仅提交就要 3.7 ms；
  - 每帧大量"活几秒"的对象：40 ms 的停顿；
  - 每个实体单独 `writeBuffer`：1 万个要 2 ms；
  - 每个实体每帧调一次 wasm。
- **要尽早实测的**：Jolt 在 1 千到 1 万个物体时的步进时间、动画的批量采样、GPU 进程在几千个 draw 时会不会成为瓶颈。等渲染器的里程碑 1 有了真实场景，用 `stride perf` 和 `stride cpu-profile` 测。

## 组件 API：脚本、数据组件、系统（2026-11-18 设计草案，取代 11-17 的装饰器加插件方案）

**实现状态（2026-11-18，`packages/engine/src/data` 和 `src/engine`）**：

- **已实现**：
  - `prop` builder（`number`、`f32`、`int`、`u8`、`u32`、`bool`、`string`、`enum`、`entity`；`default`、`optional`、`transient`、`min`、`max`、`step`、`unit`、`label`、`group`、`description`、`hidden`、`renamedFrom`、`brand`）和字面量简写；
  - 登记时生成的初始化函数（不支持代码生成的环境退回循环）；
  - `component()`、`tag()`，按 archetype 分表的列存储；
  - 实体对象和按 id 批量生成（`spawn` 返回批次，可按列写入每个实体的值）；
  - 视图（`entity.get`、`require`）；
  - `system()`，支持 `with`、`without`、`writes`、`changed`、`phase`、`after`，以及命令缓冲；
  - `StartupScript`、`SyncScript`、`AsyncScript`（`props`、`with`、`signal`、`disposables`、`nextFrame`、`delay`、`cancel`）；
  - 按"路径#导出名"登记（`Registry`）；
  - （2026-11-18 补全）属性类型 `vec3`、`quat`、`color`（数学类型在 `mathematics/vectors.ts`；数据组件里按行交错存 3 或 4 个 float，视图返回直接读写列的 x/y/z 对象），以及只给脚本用的 `list`、`object`、`union`、`json`（接 Standard Schema）、`component`（引用别的脚本或数据组件）；
  - 修饰 `sealed`、`inherit`（加 `game.defaults` 作用域默认值）、`stat`（`script.stats`，可限时、可用 `using` 自动撤销）；组件和脚本的变体（`variants`、`.variant(name, init)`）；
  - `validator(Type)` 产出 Standard Schema 校验器；
  - `EventKey`（广播，每个接收者一个队列）和 `Hook`（同步、使用方先执行、可 `preventDefault`，事件对象复用并在派发后失效）；脚本的 `this.on`、`this.receive` 随脚本释放；
  - 系统的 `added`、`removed`：按实体回调（不是按块），`removed` 时还能读到数据，回调里的结构性改动走命令缓冲；
  - （2026-11-18）`Transform`：数据在 stride-native 的变换存储里，表里只存槽位；父子层级、销毁时连带子实体、和物理世界绑定，见上文"共享内存的数据模型"；
  - （2026-11-18）热重载：`Game.hotEntry`、`game.hotUpdate`，组件、脚本、系统、游戏类都能在运行中换成新版本，见"热重载"；
  - 运行时测试 68 个（含管线的导入测试），类型测试 `test/types.check.ts`，类型压力测试 `test/stress.check.ts`（由 `tools/gen-type-stress.mjs` 生成）。
- **和下文设计的出入**：
  - 一个 archetype 目前是一块可增长的表（容量翻倍），还没有切成固定大小的块。
  - 默认值的检查在定义时做（越早越好），报错带字段名。
  - 布尔字段在列里是 `Uint8Array`（0 和 1），视图和脚本里是 `boolean`。
  - 数据组件的字段不能是 `optional`：列里没有"缺失"这个值。
  - `nextFrame()` 之后的代码在当前帧结束后、下一帧开始前运行：Promise 的后续代码没法插进同步的一帧中间。这一点和 Stride 不同，Stride 是在下一帧的脚本阶段继续。
  - 脚本引用自己或互相引用时，`props()` 里写 `prop.component(() => ScriptComponent)`，再在类体里用 `declare target: Other` 收窄：继承表达式里出现自己的类名，TS 会报循环引用（TS2506），和 easy-query-ts 把关系与实体分开定义是同一个原因。
  - `stat` 只给脚本用；数据组件的数值在系统里改。
- **还没做**（依赖后面的里程碑）：
  - 资源引用 `asset`：要等内容管线；
  - 预制体、部件（`prop.parts`）、按子树生效的默认值：实体层级已经有了（`Transform` 的父子），预制体还要等内容管线；

### bigint、小数、日期时间（2026-11-18 用户要求，已实现）

要求：原生支持 bigint、decimal、日期这类 JSON 装不下的值，像 json-wire（`C:\Users\Administrator\IdeaProjects\json-wire`）给 JSON 加的支持那样，而且要方便和 wasm 那边互相操作。用户定的做法：不依赖 json-wire，自己实现一套适合引擎的。

| 属性 | 脚本、视图里的值 | 数据组件的列 | C 侧（`StrideNative/Values.h`） | 线上（json-wire 的种类） |
|---|---|---|---|---|
| `prop.i64()`、`prop.u64()` | `bigint` | `BigInt64Array`、`BigUint64Array` | `int64_t`、`uint64_t` | bigint |
| `prop.decimal(scale, precision = 18)` | `Decimal` | `BigInt64Array`（单位数） | `sn_decimal64` | decimal：`"12.50"` |
| `prop.date()` | `LocalDate` | `Int32Array`（1970-01-01 起的天数） | `sn_date` | date：`"2024-01-31"` |
| `prop.time()` | `LocalTime` | `BigInt64Array`（零点起的纳秒） | `sn_time` | time：`"13:45:00"` |
| `prop.datetime()` | `LocalDateTime` | `BigInt64Array`（纳秒，钟面时间） | `sn_datetime` | timestamp：`"2024-01-31T13:45:00.5"` |
| `prop.instant()` | `Instant`（和 `Date` 互转） | `BigInt64Array`（Unix 纪元起的纳秒） | `sn_instant` | timestamptz：`"2024-01-31T05:45:00Z"` |
| `prop.bytes()`（只给脚本） | `Uint8Array` | 无 | 无 | bytes：base64 |

- **二进制布局参照 Apache Arrow**（decimal64、date32、time64[ns]、timestamp[ns]）：这是为跨语言零拷贝设计的成熟布局。数据组件的列可以直接放进 wasm 内存，C++ 按 `Values.h` 的类型读写，JS 用 `native.i64()`、`native.i32()` 视图看同一块内存，中间不换算、不拷贝。Emscripten 默认用 BigInt 传 i64 参数（`WASM_BIGINT` 一直开着）。
- **两边的算法相同、用同一组对照值测试**：日期用 Howard Hinnant 的 days_from_civil；小数换算位数用银行家舍入。对照值由 JS 的 `Date` 独立算出，`values.test.ts` 和 fork 的 `RuntimeTests.cpp` 都拿它核对。
- **小数是定点数**：位数是属性声明的一部分，不跟着值存；最多 18 位有效数字（放得进 int64）。传入的值小数位比声明多、或有效数字超出时报错，不悄悄舍入。运算（加减乘除、换算位数）在 `Decimal` 上精确进行，除法和缩位按指定方式舍入。
- **值类型自带、零依赖**：`Decimal`、`LocalDate`、`LocalTime`、`LocalDateTime`、`Instant` 在 `packages/engine/src/values/`，不可变，命名同 java.time（json-wire 的 Java 一侧也是这些名字）。不用 decimal.js 和 `@internationalized/date`。
- **线上格式和 json-wire 一致**：`values/wire.ts` 的 `toWire`、`fromWire`、`stringifyWire`、`parseWireJson`、`wireText`、`parseWire`，路径、转义、`$value` 包装、同一路径一种值的规则都相同，所以能和用 json-wire 的 Java、TS 后端直接互通。用 json-wire 仓库的 `spec/order.json` 做对照测试：读进来、再写回去，结果完全相同。
- **只给系统看原始值**：系统拿到的是 int64 / int32 列（快，和 wasm 一致）；脚本和视图读字段时才换算成值对象。

**实测（沙盒，本机 Chrome）**：
- 负载：1.2 万个粒子实体，`Fountain` 脚本每 0.5 秒生成 2000 个，`expire` 系统用命令缓冲销毁到期的。
- 每帧耗时：脚本加系统中位 0.14 ms，p99 0.3 ms；生成那一帧最长约 3 ms。
- 同样的生成加销毁（2000 个）在 Node 里约 0.4 ms。
- GC：6 秒内 7 次新生代回收，最长 0.69 ms；1 次老生代回收，1.2 ms。
- 类型压力测试：300 个组件、150 个系统、150 个脚本，tsc 检查时间多 0.36 s，实例化 15.5 万次，没有 TS2589。

原则（参考 easy-query-ts 的实体定义，见 `C:\code\easy-query-ts\packages\core\src\schema.ts`）：
- **一份声明，多处使用**：属性用 `prop` builder 声明，TS 类型、默认值、场景文件的编解码、加载时的校验、编辑器面板都从它来。类型靠推导，不靠代码生成、装饰器或反射；唯一的例外是编辑器做的资源（预制体、场景、模型、材质），由工具生成类型，见"资源的强类型"。
- **尽量强类型**（用户 2026-11-18）：代码引用组件、预制体、部件、材质槽、钩子、事件时，名字和值写错都要是类型错误；可以用类型提取工具简化写法，但不退回 `string`、`any` 这类宽松类型。
- **引擎核心零依赖**：和校验库只通过 [Standard Schema](https://standardschema.dev)（`~standard.validate`）对接。zod、valibot 的 schema 能接进来，我们的 schema 也能导出给它们的生态用。
- **DSL 只在定义时跑**：builder、schema、查询只在模块加载和场景加载时求值；每帧的路径上没有代理、闭包和临时对象。
- **源码只用可擦除的语法**（`erasableSyntaxOnly`）：不用 enum、namespace、参数属性、装饰器；枚举一律写成字符串字面量联合。

| 写法 | 用途 | 数据存在哪里 |
|---|---|---|
| 脚本（`SyncScript`、`AsyncScript`、`StartupScript`） | 游戏玩法：角色控制、关卡流程、UI 逻辑，数量少，写起来要顺手 | 普通对象 |
| 数据组件（`component()`） | 大量实体共有的数据：血量、速度、AI 状态 | 按块存放的列：数值是 TypedArray，其余是普通数组 |
| 系统（`system()`） | 每帧对大量实体做的事：回血、移动、冷却计时 | 直接遍历块里的列 |

### 属性：`prop`

```ts
prop.number()  prop.f32()  prop.int()  prop.u8()  prop.bool()  prop.string()
prop.enum(['idle', 'run', 'jump'])     // 'idle' | 'run' | 'jump'
prop.vec3()  prop.quat()  prop.color()
prop.asset(Model)                      // AssetRef<Model>: the scene file stores the asset id
prop.entity()                          // EntityId
prop.component(() => CameraComponent)  // resolved after the scene is built; the thunk breaks import cycles
prop.list(prop.vec3())
prop.object({ min: prop.vec3(), max: prop.vec3() })
prop.union('kind', { box: { size: prop.vec3() }, sphere: { radius: prop.f32() } })  // discriminated union
prop.json(schema)                      // any Standard Schema (zod, valibot): checked on load and on edit
```

修饰方法都返回新对象，并把状态记在类型参数里（幻影类型参数，同 easy-query-ts 的 `Column<T, N, O, P>`）：

| 方法 | 作用 |
|---|---|
| `.default(v)` | 默认值；有默认值的属性在场景文件里可省 |
| `.optional()` | 值可以是 `undefined` |
| `.transient()` | 运行时状态：不存盘，不进编辑器面板 |
| `.min()`、`.max()`、`.step()`、`.unit()` | 只能用在数值属性上（用 `this` 参数限定），加载和编辑时校验，编辑器拿来做滑块 |
| `.label()`、`.group()`、`.description()`、`.hidden()` | 编辑器面板 |
| `.renamedFrom('oldName')` | 改名以后，旧的场景文件和热重载照样能读 |
| `.brand<'PlayerId'>()` | 只改类型，让不同用途的整数不能混用 |
| `.sealed()`、`.inherit()`、`.stat()`，`.default(fn)` | 和分层覆盖有关，见下文"属性的分层、合并和转发" |

**字面量简写**：属性直接写一个值，就是"这个类型加这个默认值"。`speed: 10` 等于 `prop.number().default(10)`，`name: 'hero'`、`visible: true` 同理；数据组件里的数字简写成 `f32`。

### 组件的名字（2026-11-18 用户决定：默认不手写）

运行时有四处要用一个稳定的字符串认出组件：场景和预制体文件里的 `type`、热重载时新旧定义的对应、编辑器的组件列表和覆盖记录、按需加载时该 `import()` 哪个模块。C# 靠反射拿类型全名；JS 里类名在正式版被压缩，打包后模块路径也不存在，数据组件更是没有类名。

做法：**名字由源文件路径加导出名推出**，形如 `gameplay/health#Health`，作者不写。

```ts
// game entry: Vite's built-in import.meta.glob, keys stay source paths in production builds too
const modules = import.meta.glob('./**/*.ts');
await game.run(canvas, { modules });

// gameplay/health.ts
export const Health = component({ max: prop.f32().default(100), current: 100 });
```

- 游戏入口把 `import.meta.glob` 的结果交给引擎。它是 Vite 自带的功能，不是我们的编译期改写；键是源文件路径，值是 `() => import(...)`。
- 模块执行完以后，引擎遍历它的导出，按对象身份给组件、脚本、系统登记名字（`Registry.registerModules`）。属性和默认值在定义时就检查，报错带字段名；同名冲突在登记时报，带上推出的名字。
- 名字直接指向模块：场景引用了 `levels/castle/boss#BossAI`，加载器就知道去 `import()` 哪个分块，按关卡拆分代码不需要另做一份"名字到模块"的清单，也不必一开始就加载所有模块。
- 热重载时模块路径和导出名不变，新旧定义自然对上。
- 代价：移动文件或改导出名，名字就变了（同 Godot 的 `res://` 路径、Unreal 的资源路径加重定向）。编辑器移动文件时自动在工程里记一条重定向（`renamed: { 'old/path#X': 'new/path#X' }`），场景加载时先查它；也可以在定义处写 `renamedFrom`。

需要手写名字的情况，作为第一个可选参数：

| 情况 | 例 |
|---|---|
| 引擎和库包里的组件：不经过游戏的 glob，名字要跨版本稳定 | `component('Stride.Physics.RigidBody', { ... })` |
| 希望移动文件也不影响存档的少数游戏组件 | `SyncScript.props('Gameplay.Player', { ... })` |

`EventKey` 不存盘，不需要名字；调试时显示它被登记的导出名。

### 脚本

```ts
export class PlayerController extends SyncScript.props({
  maxRunSpeed: prop.number().min(0).default(10).unit('m/s'),
  jumpHeight: 1.2,
  camera: prop.component(() => CameraComponent),
}) {
  private readonly move = new Vector3();
  private character!: CharacterComponent;

  override start(): void {
    this.character = this.entity.require(CharacterComponent);
  }

  override update(time: GameTime): void {
    this.move.set(0, 0, 0);
    if (this.input.isKeyDown('KeyW')) this.move.z -= 1;
    this.character.move(this.move.normalize().scale(this.maxRunSpeed));
    if (this.input.isKeyPressed('Space')) this.character.tryJump(this.jumpHeight);
  }
}

export class DoorOpener extends AsyncScript.props({
  trigger: prop.component(() => TriggerComponent),
}) {
  override async execute(): Promise<void> {
    for (;;) {
      await this.trigger.entered(this.signal);
      await this.delay(0.5);
    }
  }
}
```

- `SyncScript.props(shape)` 返回一个已经带好属性类型的基类；名字由文件路径和导出名推出（见下文"组件的名字"）。不需要属性的脚本直接 `extends SyncScript`。
- `entity.get(T)` 返回 `T | undefined`；`entity.require(T)` 拿不到就抛错，消息里带实体名和组件名。
- `AsyncScript` 有 `this.signal`（`AbortSignal`），脚本被移除或游戏退出时中止，对应 Stride 的取消。脚本自己的等待方法（`nextFrame()`、`delay()`）自动带上它；等别的东西时把它传进去。
- 按键用 `KeyboardEvent.code` 的字面量联合（`'KeyW'`、`'Space'`），不另造一套 `Keys`。

### 数据组件和系统

```ts
export const Health = component({
  max: prop.f32().min(0).default(100),
  current: 100,
});
export const Regen = component({ rate: 5 });   // per second
export const Dead = tag();

export const regen = system({
  with: { health: Health, regen: Regen },
  without: [Dead],
  writes: [Health],
  update({ health, regen, count }, time) {
    for (let i = 0; i < count; i++)
      health.current[i] = Math.min(health.max[i], health.current[i] + regen.rate[i] * time.elapsed);
  },
});
```

- **存储按 archetype 分块**：组件组合相同的实体放在同一块里，块内每个字段一列、连续存放。`update` 每块调用一次，`count` 是这一块的实体数；列是预先建好的视图，每帧不分配。
- **`with` 写成对象**：键名就是 `update` 里解构出来的名字，列的类型从 schema 推出：`f32` 是 `Float32Array`，`int` 是 `Int32Array`，`bool` 是 `Uint8Array`，`entity` 是 `Uint32Array`，其余是普通数组。
- **`writes`** 声明会改哪些组件，用于变更检测（按块记版本）和以后的调度检查；`changed: [Health]` 只处理上次运行之后被写过的块。
- **结构性改动**（加删组件、创建销毁实体）在遍历时只能记进命令缓冲：`update(chunk, time, commands)`，系统跑完后统一执行。
- **顺序**：`phase`（物理之前、之后等）加 `after: [movement]`。
- **引擎自己的组件**（变换、刚体）在 wasm 内存里，按实体槽位存放，不按块：块里带一列 `slot`，写成 `transform.position[transform.slot[i] * 3]`（`Transform` 已实现）。
- **脚本里访问单个实体**：`entity.get(Health)` 返回一个视图对象，`health.current -= 10` 直接读写那一格；每个实体缓存一个视图。
- 数据组件之间用实体句柄（`EntityId`，带品牌的整数）互相引用。

### 生命周期

参照 Stride（脚本的 `Start`、`Update`、`Execute`、`Cancel`；处理器的 `OnEntityComponentAdding`、`OnEntityComponentRemoved`）和 Vue（setup 里登记的东西卸载时自动清理）。

| 阶段 | 脚本 | 数据组件 |
|---|---|---|
| 属性解码完 | 实例已创建，引用还没解析，不调用户代码 | 值写进列 |
| 同一批生成的组件都挂好、引用解析完 | `start()` | 系统的 `added(chunk)` |
| 每帧 | `update(time)`；异步脚本的 `await` 在固定时机继续 | 系统的 `update` |
| 停用、启用 | `enabled = false` 时不再调 `update`，状态保留 | 加 `Disabled` 标签，系统用 `without` 排除 |
| 移除 | `cancel()`；`this.signal` 中止 | 系统的 `removed(chunk)` |

**清理自动化**：脚本里登记的东西（钩子、事件接收器、`.stat()` 修饰、计时器、加载的资源）都挂到脚本自己的清理栈上（JS 原生的 `DisposableStack`），移除时一起释放，不用在 `cancel()` 里逐个注销：

```ts
override start(): void {
  this.on(door.opening, (e) => { /* ... */ });   // released with the script
  this.hits = this.receive(damaged);             // same
}
```

在脚本之外登记的（工具、编辑器插件）返回一个 `Disposable`，自己用 `using` 或 `dispose()` 释放。

**每帧的顺序**（固定，所有事件都在这个顺序里的固定位置派发，不在浏览器的事件回调里直接调游戏代码）：

1. 输入：把这一帧收到的 DOM 事件合进输入状态。
2. 拾取和输入事件的派发（见下文"事件"）。
3. 待启动脚本的 `start()`（异步脚本是 `execute()`），然后同步脚本的 `update`。异步脚本 `await nextFrame()` 之后的代码在上一帧结束后、这一帧开始前运行（见上文"实现状态"）。
4. 系统：物理之前的阶段。
5. 固定步长的物理（每帧 0 到 4 步），步进结束后派发接触事件。
6. 系统：物理之后的阶段。
7. stride-native 里做变换传播、动画求值。
8. 渲染：收集、提取、准备、绘制。

结构性改动（生成、销毁、加删组件）在 3 到 6 里都只记进命令缓冲，每个阶段结束时统一执行。

### 事件

参照 DOM（捕获、冒泡，`stopPropagation`、`preventDefault`）、Stride UI 的路由方式（`Tunnel`、`Bubble`、`Direct`）、Bepu 的接触回调（开始、持续、结束接触），以及 vue-tsx-pro 合并事件的规则（使用方先执行，`preventDefault()` 跳过组件自己的处理）。

| 种类 | 例 | 怎么派发 |
|---|---|---|
| 广播消息 `EventKey<T>` | 受伤、关卡完成 | 发给所有接收者，同步读或异步等，同 Stride |
| 钩子 `Hook<T>` | 门要打开、角色要跳 | 同步，使用方先处理，可以 `preventDefault()` 接管组件自己的行为 |
| 输入 | 按键、鼠标、手柄 | 轮询状态（`isKeyDown`、`isKeyPressed`）加按帧的事件流 |
| 实体上的指针事件 | 点中、悬停一个物体 | 沿实体的父链路由：先捕获（根到目标），再冒泡（目标到根） |
| 物理接触 | 开始、持续、结束接触；进出触发区 | 在 wasm 里收集，步进结束后派发；先给刚体所在实体，再冒泡到父实体 |

```ts
export const damaged = new EventKey<{ target: EntityId; amount: number }>();
damaged.broadcast({ target, amount: 10 });
for (const hit of this.hits.drain()) { /* sync scripts, once per frame */ }
const hit = await this.hits.receive(this.signal);   // async scripts

// a hook declared by the Door component; user handlers run before the door's own logic
this.on(door.opening, (e) => {
  if (!player.hasKey) e.preventDefault();
});

// pointer events on entities: picked by a raycast at the start of the frame
this.on(this.entity.pointer.click, (e) => {
  e.stopPropagation();                    // the parent entities do not hear it
});

// contacts: the wheel's contact bubbles up to the car
this.on(this.entity.contact.started, (e) => {
  if (e.other.has(Hazard)) damaged.broadcast({ target: this.entity.id, amount: 10 });
});
```

- **指针事件**：每帧开头用一条射线拾取，目标是带碰撞体或 `Pickable` 标签的实体。事件有 `pointerenter`、`pointerleave`、`pointerdown`、`pointerup`、`click`，沿父链路由，组合物体在根上就能统一处理（点中车轮，车身的脚本也收得到）。
- **接触**：Stride 的 Bepu 版接口是 `IContactHandler` 的三个回调；这里按帧收集后统一派发，不在步进途中逐个回调 JS。
- **事件对象复用**：同一种事件每次派发用池里的同一个对象，不分配；处理函数不能把它存下来，开发版在派发结束后把它标成失效，之后再读就报错。
- **类型**：`this.on(hook, handler)` 的处理函数参数由钩子的类型推出；组件声明钩子写 `opening: hook<{ by: EntityId }>()`，和属性一样在 schema 里，编辑器也能列出来。

### 服务

扩展包用声明合并登记自己的服务，核心不依赖它们（同 easy-query-ts 的 `NumericExtensions`）：

```ts
declare module '@stride-ts/engine' {
  interface Services { navigation: NavigationSystem }
}
this.services.navigation;               // typed
```

### 属性的分层、合并和转发

参考两处：
- **vue-tsx-pro**（`C:\Users\Administrator\IdeaProjects\vue-tsx-pro`，`packages/ui/src/utils/props.ts`、`config/defaults.ts`，规范见 `packages/ui/COMPONENTS.md` §2）：UI 组件的值来自好几层（组件默认、`createUi`、`Provider`、使用方、组件受管），逐层合并后再转发给内部部件（`propsXxx`）。它的体系是 Vue 和 DOM，和我们不同；借鉴的是合并规则和类型做法。
- **Stride 自己的资源继承**：`OverrideType` 有 Base、New、Sealed 三种，集合的每一项带稳定的 `ItemId`（`Stride.Core.Assets/Reflection`）。

**一个属性的值从哪里来**（上面的层覆盖下面的层）：

| 层 | 例 | 存在哪里 |
|---|---|---|
| 运行时修饰（只对 `.stat()` 属性） | 减速 ×0.5，装备 +2 | 运行时，不存盘 |
| 实例覆盖 | 场景里这个敌人的 `maxHealth: 120` | 场景文件，只存差异 |
| 预制体链 | 精英兵预制体 → 士兵预制体，可以嵌套多层 | 预制体文件，只存差异 |
| 变体 | 组件定义里的 `variants: { elite: { maxHealth: 300 } }`，实例选 `variant: 'elite'` | 组件定义 |
| 作用域默认值（只对 `.inherit()` 属性） | 工程配置、关卡或某棵子树统一给的默认值，近的优先 | 工程配置、场景 |
| schema 默认值 | `prop.f32().default(100)`，或由别的属性算出 | 组件定义 |

合并规则：
- **`undefined` 不表态**：覆盖层里没写的键沿用下面的层。`null` 只对 `.optional()` 属性有意义，表示明确地"没有值"，盖掉下面的层（同 vue-tsx-pro 的 `mergeProps`）。
- **按路径合并，不整个替换**：嵌套对象和部件（见下）逐层合并，只覆盖其中一项不会丢掉其他项。
- **集合项按 id 覆盖，不按下标**：基础预制体里插入或重排列表项，实例的覆盖不会错位（同 Stride 的 `ItemId`）。
- **只在加载、生成、编辑时合并**：合并结果写进组件的普通字段或列，运行时读值就是普通读取，不逐层查找。同一个预制体的各层只合并一次，所有实例共用结果；写进实例时用组件登记时生成的初始化函数逐项赋值，不按键名循环（实测快 17 倍，见"实测：数据放在哪里、跨边界的代价"）。基础预制体改了（编辑器里或热重载），没覆盖这一项的实例跟着变。
- **编辑器显示每个值的来源**（实例、哪个预制体、变体、作用域、默认值），可以一键"重置到下一层"，对应 Stride Game Studio 里加粗显示的覆盖值。

和分层有关的属性修饰：

| 修饰 | 作用 |
|---|---|
| `.default((p) => p.radius * 2)` | 默认值由别的属性算出；那个属性变了，没覆盖的值跟着变（vue-tsx-pro 的默认值也可以引用别的 prop） |
| `.sealed()` | 由组件自己或系统驱动（受管），预制体和实例都不能覆盖：类型上从覆盖对象里去掉，编辑器里只读。对应 Stride 的 `Sealed` 和 vue-tsx-pro 的受管层 |
| `.inherit()` | 允许作用域默认值统一设置。只给调参和外观类的属性用（摩擦、音量、颜色），状态类的不行；vue-tsx-pro 也只让外观类的选项进 `defaults` |
| `.stat()` | 允许运行时修饰 |

**作用域默认值**：

```ts
game.defaults.set(RigidBody, { friction: 0.6 });   // only .inherit() props are accepted by the type
```

关卡或子树的根实体上挂一个 `Defaults` 组件，作用于它下面的实体，近的优先（同 vue-tsx-pro 的 `Provider`）。

**部件：组合组件把覆盖转发给内部的部件**（对应 vue-tsx-pro 的 `propsXxx`）：

```ts
export const Wheel = component({
  radius: prop.f32().min(0).default(0.4),
  friction: prop.f32().default(1).inherit(),
  steerAngle: prop.f32().sealed(),          // driven by the vehicle
});

export class Vehicle extends SyncScript.props({
  maxSteer: 35,
  wheels: prop.parts(Wheel, ['frontLeft', 'frontRight', 'rearLeft', 'rearRight']),
}) {
  steering = 0;   // -1..1, set by the driver script

  override update(): void {
    this.wheels.frontLeft.steerAngle = this.steering * this.maxSteer;   // the owner may write sealed props
  }
}

await scene.spawn(assets.prefabs.car, {
  position: [0, 0, 5],
  set: {
    Vehicle: {
      maxSteer: 30,
      wheels: { all: { radius: 0.45 }, rearLeft: { friction: 0.8 } },   // `all` first, then each part
      // or per part: wheels: (name) => ({ radius: name.startsWith('rear') ? 0.45 : 0.42 })
    },
    RigidBody: { mass: 1500 },
  },
  parts: { rearLeft: { set: { Model: { materials: { tire: { tint: [0.2, 0.2, 0.2, 1] } } } } } },
});
```

覆盖对象的结构（`Overrides<P>`）：

| 层级 | 键 | 值 |
|---|---|---|
| 实体 | `set` | 组件的导出名 → 这个组件的覆盖（深层可选，去掉 `.sealed()` 属性） |
| 实体 | `parts` | 子实体的名字 → 同样结构的覆盖，可以一层层往下 |
| 组件属性 | `prop.parts` 声明的属性 | 部件名或 `all` → 部件组件的覆盖；也可以是 `(name) => 覆盖` |

- **和 vue-tsx-pro 最大的不同**：DOM 元素只有一个扁平的属性表，没声明的属性（`...rest`）可以默认落到主元素上。实体上挂着好几个组件，同名字段没法分辨，所以覆盖固定是"组件 → 字段"两级，再加部件名，不做隐式落到主元素的规则。
- **转发**：组件用 `prop.parts` 声明自己要哪些部件，覆盖经由这个组件的属性转发下去，类型是部件组件的覆盖类型；也可以不经组件，用 `parts` 直接按实体层级覆盖。两条路落到同一批子实体上，按同样的规则合并。
- **嵌套再合并**：部件的覆盖按同样的规则再合并一次（vue-tsx-pro 的嵌套 `propsXxx`），组件给部件的默认值不会因为使用方也写了这个部件就整个丢掉。
- **键名**：组件的键是它的导出名（`Vehicle`、`RigidBody`）。同一个实体上两个组件导出名相同时，编辑器报错，要求改名；代码里也可以用不依赖键名的写法 `car.root.set(Vehicle, { maxSteer: 30 })`。
- **类型**：部件名、组件名、属性名、值的类型写错都是类型错误；预制体的类型从哪里来见下文"资源的强类型"。

**运行时修饰：`.stat()`**（游戏里最常见的"层层合并"：加成和减益）：

```ts
maxRunSpeed: prop.number().min(0).default(10).stat(),

using slow = this.stats.maxRunSpeed.multiply(0.5);     // removed at the end of the block
this.stats.maxRunSpeed.add(2, { duration: 5 });          // removed after 5 seconds
```

- 计算顺序固定：(合并后的基础值 + 所有加值) × 所有乘数，最后按 `min`、`max` 截断；需要时再加带优先级的"直接改成某值"。
- 只在修饰增减或到期时重算，结果写回字段，读取不花额外时间。

**状态用标签表达**（vue-tsx-pro 用 `data-state` 属性表达组件状态，样式直接按状态选择）：`Stunned`、`Dead` 这类状态写成标签组件，系统用 `with`、`without` 直接选；编辑器和调试工具也能看到。加删标签会让实体换块，所以每帧都在切换的开关仍用 `bool` 列。

**类型测试补充**：覆盖 `.sealed()` 属性、部件名写错、覆盖值类型不对，都要有 `@ts-expect-error` 的负例；vue-tsx-pro 还用一个静态检查脚本核对受管属性都从使用方的类型里去掉了，我们的 `Overrides` 由类型推出，不需要这一步。

### 资源的强类型（2026-11-18 用户要求：编辑器做的预制体等，代码引用时尽量强类型）

编辑器做的预制体、场景、模型、材质是数据文件，TS 推导不出它们的结构（导入 JSON 得到的是放宽后的 `string`，认不出组件）。所以**资源由工具生成类型**，这是整个工程里唯一的代码生成，只针对资源；组件、脚本、系统的类型仍全部靠推导。

**生成什么**：一个 TS 模块 `src/assets.gen.ts`，导出带类型的资源句柄，值只是资源 id，类型里记着结构：

```ts
// src/assets.gen.ts: generated from the asset files, do not edit
import type { Vehicle } from './gameplay/vehicle';
import type { Wheel } from './gameplay/wheel';
import type { RigidBody, Model } from '@stride-ts/engine';

interface CarPrefab {
  components: { Vehicle: typeof Vehicle; RigidBody: typeof RigidBody; Model: ModelOf<CarModel> };
  parts: {
    frontLeft: { components: { Wheel: typeof Wheel; Model: ModelOf<WheelModel> }; parts: {} };
    // frontRight, rearLeft, rearRight ...
  };
}
// WheelModel, CarPaint, Glass, Rubber, GatePrefab, BossPrefab are generated the same way
interface CarModel { materials: { body: typeof CarPaint; glass: typeof Glass; tire: typeof Rubber } }

export const assets = {
  prefabs: { car: prefabRef<CarPrefab>('c3a1…') },
  models: { car: modelRef<CarModel>('9f20…') },
  scenes: { castle: sceneRef<{ entities: { gate: GatePrefab; boss: BossPrefab } }>('41be…') },
} as const;
```

- **组件类型用 `import type` 引入**：组件的名字就是"路径#导出名"（见"组件的名字"），生成器据此直接写出引用；在 IDE 里重命名组件，预制体的类型跟着报错，不会悄悄失效。
- **覆盖到哪一层都有类型**：组件名、属性名、部件名、模型的材质槽名、材质的实例参数名和值类型。编辑器里删了一个部件，引用它的代码在类型检查时就报错。
- **场景只给标了"导出"的实体生成类型**：代码要引用的门、首领在编辑器里勾选导出，`scene.entities.gate` 有类型；其余实体不进类型，生成文件和类型检查都保持小。
- **怎么生成、什么时候更新**：
  - 编辑器的 Node 后端保存资源时重写这个文件，Vite 热更新跟着生效。
  - `pnpm assets:types` 单独生成；`dev`、`build`、`typecheck` 先跑它。
  - 生成的文件不提交（`.gitignore`），避免合并冲突；新克隆的仓库跑一次 `typecheck` 就有了。
  - 输出按资源路径排序、格式固定，同样的资源生成同样的文件。
- **类型写法**：生成的结构用 `interface`（类型检查器能缓存，悬停时显示名字而不是展开一大串），不用深层交叉类型。类型压力测试里加上"几百个预制体、几层部件"的生成样例，记录检查时间。

**类型提取工具**（简化使用方的写法，仍然是强类型）：

| 工具类型 | 得到 |
|---|---|
| `Overrides<P>` | 预制体或组件的覆盖对象（深层可选，去掉 `.sealed()`） |
| `ComponentsOf<P>`、`PartsOf<P>` | 预制体根实体上的组件表、部件表 |
| `PartOf<P, 'frontLeft'>` | 某个部件的结构，可以继续取 `ComponentsOf` |
| `PropsOf<C>`、`ValuesOf<C>` | 组件的属性声明、属性值类型 |
| `MaterialParams<M>` | 材质可以逐实例改的参数和值类型 |
| `InstanceOf<P>` | `spawn` 返回的实体句柄：`car.components.Vehicle`、`car.parts.frontLeft` 都有类型 |

```ts
type CarSetup = Overrides<typeof assets.prefabs.car>;
const tuned: CarSetup = { set: { Vehicle: { maxSteer: 28 } } };

const car = await scene.spawn(assets.prefabs.car, tuned);
car.components.Vehicle.steering = 0.5;            // Vehicle instance, typed
car.parts.frontLeft.components.Wheel.radius;      // number
```

**代码里定义的预制体**用 `prefab({ components, parts })` 写，类型直接推导，得到和生成的预制体同样的结构，`spawn`、`Overrides` 两者通用。

### 外观：材质参数的分层（对照 CSS）

参照 vue-tsx-pro 的样式引擎（`packages/tsx/STYLE-ENGINE.md` §1、§11，`src/styles/recipe.ts`）：配方把"部件 × 档位 × 组合档位 × 默认值"写在一处；按"基础 < 档位 < 组合档位 < 主题定制 < 使用方 `sx`"分段放进依次靠后的 `@layer`；主题 token 是根上的变量，换主题只换变量；状态样式跟着 `data-*` 属性；动态值直接改元素上的 CSS 变量，类名不变、组件不重新渲染。

| CSS 这边 | 这里 |
|---|---|
| 声明（`color`、`padding`） | 材质参数（基础色、粗糙度、自发光），布局来自 WGSL 反射 |
| 配方的部件 | 模型的材质槽（车身、玻璃、轮胎），名字有类型（见"资源的强类型"） |
| 配方的档位、组合档位 | 材质变体：`team: 'red' \| 'blue'`、`wear: 'clean' \| 'scorched'`，以及几个档位同时取某些值时的追加 |
| `@layer` 分段覆盖 | 同一套分层：材质资源 < 变体 < 作用域（关卡的调色板）< 实例覆盖；`undefined` 不表态 |
| 主题 token、根上的变量 | 全局着色器参数（调色板、雾、时间）：一个 uniform 缓冲，改了不用逐个物体处理 |
| 动态值改 CSS 变量，类名不变 | **实例参数**：材质声明哪些参数能逐实例改，值写进实例数据列、整段上传；改它不换管线，也不打断合批 |
| 改到类里写死的值，生成新的组合类，按片段缓存 | 改到非实例参数，派生一个材质，按（基础材质，覆盖内容）缓存；同样的覆盖共用一个派生材质，照样能合批 |
| 状态别名（`_hover`、`_selected`） | 状态标签驱动变体或实例参数：受击闪白是改实例参数 `emissive`，不换材质 |
| 样式热更新原地生效 | 材质资源改了，原地更新参数缓冲，不重载场景 |

```ts
export const CarPaint = material({
  effect: 'StrideForwardShadingEffect',
  params: { baseColor: param.color().default([1, 1, 1, 1]), roughness: param.f32().default(0.4) },
  instanceParams: { tint: param.color().default([1, 1, 1, 1]), emissive: param.f32().default(0) },
  variants: {
    team: { red: { baseColor: [0.8, 0.1, 0.1, 1] }, blue: { baseColor: [0.1, 0.2, 0.8, 1] } },
  },
});

model.materials.body.set({ tint: [1, 0.9, 0.9, 1] });   // instance param: no new material, still batched
model.materials.body.variant({ team: 'blue' });         // variant: shared derived material, cached
```

- **关键取舍：哪些是"变量"，哪些是"类"**。实例参数相当于 CSS 变量，可以逐物体改，不打断合批；排列组合键（有没有法线贴图、透明模式）相当于类，改了要换管线。这决定渲染性能，所以在材质定义里显式声明，不靠运行时猜。
- 材质用 TS 定义（`material()`）时类型直接推导；编辑器里做的材质由生成的 `assets.gen.ts` 给出同样的类型。
- 参数名和类型来自着色器的反射数据；材质声明的参数和反射对不上时，在登记时报错。
- 游戏内 UI（里程碑 5）还没定：用 DOM 叠加层就直接用 vue-tsx-pro 的样式引擎；用 WebGPU 自己画（照 Stride UI）就按这里的分层规则做 UI 的主题。

### 向量和临时对象

- `Vector3` 等是可变的类：实例方法原地修改并返回 `this`，可以链式调用；要新对象就显式 `clone()`。参数接受 `Readonly<Vec3Like>`（`{ x, y, z }`），wasm 内存里的变换视图也能直接传。
- 临时向量从池里取，配合 `using`：`using v = temp.vec3();`，作用域结束自动还回池，没有分配。

### 校验放在哪里

- **登记时**（模块执行完、名字推出之后）：检查重名、默认值是否满足 `min`/`max`、`renamedFrom` 是否冲突，报错带组件名和字段名。
- **加载和编辑时**：场景文件按 schema 解码，问题带路径（`entities[3].gameplay/health#Health.max`）。`validators(Health)` 产出符合 Standard Schema 的校验器，给编辑器和 Node 后端用。
- **公共 API 的选项**：在边界上检查一次（`createStrideNative`、`NavConfig`），内部不重复。
- **每帧路径不校验**；开发期的断言写在 `import.meta.env.DEV` 里。

### 热重载（Vite HMR，不重启；2026-11-18 已实现）

- **脚本**：按名字（模块路径加导出名）找到新类，把已有实例的原型换成新类的原型（`Object.setPrototypeOf`），下一次 `update` 就跑新代码；运行时状态的字段保留；类体里新加的字段（字段初始化只在构造时跑）从一个新实例上拷过来；属性按新 schema 重新赋值（`renamedFrom` 生效，新属性取默认值，`stat` 属性不动）。
- **数据组件**：新版本接替旧版本的编号，所以旧代码手里的旧版本和新版本落到同一组列上；按字段名把旧列搬进新布局（`renamedFrom` 生效），新字段和种类变了的字段取默认值；视图、系统缓存的列、作用域默认值跟着换。
- **系统**：加入过的旧版本换成新版本（保留 `changed` 的进度），排序重算；`after` 里的旧版本按名字找到新版本。
- **游戏的类**：正在运行的游戏换成新类的原型，`update`、`draw` 也能热改。

**怎么接上 Vite**（用户定的方向：不做编译期改写，所以不加插件，由游戏入口自己接住更新）：入口模块写 `import.meta.hot?.accept()`。入口导入的任何游戏模块改了，Vite 都把更新传到入口、重新执行它；`Game.hotEntry(import.meta.hot, modules, GameClass, ...args)` 在 `import.meta.hot.data` 里存着正在运行的游戏，重新执行时返回同一个，换原型并调用 `game.hotUpdate(modules)`，第一次才新建。重新执行后的 `import.meta.glob` 里，改过的模块（以及沿着导入链被重新执行的模块）是新对象，没改的还是原来的对象；`registry.update` 按名字配对，只换真正变了的。正式构建里 `import.meta.hot` 是 undefined，`hotEntry` 就是一次普通的 `new`。沙盒是范例（`apps/sandbox/src/main.ts` 只负责启动，游戏内容在 `game/` 里）。

实测（2026-11-18，沙盒的开发服务器加本机 Chrome）：运行中改 `game/particles.ts` 的重力并给 `Position` 加一个带默认值的字段，再改 `game/sandbox.ts` 里游戏类的统计文字；页面不刷新，游戏还是同一个对象，帧数接着走，已有的 6000 个粒子都有了新字段的默认值，新的统计文字下一帧就出现。

要知道的限制：
- 游戏定义（组件、脚本、系统）都要从 `game/` 这类被 glob 登记的模块**导出**，按名字登记了才能被替换；入口模块里不要定义它们，入口每次热更新都会重新执行，里面的东西每次都是新对象。
- 脚本里用 TS 的 `private`，不要用 `#私有字段`：新类的方法认不出旧实例上旧类的私有字段，会抛 TypeError。
- 正在跑的 `AsyncScript.execute` 继续跑旧代码，直到它结束；`start()`、`loadContent` 不会重跑，场景搭建改了要刷新页面。
- 新版本里新出现的系统不会自动加入（加不加系统是游戏的决定）；数据在原生内存里的组件（`Transform`）不能热替换（它们是引擎的，不在游戏模块里）。
- 重新执行的模块里的模块级变量（统计对象之类）是新的；替换后的系统和脚本用的就是新变量，所以前后一致。

### 类型测试

做法同 easy-query-ts：
- `*.check.ts` 只给 tsc 检查：正例用 `Equal` 断言推导出的类型，负例用 `@ts-expect-error` 固定"必须报错"。
- 用脚本生成上百个组件和系统的压力样例，记录 tsc 的检查时间和实例化次数，防止类型推导拖慢编辑器。

## 原生模块的 TS 接口（2026-11-18 已实现）

绑定层和 C API 放在一起，都在 fork 的 `StrideNative/JS/`，用 TypeScript 写（`native-module.ts`、`stride-native.ts`、`stride-tools.ts`）。原先的设想是把绑定搬进本仓库，实际做下来留在 fork 更好：改 C API 的同一个提交里就能改绑定和 fork 的 Node、浏览器测试，两边不会对不上。

- **只用可擦除的语法**：Node 22.18+/24 直接运行（fork 的 Node 测试），Vite 照常编译，fork 的浏览器测试服务器用 `module.stripTypeScriptTypes` 去掉类型再发出。不需要构建步骤，也没有手写的 `.d.ts`。
- **Emscripten 工厂的类型**：`*-core.d.mts` 逐个列出各模块导出的 C 函数名，`CoreModule<E>` 把它们映射成 `_sn_*` 成员。不用 `_sn_${string}` 索引签名：名字写错在编译期就报，也不会因为 `noUncheckedIndexedAccess` 变成可能 undefined。
- **打包和安装**（2026-11-18 用户定）：fork 的 `StrideNative/JS/` 是 npm 包 `@stride-ts/native`。源码在 `src/`，fork 自己的 tsconfig 开 `allowImportingTsExtensions` 加 `rewriteRelativeImportExtensions`（同 easy-query-ts），编译成 `dist/*.js` 加 `.d.ts`（带 declarationMap）；`dist/` 里还有 Emscripten 的 `.mjs`、`.wasm`，两个 wasm 也在 `exports` 里导出。fork 自己的 Node 测试和浏览器测试页加载的就是 `dist/`。`build-wasm.ps1` 最后 `pnpm pack`，`release-native.ps1` 发布成 fork 的 GitHub Release `native-v<版本>`；本仓库各包照常依赖 `^0.1.0`，`pnpm-workspace.yaml` 的 override 指向 Release 的 tgz 地址，发布到 npm 后删掉。Vite 配置里 `optimizeDeps.exclude` 了这个包：Emscripten 的模块按 `import.meta.url` 找 `.wasm` 和自己的 worker，预打包会把这层关系弄断。
- **两次踩坑**（都是 JetBrains IDE 解析不出包的类型，`tsc`、Vite 都正常）：拷到本仓库 `dist/` 时，IDE 把 `dist` 当构建输出排除、不建索引；改用 `file:` 安装本地 tgz 时，pnpm 在 `node_modules/.pnpm` 下建的目录名带 `..`（`@stride-ts+native@file+..+._<hash>`），IDE 的解析器遇到这种路径就失败（同一份文件放进正常名字的目录就好了，2026-11-18 实测）。从 GitHub Release 安装，目录名是 `@stride-ts+native@https+++g_<hash>`，没有这个问题。

接口相对原来的 .mjs 版本的变化：

| 原来 | 现在 |
|---|---|
| `addBox(position, halfExtent, dynamic: boolean)` | `addBox({ position, halfExtent, motion })`；批量的 `addBoxes` 走 Jolt 的 `AddBodiesPrepare`/`AddBodiesFinalize`，返回每个盒子的 `BodyId` |
| `TextureTarget.bc7 = 1`、`mode?: number` | 字符串字面量联合，如 `'bc7'`；整数只在绑定层内部用，公开边界检查取值 |
| 返回裸 `number` 的物体编号、代理编号 | 品牌类型 `BodyId`、`AgentId`，不能混用，运行时零开销 |
| `destroy()` | 原生对象共用基类 `NativeObject`：`destroy()` 可重复调用，同时实现 `[Symbol.dispose]`，可以写 `using world = native.createPhysicsWorld(...)`；释放后再用抛 `invalid-handle` |
| 公开的 `handle: number` | 藏在不从公开入口导出的 symbol 后面，只有绑定层内部互相传 |
| `NativeError.code` 是负整数 | 字符串联合 `'invalid-argument' | 'invalid-handle' | 'failed' | 'not-initialized'`，负数放在 `status` |
| `decodeMeshopt` 有 5 个位置参数 | 单个调用和批量调用用同一个 `MeshoptRequest` |
| `positions()` 每次分配、拷贝、`slice()`、释放 | 物理世界和人群都返回常驻视图，由步进和更新在原生里写入；绑定了变换槽位的物体由步进直接写回变换存储（`createTransforms`、`BoxDesc.transform`） |
| `addBox` 每次调用都分配临时内存 | 参数缓冲复用 |
| 基准要绕过包装层拿原始导出做分配 | `alloc`、`free` 和 `u8`/`i32`/`f32`/`i64` 等视图是公开方法 |

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

**实现状态（2026-11-18，@stride-ts/native 0.8.1，引擎的 `physics/`、`input/`）**：

- **原生侧（`Physics.h`）**：
  - 形状：盒子、球、胶囊、圆柱、三角网格（按实体的世界缩放），带本地位姿的复合碰撞体。
  - 物体：静态、动态、运动学、角色。成批加入。
  - 32 个碰撞层加对称的碰撞矩阵，射线和球体扫掠按层遮罩。
  - 插值：记下前后两步的位姿，`interpolate(alpha)` 写回两步之间。
  - 角色在 `JPH::Character` 上照 Bepu 的角色控制器（Stride.BepuPhysics 的 `CharacterControllers`）实现：
    - 站稳时用有上限的力（`MaximumHorizontalForce`）追目标水平速度，竖直方向用 `MaximumVerticalForce` 把角色压在地面上；
    - 起跳把相对支撑物的竖直速度补到 `JumpForce`；
    - 能不能站立按 `SlopeAngle`，地面状态用 Jolt 的 `PostSimulation`。
- **引擎**：
  - 组件：`Static`、`Character`。碰撞体是 `Collider` 资源，网格形状引用渲染网格，位置从量化数据反量化出来。
  - `Simulation` 同 Stride 的 BepuSimulation：固定步长，每帧最多 3 步，单帧最多处理 0.25 秒。`Game` 在“物理前”和“物理后”两组系统之间调用它；有 physics 原生功能时自动建。
  - 角色的移动照 Stride：脚本写 `moveX`、`moveY`（MoveVector，在角色的基里）和 `jump`，仿真后读 `grounded`。
  - `InputManager` 是 Stride InputManager 的常用部分：键盘（KeyboardEvent.code）、鼠标（移动量按画布归一化，Pointer Lock）、手柄（标准布局，摇杆 y 向上为正）。
- **资源管线**：导入 `StaticComponent`、`CharacterComponent` 的复合碰撞体和网格碰撞体、碰撞层、摩擦、角色参数，以及 GameSettings 里 BepuConfiguration 的仿真设置（重力、阻尼、步长）。凸包碰撞体还不支持，导入时警告。
- **和 Stride 有意不同的地方**（Stride 的做法有缺陷时，修掉并在注释里写明）：
  - 角色的摩擦为 0：水平速度完全由角色逻辑给，相当于 Bepu 的运动约束；Bepu 是约束和摩擦一起求解。
  - 空中操控先把方向归一化：Stride 拿没归一化的目标速度做点积，单位对不上，离地后几乎没有空中操控。速度上限按目标速度的大小，摇杆推一半，空中也只到一半。
  - 球体扫掠可以忽略起点就重叠的物体。TPP 的相机用它，再配一条射线防止钻进正后方的墙；Stride 的相机贴着旁边的箱子时会被拉到最近。
  - TPP 的脚本按时间平滑（Stride 每帧固定比例，帧率越高越快），起跳宽限按帧时间减，每帧把输入事件取完（Stride 每帧取一个，悬空时没取的起跳会积到落地后才触发）。
- **还没做**：
  - 实体销毁时移除物体：原生侧还没有移除接口，目前销毁带物理组件的实体，物体会留在世界里。
  - 动态物体组件（BodyComponent）、触发器、接触事件、约束。
  - 场景里的脚本组件随场景导入：TPP 现在由游戏代码按实体名挂脚本。
  - 动画。

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
  - 保存资源时重新生成 `src/assets.gen.ts`（资源的强类型，见"组件 API"里的"资源的强类型"），移动文件时记重定向（见"组件的名字"）。
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

**第一段（2026-11-18 已实现）**：
- **格式**（`packages/engine/src/content/format.ts`，不依赖别的模块，管线通过 `@stride-ts/engine/content-format` 导入）：资源之间按内容路径引用（"包名/相对路径"，不带扩展名）。模型 `.model` 是一个小容器：12 字节头（magic `SMDL`、版本、JSON 长度）、JSON 头（网格表、材质槽）、数据区（每个网格的交错顶点和索引）；每个网格记下顶点布局（`VertexLayout`）、反量化参数和是否 meshopt 压缩，见下面的"体积"。材质 `.material.json`、场景 `.scene.json` 先用 JSON（父实体排在前面），以后场景换成二进制。
- **预制体**（2026-11-19，BepuSample）：导入器把 .sdprefab 导出成 `<路径>.prefab.json`（和场景一样的实体层级），脚本属性引用预制体时随场景一起加载（`ContentManager.loadPrefab`，引用的资源先加载好），`Prefab.instantiate(entities)` 每次建一组新实体、返回根实体，预制体里脚本的实体引用指向这一组。场景和预制体共用"预加载资源"和"按实体文件建实体"两步。和 Stride 不同：实体建出来就在游戏里，不用再加进场景。
- **换场景**（2026-11-19）：`game.setRootScene(path | SceneReference)` 对应 Stride 给 `SceneSystem.SceneInstance.RootScene` 赋值：加载新场景（加载期间旧场景照常跑），加载好后先设 `game.rootScene` 再销毁旧场景文件里的实体（子实体、脚本、物体、连着的约束跟着去掉）；连着换几次按顺序来。`game.loadScene` 是叠加加载，不算根场景。脚本属性引用场景时得到 `SceneReference`（只有路径），引用的场景不随引用它的场景加载（场景之间常常互相引用），导入器也不跟着导入。和 Stride 不同：脚本运行中另建的实体不跟着旧场景销毁。
  `game.unloadScene(instance)` 卸载 `loadScene` 叠加加载的场景（Stride 的子场景 Scene.Children，BepuSample 的演示场景这样加载），`setRootScene` 也用它。
- **运行时**（`ContentManager`，`game.content`）：按内容路径加载，同一份只加载一次；`loadScene(path, entities)` 先并行加载场景引用的模型和材质，再按顺序创建实体（`Transform` 和父子、`Model`、`Camera`、`Light`），多网格的模型把多出来的网格挂成子实体。读文件的函数可以换，测试里在 Node 下读内存。
- **管线**（`packages/pipeline`，Node 直接运行 TS）：Stride 工程导入器 `StrideImporter`。YAML 用 `yaml` 库读；Stride 的标签里允许逗号（`!Stride.BepuPhysics.StaticComponent,Stride.BepuPhysics`），按规范不行，所以解析前把标签里的 `,` `[` `]` 换成百分号编码，读完再解码。资源按 GUID 索引；场景的父子关系来自 `Transform.Children` 里引用的子 Transform 组件 id。模型的源文件经 stride-tools 导入（0.2.0 起按节点实例和材质拆网格、烘焙节点变换，同 Stride），网格按材质名对上 `.sdm3d` 的材质槽，应用 `PivotPosition`、`ScaleImport`。材质把 Stride 的颜色树（`ComputeColor`、`ComputeTextureColor`、`ComputeBinaryColor` 加运算符）化成"一张贴图按运算符组合一个线性颜色"（见下面的"贴图"）；`LightSkybox` 和 `BackgroundComponent` 见下面的"天空盒和背景"。不认识的组件（物理、脚本、动画）跳过并计数。命令行：`node packages/pipeline/src/cli.ts import-stride --package 名字=资源目录 … --scene 包名/场景 --out 目录 [--overrides 目录] [--textures ktx2|source|smallest] [--plain]`。
- **Third Person Platformer**（`apps/platformer`）：`pnpm --filter @stride-ts/platformer import:stride` 从 Stride 仓库导入场景和 PrototypingBlocks、mannequinModel 两个资源包（0.8 秒；278 个实体、19 个模型、13 个材质、2 张 SVG 贴图、1 个天空盒，内容共 1 MB，brotli 后 327 KB），页面加载场景用约 120 ms，150 个实例分 34 次绘制，draw 0.3 ms，165 fps。几何、层级、光源、贴图、PBR、天空和色调和 Stride 自带的截图一致；差别：没有阴影、Bloom 和 FXAA，人物停在绑定姿势，没有法线贴图。
- **着色（2026-11-18 起是 PBR）**：和 Stride 默认材质一致（`MaterialSurfaceShadingDiffuseLambert` 加 `MaterialSurfaceShadingSpecularMicrofacet`，公式见 `MeshRenderFeature.ts` 的文件注释）。金属度工作流：镜面色 `lerp(0.02, albedo, 金属度)`、漫反射 `albedo · (1 - 金属度)`，再乘 cavity；直射光是 Lambert 加 GGX、Schlick、Smith-Schlick-GGX（alphaR = 粗糙度²）；没有 Specular 特性的材质没有镜面项；自发光直接加。`Light` 组件有方向光（照向本地 -Z）、环境光（漫反射和镜面都用环境色，同 `LightSimpleAmbient`）、天空盒光（`skybox` 列存 `Skybox.id`）；颜色按 sRGB 写，渲染时转线性再乘强度。直射光（漫反射加镜面）的总和乘 π（`MaterialSurfaceLightingAndShading` 的 "*PI over hemisphere"），所以同样的光强和桌面 Stride 一样亮。
- **材质特性（2026-11-19，PhysicsSample）**：除了漫反射、金属度、光泽度、法线、cavity，还有镜面颜色工作流（`specular`，Stride 的 MaterialSpecularMapFeature：镜面颜色乘强度，漫反射不变暗）、贴图乘颜色的自发光（`emissiveTexture`）、环境光遮蔽（`ambientOcclusion`：数值或贴图的一个通道；环境光全乘，直射光乘 lerp(1, ao, directLighting)）、透明混合（`transparency`：可见的漫反射和镜面乘 alpha、tint，预乘 alpha 混合，画在透明阶段、不写深度，透明的批按第一个实例的距离从远到近；和 Stride 不同：不按 alpha 抖动投阴影、同一批的实例不排序）。没有贴图的槽绑 1x1 白图，一条管线覆盖全部组合。贴图引用的 `srgb` 来自 Stride 的贴图类型，没写时按用途。材质层留给 P2 的着色器系统。
- **贴图采样器（2026-11-19，BepuSample）**：贴图槽带 `filter`（point、anisotropic，默认线性三线性）和 `addressU`、`addressV`（clamp、mirror，默认重复），来自 Stride 的 ComputeTextureBase；材质的每张贴图各自一个采样器（`GpuResources.sampler` 按设置共用）。
- **天空盒和背景**：资源管线读 `.sdsky` 引用的 HDR 立方体贴图（DDS，RGBA16F/32F，`packages/pipeline/src/hdr.ts`），用 stride-tools 算 3 阶球谐（Lambert 预滤波，同 Stride 的 `SkyboxGenerator`），源立方体贴图存成 RGB9E5 的 `.cubemap`（mip 从第 0 级按 2x2 盒式平均重建，同 Stride 贴图编译默认的 GenerateMipmaps；背景也用它）；`<路径>.skybox.json` 是球谐系数、源立方体贴图的路径和镜面贴图的尺寸。镜面的 GGX 预滤波在运行时第一次用到时在 GPU 上做（`SkyboxPrefilter.ts`，256 立方体贴图、1024 个采样，第 i 级粗糙度 i / (级数 - 1)，最高一级只重采样，同 Stride 的 `RadiancePrefilteringGGXNoCompute`），不随内容下载。着色器里天空盒的漫反射是球谐求值，镜面在反射方向上按 `mip = sqrt(alphaR) · 级数` 采样，方向按天空盒的旋转转回去再把 z 取反（Stride 的约定）；镜面项都乘 DFG 查找表（Stride 的 `MaterialSpecularMicrofacetEnvironmentGGXLUT`，按 (1 - sqrt(alphaR), N·V) 采样）。查找表启动时在 GPU 上积分（32x64，1024 个 GGX 样本），和 Stride 自带的 `EnvironmentLightingDFGLUT16` 比最大误差 0.024、平均 0.0013，不用拷它的数据。`BackgroundComponent` 变成 `Background` 组件，`BackgroundRenderFeature` 在网格之后画（全屏三角形在远平面上，深度 less-equal），同 Stride 的 `SkyboxShaderCubemap`。贴图、立方体贴图的 GPU 上传放在渲染系统共用的 `GpuResources`；按 id 登记的资源（网格、材质、立方体贴图、天空盒）共用 `ResourceTable`。
- **HDR 和色调映射**：`ForwardRenderer` 画进 RGBA16F 的颜色缓冲（Stride 的 HDR 渲染模式），再由 `ToneMap` 写进后备缓冲的 sRGB 视图。设置同 Stride 的 `ToneMap` 默认值：对数平均亮度（Rec.601 亮度取 log2 写进 S×S 的 R16F，2x2 平均到 1x1）、随时间适应（AdaptationRate 1）、自动 key 和自动曝光、Hejl2 算子（白点 5）。Stride 在 CPU 上做适应（要回读平均亮度），这里在 GPU 上用两张 1x1 的 R32F 轮流读写，没有回读。
- **贴图（2026-11-18 已实现）**：
  - 管线：`.sdtex` 的源图片经 stride-tools 的 `decodeImage`（stb_image，PNG/JPEG/TGA，@stride-ts/native 0.3.0）解成 RGBA8，再 `encodeBasis` 编成 KTX2（UASTC 加 zstd 超压缩、带 mipmap），写成 `<内容路径>.ktx2`。颜色贴图（`ColorTextureType`，默认 `UseSRgbSampling`）标 sRGB，法线、灰度贴图是线性的。
  - 材质格式：`baseColorTexture` 是 `{ texture, scale, offset }`，采样坐标 `uv * scale + offset`，scale 已经乘上材质的 `Overrides.UVScale`（同 Stride 的 `ComputeTextureBase`）；`baseColorOperator` 是 `multiply`（默认）或 `add`。颜色树里纯颜色的子树导入时算好；"贴图运算颜色"只支持乘和加（TPP 用到的是 `Add`，Stride 的 Add 是 3ds 风格加法，对不透明颜色就是相加），两张贴图或别的运算符记警告、只留一张贴图。以后做着色器系统时，颜色树直接生成着色器代码（Stride 的做法），这个形状就是它的特例。
  - 运行时：`GraphicsDevice` 申请设备有的压缩特性，按 BC > ASTC > ETC2 选转码目标（`textureTarget`），都没有时是 RGBA8。`ContentManager.loadTexture` 用 `Game` 设置的 `textureDecoder`（`ktx2Decoder`：stride-native 的 Basis 转码器在原生线程里并行转各级 mip）；压缩格式要求尺寸是 4 的倍数，不是的贴图退回 RGBA8。`Texture` 和 `Mesh` 一样只放数据，`MeshRenderFeature` 第一次用到时上传（压缩格式按块算每行字节数，小于一个块的 mip 按整块拷贝）。采样器同 Stride 的默认值：重复、线性过滤、mipmap 线性，加 16 倍各向异性。没有贴图的材质绑一张 1x1 的白图，着色器不分支。
- **体积（2026-11-18）**：页面下载的东西都量过，按"调试优先、完整引擎用得到的代码不裁剪、保留小体积下载的能力"取舍：
  - **原生模块不裁剪**：Jolt 的调试渲染器、性能分析器、约束、软体、载具、高度场，Basis 的 HDR、BC4/BC5、ETC1S、XUASTC，运行时导航网格构建都留着（编辑器、地形、法线贴图、动态导航网格、小体积贴图都会用到）；LTO、`-Os`、closure 这些让堆栈难读的优化也先不做。正式版 wasm 留着函数名（`--profiling-funcs`，brotli 后多 4%），另有调试版（Jolt 断言加 Emscripten 运行时检查），`Game.run` 的 `debugNative` 选它，app 传 `import.meta.env.DEV`。
  - **原生模块拆成核心加侧模块**（用户 2026-11-18 定）：核心 `stride-native-core`（任务系统、变换存储、meshopt 解码、动画、插件 API）是 Emscripten 的主模块，物理（Jolt）、贴图（KTX2/Basis 转码）、导航（Recast/Detour）是侧模块，共用同一块内存、分配器和任务系统，速度不变（1000 个盒子的步进实测一样）。游戏用 `Game.run(canvas, { nativeFeatures: [physics] })` 选用，功能从 `@stride-ts/native/<名字>` 导入，没导入的打包器不输出；没加载的功能的方法抛 `NativeError` 并说明怎么加载，KTX2 解码器只在有 texture 时接上。正式版各模块：核心 361 KB（brotli 97 KB），physics 1.6 MB（275 KB），texture 1.1 MB（339 KB），navigation 204 KB（64 KB）；原来整个运行时模块 3.1 MB（728 KB）。第三方也能写 wasm 插件（插件 C API 加 CMake 函数，见 fork 的 `StrideNative/Plugins/README.md`），和内置侧模块一样在启动时加载。
  - **模型**：顶点量化成 16 字节（位置按模型的包围盒 unorm16，精度低于 0.1 mm 时保留 float；法线八面体 snorm16x2；UV 按范围 unorm16，范围超过 16 时保留 float），按顶点缓存和读取顺序重排后 meshopt 编码（`packages/pipeline/src/mesh.ts`，参考 glTF-Transform）；运行时 `ContentManager.meshoptDecoder`（原生 `decodeMeshoptBatch`）并行解码，顶点着色器按网格参数反量化、解八面体法线。TPP 的模型 1.12 MB（brotli 512 KB）变 383 KB（brotli 303 KB），显存也减半。`--plain` 导出不压缩的 float 模型方便调试，运行时两种都能读。
  - **贴图**：除了 KTX2，贴图槽可以是 svg、png、jpeg（`browserImageDecoder`：PNG/JPEG 用 createImageBitmap，SVG 用 Image 加 OffscreenCanvas 按目标尺寸栅格化），只有第 0 级，`MipmapGenerator` 在 GPU 上生成 mip（sRGB 视图，线性空间平均）。导入时 `--overrides` 目录里的 `<内容路径>.svg` 代替源图片；TPP 的两张棋盘格是手写的 SVG（0.8 KB、1 KB，原来的 KTX2 是 16 KB、52 KB；栅格化后和原 PNG 的平均差 0.02 和 3.4），代价是显存里是未压缩的 RGBA8。
  - **天空盒**：见上面，镜面预滤波改在运行时做，内容少 4 MB。
  - **分发**：`tools/vite-app.ts` 是 apps 共用的 Vite 配置，构建后给 dist 里压得小的文件写 `.br` 和 `.gz`，静态服务器打开预压缩文件的支持就直接发。
  - **结果**：TPP 页面下载（正式版 wasm、JS、内容）从约 9.4 MB（brotli 约 1.6 MB）变成 4.2 MB（brotli 1.1 MB），其中 wasm 3.1 MB（brotli 728 KB）；原生模块拆分后 TPP 只要核心，页面 1.6 MB（brotli 约 500 KB），wasm 361 KB（brotli 97 KB）。
- **法线贴图（2026-11-18）**：照 Stride 的 MaterialNormalMapFeature、MaterialSurfaceNormalMap 和 NormalUpdate：切线空间的法线（InvertY、×2-1、由 xy 算 z）乘 TBN，副切线 = w · cross(法线, 切线)。导入器只给材质用法线贴图的网格生成 MikkTSpace 切线（`addTangents`：每个三角形角一份，切线不同的地方拆开顶点），量化成 snorm8x4，顶点从 16 字节变成 20 字节；Stride 在导入时翻转法线贴图的绿色通道（NormalMapTextureType.InvertY，默认开），这里记在材质上、采样后翻转，结果一样，PNG 可以原样复制。TPP 只有人物的两块哑光黑用法线贴图，platformer 的导入改成 `--textures source`：两张 PNG 178 KB，编成 KTX2 是 95 KB，但要多下载 339 KB（brotli）的贴图转码侧模块。
- **和桌面 Stride 的截图比对（2026-11-18）**：TPP 默认设置下平均每通道差 0.7/255，差超过 10 的像素 0%，只剩地面网格线的亚像素差（SVG 棋盘格）。方法和工具见 `tools/stride-capture/tpp/README.md`；比对中修掉了直射光少乘 π、材质贴图多开的各向异性（Stride 默认三线性）、天空盒源贴图用了文件自带的 mip（Stride 从第 0 级重建）；剩下的只有有意保留的 SVG 棋盘格。按通道比 GPU 时间（Stride 用它自己的时间戳）又修了深度预通道、PCF 和 FXAA 的展开。同一块显卡上的帧时间：桌面 Stride 7.70 ms，我们 6.65 ms（关掉后处理时 3.95 对 3.34 ms），明细见那份 README。

## 对齐的验证方法

- **截图比对**：同一场景、同一相机位置，用桌面 Stride、C# 移植版和这里各截一张，算差异图。桌面 Stride 用 `tools/stride-capture`（官方 4.4.2，可以关单个后处理、固定曝光、只留一种光），这边用 `stride shot --diff`；整体偏亮偏暗时用 `tools/hdr-ratio.ts` 看是倍数差还是随角度的差。
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
