# Stride 的 TypeScript 孪生版：调研

（复制自 Stride 仓库 `docs/browser/ts-twin-research.md`，2026-11-16。）

状态：调研，2026-11-16。要回答的问题：做一个"形状像 Stride"的浏览器引擎，引擎代码用 TypeScript 写（编译快、能热重载）；计算量大的部分交给预编译好的 WebAssembly 库，这些库很少重编、可以长期缓存；凡是已经有成熟 JavaScript 库或浏览器 API 的地方，直接用现成的。

## 为什么这种分工在浏览器里成立

浏览器用 JIT（V8、SpiderMonkey）编译 JavaScript。WebAssembly 里的 .NET 没有 JIT：它的解释器比 AOT 代码慢 10 到 30 倍，所以 C# 移植版每次改动都要做一次 AOT 编译（见 Stride 仓库的 `docs/browser/ROADMAP.md`）。TypeScript 引擎不需要编译这一步就能以 JIT 的速度运行：esbuild 或 Vite 重新构建一次改动远不到一秒，还能原地替换模块。JavaScript 不擅长的部分（对大量对象做紧凑的数值循环），交给编译一次的 WebAssembly 库：物理、导航、纹理转码。

已经用这种方式做出来的引擎：
- Babylon.js：TypeScript，2026 年 3 月发布 9.0，支持 WebGPU 和 WebGL 2。
- PlayCanvas：JavaScript 加 TypeScript 类型声明，2.x 起支持 WebGPU。
- three.js：WebGPURenderer 和 TSL 着色语言，r182 起成为推荐渲染器。
- Cocos Creator 3：TypeScript 引擎层，下面是原生代码。

这些引擎的物理都是 WebAssembly（Havok、Ammo/Bullet、Rapier、Jolt）。

## Stride 运行时用到什么，浏览器里换成什么

依据：`sources/Directory.Packages.props`、运行时项目（`sources/core`、`sources/engine`、`sources/plugins`、`sources/shaders`）的包引用、`[DllImport]` 的库名，以及 `deps/` 目录。

| 方面 | Stride 现在 | 浏览器里的替代 | 类别 |
|---|---|---|---|
| 图形 API | Direct3D 11/12、Vulkan、WebGPU（C# 移植版用 `wgpu_native` 和 emdawnwebgpu） | WebGPU（`navigator.gpu`），需要时用 WebGL 2 兜底 | 浏览器 API |
| 窗口、输入 | SDL（Silk.NET.Sdl）、DirectInput、XInput | DOM 指针和键盘事件、Pointer Lock、Gamepad API（含震动）、`devicemotion` | 浏览器 API |
| 音频 | `strideaudio`（XAudio2、OpenAL、OpenSL ES、AVFoundation） | Web Audio API（3D 用 panner 节点，流式播放用 AudioWorklet） | 浏览器 API |
| 压缩音频 | Celt（`deps/Celt`） | 导出时转码为 Opus 或 Ogg Vorbis，浏览器的 `decodeAudioData` 和 WebCodecs 都能解码；只有必须保留 Celt 时才用 WebAssembly 版 libopus | 导出步骤 |
| 视频 | FFmpeg（FFmpeg.AutoGen） | `<video>` 加 `copyExternalImageToTexture`，或 WebCodecs `VideoDecoder` | 浏览器 API |
| 运行时字体 | FreeType（`freetype`） | Canvas 2D `fillText` 画进字形图集（系统字体和网络字体都能用）；需要轮廓时用 opentype.js；只有要求和桌面完全一致时才用 WebAssembly 版 FreeType | 浏览器 API |
| 预编译字体 | 资源编译时用 msdfgen | 导出时用 msdf-atlas-gen，运行时只采样图集 | 导出步骤 |
| 图片 | SixLabors.ImageSharp（Stride.Foundation） | `createImageBitmap`、`ImageDecoder` | 浏览器 API |
| GPU 纹理 | 编译时用 DirectXTex、astcenc 生成 BC/ASTC | KTX2 加 Basis Universal（官方的 WebAssembly 转码器）；设备支持 `texture-compression-*` 时直接用 BC/ASTC | 预编译 wasm |
| 内容压缩 | LZ4（K4os.Compression.LZ4.Legacy） | HTTP 的 brotli/gzip、`DecompressionStream`；网格用 meshopt 压缩（meshoptimizer 解码器） | 浏览器 API、小型 wasm |
| 物理 | BepuPhysics 2.5（C#） | Jolt（JoltPhysics.js 1.x，WebAssembly，功能最接近 Bepu：角色、约束、软体）；Rapier（`@dimforge/rapier3d` 0.19.x，Rust 编成 WebAssembly，有 SIMD 版和确定性版）；Havok（Babylon 的插件）；或者把 Bepu 本身编成 wasm（见下一节） | 预编译 wasm |
| 导航 | DotRecast（C# 版 Recast 和 Detour） | recast-navigation-js 0.43.x（Recast 和 Detour 的 WebAssembly 版，算法相同）；navcat（纯 JavaScript 移植） | wasm 或 JS |
| VR | OpenXR（Silk.NET.OpenXR）、Oculus OVR、OpenVR | WebXR | 浏览器 API |
| 着色器 | SDSL，经 SPIR-V（SPIRV-Tools、SPIRV-Cross、DXC）编译；C# 移植版再用 naga 转成 WGSL | 导出时写好或生成 WGSL；场景用到的效果排列组合提前编译（C# 移植版的内容步骤已经在做） | 导出步骤 |
| 场景格式 | Stride 对已编译资源的二进制序列化 | 网格、材质、蒙皮和动画用 glTF 2.0，实体和组件用一份 JSON 场景描述 | 导出步骤 |
| 性能剖析 | VTune、WinPix | 浏览器性能面板、WebGPU 时间戳查询 | 浏览器 API |
| 崩溃报告 | 原生崩溃处理器 | `window.onerror`、JavaScript 错误上报 | 浏览器 API |

只留在桌面、永远不进浏览器的：编辑器（Game Studio，WPF/Avalonia）、资源编译器及其工具（Assimp、DirectXTex、astcenc、VHACD、msdfgen、FFmpeg 导入、SPIRV-Cross、SPIRV-Tools、DXC、LLVM）、Roslyn、MSBuild、NuGet。

所以运行时真正需要 WebAssembly 库的只有三块，而且都是别人维护、预先编好的：物理（Jolt 或 Rapier）、导航（Recast）、纹理转码（Basis）。其余要么是浏览器 API，要么在导出内容时一次性处理掉。

## 把 C# 库编成 wasm 给 JavaScript 调用

可行，而且对孪生版有一个独特的好处：物理可以继续用和桌面 Stride 完全相同的 BepuPhysics，同一个场景在两边的物理表现一致。换成 Jolt 或 Rapier，行为总会有差异。

两条技术路线：

1. **Mono 版 .NET WebAssembly 加 `[JSExport]`**：现在就能用，C# 移植版用的就是它。
   - 页面加载 .NET 运行时（`dotnet.js`），只为物理这一个库服务。
   - 接口要粗粒度：例如"创建物体""步进一帧"。每帧的位置和朝向写进一块固定的 `float` 数组，JavaScript 直接从 wasm 内存读取，不逐个物体跨边界调用。
   - 物理库必须 AOT，否则太慢。但它很少改，编一次后按内容哈希命名，就能长期缓存。C# 移植版今天做的 AOT 编译缓存（`build/browser/MonoAotCache`）可以直接复用。
   - 代价：要多下载一个 .NET 运行时；而且 .NET 11.0.0 的 Mono LLVM 有个 SIMD bug（dotnet/runtime#136319，修复是 #137615，还没发布），目前 Bepu 只能关着 SIMD 编译，性能打折。
2. **NativeAOT-LLVM**：把 C# 编成不带 Mono 运行时的独立 wasm，用 `[UnmanagedCallersOnly(EntryPoint = ...)]` 导出 C 函数，体积更小、调用更快。但它仍然是 dotnet/runtimelab 里的实验分支，公开的问题和合并请求大多停在 2024 年，不适合作为依赖。

结论（2026-11-16 已定）：以 C/C++/Rust 编成的现成 wasm 库为主。C# 编成 wasm 要额外带一个 .NET 运行时（体积和启动时间都多出一大截），必须 AOT，而且目前只能关着 SIMD 编 Bepu，最大的性能优势就丢了。它只在"物理必须和桌面 Stride 完全一致"成为硬性要求时才值得做，而且应该作为物理接口背后的一个可选实现。

## 原生库选型

原则：优先用浏览器 API；其次是有人长期维护、已经有 JS 绑定的 C/C++/Rust 库；自己写原生代码放在最后。

| 用途 | 选择 | 备选 | 不选，以及原因 |
|---|---|---|---|
| 物理 | **Jolt**（C++，JoltPhysics.js，由 Jolt 的作者本人维护）。功能覆盖 Stride 用到的：角色、约束、软体、车辆、布娃娃；有带 SIMD 的多线程版本；《地平线：西之绝境》在用，Godot 也已内置 | **Rapier**（Rust）：JS API 更顺手，有跨平台确定性版本，适合联网同步和回放；npm 包是单线程的 | Havok：闭源二进制，不能自己改和重编。Ammo.js：Bullet 的老移植，维护少。cannon-es、crashcat：纯 JS，性能和成熟度不够。Bepu 编成 wasm：见上一节 |
| 导航网格 | **recast-navigation-js**（C++ 的 Recast 和 Detour）。Stride 用的 DotRecast 是同一套算法的 C# 移植，导航参数可以一一对应 | navcat（纯 JS 移植，体积小） | 自己写：没必要 |
| GPU 纹理 | **KTX2 + Basis Universal 转码器**（glTF 标准扩展 KHR_texture_basisu），在 Worker 里转码 | 设备支持时直接用 BC 或 ASTC | 运行时用 JS 解 PNG 再上传：显存和带宽都浪费 |
| 网格压缩 | **meshoptimizer**（EXT_meshopt_compression）：解码器很小、很快，也能压缩动画和实例数据 | Draco，只在已有 Draco 资源时用 | Draco 作为默认：解码器大，只压缩几何 |
| 文字排版 | 浏览器 Canvas 2D（本身就支持复杂文字的排版）加离线生成的 MSDF 图集 | harfbuzzjs，仅当 MSDF 文字需要阿拉伯文、印地文这类复杂排版时 | FreeType wasm：浏览器已经能栅格化字体 |
| 骨骼动画 | 底层引擎的动画系统，Stride 的混合树用 TS 移植 | ozz-animation（C++），只在动画混合成为热点时 | — |
| 音频解码 | 浏览器原生（Opus、Vorbis、MP3、AAC） | — | 任何 wasm 解码器 |
| 自己写的原生代码 | 新代码用 **Rust**（wasm-bindgen 和 wasm-pack 工具链最顺手，也更安全） | 复用现有代码时用 C++ 加 Emscripten | 用 C# 写新的原生库 |

## 线程模型与 API 取舍

### Stride 现在的线程模型

- **主循环**：Update 和 Draw 在一条线程上，但其中的渲染准备、变换计算、剔除，通过 `Dispatcher.For` 和 `ForEach` 分发到线程池并行。
- **脚本**：`MicroThread` 调度器，单线程协作式。`AsyncScript` 通过 `await Script.NextFrame()` 让出执行权。
- **物理**：Bepu 在自己的线程调度器上多线程步进；脚本里的射线检测、形状检测是同步调用，直接返回结果。
- **音频**：原生音频库有自己的线程。
- **资源加载**：`Content.LoadAsync` 在线程池上异步加载；`Content.Load` 会阻塞等待。

### 浏览器的现实

- 主线程是事件循环，不能阻塞：主线程上不能用 `Atomics.wait`，同步等待网络也不行。
- Worker 有各自独立的堆。要共享内存（SharedArrayBuffer、wasm 多线程），页面必须开启跨源隔离，也就是带上 COOP/COEP 响应头。有些托管平台设不了这两个头，这是部署上的硬约束。
- WebGPU 可以通过 OffscreenCanvas 在 Worker 里使用；但 `AudioContext` 只能在主线程创建（AudioWorklet 在音频线程里跑）。

### 取舍

> 2026-11-17 修订：用户决定只用多线程版，放弃单线程路线。部署必须带 COOP/COEP，第 3 条从"可选"变成"唯一"。

1. **一条主线程驱动完整的一帧**：逻辑、脚本、物理步进、渲染命令编码。顺序和 Stride 的 Update/Draw 一致；物理查询仍然是同步的，保留 Stride 的 API 形状。物理步进从主线程发起，由 Jolt 的任务系统分给工作线程并行算，主线程等待时自己也执行任务（Emscripten 在主线程上用忙等代替 `Atomics.wait`，步进很短，可以接受）。
2. **Worker 只做无状态的重活**：纹理转码（Basis）、网格解码（meshopt）、导航网格构建（Recast）。数据通过可转移的 ArrayBuffer 传递。
3. **只出多线程版**：`stride-native` 用 `-pthread` 编译，Jolt 用自己的任务系统，变换数据就在共享的 wasm 内存里。页面必须开启跨源隔离（COOP/COEP），设不了这两个头的托管平台不支持。
4. **暂时不做：整个引擎搬进 Worker（OffscreenCanvas）**：输入、音频、DOM UI 都要通过消息转发，物理查询也会变成异步，和 Stride 的 API 差别太大。等主线程真的出现卡顿再考虑。

### Stride API 到 TypeScript 的对应

| Stride | TS 孪生版 | 说明 |
|---|---|---|
| `SyncScript.Update()` | 每帧回调 `update()` | 一一对应 |
| `AsyncScript` 加 `await Script.NextFrame()` | async 函数加 `await this.nextFrame()` | 都是单线程协作式，语义一致 |
| `Dispatcher.For` 并行循环 | JS 里是普通循环；只有纯数据批处理才交给 Worker。wasm 里（物理、变换、剔除）用 `stride-native` 的 pthread 线程池 | JS 对象不能跨线程共享，只有 wasm 内存是共享的 |
| `Content.Load`（同步） | `await content.load()`；预加载过的资源可以同步 `get()` | 浏览器里网络请求只能异步；C# 移植版的 `BrowserContent.PreloadAsync` 是同一个思路 |
| Bepu 的 `BodyComponent`、`StaticComponent` | 组件背后是 Jolt 的 Body | Stride 的 32 个碰撞层，映射成 Jolt 的 ObjectLayer 加层对过滤表 |
| Bepu 接触事件 | 步进期间在 wasm 里收集接触，步进结束后统一派发到 JS | 不在步进中途逐个接触回调 JS，避免频繁跨边界 |
| `CharacterComponent`（Bepu 动态刚体加支撑约束） | Jolt 的 `CharacterVirtual`（运动学角色，用形状扫掠移动） | 爬坡、上台阶的手感会不同，要逐个游戏调参；方法名保留 `Move`、`TryJump` |
| 物理固定步长加插值 | 一样 | 保持 Stride 的行为 |
| `Vector3`、`Matrix` 值类型 | 预分配的可变对象或基于 Float32Array 的数学库 | JS 里每 new 一个对象都是堆分配：引擎路径上每帧不能分配内存，否则会触发 GC 卡顿 |
| 对象由 .NET GC 回收 | Jolt 对象要手动 `destroy()`，Rapier 要 `free()` | wasm 对象的生命周期绑定到组件的挂载和卸载上；调试版检查泄漏 |
| `Input.IsKeyDown`（轮询） | 由 DOM 事件更新的轮询状态 | C# 移植版已经是这样做的 |

## 组件写法与加载优化（设计草案）

脚本和组件沿用 Stride 的名字和结构，C# 脚本可以逐行翻译；按 TypeScript 的习惯调整。完整示例见 stride-ts 仓库的 README。

| Stride（C#） | TS 孪生版 |
|---|---|
| `Entity.Get<T>()` | `entity.get(Type)`：泛型在运行时不存在，把类本身传进去 |
| 公开属性和字段 | `SyncScript.props({ ... })` 里用 `prop` 声明，类型由推导得出（2026-11-18 起不用装饰器，见 [architecture.md](architecture.md) 的"组件 API"） |
| `SyncScript.Update()`，`AsyncScript` 加 `await Script.NextFrame()` | `update()`，async 的 `execute()` 加 `await this.nextFrame()` |
| 组件类型 | 名字默认由源文件路径加导出名推出，引擎和库的组件手写；运行时按导出场景里的 `type` 找到模块、创建实例 |
| `Vector3` 等值类型 | 可变对象，预分配、每帧复用 |
| `out`、`ref` 参数 | 传入一个结果对象让它填写，如 `simulation.raycast(from, to, hit)` |
| `Content.Load`（同步） | `await content.load()` 或 `loadGroup()`；之后同步 `get()` |
| 改脚本要重新编译、重启 | Vite HMR 只替换这个模块，已有实例换成新类，字段值保留 |

TS 版能用、而且写法基本不变的优化：
- **实例化渲染**：同网格加同材质由引擎自动合批；大量物体用 `InstancingComponent`，变换放在 TypedArray 里按下标改。
- **资源懒加载**：按场景或区域分组打包，在 Worker 里解码，用到时 `await content.loadGroup()`。
- **代码懒加载**：按关卡拆分脚本，动态 `import()`。这是 C# 版做不到的。
- **缓存三层**：
  - 网络：文件按内容哈希命名，`immutable` 缓存，可选用 Service Worker 支持离线。
  - 内存：资源引用计数，可以用 `using` 自动释放。
  - GPU：管线和着色器模块缓存，用 `createRenderPipelineAsync` 在加载时预热。
- **对象池**：子弹、特效这类频繁生成的实体复用，避免触发 GC。
- **数据布局**：引擎内部把变换等数据按结构数组存进 TypedArray，脚本看到的仍是对象视图。

## 长期缓存

- 预编译的库（`jolt.wasm`、`recast.wasm`、`basis_transcoder.wasm`，或者物理用的 .NET 运行时加 Bepu）和引擎包都按内容哈希命名，以 `Cache-Control: immutable` 提供：游戏更新时这些都不用重新下载。
- 游戏自己的代码打成一个单独的小包，游戏更新时只有它会变。
- 内容按场景或资源组拆分，各自按哈希命名，改了哪组只重新下载哪组。

这正是 C# 移植版做不到的：AOT 会把引擎、.NET 和游戏链接进同一个 `dotnet.native.wasm`，游戏的任何改动都会让它整个变掉。

## "孪生"要保留 Stride 的什么

1. **创作流程**：Game Studio 和资源编译器保持不变，增加一个导出步骤，输出 glTF、KTX2、Opus、JSON 场景，以及材质的 WGSL。C# 移植版的内容步骤已经能把效果编译成 WGSL。
2. **游戏的组织方式**：带组件的实体（Transform、Model、Light、Camera、Script、Physics）、场景和子场景、预制体；脚本 API 用 TypeScript，但沿用 Stride 的命名（`SyncScript.update`、`AsyncScript.execute` 用 async 函数、`Entity.get(Component)`），这样 C# 脚本可以照着翻译过来。
3. **渲染功能**：直接来自底层引擎：PBR 材质（glTF PBR 加扩展，对应 Stride 的材质层）、集群光照、阴影、后处理。

要放弃的东西：
- C# 游戏脚本（改用 TypeScript）。
- 原样使用自定义 SDSL 着色器（需要移植成 WGSL，或写一个生成器）。
- Stride 的 UI 系统（移植到 TypeScript，或在画布上叠一层 HTML）。
- 如果物理不用 Bepu：Jolt 或 Rapier 没有的 Bepu 功能，以及因此带来的场景行为差异。

## 底层引擎的选择

| | PlayCanvas | Babylon.js | three.js | 自己写渲染器 |
|---|---|---|---|---|
| 组织方式 | 实体加组件加脚本，最接近 Stride | 节点和网格组成的场景图，加 behavior | 场景图，只有渲染器 | 按我们的设计 |
| 语言 | JavaScript 加 TypeScript 类型 | TypeScript | JavaScript 加类型 | TypeScript |
| WebGPU | 支持（2.x，有计算着色器） | 支持（9.x，帧图、集群光照） | WebGPURenderer、TSL | 要自己写 |
| 物理 | 内置 Ammo，其他通过插件 | Havok 插件等 | 不内置 | Jolt 或 Rapier |
| 达到 Stride 功能的成本 | 低 | 低 | 中 | 以年计 |

在 PlayCanvas 或 Babylon.js 之上做孪生版，第一天就有渲染、加载器和工具；Stride 的"形状"（组件命名、脚本 API、场景格式）是我们自己要写的那一层。自己写渲染器，要做好几年才能跑起一个游戏。

**推荐（2026-11-16）：PlayCanvas**，Babylon.js 作为备选。PlayCanvas 的实体加组件加脚本和 Stride 一一对应，我们写的适配层最薄；引擎精简，出了问题容易读源码、打补丁；脚本系统支持热替换；WebGPU 成熟。代价是它的源码是 JavaScript 加 JSDoc 类型声明，改引擎内部不如原生 TypeScript 顺手。如果原型阶段发现缺的渲染功能太多（材质特性、后处理），就换成功能更全、原生 TypeScript 的 Babylon.js。这个判断来自两个引擎公开的架构和版本信息，还没在我们的场景里实测。

> 2026-11-17 再次修订：用户决定渲染器也自己写，作为长期工程：和 Stride 对齐、数据导向、和 Jolt 共享内存；不用 three.js，也不 fork PlayCanvas。设计见 [architecture.md](architecture.md)。
>
> 2026-11-17 修订：方向改为"JS/TS 在仓库内自己维护、原生库合成一个 wasm"之后，推荐改成 **three.js 负责渲染、引擎层自己按 Stride 的形状写**，fork PlayCanvas 作为备选。理由见 [own-stack.md](own-stack.md)。

## 用来做决定的原型

新开一个小仓库，做一个能量化对比的原型：

1. 从 Game Studio 导出第三人称平台跳跃游戏（Third Person Platformer）：场景导成 JSON，网格和动画导成 glTF，纹理导成 KTX2。
2. 在自己的引擎层加 three.js 上加载它（2026-11-17 修订；原计划是 PlayCanvas 或 Babylon.js），角色物理用 Jolt，角色控制脚本从 C# 翻译成 TypeScript。另做一个物理用"Bepu 编成 wasm"的版本。
3. 在同一台机器上和 C# 移植版对比：帧时间、首次加载时间、体积、从改一行脚本到页面跑上新代码的时间，以及脚本热重载的实际体验。

需要你决定的事（都定了）：
- 渲染和引擎层：用户已决定（2026-11-17）自己写，和 Stride 对齐、数据导向、和 Jolt 共享内存。
- 游戏脚本只用 TypeScript（roadmap.md 的 D5，2026-11-19）。
- C# 移植版停止，只当参考实现（D6，2026-11-19）。

## 来源

- [Rapier](https://rapier.rs/)、[rapier.js](https://github.com/dimforge/rapier.js)（0.19.x）
- [JoltPhysics](https://github.com/jrouwe/JoltPhysics)、[JoltPhysics.js](https://github.com/jrouwe/JoltPhysics.js)
- [recast-navigation-js](https://github.com/isaac-mason/recast-navigation-js)（0.43.1）、navcat
- [Babylon.js 9.0 发布公告](https://blogs.windows.com/windowsdeveloper/2026/03/26/announcing-babylon-js-9-0)
- [PlayCanvas 引擎版本](https://radiancefields.com/platforms/playcanvas)
- [three.js WebGPURenderer](https://threejs.org/manual/pages/webgpurenderer)
- [dotnet/runtimelab（NativeAOT-LLVM 实验）](https://github.com/dotnet/runtimelab)
- [Native AOT 互操作（UnmanagedCallersOnly 导出）](https://learn.microsoft.com/dotnet/core/deploying/native-aot/interop)
- [JoltPhysics.js 的多线程版本](https://app.unpkg.com/jolt-physics@1.1.0/files/README.md)、[Emscripten 多线程讨论 #110](https://github.com/jrouwe/JoltPhysics.js/discussions/110)
- [Rapier 的 parallel 特性](https://github.com/dimforge/rapier)、[wasm-bindgen-rayon](https://docs.rs/crate/wasm-bindgen-rayon/1.0.0)
- [WebAssembly 多线程（web.dev）](https://web.dev/articles/webassembly-threads)、[Emscripten pthreads](https://emscripten.org/docs/porting/pthreads.html)
