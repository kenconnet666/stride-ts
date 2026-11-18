# 测试和构建脚本

试玩、截图比对、性能和剖析都用调试 CLI `stride`（[packages/cli](../packages/cli/README.md)）：开发服务器或 preview 服务器上的游戏连上调试中枢后，`pnpm exec stride <命令>` 就能查看和操作它。常用的组合：

| 要做的事 | 命令 |
|---|---|
| 打开并等游戏跑起来 | `stride open http://localhost:5184/ --headless --size 1280x720`（preview 的地址加 `?debug`） |
| 试玩 | `stride key KeyW --hold 1500`、`stride key Space`、`stride mouse move 200 0`、`stride inspect PlayerCharacter` |
| 和桌面 Stride 比画面 | `stride eval '<关效果、固定曝光的设置>'`，再 `stride shot ours.png --diff stride-capture/<参考>.png`（`meanSignedRgb` 是我们减 Stride，看整体偏亮偏暗）；偏亮偏暗时 `node tools/hdr-ratio.ts <参考.png> ours.png` 看是倍数差还是随角度的差 |
| 帧时间、各通道 GPU 耗时、各系统 CPU 耗时 | `stride perf --seconds 5`；不限帧率测：`stride open <地址> --headless --chrome-arg=--disable-frame-rate-limit --chrome-arg=--disable-gpu-vsync` |
| CPU 剖析 | `stride cpu-profile --seconds 5 [--callers <函数名正则>] [--out profile.json]` |
| WebGPU 调用次数 | `stride gpu-calls` |
| 原生侧（物理步进、物体数、内存） | `stride native`、`stride logs --source native` |

这里剩下的脚本：

| 脚本 | 作用 |
|---|---|
| `vite-app.ts` | apps 共用的 Vite 配置（`strideApp(端口)`）：跨源隔离的响应头、不预打包原生模块、调试中枢（`strideDebug`）、构建后写 `.br`/`.gz` 预压缩文件 |
| `smoke.ts` | 样例冒烟脚本（`apps/*/scripts/smoke.ts`，`pnpm --filter <样例> smoke`）共用的部分：`startSmoke(中枢名)` 给出调 CLI 的 `stride`、`check`，`finish()` 查本次运行以来的错误日志后按结果退出 |
| `hdr-ratio.ts` | 两张截图（都固定曝光 EV0、关掉 FXAA 和亮部提取）反推色调映射前的 HDR 值，按行打印参考/我们的比值，分辨整体倍数和随角度的差。用法：`node tools/hdr-ratio.ts <参考.png> <我们的.png>` |
| `stride-capture/` | 桌面 Stride 的截图工程，每个样例一个子目录（`tpp/`、`animated-model/`、`physics-sample/`、`bepu-sample/`、`platformer2d/`）：`setup.ps1` 从 Stride 源码搭出并编译，截图参数见各自的 README |
| `bench.cjs` | 打开 `apps/bench`（先 `pnpm --filter @stride-ts/bench dev`，端口 5182），等基准跑完，打印结果表；第三个参数给文件名时另存 JSON。用法：`node bench.cjs <playwright> http://localhost:5182/ [out.json]` |
| `gc-trace.cjs` | 打开 `apps/bench/gc.html`，开着 Chrome 的 tracing 跑各种分配模式，按场景报告帧间隔和 V8 记录的主线程 GC 停顿（次数、总时长、最长一次）。用法：`node gc-trace.cjs <playwright> http://localhost:5182/gc.html [trace.json]` |
| `gen-type-stress.mjs` | 生成 `packages/engine/test/stress.check.ts`（默认 300 个组件、150 个系统、150 个脚本），之后用 `npx tsc -p . --extendedDiagnostics` 看检查时间和实例化次数。用法：`node tools/gen-type-stress.mjs [组件数] [系统数] [脚本数]` |

`bench.cjs` 和 `gc-trace.cjs` 还用 Playwright（第一个参数是它的路径，`require.resolve('playwright')`），Chrome 是本机安装的 `C:/Program Files/Google/Chrome/Application/chrome.exe`。

原生部分的脚本（PowerShell 7）：

| 脚本 | 作用 |
|---|---|
| `build-jolt-wasm.ps1` | 只测 Jolt 本身：用 emsdk 把 `jolt-native-fork` 的 `UnitTests` 编成多线程加 SIMD 的 wasm，再用 Node 跑。参数 `-Config Debug\|Release\|Distribution`（默认 Distribution）；构建目录是 `Build/WASM_<Config>` |

StrideNative 的两个模块（`stride-native`、`stride-tools`）用 fork 仓库里的 `StrideNative/Scripts/build-wasm.ps1` 构建和测试，浏览器测试页是 `StrideNative/Tests/Browser/serve.mjs`。构建脚本最后打出 npm 包 `@stride-ts/native` 的 tgz；本仓库从 fork 的 GitHub Release 安装它，更新流程见根目录 README 的"开发"。

注意事项：
- 测性能前确认笔记本的电源模式（静谧模式下 GPU 慢好几倍），`stride status` 的 `gpu` 记着适配器。
- 无头 Chrome 的帧节奏固定在 60 Hz 左右，和显示器无关；测上限要加上面的不限帧率参数。
- 测量时机器上不要跑别的重任务，否则数字不可信。
- 应用内置浏览器的面板隐藏时 `requestAnimationFrame` 不触发：看帧循环用 `stride open` 启动的 Chrome。
