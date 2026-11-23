# 测试和构建脚本

试玩、截图比对、性能和剖析都用调试 CLI `stride`（[packages/cli](../packages/cli/README.md)）：开发服务器或 preview 服务器上的游戏连上调试中枢后，`pnpm exec stride <命令>` 就能查看和操作它。常用的组合：

| 要做的事 | 命令 |
|---|---|
| 打开并等游戏跑起来 | `stride open http://localhost:5184/ --headless --size 1280x720`（preview 的地址加 `?debug`） |
| 试玩 | `stride key KeyW --hold 1500`、`stride key Space`、`stride mouse move 200 0`、`stride inspect PlayerCharacter` |
| 和桌面 Stride 比画面 | `stride eval '<关效果、固定曝光的设置>'`、`stride call dither '{"on":false}'`（输出的抖动会让每个像素差一个灰阶），再 `stride shot ours.png --diff stride-capture/<参考>.png`（`meanSignedRgb` 是我们减 Stride，看整体偏亮偏暗）；偏亮偏暗时 `node tools/dev/hdr-ratio.ts <参考.png> ours.png` 看是倍数差还是随角度的差 |
| 帧时间、各通道 GPU 耗时、各系统 CPU 耗时 | `stride perf --seconds 5`；不限帧率测：`stride open <地址> --headless --chrome-arg=--disable-frame-rate-limit --chrome-arg=--disable-gpu-vsync` |
| CPU 剖析 | `stride cpu-profile --seconds 5 [--callers <函数名正则>] [--out profile.json]` |
| WebGPU 调用次数 | `stride gpu-calls` |
| 原生侧（物理步进、物体数、内存） | `stride native`、`stride logs --source native` |

目录的分法：根上是直接敲的命令（回归、验证、停后台、测量、导入、发原生和 vue-tsx-pro 的临时版）和它们的数据（`budgets.json`）；`lib/` 是被样例和脚本引用的模块（冒烟的公共部分、Vite 配置、按改动挑样例、跑页面）；`dev/` 是偶尔用的测量、分析、生成脚本；`editor-accept/`、`debug-bridge/`、`stride-capture/` 各是一套。

这里剩下的脚本：

| 脚本 | 作用 |
|---|---|
| `lib/vite-app.ts` | apps 共用的 Vite 配置（`strideApp(端口)`）：跨源隔离的响应头、不预打包原生模块、调试中枢（`strideDebug`）、构建后写 `.br`/`.gz` 预压缩文件 |
| `measure.ps1` | 测每个样例的工程数字：导入时间、构建时间、页面下载量（原始和 brotli）、启动各阶段（`Game.startup`）、帧时间（preview 构建、无头 Chrome 不限帧率、`stride perf`）。桌面 Stride 的帧时间用各截图工程的 `--benchmark`（`stride-capture/Benchmark.cs`）。用法：`pwsh tools/measure.ps1 [-Apps a,b] [-SkipImport] [-Out measure.json]` |
| `import-all.ps1` | 把所有样例（或 `-Apps` 给的）从 Stride 源码重新导入，几个并行（`-Parallel`，默认每 8 个逻辑核一路、最多 4 路），最后打印结果表。验证跑着的时候不要用（验证工作树联接着主检出的内容）。用法：`pwsh tools/import-all.ps1 [-Apps a,b] [-Parallel 4]` |
| `lib/affected.ts` | 按改动挑冒烟样例（测试的第 2 层）：和参数给的提交（默认 origin/main）比（加上没提交的），样例目录 → 它自己，引擎的模块 → 用得最多的几个样例，认不出的 → 五个代表样例，只改文档的不跑。`regress.ps1 -Changed` 调它 |
| `regress.ps1` | 回归：所有样例的冒烟脚本跑一遍，每个样例单独起开发服务器（`--force`）、单独开无头 Chrome（CLI 状态目录按样例分开），几个样例并行（`-Parallel`，默认每 8 个逻辑核一路、最多 4 路；冒烟不看帧时间，并行不影响结果），最后打印结果表。页面带 `?stride-workers=4`：工作线程数固定，原生内存的预算和机器的核数无关；还带 `stride-pointer-lock=virtual`：锁鼠标只在引擎里模拟（`InputManager.simulatePointerLock`），无头 Chrome 真锁上时会把用户的系统鼠标限制在屏幕左上角它那个看不见的窗口里。自己用 `stride open --headless` 测锁鼠标时也带上它。`-Editor`：冒烟过了以后在同一个开发服务器上再跑编辑器验收（`editor-accept/accept.ts`，内容目录先保护、验完还原）；`-Changed` 时改了编辑器、场景的加载和格式、验收工具就自动对 platformer、greybox 跑（`affected.ts --editor`）。用法：`pwsh tools/regress.ps1 [-Apps physics-sample,topdown-rpg | -Changed [-Base HEAD~1]] [-Parallel 4] [-Editor]`（`-Base` 是 `-Changed` 和谁比，默认 origin/main，已经推送了的指推送前的提交）。跨平台：环境变量 `STRIDE_CHROME_ARGS`（空格分开的 Chrome 参数；没有显卡的机器用 SwiftShader 的软件 WebGPU 要 `--use-vulkan=swiftshader` 这几个，原因见 docs/lessons.md 的 WebGPU 一节）；画面固定 1280x720（冒烟的坐标和 UI 布局按这个大小写）。失败的样例后面附上 Chrome 自己的日志（`chrome.log`）里和 GPU 有关的行 |
| `stop-dev.ps1` | 停掉留在后台的开发服务器（vite）和调试 CLI 开的无头 Chrome：做完一个样例的验证就跑一遍（`-Keep <样例>` 留下还在用的，`-List` 只看）。回归、验证工作树的和别的会话的（状态目录 `~/.stride-ts/agent-*`）默认不动，`STRIDE_STATE_DIR`、`STRIDE_BROWSER_DIR` 指着的算自己的，`-All` 全停。它们不用了也一直占着显卡，几个叠在一起帧时间和冒烟的时序都不可信 |
| `verify.ps1` | 测试槽（用户 2026-11-23 定：不用 GitHub 的 CI，提交了直接推，测试后置）：单独的 git 工作树里先跑类型检查、单测、lint（`-NoChecks` 不跑），再跑真实显卡上的回归（或者 `-Script` 给的截图比对、测量），挂后台，主检出接着改。三个槽位用 `../stride-ts-verify-<槽位>`：3（默认）专门验证，1、2 可以被拿去开发（在分支上或有没提交的改动时这个脚本拒绝动它）；每个槽位的 CLI 状态在 `~/.stride-ts/regress-<槽位>`、开发服务器端口加 10000 + 1000 × 槽位。工作树切到给定的提交（分离头指针）、`pnpm install`，导入的内容用目录联接指向主检出，再跑脚本（默认 `regress.ps1`）。先本地提交，不等它就推送。用法：`pwsh tools/verify.ps1 [-Slot 1|2|3] [-Ref <提交>] [-Script tools/measure.ps1] [给脚本的参数，如 -Apps jumpy-jet,physics-sample]` | 停一次正在跑的验证时，停外层的 pwsh 不够（`regress.ps1` 和它的 node 子进程还在跑、和下一次抢开发服务器和无头 Chrome）：按命令行找含 `stride-ts-verify-<槽位>` 的 node、pwsh 进程停掉，再 `stop-dev.ps1 -All`。
| `debug-bridge/` | Chrome 扩展 Stride Debug Bridge：让 `cpu-profile`、`mouse --trusted` 在用户平时的 Chrome 里也能用（`chrome.debugger`，Chrome 不许默认配置文件开远程调试端口）。安装见其中的 README |
| `lib/smoke.ts` | 样例冒烟脚本（`apps/*/scripts/smoke.ts`，`pnpm --filter <样例> smoke`）共用的部分：`startSmoke(中枢名)` 给出调 CLI 的 `stride`、`check`，`finish()` 查本次运行以来的错误日志、把统计量（`stride metrics`）和 `budgets.json` 里记的基线比，再按结果退出 |
| `budgets.json` | 每个样例冒烟跑完时的统计量基线（实体数、绘制次数、显存、原生内存）。回归时不能比它高出太多（个数 1.5 倍加 16，字节 1.3 倍加 4 MB），抓成倍的退步和泄漏。有意的变化之后在验证工作树里重记（`$env:STRIDE_UPDATE_BUDGETS = 1; pwsh tools/verify.ps1`），再把工作树里的 `tools/budgets.json` 拷回主检出。场景里有雨雪时多出天空遮挡的深度图（512x512 depth32float，1 MB；每次重画 TPP 上 0.009 ms，默认每秒一次），样例默认没有雨雪，基线里没有它 |
| `dev/cdp-eval.ts` | 页面没连上调试中枢（游戏启动前出错、停在加载）时直接经 DevTools 协议在 stride 启动的 Chrome 里求值：默认报页面的文字，`--reload` 重新加载、等 15 秒报这期间的异常和控制台的错误。用法：`node tools/dev/cdp-eval.ts [--headless] [--reload] [<表达式>]`（开发服务器的编译错误先看 `stride logs --source server`） |
| `dev/hdr-ratio.ts` | 两张截图（都固定曝光 EV0、关掉 FXAA 和亮部提取）反推色调映射前的 HDR 值，按行打印参考/我们的比值，分辨整体倍数和随角度的差。用法：`node tools/dev/hdr-ratio.ts <参考.png> <我们的.png>` |
| `stride-capture/` | 桌面 Stride 的截图工程，每个样例一个子目录（`tpp/`、`animated-model/`、`physics-sample/`、`bepu-sample/`、`platformer2d/`、`topdown-rpg/`、`first-person-shooter/`、`sprite-fonts/`、`game-menu/`、`ui-element-link/`、`ui-particles/`、`simple-audio/`）：`setup.ps1` 从 Stride 源码搭出并编译，截图参数见各自的 README |
| `dev/library-thumbnails.ts` | 编辑器材质库、特效库的缩略图（`packages/editor/src/library/thumbnails/*.webp`）：借 greybox 的开发服务器和自己的无头 Chrome，每个预设现拼一个场景用引擎画一帧，缩到 128² 存 WebP。库里的预设变了重跑：`node tools/dev/library-thumbnails.ts [--only <id>,…]`，用完 `pwsh tools/stop-dev.ps1` |
| `dev/terrain-hillshade.ts` | 地形文件（`.terrain.json`）的山影图：用原生的求值器在 Node 里求一块高度、画成 PNG，调噪声、冲沟的参数不用开浏览器、发版；`--local` 用 fork 里刚编的原生模块。用法：`node tools/dev/terrain-hillshade.ts <地形文件> <out.png> [--x0 -1500] [--z0 -1500] [--size 3000] [--pixels 600] [--local]` |
| `lib/run-page.ts` | 在自己的无头 Chrome 里（`~/.stride-ts/run-page`，跑完就关）打开一个不连调试中枢的页面，等它把结果放到全局变量上，打印页面的文字；`--out` 另存 JSON，`--screenshot` 截图。不用 Playwright。用法：`node tools/lib/run-page.ts http://localhost:5182/displacement.html displacementResults --error displacementError`（几何实验 E2，见 docs/vector-assets.md）；`capabilities.html` 是 WebGPU 能力的实测（泼溅、群演、视频贴图、路径追踪，见 docs/progress-log.md） |
| `dev/bench.cjs` | 打开 `apps/bench`（先 `pnpm --filter @stride-ts/bench dev`，端口 5182），等基准跑完，打印结果表；第三个参数给文件名时另存 JSON。用法：`node tools/dev/bench.cjs <playwright> http://localhost:5182/ [out.json]` |
| `dev/gc-trace.cjs` | 打开 `apps/bench/gc.html`，开着 Chrome 的 tracing 跑各种分配模式，按场景报告帧间隔和 V8 记录的主线程 GC 停顿（次数、总时长、最长一次）。用法：`node tools/dev/gc-trace.cjs <playwright> http://localhost:5182/gc.html [trace.json]` |
| `dev/gen-type-stress.mjs` | 生成 `packages/engine/test/core/stress.check.ts`（默认 300 个组件、150 个系统、150 个脚本），之后用 `npx tsc -p packages/engine --extendedDiagnostics` 看检查时间和实例化次数。用法：`node tools/dev/gen-type-stress.mjs [组件数] [系统数] [脚本数]` |

`bench.cjs` 和 `gc-trace.cjs` 还用 Playwright（第一个参数是它的路径，`require.resolve('playwright')`），Chrome 是本机安装的 `C:/Program Files/Google/Chrome/Application/chrome.exe`。

原生部分的脚本（PowerShell 7）：

| 脚本 | 作用 |
|---|---|
| `dev/build-jolt-wasm.ps1` | 只测 Jolt 本身：用 emsdk 把 Jolt 的 fork（默认和本仓库并列的 `JoltPhysics`）的 `UnitTests` 编成多线程加 SIMD 的 wasm，再用 Node 跑。参数 `-Config Debug\|Release\|Distribution`（默认 Distribution）；构建目录是 `Build/WASM_<Config>` |

StrideNative 的两个模块（`stride-native`、`stride-tools`）用 fork 仓库里的 `StrideNative/Scripts/build-wasm.ps1` 构建和测试，浏览器测试页是 `StrideNative/Tests/Browser/serve.mjs`。构建脚本最后打出 npm 包 `@stride-ts/native` 的 tgz；本仓库从 fork 的 GitHub Release 安装它，更新流程见根目录 README 的"开发"。

注意事项：
- 测性能前确认笔记本的电源模式（静谧模式下 GPU 慢好几倍），`stride status` 的 `gpu` 记着适配器。
- 无头 Chrome 的帧节奏固定在 60 Hz 左右，和显示器无关；测上限要加上面的不限帧率参数。
- 测量时机器上不要跑别的重任务，否则数字不可信。
- 应用内置浏览器的面板隐藏时 `requestAnimationFrame` 不触发：看帧循环用 `stride open` 启动的 Chrome。

