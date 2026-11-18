# 测试和构建脚本

Stride C# 网页移植时写的 Playwright 脚本，用来在 Chrome 里试玩、测帧时间、做 CPU 剖析。它们不依赖 Stride，只要求页面提供 `globalThis.strideGame`（`frames`、`sceneFrame`、`status`），新引擎的页面照着提供即可。

Playwright 的路径作为第一个参数传入。Stride 那边是这样调用的（Git Bash）：

```bash
export NODE_PATH=/c/Users/Administrator/IdeaProjects/stride-webprobe/build/browser/node_modules
node play.cjs "$(node -e "console.log(require.resolve('playwright'))")" http://127.0.0.1:8171/ script.json out 1
```

新项目里装上 `playwright` 后，直接 `require.resolve('playwright')` 就行。Chrome 用的是本机安装的 `C:/Program Files/Google/Chrome/Application/chrome.exe`。

引擎的 `Game` 在运行时就是 `globalThis.strideGame`，所以这些脚本可以直接用在 `apps/sandbox` 上（先 `pnpm dev`，或构建后 `preview`）：

```bash
node play.cjs "$(node -e "console.log(require.resolve('playwright'))")" http://localhost:5180/ script.json out 1
```

| 脚本 | 作用 |
|---|---|
| `play.cjs` | 按 JSON 步骤试玩（按键、点击、移动鼠标、截图），报告页面错误、帧数和最长的帧间隔。默认无头；`PLAY_HEADED=1` 开窗口（指针锁定需要窗口）；`PLAY_LOG=<文字>` 打印包含这段文字的控制台输出 |
| `bench.cjs` | 打开 `apps/bench`（先 `pnpm --filter @stride-ts/bench dev`，端口 5182），等基准跑完，打印结果表；第三个参数给文件名时另存 JSON。用法：`node bench.cjs <playwright> http://localhost:5182/ [out.json]` |
| `gc-trace.cjs` | 打开 `apps/bench/gc.html`，开着 Chrome 的 tracing 跑各种分配模式，按场景报告帧间隔和 V8 记录的主线程 GC 停顿（次数、总时长、最长一次）。用法：`node gc-trace.cjs <playwright> http://localhost:5182/gc.html [trace.json]` |
| `gen-type-stress.mjs` | 生成 `packages/engine/test/stress.check.ts`（默认 300 个组件、150 个系统、150 个脚本），之后用 `npx tsc -p . --extendedDiagnostics` 看检查时间和实例化次数。用法：`node tools/gen-type-stress.mjs [组件数] [系统数] [脚本数]` |
| `frame-time.cjs` | 去掉帧率上限（`--disable-frame-rate-limit`），测场景就绪后 600 帧的平均帧时间 |
| `cpu-profile.cjs` | 用 CDP 采样主线程 5 秒，按类别（wasm、JS、GC、空闲）和函数汇总自身时间与包含时间；`PROFILE_OUT=<文件>` 保存原始剖析数据 |
| `profile-callers.cjs` | 读取保存的剖析数据，统计某个函数（正则匹配）是被谁调用的 |
| `gpu-calls.cjs` | 统计每帧各个 WebGPU 调用的次数，以及 `writeBuffer` 写入的字节数和大小分布 |
| `aot-log.cjs` | .NET 专用：拦截 `main.js`，打开 Mono 的 AOT 日志。新引擎用不到，留作参考 |

原生部分的脚本（PowerShell 7）：

| 脚本 | 作用 |
|---|---|
| `build-jolt-wasm.ps1` | 只测 Jolt 本身：用 emsdk 把 `jolt-native-fork` 的 `UnitTests` 编成多线程加 SIMD 的 wasm，再用 Node 跑。参数 `-Config Debug\|Release\|Distribution`（默认 Distribution）；构建目录是 `Build/WASM_<Config>` |

StrideNative 的两个模块（`stride-native`、`stride-tools`）用 fork 仓库里的 `StrideNative/Scripts/build-wasm.ps1` 构建和测试，浏览器测试页是 `StrideNative/Tests/Browser/serve.mjs`。编好后在本仓库跑 `pnpm native:sync`，拷进 `packages/native/dist`。

注意事项：
- 无头 Chrome 的帧节奏固定在 60 Hz 左右，和显示器无关。测性能要用 `frame-time.cjs`，它会去掉帧率上限。
- 测量时机器上不要跑别的重任务，否则数字不可信。
- 键盘输入之前，先点击一下画布，让它拿到焦点。
