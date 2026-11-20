# 交接（2026-11-20，换机器）

用户要换一台性能好一点的电脑继续。这一页说新机器上怎么接着做：先把环境搭起来，再从路线图的"进度"接着做。项目怎么做、为什么这样做，都在别的文档里（[CLAUDE.md](../CLAUDE.md) 的开工必读、[roadmap.md](roadmap.md) 末尾的"进度"、[decisions.md](decisions.md)），这里不重复。

## 1. 新机器上的准备

**仓库和路径**（Windows，用户 `Administrator`；路径不同时按下面的环境变量改）：

| 什么 | 原来在哪 | 说明 |
|---|---|---|
| 本仓库 | `C:\Users\Administrator\WebstormProjects\stride-ts` | `git clone https://github.com/kenconnet666/stride-ts`，`main` 分支 |
| Jolt 的 fork（原生部分 StrideNative） | `C:\Users\Administrator\CLionProjects\jolt-native-fork` | 远程 `origin` 是 `kenconnet666/JoltPhysics`，工作分支 `stride`；`upstream` 是 `jrouwe/JoltPhysics`，**永远不推** |
| Stride 源码（导入样例用，只读） | `C:\Users\Administrator\IdeaProjects\stride` | 导入脚本默认找 `~/IdeaProjects/stride`，别处用 `STRIDE_REPO` |
| vue-tsx-pro（编辑器界面的组件库，用户自己的） | `C:\Users\Administrator\IdeaProjects\vue-tsx-pro` | 本仓库从 npm 装 `@zerodep-dev/vue-tsx-pro-*`（现在 0.30.0）；只有要改组件库时才需要它，约定见它的 HANDOFF.md |
| 参考用的开源仓库（浅克隆） | `C:\code\refs` | 清单见 CLAUDE.md；用到时再克隆 |
| 用户的 easy-query-ts（只读参考） | `C:\code\easy-query-ts` | TS API 的写法参考 |
| 测试数据 | `C:\code\testdata` | 公开数据集，可以直接下载 |

**工具**：Node 24（22 以上）、pnpm 10.34、PowerShell 7.6（`pwsh`）、Git Bash、Python 3（改文件的脚本写成文件再跑，见 CLAUDE.md）、`gh`（keyring 登录）。改原生部分时还要 fork 里 `StrideNative/README.md` 说的 emsdk 和 CMake。

**步骤**：

1. `pnpm install`（原生包从 fork 的 GitHub Release 装，`pnpm-workspace.yaml` 的 override，不用先编原生部分）。
2. 每个样例导入 Stride 的内容（不提交）：`pnpm --filter @stride-ts/<样例> import:stride`。全部导一遍：对 `apps/` 下有 `import:stride` 脚本的样例逐个跑。导入时 `prefab instances kept expanded` 的警告应该一个都没有。
3. `pnpm typecheck`、`pnpm test`，然后 `pwsh tools/regress.ps1`（或 `pwsh tools/verify.ps1`）把 20 个样例的冒烟跑一遍，确认新机器上都过。预算基线（`tools/budgets.json`）是在旧机器（RTX 3050 笔记本）上记的：显存、绘制次数这些和机器无关，帧时间会变——要是只有帧时间超了，在验证工作树里重记（`$env:STRIDE_UPDATE_BUDGETS = 1; pwsh tools/verify.ps1`，再把工作树里的 `tools/budgets.json` 拷回来提交）。
4. Chrome：装 Claude in Chrome 插件（看画面、点按钮用，主 Chrome 一直登录着）；要 `stride cpu-profile`、`mouse --trusted` 时再装调试桥扩展（`tools/debug-bridge`，见它的 README）。
5. Claude Code 的记忆（用户的工作偏好：推送不用问、长任务放验证工作树、用完停掉开发服务器……）在旧机器的 `C:\Users\Administrator\.claude\projects\C--Users-Administrator-WebstormProjects-stride-ts\memory\`，要的话整个拷到新机器同样的位置（工作目录的路径不同时，目录名跟着路径变）。要点 CLAUDE.md 里都写了。
6. 定时任务：旧机器上的已经停了。要接着无人值守，在新机器上用 CronCreate 建一个每 15 分钟的任务，提示词照抄下面第 4 节。

## 2. 现在做到哪了

最新的提交都在 `main` 上（推送到 origin 的最后一个见 `git log origin/main`）。路线图的"进度"一节是准的，下一步也写在那里。这一轮（2026-11-20）做完的：

- **预制体**：场景里只存引用和差异；导入器把 Stride 的实例转成引用；编辑器里改、删实例的成员落成覆盖，单独打开预制体编辑，覆盖里的资源路径随移动改写。
- **P4 底座**：后处理、GTAO、背景的管线在加载时预热（TPP 当场建的管线 22 → 5）；绘制次数按渲染通道数（`stride draws`）。
- **P4 画面**：屏幕空间反射（Hi-Z、GGX、空间复用、时间累积，TPP 上看过画面）；接触阴影、运动模糊（都默认关）。
- **编辑器**：升级到 vue-tsx-pro 0.30.0（场景树单击能选中了）。

## 3. 没收尾的

- **接触阴影、运动模糊**（提交 `a2792fe`）：单测、类型检查过了，全量回归见下一条；**还没在 Chrome 里看过画面**。下一步：TPP 上 `pnpm exec stride contact on`（看角色脚下、墙根的影子有没有贴上去，`--length`、`--thickness` 调参）；`pnpm exec stride blur on` 加移动相机（`stride input`）看糊得对不对，静止时画面应该和关着时一样。看过以后把结果补进 progress-log.md，有问题就修。
- 全量回归的结果：见第 5 节（交接时写上）。

## 4. 定时任务的提示词

> 【无人值守续跑】继续执行 stride-ts 的路线图 docs/roadmap.md（取舍已全部按推荐定，见 docs/decisions.md）。先读路线图末尾的"进度"一节，从记录的下一步接着做；如果上一轮做到一半（工作区有未提交的改动），先把它做完。按路线图第五节的流程推进：缺什么补什么、写单测、用调试 CLI（pnpm exec stride …）在 Chrome 里验证、提交并推送、更新"进度"。长任务放后台跑。只有遇到 D10 里"停下来问"的情况才停下来问用户，其他情况不要停，也不要只汇报不干活。路线图全部完成后，在"进度"里写明，并用 CronDelete 删掉这个定时任务。这个定时任务创建于 2026-11-19，7 天后会自动过期：如果今天已经是 2026-11-25 或更晚，并且路线图还没做完，就用 CronCreate 新建一个同样的任务（每 15 分钟，提示词照抄这段）。

（在新机器上建时，"创建于"那一句改成新的日期。）

## 5. 交接时的状态

（交接的最后一步填）
