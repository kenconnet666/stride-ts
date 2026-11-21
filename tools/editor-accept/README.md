# 编辑器验收

用编辑器把样例打开、改、保存、重新打开、试玩一遍，看编辑器和运行时有没有错。改了编辑器（`packages/editor`、引擎的 `editor/`、字段描述、场景的加载）以后复跑。2026-11-20 第一次跑的结果在 docs/progress-log.md 的"P3 编辑器的验收"。

## 用法

先照字段描述查所有样例的场景、预制体文件（实体的组件和场景自己的设置；不开浏览器，几秒钟）：

```bash
node tools/editor-accept/check-fields.ts
```

再在浏览器里跑（每个样例一两分钟，一次一个无头游戏）：

```bash
pwsh tools/editor-accept/run.ps1 -Apps platformer,topdown-rpg
```

不给 `-Apps` 时跑所有有场景文件的样例（sprite-fonts、custom-effect 的场景是代码建的，跳过）。端口是样例的端口加 `$env:STRIDE_PORT_OFFSET`，CLI 的状态目录照 `$env:STRIDE_STATE_DIR`、`$env:STRIDE_BROWSER_DIR`：几个会话同时跑时各设各的，别和别人的开发服务器撞端口。报告（`<样例>.json`）、日志和截图默认在临时目录的 `stride-editor-accept/` 下（`-Out` 改）。

## 每个样例做什么（accept.ts）

经 CDP 操作编辑器页面里的会话对象（`document.querySelector('#app').__vue_app__._instance.props.session`）：

1. 打开根场景，逐个实体选中，让属性面板画一遍（控制台有错误、警告就记下）。
2. 不改就保存：场景文件应逐字节不变（编辑器写的格式和导入器的一样）。
3. 改：根下第一个带模型的实体上移 1、改名；加一个子实体，给它加游戏的一个脚本（挑没有必填属性、不要求别的组件的）；复制粘贴这个实体；撤销到底再重做到底。保存，检查文件里有这些改动。
4. 重新加载页面，改动还在。
5. 依次打开资源里的其他场景，各画一遍属性面板。
6. 试玩，检查游戏里有加的实体。

## 注意

- **保存会写内容目录**：`run.ps1` 先用 `content.ps1 protect` 保护起来（目录联接换成拷贝；真目录整份备份），验完 `restore` 还原。中途停掉的话手动 `pwsh tools/editor-accept/content.ps1 restore <样例>`，不然内容目录里留着验收改过的场景。
- **第一次开编辑器要等预构建**：新起的开发服务器第一次打开编辑器时，Vite 要预构建依赖，页面一分钟左右才起来；accept.ts 等 3 分钟。
- 回归里也跑：`regress.ps1 -Editor`（或 `-Changed` 时改了编辑器自动跑 platformer、greybox）在冒烟过了以后、同一个开发服务器上开编辑器跑 `accept.ts`，前后用 `content.ps1` 保护、还原内容目录；报告在这个样例的回归状态目录的 `editor-accept/` 下。单独跑用 `run.ps1`。
