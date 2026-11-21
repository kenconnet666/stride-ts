# 交接（2026-11-20，换机器）

用户要换一台性能好一点的电脑继续。这一页是给新机器上接手的人（或新会话里的 Claude）的：**先照第 1 节把环境搭起来、确认能跑，再照第 2 节的顺序接着做**。项目的设计和"为什么"在别的文档里，这里只给入口和结论：

| 先读 | 讲什么 |
|---|---|
| [CLAUDE.md](../CLAUDE.md) | 项目一页纸：做什么、各模块在哪、约定（中文注释和提交、推送规则、验证方式） |
| [roadmap.md](roadmap.md) 末尾的"进度" | 各阶段做到哪了、**正在做和下一步**、等用户定的事 |
| [decisions.md](decisions.md) | 执行中自己做的决定（按时间倒序，最上面几条是这一轮的） |
| [progress-log.md](progress-log.md) | 做完的各项的过程和验收（截图比对、数字） |
| [architecture.md](architecture.md)、[lessons.md](lessons.md) | 已定的架构；WebGPU 和浏览器的坑 |

---

## 1. 新机器上的准备

### 1.1 仓库和路径

旧机器是 Windows 11，用户 `Administrator`。新机器路径不同时，下表的"说明"一栏说怎么改。

新机器（2026-11-20 搭好）上的位置：本仓库 `C:\code\stride-ts`；Jolt 的 fork `C:\code\JoltPhysics`（`build-wasm.ps1`、`tools/build-jolt-wasm.ps1` 默认找和本仓库并列的它）；Stride 源码 `~\IdeaProjects\stride`（kenconnet666/stride 的 `web-experiment-base` 分支，浅克隆）；验证工作树 `C:\code\stride-ts-verify-1`、`-2`；emsdk 6.0.8 在 `~\emsdk`（脚本先看 `$env:EMSDK`）；vue-tsx-pro、easy-query-ts、json-wire 在 `~\IdeaProjects\` 下；参考仓库 `C:\code\refs`（PlayCanvas 的目录叫 `playcanvas-engine`）。Python 3 用 scoop 装的（带 Pillow）。

| 什么 | 旧机器上的位置 | 怎么来 | 说明 |
|---|---|---|---|
| **本仓库** | `C:\Users\Administrator\WebstormProjects\stride-ts` | `git clone https://github.com/kenconnet666/stride-ts`，`main` | 推送到 `origin` 不用先问用户（提交并验证以后） |
| **Jolt 的 fork**（原生部分 StrideNative：物理、导航、动画、贴图解码编成 wasm） | `C:\Users\Administrator\CLionProjects\jolt-native-fork` | `git clone https://github.com/kenconnet666/JoltPhysics jolt-native-fork`，分支 `stride` | `upstream` 是 `jrouwe/JoltPhysics`，**永远不推**。只在要改原生部分时需要；平时本仓库从 fork 的 GitHub Release 装编好的包 |
| **Stride 源码**（只读：导入样例、对照实现） | `C:\Users\Administrator\IdeaProjects\stride` | `git clone --depth 1 -b web-experiment-base https://github.com/kenconnet666/stride`（用户的 fork） | **要这个分支**：里面的样例换成了 BepuPhysics 的组件，导入器只认这些；上游 stride3d/stride 的样例还是 Bullet 的物理组件，导入时会被跳过，first-person-shooter、platformer 这些就跑不起来。导入脚本默认找 `~/IdeaProjects/stride`，别处用环境变量 `STRIDE_REPO`。不在那边提交 |
| **vue-tsx-pro**（编辑器界面的组件库，用户自己的） | `C:\Users\Administrator\IdeaProjects\vue-tsx-pro` | 用户的仓库 | 本仓库从 npm 装 `@zerodep-dev/vue-tsx-pro-tsx`、`-ui`（现在 `^0.30.0`）。只有要改组件库时才需要源码；它的约定见那边的 HANDOFF.md：`node scripts/dev/check.mjs` 过了再提交，`node scripts/release.mjs <版本> --wait` 发版（等 CI，打标签以后 CI 发 npm） |
| 参考用的开源仓库（浅克隆） | `C:\code\refs` | 用到时 `git clone --depth 1` | 清单见 CLAUDE.md 的"参考用的开源仓库"（glTF-Transform、three.js、PlayCanvas、dawn、wgpu、Babylon.js、filament……） |
| 用户的 easy-query-ts（只读参考） | `C:\code\easy-query-ts` | 用户的仓库 | TS API 写法的参考（不可变 builder、类型推导） |
| 测试数据 | `C:\code\testdata` | 公开数据集，直接下载 | 下了什么事后告诉用户就行 |
| 桌面 Stride 的截图工程 | 本仓库 `tools/stride-capture` | 本仓库 | 和桌面 Stride 4.4.2 逐像素比对用（要装 .NET 和 Stride） |

### 1.2 工具和版本

| 工具 | 旧机器上的版本 | 用途 |
|---|---|---|
| Node.js | 24.12.0（要 22 以上） | 构建、导入器、调试 CLI（Node 直接跑 TS） |
| pnpm | 10.34.5 | monorepo |
| PowerShell | 7.6（`pwsh`，不是 Windows PowerShell 5.1） | `tools/*.ps1`：验证、回归、停后台进程 |
| Git Bash | Git for Windows 自带 | 日常命令 |
| Python 3 | 3.14（带 Pillow） | 改文件的脚本、截图裁切比较 |
| GitHub CLI `gh` | keyring 登录（没有设 `GITHUB_TOKEN`） | 看 CI、发 Release |
| Chrome | 稳定版，WebGPU 开着 | 跑游戏、验收画面 |
| 改原生部分时 | emsdk、CMake、Ninja（见 fork 的 `StrideNative/README.md`） | `StrideNative/Scripts/build-wasm.ps1` |
| 截图比对桌面 Stride 时 | .NET 8+、Stride 4.4.2 | `tools/stride-capture` |

旧机器的显卡是 RTX 3050 笔记本（性能模式下才可信，静音模式会降频四倍左右）。

### 1.3 第一次跑起来

1. **装依赖**：`pnpm install`。原生包 `@stride-ts/native` 经 `pnpm-workspace.yaml` 的 override 从 fork 的 GitHub Release（`native-v<版本>`）下 tgz，不用先编原生部分。**不要**改成 `file:` 指向本地 tgz（JetBrains 认不出类型）。
2. **导入每个样例的内容**（`public/content/`，不提交）：`pwsh tools/import-all.ps1`（几个样例并行，最后打出结果表）。

   导入时的警告里**不应该有** `prefab instances kept expanded`（有的话是预制体实例没转成引用，见 decisions.md 的预制体那条）。粒子样例有几条"不是内置的粒子模块"的警告，是正常的。
3. **检查**：`pnpm typecheck`、`pnpm test`（按子项目各跑各的：每个包、样例有自己的 `tsconfig.json`（继承根上的 `tsconfig.base.json`）和 `typecheck`、`test` 脚本；只查改了的用 `pnpm typecheck:changed`、`pnpm test:changed`）。
4. **回归**：`pwsh tools/verify.ps1`（建 git 工作树 `../stride-ts-verify-1`（`-Slot 2` 用 `-2`，可以和 1 同时跑），切到当前提交、装依赖、把主检出导入的内容联接过去，跑 `tools/regress.ps1`：20 个样例的冒烟，每个起开发服务器和无头 Chrome，最后和 `tools/budgets.json` 的预算比）。旧机器上一遍 20 分钟左右，最后打出每个样例 `True`/`False` 的表。
   - **预算和机器无关**：实体数、绘制次数、显存、当场建的管线、原生内存（回归用 `?stride-workers=4` 固定工作线程数，每个线程 1 MB 的栈算在原生内存里）；帧时间不进预算。有意的变化之后重记：`$env:STRIDE_UPDATE_BUDGETS = 1; pwsh tools/verify.ps1`，再把 `../stride-ts-verify-1/tools/budgets.json` 拷回主检出、单独提交（"预算的基线：……"）。
   - 回归默认几个样例并行（`-Parallel`，每 8 个逻辑核一路、最多 4 路），新机器（36 线程、RX 9070 GRE）上是 4 路。
5. **Chrome**：
   - 装 **Claude in Chrome** 插件：看画面、点按钮、读控制台都用它（用户的主 Chrome 一直登录着）。一个开发服务器只留一个游戏标签页（CLI 连最后连上的那个）。
   - 要 `stride cpu-profile`、`stride mouse left --trusted`（真实点击、指针锁定）时，装调试桥扩展 `tools/debug-bridge`（见它的 README）；或者用 `pnpm exec stride open <url> --headless` 自己起的 Chrome。
6. **Claude Code 的记忆**（用户的工作偏好）在旧机器的 `C:\Users\Administrator\.claude\projects\C--Users-Administrator-WebstormProjects-stride-ts\memory\`，要的话整个拷到新机器同样的位置（工作目录的路径不同时，目录名跟着路径变：盘符和路径里的 `\`、`:` 都换成 `-`）。要点都在 CLAUDE.md 和下面第 3 节里。
7. **定时任务**：旧机器上的已经停了（2026-11-20）。要接着无人值守，在新机器上建一个，见第 6 节。

### 1.4 各样例的端口

开发服务器：`pnpm --filter @stride-ts/<样例> dev`（或在 `apps/<样例>` 里 `pnpm dev`），页面 `http://localhost:<端口>/?debug`（带 `?debug` 才连调试 CLI），编辑器 `http://localhost:<端口>/__stride/editor/`。

| 样例 | 端口 | 样例 | 端口 |
|---|---|---|---|
| platformer（TPP） | 5184 | particles-sample | 5208 |
| animated-model | 5186 | jumpy-jet | 5210 |
| physics-sample | 5188 | space-escape | 5212 |
| bepu-sample | 5190 | material-shader | 5214 |
| platformer2d | 5192 | custom-effect | 5216 |
| topdown-rpg | 5194 | morph-targets | 5218 |
| first-person-shooter | 5196 | csharp-beginner | 5220 |
| sprite-fonts | 5198 | csharp-intermediate | 5222 |
| game-menu | 5200 | collect-dodge（C1 的小游戏） | 5224 |
| ui-element-link | 5202 | short-film（F4 的短片） | 5226 |
| ui-particles | 5204 | greybox（白盒演示） | 5228 |
| simple-audio | 5206 | campsite（S2 的营地） | 5230 |

另外：`apps/sandbox`（5180，冒烟页）、`apps/bench`（5182，基准）。

---

## 2. 现在做到哪了，接着做什么

看 [roadmap.md](roadmap.md) 末尾的"进度"（各阶段做到哪了、正在做和下一步、遗留的尾巴）和 CLAUDE.md 的"现状"。2026-11-20 那次换机器时的快照（当时的提交表、接着做什么、没跑完的）原样挪到了 [progress-log.md](progress-log.md) 的"换机器交接时的快照（2026-11-20）"。

---

## 3. 怎么干活（约定和惯例）

完整的在 CLAUDE.md 的"约定"，这里是最常用到的：

- **语言**：和用户中文；代码注释（含文档注释、测试标题）、提交信息中文；标识符、文件名、报错和日志英文。
- **提交**：`git add` 写明路径（不 `git add -A`）；提交信息末尾 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`；整理和功能改动分开提交。
- **验证和推送**：本地提交 → `pwsh tools/verify.ps1` 后台跑（在工作树里，不挡主线程）→ 通过再 `git push origin main`。预算有意变了就带 `STRIDE_UPDATE_BUDGETS=1` 跑，把工作树里的 `tools/budgets.json` 拷回来单独提交。fork 也直接推 origin，**永远不推 upstream**。不 force push。
- **"做完"的标准**：在 Chrome 里实际跑过、看过；用调试 CLI 量。改了画面的功能开关各截一张做差（`stride shot --diff`）。
- **后台的东西用完就停**：`pwsh tools/stop-dev.ps1`（`-All` 全停，`-Keep` 留下在用的）；游戏标签页用插件关。几个页面同时满帧渲染会把显卡吃满，帧时间和冒烟的时序都不可信。
- **回归在主检出跑时**（`pwsh tools/regress.ps1`）开发服务器会热更新工作区：跑完之前不改 `packages/`、`apps/`。验证工作树里跑的不受影响。
- **验证期间**不在主检出重新导入内容（工作树联接的是主检出的 `public/content`），也不开浏览器、不占显卡。
- **Stride 的 bug 不跟**：比 Stride 做得好，改了的地方注明"和 Stride 不同：……"并记进 decisions.md。默认关掉 Stride 没有的效果（接触阴影、运动模糊），免得和桌面 Stride 的截图比对对不上。
- **原生部分有问题直接改 fork**，不在 TS 里绕：改 `StrideNative/JS/package.json` 的版本 → `pwsh StrideNative/Scripts/build-wasm.ps1` → 提交推送 fork → `pwsh StrideNative/Scripts/release-native.ps1` → 本仓库 `pnpm-workspace.yaml` 的 override 换成新地址 → `pnpm install`。

## 4. 调试 CLI 常用命令

在仓库根目录 `pnpm exec stride <命令>`（全部见 [packages/cli/README.md](../packages/cli/README.md)）。页面要带 `?debug`。

| 命令 | 用途 |
|---|---|
| `status`、`entities --name X`、`inspect <实体>` | 看状态、实体 |
| `set <实体> <组件.字段> <JSON>` | 改值 |
| `pause`、`resume`、`step 1` | 暂停、单步（截图比较前先暂停） |
| `key KeyW --hold 1000`、`mouse move 100 0` | 模拟输入 |
| `shot out.png --diff ref.png` | 截图、和参考比较（输出每通道平均差、超阈值的像素数） |
| `perf --seconds 3`、`metrics`、`draws` | 帧时间和 GPU 每通道耗时、统计量和预算、按通道的绘制次数 |
| `quality low\|medium\|high\|ultra` | 画质档位 |
| `ao`、`taa`、`ssr`、`contact`、`blur`（`on`/`off`/参数） | 屏幕空间效果的开关；`ssr --debug hits\|reflection` 看命中和反射 |
| `eval "<JS>"` | 在页面里执行（全局 `strideGame`），比如 `strideGame.graphicsCompositor.graphStats.passes` 看这一帧跑了哪些通道，`strideGame.graphicsDevice.pipelines.recentSync` 看最近当场建的管线 |
| `logs -f` | 页面的 console 和引擎日志 |

## 5. 这一轮踩过的坑（新机器上也会遇到）

- **冒烟检查不能按帧数或 CLI 的按下松开算时长**（新机器上发现的）：这台机器的无头 Chrome 跑 120 fps（旧机器 60），单核慢，每条 `stride` 命令（一个新的 Node 进程）要接近一秒。"等 60 帧"只剩一半的游戏时间，`key D --down` 和 `--up` 之间实际按住的时间多出一大截。要等一段时间用 `PAGE_HELPERS` 的 `seconds(s)`，要按住一会儿用 `holdFor(code, s, sample)`，都在页面里按游戏时间算。
- **并行回归的负载**：两个槽位各 4 路（8 个游戏同时跑）时，靠墙钟时间的检查（锁鼠标、点击后等 250 毫秒）会偶尔失败；单独跑都通过。一个槽位 4 路是默认。

- **改文件的 Python 脚本写成文件再跑**：Git Bash 的 heredoc（`python - <<'EOF'`）会把反斜杠、`\U` 这类吃掉或报错。Windows 上 Python 以文本模式写文件会把换行写成 CRLF：一律 `open(p, 'w', encoding='utf-8', newline='')`。
- **Chrome 标签在后台时不画帧**：`stride shot` 会一直等下一帧直到超时。先用插件截一张（把标签带到前台），再 `stride shot`；脚本里给它套 `timeout 60`。
- **改了引擎里登记调试命令的代码**（`debug/commands.ts`）以后，Vite 的热更新不会重新登记命令：重新加载页面。
- **停后台验证**：`TaskStop` 只停最外层的 pwsh，`tools/regress.ps1` 和它的 node 子进程还在跑、和下一次抢资源（表现是下一次冒烟里 `no page is connected to this hub`）。停的时候按命令行找（槽位 2 换成 `stride-ts-verify-2`）：`Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='pwsh.exe'" | Where-Object { $_.CommandLine -match 'stride-ts-verify-1' } | Stop-Process`，再 `pwsh tools/stop-dev.ps1 -All`。不要用 `&` 在 Bash 里起验证（收不到结束的通知）。
- **编辑器页面**：会话对象在 `document.querySelector('#app').__vue_app__._instance.props.session`（JS 里查状态、模拟操作用）；编辑器的场景树和视口都要等游戏页面起来（几秒），太早点会点在加载中的骨架上。
- **场景树单击选不中**：是 vue-tsx-pro 0.29 的 bug（拖动时按下就捕获指针），0.30.0 修了。
- **样例导入的 Stride 内容里有过时的预制体引用**（CSharpIntermediate 的 DefaultScenery、FPS 的 Stairs1x1x2：成员的 `Base` 指着预制体里删掉的实体）：导入器把这样的成员当普通实体，别的照常转成引用。

## 6. 定时任务（无人值守续跑）

在新机器上用 CronCreate 建一个每 15 分钟的任务，提示词照抄下面这段（2026-11-21 在用的版本；"【续期】"那句的日期改成新建那天往后 6 天）：

> 【无人值守续跑】继续执行 stride-ts 的路线图 docs/roadmap.md（取舍已全部按推荐定，见第四节；只有 D10 里"停下来问"的事才停下问用户）。用中文和用户沟通。
> 做法：读 docs/roadmap.md "进度"里的"正在做和下一步"（2026-11-20 重排过的有序清单），按顺序做第一项没做完的；做完在清单里划掉、写结论。先读相关代码和参考实现再动手（调研自己做）。做完更新"进度"、docs/decisions.md、docs/progress-log.md 和 CLAUDE.md 的现状。
> 提交和测试：提交前 pnpm typecheck、pnpm test（失败了不提交）；提交后 git pull --rebase origin main 再推 origin main（不强推）；推送后在验证工作树里跑 pwsh tools/verify.ps1 -Changed -Base <推送前的提交>（回归按 WebGPU 默认上限开页面），失败了修好再推；看 CI（gh run list）的失败并修。在 Chrome 里实际看过、量过耗时才算完成。开发服务器、无头 Chrome 用完就停（pwsh tools/stop-dev.ps1）。改源码里带反引号或 ${} 的文字用 Edit 工具或写成脚本文件，不用 PowerShell 的字符串替换。耗时的命令放后台跑。
> 调试难时先升级调试 CLI（packages/cli），再用 CLion 的 JS 调试器（MCP 的 xdebug_*）和电脑控制（CLion 点击级、Chrome 只读）。
> 【单会话】用户 2026-11-20 定：不再多个会话并行，除非用户主动通知；不开子会话、不提议开。../stride-ts-verify-1、-2、-3 是验证位（分离头指针、没有没提交的改动）。
> 【wasm】原生那边（C:\code\JoltPhysics 的 StrideNative）有问题或者不够用时直接改那边、重编、发新版本，不在 TS 里绕。
> 【续期】这个定时任务 7 天后过期：2026-11-27 之后路线图还没做完，就照这段文字重新建一个。
