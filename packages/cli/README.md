# @stride-ts/cli（`stride`）

从命令行查看和操作正在运行的 stride-ts 游戏，给 agent 和开发者调试用。结果是 JSON，打到 stdout；出错时信息打到 stderr，退出码 1。

```bash
pnpm exec stride --help
```

## 怎么连上的

```
CLI ──HTTP + 令牌──▶ 调试中枢（开发服务器上的 Vite 插件） ◀──WebSocket（同源）── 页面里的 Game（game.debug）
```

- **中枢**：`tools/lib/vite-app.ts` 给所有 app 的开发服务器和 preview 服务器挂上 `strideDebug()`（`src/vite.ts`、`src/hub.ts`）。中枢把地址和令牌登记在 `~/.stride-ts/hubs/`，CLI 按它找。同时开着几个中枢时，默认用页面连上得最晚的那个；`--hub <名字或地址里的文字>` 指定。
- **页面**：`Game.run` 的 `debug` 选项打开时连中枢。app 的入口传 `import.meta.env.DEV || undefined`，所以开发服务器上总是打开，preview 或部署出去的页面在地址后加 `?debug` 才打开。
- **安全**：中枢只接受同源页面的 WebSocket；HTTP 接口要带令牌，并且拒绝带 Origin 头的请求，其他网页没法借用户的浏览器调用。

## 常用命令

| 命令 | 作用 |
|---|---|
| `open <url> [--headless] [--size 1400x900] [--dpr 2]` | 用自己启动的 Chrome 打开（独立的用户目录 `~/.stride-ts/chrome`，无头的另用 `~/.stride-ts/chrome-headless`；开着 CDP 端口），等到游戏运行起来再返回；再次 open 时在同一个浏览器里开新标签。`close` 关掉这个浏览器。平时看画面用自己的 Chrome 就行：页面经开发服务器的中枢连 CLI，开在哪个浏览器里都能用 |
| `status` | 状态、帧号、游戏时间、帧率、画布、GPU 适配器、计数器、观察项 |
| `entities [--name x] [--with C]`、`inspect <实体>` | 列实体；看某个实体的所有组件值和脚本属性。实体写 id 或名字 |
| `set <实体> <组件.字段> <JSON>` | 改组件字段或脚本属性，例如 `set PlayerCharacter Character.speed 20` |
| `pause`、`resume`、`step [n]`、`time --scale 0.5 --fixed 0.016 --total 2` | 暂停（只画不更新）、单步、时间倍率、固定步长（复现用）、把游戏时钟拨到某个秒数（按时间动的着色器比对截图用） |
| `key KeyW --hold 1000`、`mouse move 100 0`、`mouse left` | 模拟输入（合成 DOM 事件，走 InputManager 的正常路径；拿不到指针锁定） |
| `mouse left --trusted` | 用 DevTools 协议在画布中央真实地按一下：算用户操作，页面能锁定指针；锁定后 `mouse move` 的移动量照常进 `mouseDelta`。要 DevTools 协议的命令，页面所在的 Chrome 装着调试桥扩展（[tools/debug-bridge](../../tools/debug-bridge/README.md)）时经它，否则要 stride open 启动的 Chrome |
| `cpu-profile [--seconds 5] [--out p.json] [--callers <正则>]` | 录一段 CPU 采样（Tracing 的 v8.cpu_profiler，0.1 ms），按类别、函数给每帧的自身和包含时间；`--callers` 列某些函数的调用链。同上，经调试桥扩展或 stride open 的 Chrome |
| `shot out.png [--diff ref.png] [--region x,y,w,h]` | 截下一帧的后备缓冲（不含页面上的文字）；和参考图逐像素比较，写放大 16 倍的差异图。结果里 `meanChannel` 是平均每通道差，`mean` 是每个像素取差最大的通道再平均；`--region` 只比那一块（比如去掉两边画法不同的 UI） |
| `perf [--seconds 3]` | 帧时间分布、每个系统和阶段的 CPU 时间、每个渲染通道的 GPU 时间、渲染统计 |
| `blur [on\|off] [--shutter s] [--maxPixels n]` | 运动模糊：开关、快门（一帧的比例）、最长几个像素 |
| `contact [on\|off] [--length m] [--steps n] [--thickness t]` | 接触阴影（投阴影的方向光，屏幕空间）：开关、参数 |
| `sss [on\|off] [--entity e] [--width m] [--translucency t]` | 次表面散射：开关模糊；`--entity` 给这个实体和子实体的模型材质加上皮肤散射（`off` 时去掉），宽度、透光度可改 |
| `ssgi [on\|off] [--radius m] [--thickness m] [--intensity x] [--feedback f]` | 屏幕空间全局光照（近处表面反射的漫反射光和遮蔽，开着时代替 GTAO）：开关、参数 |
| `ssr [on\|off] [--maxRoughness r] [--thickness t] [--maxSteps n] [--debug off\|hits\|reflection]` | 屏幕空间反射：开关、参数，调试视图（命中的把握、累积后的反射） |
| `draws` | 上一帧的绘制次数，按 GPU 的渲染通道分（场景的各阶段、阴影、后处理的每一步、UI、调试线），按画的顺序 |
| `metrics [--over]` | 各系统的统计量和预算（`game.metrics`）：实体数、绘制次数、显存（缓冲、贴图的个数和字节）、原生内存、帧时间，加上游戏自己登记的；`--over` 只列超了预算的 |
| `pick <x> <y>` | 画布上那个像素（CSS 像素，左上角起）最前面的网格或精灵属于哪个实体（GPU 编号缓冲，同 `game.pick`） |
| `ao [on\|off] [--radius <米>]` | 屏幕空间的环境光遮蔽（GTAO）；不带参数是切换（`game.graphicsCompositor.ambientOcclusion`） |
| `taa [on\|off]` | 主画面用时间抗锯齿（TAA 加锐化）代替 FXAA；不带参数是切换（`game.graphicsCompositor.temporalAntialiasing`） |
| `quality [low\|medium\|high\|ultra]` | 画质档位：阴影和后处理的上限（`game.graphicsCompositor.quality`，见 `rendering/Quality.ts`）；不带参数是看现在的 |
| `wireframe [on\|off]` | 在主画面上叠画网格的线框（三角形的边）；不带参数是切换（`game.graphicsCompositor.wireframe`） |
| `raycast <x,y,z> <dx,dy,dz>` | 物理射线 |
| `logs [-f] [--level warn]` | 页面的 console 输出、未捕获的异常、引擎日志、埋的事件 |
| `eval <代码 \| -> \| --file <脚本>` | 在页面里执行。一个表达式：结果是它的值，能直接 await，作用域里有 `game`、`engine`（样例挂的 `strideEngine`）、`entity(名字或 id)`、`named(名字)`、`frames(n)`、`seconds(s)`（按游戏时间等）。几条语句：照旧在全局作用域里跑，结果是最后一个的值；语句里有顶层 await 时当异步函数体跑，结果用 return 给。`-` 从标准输入读，`--file` 从文件读（PowerShell 里不用转义） |
| `wait --game <秒>` | 等游戏时间走这么多（不是墙钟：CI 的软件 WebGPU、后台标签上一帧可能几百毫秒）；不带 `--game` 是等页面连上、游戏跑起来 |
| `slow <毫秒>` | 每帧在页面里多忙等这么久（0 停）：本机复现 CI 的软件 WebGPU 上几百毫秒一帧的情况，冒烟脚本的时序问题不用推上去等 CI |
| `throttle <倍数> [--seconds s]` | CPU 降速（DevTools 的 CPU throttling），复现 CI 上软件 WebGPU、慢机器的时序；挂着直到 `--seconds` 到或 Ctrl+C，结束时恢复。和 `slow` 不同：整个渲染进程都慢（Chrome 隔一会儿停一下主线程），所以页面里 JS 量出来的毫秒数不变、帧率掉（20 倍时 120 → 41 帧每秒） |
| `viewport <宽x高> [--dpr 2] [--mobile] [--seconds s]`、`viewport off` | 模拟屏幕大小和像素比（手机竖屏：`390x844 --dpr 3 --mobile`）；同样挂着直到结束 |
| `front` | 把游戏的标签切到前面：后台的标签不跑 `requestAnimationFrame`（启动参数也管不了），`status` 的 `visibility` 是 `hidden` 时用它；`visible` 却很慢时看 `status`、`perf` 的 `throttled`（窗口被挡住，浏览器在节流，换无头的 Chrome 量） |
| `particles [--name x]` | 每个粒子发射器：在 CPU 还是 GPU 上、粒子池多大、活着几个、活着的粒子在世界里的范围（GPU 上的读回来数）。粒子看不见时先看这个 |
| `commands`、`call <命令> <JSON>` | 列出页面登记的命令；调任意命令（游戏自己加的也行） |

**测性能前**：确认笔记本的电源模式（静谧模式下 GPU 慢好几倍），`status` 里的 `gpu.description` 记下了适配器。

## 类型感知（`stride ts`、`eval --check`）

CLI 起一个 TypeScript 7 的语言服务器（仓库里装的 `tsc --lsp --stdio`，`src/lsp.ts`），按 LSP 问类型，agent 不开 IDE 也能拿到编辑器那样的信息。位置写 `文件:行:列`（1 起，同 tsc 的报错），结果是 JSON。每次调用起一个服务器，问一次一般半秒到一秒。

| 命令 | 作用 |
|---|---|
| `ts hover <文件:行:列>` | 那里的类型和文档注释（同编辑器里的悬停） |
| `ts def <文件:行:列>`、`ts refs <文件:行:列>` | 定义在哪、所有引用 |
| `ts complete <文件:行:列> [--limit 100]` | 那里能写的名字，带类型 |
| `ts check <文件>...` | 这些文件的类型错误和警告；有错误时退出码 1 |
| `ts symbols <名字> [--in <文件>]` | 按名字找符号（类、函数、变量……）；在 `--in` 所在的工程里找，默认引擎 |
| `ts type <表达式>` | eval 作用域里一个表达式的类型，比如 `ts type "game.world.loaded"` 是 `string[]` |
| `ts members <表达式>` | eval 作用域里一个表达式的属性和方法，带类型：`ts members "game.graphicsCompositor"` |
| `eval --check <代码>` | 先按引擎的类型查代码（拼错的属性、参数类型不对），有错误时不跑，退出码 1，报出代码里的行列 |

eval 作用域和页面里一样：`game`（`Game`）、`engine`（引擎的全部导出）、`pageHelpers` 的帮手（`entity`、`named`、`frames`、`seconds`、`until`……，类型取自 `PageHelpers`，加了帮手不用改这里）。代码放在引擎源码目录里一个不落盘的虚拟文件里，当异步函数体查（表达式、语句、顶层 await、`return` 都行）。

## 断点和日志点（`stride debug`）

一次性的调试会话（`src/debugger.ts`，DevTools 协议的 Debugger 域），给 agent 用：一份 JSON 计划进去，每次停下的调用栈、局部变量、表达式的值出来，停下的地方自动继续，不用交互。功能照 VS Code 的 js-debug 挑：

| 计划里的项 | 作用 |
|---|---|
| `breakpoints: [{ at: "terrain/TerrainSystem.ts:194" }]` | 按 TS 源码的行下断点（文件写仓库里路径的结尾就行），经 Vite 内联的 source map 换成浏览器里的位置；报回来的位置也换回源码 |
| `condition`、`hitCount` | 条件断点、第几次经过才停 |
| `log: "表达式"` | 日志点：不停下，记下每次经过时的值（最多 2000 条），适合看帧循环里的数怎么变 |
| `watch: [...]`（断点上或计划上） | 停下时在那一帧的作用域里求值（对象展开 `depth` 层，默认 1） |
| `exceptions: "uncaught" \| "all"` | 抛异常时停下，报抛出的值、调用栈和局部变量 |
| `steps: n` | 停下以后再单步 n 次（跳过函数调用），每步记位置和表达式 |
| `run: "代码"` | 断点设好以后在页面里跑的代码（同 `stride eval`，有 `game`、`entity`、`frames`……），用来触发要查的路径；它的结果也报回来 |
| `maxHits`（10）、`seconds`（10） | 最多停几次、最多等几秒 |

```powershell
pnpm exec stride debug --file plan.json
```

C++ 也能下断点：`at` 写原生源码的 `文件:行`（比如 `Source/Runtime/TerrainApi.cpp:272`），按调试版 wasm 带的 source map 找位置（游戏要按 `debugNative` 加载调试版模块，开发服务器上默认就是）；调用栈从 C++ 一路报到 TS 的调用方。C++ 的帧只有行号没有变量名：局部变量是 `$var0`、`$var1`……（参数在前，值是真的值，i64 带 `n`），`watch` 里也这么写。要看 C++ 的变量名、结构体，用原生的 `-SourceDebug` 版（DWARF）加 Chrome 的 C/C++ 扩展。

第三方代码（`node_modules`、Vite 的模块）不进单步和调用栈。停下的会话要和页面无关的 DevTools 连接：用 `stride open <地址>`（有界面、无头都行）开的 Chrome；经调试桥扩展的连接走页面转发，页面停住时没法再发"继续"，所以不支持（以后调试桥改成扩展直连中枢）。

## 像人一样看和操作页面（`stride page`）

照 Claude in Chrome 那套能力做的，经 DevTools 协议：主 Chrome 经调试桥扩展、`stride open` 的 Chrome 直连，一样用。主要用在编辑器的界面（`/__stride/editor/`），游戏页面的 DOM 也行。

| 命令 | 作用 |
|---|---|
| `page tree [--interactive] [--max 400]` | 无障碍树，每个元素带编号（`e123`），连同里面的 iframe（编辑器的视口）；`--interactive` 只列能操作的和它们所在的区域 |
| `page find <文字>`、`page text` | 名字或值里有这段文字的元素；页面的文字 |
| `page click <编号或 x,y> [--button right] [--count 2] [--modifiers ctrl+shift]` | 真实的点击（浏览器当成用户操作），编号先滚进视口、点中心 |
| `page hover`、`page drag <从> <到> [--steps 12]`、`page scroll <位置> [--dy 300]` | 悬停、按住拖过去（中间有移动事件，拖操纵器、拖资源都行）、滚轮 |
| `page type <文字>`、`page key <组合>... [--repeat n]` | 往焦点里打字；按键（`Enter`、`ctrl+s`、`shift+Tab`、`F2`、`a`） |
| `page shot <out.png> [--ref e123]` | 截视口或一个元素，按 CSS 像素（图上的坐标就是 click 用的坐标，高分屏也一样） |
| `page eval <表达式>` 或 `--file` | 在顶层页面（编辑器的界面，不是视口里的游戏）求值，查界面的布局、状态 |

鼠标、键盘的操作会在页面最上层画一个 agent 的指针（橙色，不挡点击）：平滑地移过去再点，点击有波纹，按键、滚轮在旁边标出来，闲置 4 秒淡出；人在旁边看得清 agent 在干什么。截图比对、测帧时间时加 `--no-cursor`。编号在页面刷新、元素重新渲染后会变，失效时报错提示重新 `page tree`。后台的标签不出帧，`stride front` 切到前面。

## 在游戏里埋点

```ts
game.debug.command('spawnEnemies', 'Spawn n enemies. args: n', ({ n }) => spawn(Number(n)));
game.debug.counter('ai.agents', agents.length);           // status 里列出
game.debug.watch('player.velocity', () => player.velocity);  // 读状态时才求值
game.debug.event('player.jump', { height });              // 进日志；没连中枢时什么都不做
```

渲染特性重写 `stats()`，`perf` 里就有它的统计；`EntityManager.timings` 打开时按系统和阶段计 CPU 时间（`perf` 采样时自动打开）。

命令超时：页面命令默认等 120 秒，`--timeout <秒>` 或环境变量 `STRIDE_TIMEOUT` 改它（CI 的软件 WebGPU 上一帧零点几秒，工作流里设成 300）。
