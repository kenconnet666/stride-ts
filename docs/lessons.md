# 从 Stride C# 网页移植里学到的经验

来源：2026-11 在 Stride 仓库（`C:\Users\Administrator\IdeaProjects\stride`，分支 `web-experiment-base`）把引擎用 .NET 11 WebAssembly 加 WebGPU 搬进浏览器，并用十几个官方样例和模板游戏验证。下面只列对 TypeScript 引擎同样有用的部分；细节和提交记录在那边的 `docs/browser/ROADMAP.md` 和 git 历史里。

## WebGPU

- **`queue.writeBuffer` 在整个命令缓冲之前生效**，而不是按录制顺序。同一次提交里，如果先用一段缓冲画了东西，再往同一段写新数据，前面的绘制读到的就是新数据。Stride 里这造成过 JumpyJet 标题后面的白框，以及精灵花屏。规则：一次提交里，被绘制用过的区域不能再写；常量数据用环形缓冲或动态偏移，只追加。
- **常量数据只传一次**：Stride 每次提交都把整个常量池从头重新上传，每帧白传 2.7 MB。按"已上传到哪里"只上传新增的部分。
- **每次 draw 都重设全部状态很贵**：pipeline、bind group、顶点缓冲、viewport、stencil、blend 常量，每帧几百次 draw 就是几千次调用。在一个 render pass 内记住上次设置的值，只在变化时调用。
- **bind group 要缓存**。每个 draw 的常量都在缓冲的不同偏移上，就会变成每个 draw 一个 bind group；用动态偏移（`hasDynamicOffset`）就能让多个 draw 共用同一个。
- **不要为了调试标签结束 render pass**：Stride 每个性能剖析作用域都推一个调试组，结果一帧切出 64 个 pass。调试组只在调试模式下用，或者用 pass 编码器自己的 `pushDebugGroup`。
- **scissor 在 pass 内一直有效**：前一个 draw 设了 scissor，后面没打算裁剪的 draw 也会被裁。每个 draw 都要明确设置。
- **片元着色器没有写的颜色目标，`writeMask` 必须设为 0**，否则验证报错。
- **多渲染目标的通道里，每个画进这个通道的管线都要带上全部颜色目标**（2026-11-20，屏幕空间反射的表面）：附件和管线的 targets 要一一对应，不写的目标给 `writeMask: 0`；所以只有一部分特性要多写的目标时，把那部分单独开一个通道（我们把透明的、粒子、线框挪到接着的一遍）。
- **读回是异步的**：`mapAsync` 加一圈 staging 缓冲，读上一帧的结果。不要为了读回而每帧额外提交一次。
- **时间戳查询不是到处都有**：要先判断特性是否支持，再决定开不开 GPU 计时。
- **输出带 alpha 的画布**：透明像素会透出页面背景。不需要透明就把 alpha 写成 1，或者把画布配置成 opaque。
- **着色器里别用运行时的循环次数和动态下标**（2026-11-18，stride-ts 和桌面 Stride 逐通道比 GPU 时间时发现）：
  - Chrome 在 Windows 上把 WGSL 经 Tint 转成 HLSL，再用 DXC（`-O3`）编译。Dawn 的 `use_dxc` 默认已开；强制开或关，GPU 时间都一样。
  - 下标是变量时，DXC 会把整个 vector 存进局部数组再读回来（DXIL 里的 `alloca`），像素着色器里很慢。这包括按下标取 uniform 里 vec4 的分量，比如 `splits[i]`。改法：用 vector 运算，或者和独热向量求点积。
  - 次数只在运行时才知道的循环不会展开。Stride 的着色器是编译期常量加 `[unroll]`；我们这边按情况拆成几个完全展开的函数，或者按设置生成着色器源码（FXAA 预设）。
  - 实际效果：PCF 从 2.9 ms 降到 1.6 ms，阴影级联的分界从 1.6 ms 降到 1.5 ms，FXAA 从 0.62 ms 降到 0.52 ms。
  - 看生成代码：Chrome 加 `--enable-unsafe-webgpu --enable-dawn-features=dump_shaders,disable_symbol_renaming`，控制台里会打出每个着色器的 WGSL、HLSL 和 DXIL 反汇编。
- **浏览器在呈现时多做的事**（读源码确认的，`C:\code\refs` 里的 chromium、firefox）：
  - Chrome 的画布配成 `alphaMode: 'opaque'` 时，每帧呈现前会多画一遍全屏三角形，只写 alpha 通道（`WebGPUTextureAlphaClearer`），开销是一次 bgra8 读写，大约几十微秒。改成 `premultiplied` 能省掉这一遍，但合成器就要把画布当半透明图层混合，所以还是用 `opaque`。
  - 在 Windows 上，首选格式 bgra8unorm 不需要额外拷贝。Mac 的 rgba8unorm、Linux 和 Android 的 bgra8unorm 会多拷一次，所以要用 `getPreferredCanvasFormat()`。
  - Firefox 只有 bgra8unorm 走共享纹理；别的格式要读回 CPU，非常慢。它会把 `viewFormats` 传下去，所以我们这种“bgra8unorm 画布加 sRGB 视图”的写法可以用。
- **测过但没用的**：
  - 关掉 Dawn 的 robustness（越界保护）或校验，GPU 时间不变。
  - 全屏通道的 `loadOp` 从 `clear` 换成 `load`，帧时间不变、通道时间反而多 0.5 ms。NVIDIA 对“清屏后整张覆盖”的情况有快速路径，所以全屏通道照常用 `clear`。

## 浏览器运行环境

- **主线程不能等待**：忙等循环、阻塞等待、"把任务分给线程池然后等结果"，在浏览器里都会让页面卡死。Stride 的物理工作线程、性能剖析器的轮询、并行循环，都出过这个问题。所有"等待"都要改成异步，或者在单线程下直接内联执行。
- **指针锁定**：锁定状态下不要再调用 `setPointerCapture`；锁定需要用户手势和真实窗口，无头浏览器做不到。
- **键盘输入前，画布要先拿到焦点**（先点一下）。
- **按下时就 `setPointerCapture` 到祖先元素，单击就点不到按下的那个元素**（2026-11-20，vue-tsx-pro 的 Tree）：捕获着松开时，click 发给按下的元素和捕获元素的公共祖先。要区分单击和拖动的，过了阈值再捕获，事件在 window 上收。
- **后台标签页不画帧**：`requestAnimationFrame` 停了，等"下一帧"的调用（截图）会一直等。自动化截图前先把标签带到前台。
- **手柄**：Gamepad API 只能每帧轮询；`vibrationActuator`（`dual-rumble`）的单次震动有时长上限，要持续震动就得定时重新触发。
- **无头 Chrome 的帧节奏固定在 60 Hz 左右**：测性能要加 `--disable-frame-rate-limit` 和 `--disable-gpu-vsync`。
- **SharedArrayBuffer 和 wasm 多线程需要跨源隔离**（COOP/COEP 响应头）。有的托管平台设不了这两个头，所以不能作为默认依赖。（2026-11-17 用户决定 stride-ts 只用多线程版，接受这个部署约束，见 [architecture.md](architecture.md)。）
- **大的 wasm 模块编译慢、启动慢**：262 MB 的模块就有明显的启动代价，体积不能完全不管。

## 内容和资源管线

- **着色器排列组合要提前编译**：场景用到的组合在导出时编好；运行时请求了没编过的组合，要么少画东西，要么直接崩溃（Stride 里天空盒就会让游戏停住）。做法是：浏览器运行时把缺失的请求记录下来，导出时补上（Stride 那边的 `effect-requests/*.json` 机制）。
- **内容准备按输入的哈希缓存**：输入没变就整步跳过。只改了游戏脚本时，不要重新准备内容。
- **读写 Stride 的资源文件一律用真正的解析器**（`Stride.Core.Yaml`、`System.Xml.Linq`），不要用正则。例子：组件引用必须写成 `!Stride.BepuPhysics.BodyComponent,Stride.BepuPhysics ref!! <guid>`，`ref!!` 后面少一个空格，引用就会被当成一个对象去解析，组件变成空值，而且编译时不报错。
- **从 Bullet 换到 Bepu 时踩过的坑**，以后把 Stride 物理映射到 Jolt 时同样要注意：
  - Bullet 的角色有自己的重力，Bepu 的角色用仿真的全局重力。Third Person Platformer 的角色重力是 -40，跳跃速度照搬后跳高变成 4 倍，能直接越过围墙。要么改仿真重力，要么按比例换算起跳速度。
  - 坡度角为 0，在 Bepu 里意味着角色什么都站不住，永远在空中。
  - 两个运动学刚体之间不产生接触：触发器和"拳头"之类的物体要用别的方式检测。
  - 场景流式加载的触发器引用的是刚体组件，类型改了，引用也要跟着改。

## 性能经验

- **先测量再优化**：用保留函数名的构建加 CDP 剖析器，看时间花在哪；数每帧的 WebGPU 调用次数和上传字节数。我们第一次剖析就找出了 4 个大头。
- **跨边界调用很贵**：Stride 里是 wasm 到 JS，新引擎里是 JS 到 wasm（物理）。接口要粗粒度：每帧整步、批量读写变换，不要逐个物体调用。
- **托管语言要避免每帧分配内存**：.NET 和 JS 都会因此触发 GC 卡顿。
- **C# 移植版的参考数字**（同一台机器）：
  - FPS 枪战：解释器约 170 ms/帧，jiterpreter 64–170 ms，AOT 10–13 ms。
  - Top Down RPG（AOT）：13–16 ms/帧，主线程一直满载。
  - JumpyJet：解释器 9.3 ms，AOT 3.5 ms。
  - Third Person Platformer（AOT，`-O1`）：无头约 90 fps。
- **C# 版发布慢的原因**，也是这个新项目要避免的：
  - 浏览器里的 .NET 没有 JIT，只能 AOT。
  - Mono 的 AOT 只要有一个程序集变了，就把所有程序集重编。
  - 引擎、.NET 和游戏被静态链接成一个 wasm，任何改动都要重新下载整个文件。

## 工作方式（用户的偏好）

- 用中文沟通；代码、注释、提交信息用英文。
- 说"完成"之前，要在真实的 Chrome 里跑过、截过图。
- 耗时的任务放后台跑，不要阻塞对话；同时跑的重任务要有数（曾经有一个失控的预热进程吃掉 37 GB 内存）。用户不喜欢干等，长步骤要主动想办法提速，被问到时报告 CPU 占用。
- 调研和读代码自己做，不要派子代理（用户明确叫停过一次）。
- 提交时写明具体路径（`git commit -- <paths>`）；不推上游；对外的操作（建仓库、发评论、发 PR）先问用户。
- 发现已经推送的东西有问题，要第一时间说清楚并修好，不要藏着。

## 参考位置

- 调研全文：本仓库 [research.md](research.md)。
- Stride 仓库：`C:\Users\Administrator\IdeaProjects\stride`。
  - 网页移植的构建脚本：`build/browser`（`Stride.Browser.Game.targets`、`PrepareGameContent.ps1`、`MonoAotCache`、`validate-sample.cjs`）。
  - 路线图和决策：`docs/browser/ROADMAP.md`。
  - 原型要用的游戏：`samples/Templates/ThirdPersonPlatformer`（已转换为 Bepu）。
- 已经打好包、可以直接跑的 C# 版游戏副本：`C:\Users\Administrator\IdeaProjects\stride-games`（`aot/` 下是 AOT 发布输出）。
- 试玩和测量脚本：本仓库 [`tools/`](../tools/README.md)。
