# 扩展引擎和编辑器

游戏和工程不改引擎、编辑器的源码就能加的东西，每一项在哪里写、照哪个样例。接口的细节看各处的文档注释，这里只给入口。

| 想加的 | 怎么加 | 样例 |
|---|---|---|
| 挂在实体上的逻辑 | 脚本：`SyncScript.props({...})` / `AsyncScript` 的子类，按模块路径登记 | `apps/collect-dodge/src/game/Coin.ts` |
| 对大量实体的每帧逻辑 | 数据组件 `component({...})` 加系统 `system({ with, writes, update })` | `apps/sandbox/src/game/particles.ts` |
| 不属于某个实体的每帧逻辑 | 子系统 `game.addSystem({ phase, update, moveOrigin, destroy })` | 引擎内置的地形、摆放、天气（`engine/Game.ts` 的 `#builtinSystems`） |
| 自己的资源种类 | 引擎：`registerAssetKind` 加 `CustomAssetKinds` 声明合并；编辑器：工程扩展 `defineEditorExtension` | `apps/greybox/editor/extension.ts`（柱子） |
| 调试命令 | `game.debug.command(名字, 说明, handler)`，CLI 用 `stride call <名字>` | `apps/collect-dodge/src/game/GameRules.ts` 的 `rules` |
| 网格的着色钩子 | `meshEffect(wgsl, defaults)` 按导出名登记，场景合成器的效果名引用 | `apps/space-escape`（走廊弯曲、远处起雾） |
| 自己画的东西 | 继承 `RootRenderFeature`（extract、cull、prepare、draw），`game.renderSystem.addFeature(...)` | `rendering/sky/BackgroundRenderFeature.ts`、`rendering/SpriteRenderFeature.ts` |
| C/C++ 写的重活 | 原生插件：wasm 侧模块，和物理、贴图、导航模块同等地位，共用内存和线程 | fork 的 `StrideNative/Plugins/README.md` 和 `Example/` |

## 脚本、数据组件和系统

写法见 [architecture.md](architecture.md) 的"组件 API"：属性用 `prop` builder 声明（类型全靠推导，属性面板照它画字段），脚本有
`start`、`update`、`cancel` 的生命周期和 `disposables`，数据组件是列存储，系统按查询批量跑。入口用 `Game.hotEntry` 加
`import.meta.glob('./game/**/*.ts')`，开发时改了热重载。

## 每帧的子系统

`GameSystem` 的 `phase` 分两种：会挂上、挪动实体的放 `beforeTransforms`，读世界矩阵的放 `afterTransforms`（默认）。大世界里
渲染原点挪动时 `moveOrigin(dx, dy, dz)` 被调，存着渲染空间坐标的东西跟着挪；游戏退出时倒着加的顺序调 `destroy`。同一阶段按加的
顺序跑，排在内置的后面。

## 自定义的资源种类

一种资源在一处写全（编辑器扩展的 `assetKinds` 一项）：

- 种类名和主文件的扩展名（`.lamp.json`；以 `.json` 结尾的能在属性面板里改、经编辑器接口和 MCP 读写）；
- `references`：文件里引用别的资源的每一处，编辑器移动、改名、删除资源时照它改写，资源浏览器列依赖，加载场景时预加载；
- `fields`：属性面板的字段（`@stride-ts/engine/editor-fields` 的 `fields<F>()`），也是 agent 拿到的 JSON Schema；
- `label`、`template`：界面上的名字（按语言）、资源浏览器"新建"菜单里的一项；
- `bake`：存下、改了、打开工程时后端烘出的文件（一般是同名的模型），烘出的资源跟着源文件挪、删。

工程清单 `stride.project.json` 的 `extension` 指向这个模块。编辑器后端和 MCP 服务在 Node 里装它，界面在浏览器里装同一个模块，
所以模块顶层只放数据和纯函数，烘焙要用 Node 的东西放进 `bake` 里动态导入。类型上：

```ts
declare module '@stride-ts/engine' { interface CustomAssetKinds { lamp: LampFile } }
```

之后 `AssetKind` 认得 `'lamp'`，`references`、`bake` 拿到的是 `LampFile`。游戏运行时也要认这种资源（预加载它的引用）时，游戏
代码里调一次 `installEditorExtension`（或者只用引擎的 `registerAssetKind`）。细节在编辑器的 [README](../packages/editor/README.md)
"界面"一节。

## 调试命令

`game.debug.command` 返回一个 `Disposable`，脚本里放进 `this.disposables`，脚本去掉时命令跟着去掉。handler 拿到 JSON 解出的参数，
返回值（可以是 Promise）转成 JSON 交给 CLI，抛错时 CLI 拿到错误信息。引擎自带的命令按领域分在 `debug/commands/` 里，可以照着写。

## 渲染

- 网格效果（`rendering/mesh/meshEffect.ts`）：WGSL 里定义 `effectWorldPosition`、`effectUv`、`effectVarying`、`effectShading`
  几个钩子（只写要改的），每个网格 16 个参数，脚本用 `Mesh.setEffectParameters` 改。
- 根渲染特性（`rendering/RenderSystem.ts` 的 `RootRenderFeature`）：`extract` 在 CPU 上取这一帧要画的，`cull` 按视图剔，
  `prepare` 上传，`draw` 在各阶段（不透明、透明、阴影、点选、运动向量）画；覆盖 `supportsPicking`、`supportsVelocity`、`supportsWireframe`、`drawsDepth` 这几个开关，
  不画的阶段不被调用。
- 材质节点图的节点库（`rendering/mesh/materialGraph.ts` 的 `MATERIAL_NODES`）和视口里的编辑工具（`editor/viewport/tools/`
  的 `ViewportTool`）现在只有内置的，还不能从工程里登记。

## 原生插件

自己的 C/C++ 编成 wasm 侧模块，和核心模块一起加载（`Game.run` 的 `nativeFeatures`），零拷贝地读写变换存储这类运行时数据、把
工作分到所有线程上。只用 C API（`Plugin.h`、`Core.h`、`Runtime.h`、`Debug.h`），和运行时同一个 emsdk 版本，64 位；构建用 npm 包
`dist/sdk/` 里的 CMake 函数。见 fork 的 `StrideNative/Plugins/README.md`。
