# @stride-ts/editor

编辑器：Node 后端（挂在应用的开发服务器上）和界面（Vue 加 vue-tsx-pro）。任何一个样例 `pnpm dev` 以后，打开开发服务器上的 `/__stride/editor/` 就是它的编辑器，比如：

```bash
pnpm --filter @stride-ts/platformer dev
```

然后打开 `http://localhost:5184/__stride/editor/`。

新建工程（仓库的 `apps/` 下面一个能跑的空游戏，主场景里有相机、投阴影的太阳、物理天空、地面）：

```bash
node packages/editor/src/server/cli.ts new apps/my-game
```

然后 `pnpm install`、`pnpm --filter my-game dev`，打开它打印的编辑器地址。端口接着仓库里已有的往后排；手搭的工程内容要提交，`.gitignore` 里给它加一行例外（模板在 `src/server/template.ts`）。

## 界面

`src/ui`：布局参考 JetBrains IDE（`App.tsx` 用 vue-tsx-pro 的 Workbench，`Toolbars.tsx`）。最上面是主工具条（工程名、保存、撤销、重做，右边试玩）；中间是视口（游戏页面本身，嵌在同源的 iframe 里，地址带 `?debug&stride-edit`），上面是文档页签和视口工具条（对选中实体的操作、吸附、画幅参考线）；面板是停在四周的工具窗口——左边场景树（上）和资源（下），右边属性面板，下边是正在编辑的时间轴、节点图或粒子（打开时自动出来）；两侧竖条上的图标显示、收起它们，显示哪些、各占多大记在浏览器的 localStorage 里；最下面是状态栏（提示和出错、选中几个、界面语言）。工程、资源列表还没读到，或视口还在打开游戏页面（`session.opening`）时，场景树、资源、属性面板、文档页签、视口画骨架屏。按钮、输入框、下拉框、菜单、页签都用 vue-tsx-pro 的组件。界面由第二个 Vite 服务器提供，第一次打开编辑器时才建（见 `src/server/vite.ts`），游戏页面不经过它。`src/` 根上是前后端共用的接口（`protocol.ts`）和前端的封装（`EditorClient.ts`），`src/server` 是后端。

- 场景文档和撤销栈在界面这边（`ui/session.ts`），游戏页面里的实体跟着它；视口里拖操纵器、属性面板里改的，都是对文档的修改。
- 属性面板照引擎的字段描述（`editor/fields/index.ts`）画控件；脚本的字段问游戏页面（它有脚本的类）。"添加组件"里也列出游戏登记的脚本，加上的脚本 `type` 写登记的名字（`game/player/PlayerInput#PlayerInput`）。加脚本、加组件时，它要同一个实体上有的组件（脚本的 `requires`、字段描述的 `requires`，比如日夜循环要物理天空）一起加上；去掉被依赖的组件时工具条上提示。必填属性没设的标红，保存时在工具条上列出来（试玩时这些脚本不挂）。
- 不选实体时属性面板显示场景自己的设置（物理、导航、偏移、合成器，`SCENE_FIELDS`）：合成器、偏移改了视口马上变，物理、导航试玩时用上。
- 快捷键：Ctrl+S 保存，Ctrl+Z / Ctrl+Y 撤销重做（焦点在视口里也行）；视口里 W、E、R 换操纵器，F 聚焦。
- 吸附：视口工具条上的磁铁开关和移动（米）、旋转（度）、缩放（倍数）的步长；拖操纵器时按住 Ctrl 反过来（开着时临时不吸、关着时临时吸）。设置记在编辑器的会话里。
- 场景树最上面一个节点是场景（打开预制体时是预制体）本身：选中它、或者在视口里点空处，属性面板显示场景的设置；实体拖到它上面挂到根上。
- 多选：场景树里 Ctrl+单击加减、Shift+单击选一段（视口里 Ctrl+单击）。属性面板显示选中的实体都有的组件，值不一样的显示"多个值"；改一处改所有选中的，一步撤销。
- 复制粘贴实体：Ctrl+C 复制选中的实体（连同后代、组件），Ctrl+V 粘贴成选中的实体的兄弟（紧跟在后面），Ctrl+Shift+V 粘贴成它的子实体，Ctrl+D 复制一份放在原来的后面。新 id，拷贝之间的引用跟着换，实例还是引用加覆盖；取舍见 docs/decisions.md 的"编辑器里复制、粘贴实体"。
- 试玩是不带 `stride-edit` 重新打开游戏页面（先保存）。
- 时间轴：资源浏览器里打开 `.timeline.json`，下面出时间轴面板（`src/ui/TimelinePanel.tsx`）：拖时间视口预览（不改场景文档）、从时间轴的相机里看、拖关键帧、加删关键帧、给选中实体的位置旋转打关键帧；曲线编辑器（`src/ui/TimelineCurves.tsx`）：拖关键帧的值和切线、自动和平切线、插值方式。
- agent 工具：`node packages/editor/src/server/cli.ts mcp apps/<工程>` 用 stdio 起 MCP 服务（`src/server/mcpServer.ts`），工具有资源的读写、新建、删除、移动、导入，场景和预制体的修改（`edit_scene`，照字段描述检查），切精灵表（`slice_sprites`：按网格或自动找不透明的块），合成音效（`generate_sound`：按类别随机或在已有的附近变一点，sfxr 的参数），材质库和特效库（`list_library`、`use_library`：拷进工程、用在实体上或加进场景），大世界（`create_world` 建 `.world.json`，`place_in_world` 按世界坐标把实体放进对应格子的场景、补上索引，`world_info` 列格子），字段描述的 JSON Schema，截图、出片（`render`：离线渲染成 MP4 或 PNG 序列，存进工程的 `exports/`；编辑器页面上会开一个看不见的试玩页面来渲染）和页面命令（要开发服务器开着）。一个服务一次编辑一个工程，`switch_project` 换到仓库里别的工程（`project` 列出有哪些）。仓库根的 `.mcp.json` 已经把它登记成 Claude Code 的项目级 MCP 服务（`stride-editor`，从 `apps/open-world` 开始）。
- 多语言：界面文字在 `src/ui/messages.ts`（界面）和 `src/ui/fieldMessages.ts`（组件、字段的名字和说明，按英语原文翻）里，自带简体中文和英语；`?lang=`、工具条右边的下拉框换语言。加字段描述时一起翻（`test/i18n.test.ts` 查）。
- 验收：`pwsh tools/editor-accept/run.ps1 -Apps <样例>`（见 [tools/editor-accept](../../tools/editor-accept/README.md)）。
- 编辑资源：资源浏览器里选中材质、JSON 写的模型，属性面板显示资源自己的字段（引擎 `editor/fields/index.ts` 的 `ASSET_FIELDS`：材质的常用字段有控件，颜色树、材质层这类按 JSON 改；模型按形状换字段），改了稍等一下就存进资源文件，视口里用到它的实体热重载。选实体时回到实体的字段。
- 关卡白盒：`.brush.json`（引擎的 `BrushFile`）存下（属性面板、`PUT /asset`、MCP 的 `write_asset`）或在磁盘上改了，后端就烘出同名的 `.model`（pipeline 的 `bakeBrushModel`，原生工具模块的 Manifold）；笔刷不对时保存报 400。白盒和它的模型一起挪、一起删。
- SDF 建模：`.sdf.json`（引擎的 `SdfFile`）同白盒一样，存下或在磁盘上改了，后端就烘出同名的 `.model`（pipeline 的 `bakeSdfModel`，原生工具模块的 `st_sdf_mesh`：形状平滑地并、差、交，Manifold 的等值面网格化，再按几何误差简化）；两种都在后端的同一张烘焙表里（`#bake`），模型跟着源文件挪、删。资源浏览器的"新建 → SDF 模型"建一个椭球加球头的例子，属性面板里改形状、融合宽度，视口热重载。
- 3D 文字：`.text.json`（引擎的 `TextModelFile`：文字、字体资源、字高、厚度、对齐、行距、字距）同样烘出同名的 `.model`（pipeline 的 `bakeTextModel`：字体资源的字形轮廓按 Manifold 挤出、挖洞，字面是材质槽 0、侧面和背面是槽 1）。"新建 → 3D 文字"用工程里的第一个字体。
- 多边形网格：`.poly.json`（引擎的 `PolyMeshFile`）同白盒一样烘成同名的 `.model`。编辑操作（挤出、内插、倒角、合并、切割、连接、移动、删面、翻面、换材质）是引擎 `modeling/polyEdit.ts` 的纯函数，agent 用 MCP 的 `edit_poly` 按名字调；人在属性面板的模型组件上点"编辑多边形"，视口进点、边、面的编辑模式（1、2、3 换模式，操纵器拖选中的顶点，视口工具条上是各个操作），每一步存文件、后端烘、视口热重载，开着时撤销、重做是网格的一步（`session.polyEditing`）。
- 粒子：属性面板的粒子系统上点"粒子编辑器"，下边的粒子窗口是发射器的模块栈（引擎的模块库 `editor/particleModules.ts`）。窗口工具条上的"烘成序列帧"把这个粒子系统烘成一张图集（引擎的 `offline/FlipbookBaker.ts`，游戏页面里的调试命令 `bake`，agent 用 MCP 的 `game_command`），存进 `Textures/<名字>Flipbook.png`，旁边加一个用一个粒子放它的实体。
- 资源浏览器：选中资源可以移动、改名、删除（引用它的文件跟着改写）；场景、预制体可以打开（双击或"打开"按钮）。"新建"在选中的文件夹里建场景、材质、基本形状的模型（JSON 写的 `.model`，引擎生成网格）、UI 页面（初始内容在 `src/newAssets.ts`），重名的加数字，建好以后选中它、路径框里改名。从系统里拖进来的音频（mp3、ogg、wav、flac、aac）导入成声音、图片（png、jpg、webp、svg）导入成贴图，源文件放在旁边；模型（glb、gltf、fbx、obj）经导入器（pipeline 的 `importSourceModel`）成模型、材质、贴图（`POST /import`；带骨骼、动画的连骨架和每个动画的剪辑一起导入，放在 `<名字>/` 下）。源模型留在旁边，导入设置写在同名的 `.import.json`（缩放、材质、动画、采样率），属性面板或 MCP 改了就重新导入（已经有的材质不动）；字体（ttf、otf、ttc）编成运行时字体（pipeline 的 `importFontFile`，字形轮廓按码位分块，用到哪块下哪块）。

### 预制体

场景文件里的实例只存引用和差异（格式和取舍见 [docs/prefabs.md](../../docs/prefabs.md)）。编辑器里看到、改的都是展开以后的场景：

- 场景树里实例后面标着预制体的名字（⟨Pillar0x5x0⟩），展开能看到成员（斜体）；视口里点到成员选中的是实例。
- 属性面板显示展开后的值（实例的根带着预制体的组件）；改成员的值、根的组件，记成实例 `prefab.set` 里的一条覆盖，改回和预制体一样时这条覆盖去掉；可选字段设回默认值时不写。删成员记进 `prefab.removed`。换算在引擎的 `editor/prefabEdits.ts`（`toDocumentEdit`）。
- 成员不在文档里、跟着预制体：不能拖去别处；可以在它下面加、粘贴、拖进实体（场景文件里是普通实体，父实体写成员的 id `<实例>/<预制体里的 id>`）。
- 做成预制体：选中一个实体（场景里的普通实体，不是实例或成员），工具条上的"做成预制体"把它连同后代存到 `Prefabs/<名字>`（根的变换归零），场景里原地换成它的实例（用原来的 id；指向后代的引用改成 `<根>/<后代>`），一步撤销（预制体文件留着）。在引擎的 `editor/makePrefab.ts`。
- 单独打开预制体：视口里只有它（加两盏预览用的灯），改完保存，回到场景（关掉预制体的页签，或点场景的页签）时场景里的实例跟着变。游戏页面拿到的是编辑器展开好的场景，不自己读预制体文件。

## 后端

后端是一个 Vite 插件，挂在应用的开发服务器上（`tools/lib/vite-app.ts` 的 `strideApp` 已经带上，所以每个 `apps/*` 的 `pnpm dev` 都有）：

```ts
import { strideEditor } from '@stride-ts/editor/vite';
export default defineConfig({ plugins: [strideEditor()] });
```

- **工程**就是应用的目录。清单 `stride.project.json` 可以没有，里面的每一项都有默认值：

  ```json
  { "format": 1, "name": "my-game", "content": "public/content", "assetTypes": "src/assets.gen.ts" }
  ```

- **内容目录就是资源的真相**：编辑器编辑的就是运行时加载的那些 JSON（场景、预制体、材质、UI……），保存就是写回这些文件；模型、贴图这些二进制由导入器产出。
- **资源数据库**（`AssetDatabase`）：启动时扫一遍内容目录，之后只重读变了的文件（文件变化用 Vite 自己的监视器）。每个资源记着它的文件、大小、引用了谁（和运行时加载场景时去读哪些文件是同一份逻辑，引擎的 `content/references.ts`），可以反过来查谁引用了它、哪些引用指向不存在的资源。
- **移动、改名、删除**（`moveAssets`、`deleteAsset`）：资源之间按内容路径引用，挪一个资源时引用它的文件里的那几处一起改写（位置由引擎的 `assetReferenceSlots` 找，模型、动画的二进制文件头也改），字体连着字形块、声音连着同名的音频文件一起挪，可以整个文件夹挪。删的时候还有别的资源引用它就不删，除非 `force`。
- **接口**（`src/protocol.ts`）：`/__stride/editor/api/` 下的 `GET project`、`GET assets`、`GET asset`、`PUT asset`、`DELETE asset`、`POST move`；资源变了经 Vite 的 HMR 通道推送 `stride:assets`。只认本机同源页面发的、带 `x-stride-editor` 头的请求。前端用 `EditorClient`（`@stride-ts/editor/client`）。
- **资源句柄**：按内容目录生成 `src/assets.gen.ts`（不提交），资源改名、删掉以后引用它的代码在类型检查时报错：

  ```ts
  import { assets } from './assets.gen';
  const bullet = await game.content.load(assets.prefabs.Game.Prefabs.Bullet);
  await game.setRootScene(assets.scenes.Game.MainScene);
  ```

## 命令行

不开开发服务器也能用（`typecheck`、`build` 之前生成句柄；检查引用）：

```bash
node packages/editor/src/server/cli.ts assets-types apps/platformer
```

```bash
node packages/editor/src/server/cli.ts assets apps/platformer
```

移动、改名、删除（引用它的文件跟着改写）：

```bash
node packages/editor/src/server/cli.ts move apps/platformer material MyGame/Materials/Grid MyGame/Materials/Floor
```

```bash
node packages/editor/src/server/cli.ts move-folder apps/platformer MyGame/Materials MyGame/Shared/Materials
```

```bash
node packages/editor/src/server/cli.ts delete apps/platformer material MyGame/Materials/Floor
```

## 在页面里编辑场景

运行时那一半在引擎里（`@stride-ts/engine` 的 `editor/`）。游戏页面的地址带上 `?stride-edit`（开发服务器上）就开在编辑状态：游戏照自己的入口启动，但场景不挂脚本、仿真不走，`game.editor`（`EditAgent`）是编辑器在这个页面里的代理——编辑相机、让实体跟着场景文档、点选、选中的框、操纵器。场景文档（`SceneDocument`，场景文件是真相）和撤销栈在编辑器的界面那边。合起来：

```ts
const editor = game.editor!;
const client = new EditorClient();
const document = new SceneDocument(await client.readAsset<SceneFile>('scene', editor.scenePath!));
const undo = new UndoStack(document);
await editor.open(undo);                  // 实体跟着文档；视口里拖操纵器改的也记进 undo
undo.apply({ type: 'set', entity: id, path: ['position'], value: [0, 2, 0] });
await editor.sync();
await client.saveAsset('scene', editor.scenePath!, document.file);
```

试玩是把页面不带 `?stride-edit` 重新打开。
