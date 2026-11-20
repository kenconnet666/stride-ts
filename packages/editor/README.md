# @stride-ts/editor

编辑器：Node 后端（挂在应用的开发服务器上）和界面（Vue 加 vue-tsx-pro）。任何一个样例 `pnpm dev` 以后，打开开发服务器上的 `/__stride/editor/` 就是它的编辑器，比如：

```bash
pnpm --filter @stride-ts/platformer dev
```

然后打开 `http://localhost:5184/__stride/editor/`。

## 界面

`src/ui`：工具条（保存、撤销、重做、试玩），左边场景树，中间视口（游戏页面本身，嵌在同源的 iframe 里，地址带 `?debug&stride-edit`），右边属性面板，下面资源浏览器。界面由第二个 Vite 服务器提供，第一次打开编辑器时才建（见 `src/server/vite.ts`），游戏页面不经过它。

- 场景文档和撤销栈在界面这边（`ui/session.ts`），游戏页面里的实体跟着它；视口里拖操纵器、属性面板里改的，都是对文档的修改。
- 属性面板照引擎的字段描述（`editor/fields.ts`）画控件；脚本的字段问游戏页面（它有脚本的类）。"添加组件"里也列出游戏登记的脚本，加上的脚本 `type` 写登记的名字（`game/player/PlayerInput#PlayerInput`）。
- 快捷键：Ctrl+S 保存，Ctrl+Z / Ctrl+Y 撤销重做（焦点在视口里也行）；视口里 W、E、R 换操纵器，F 聚焦。
- 复制粘贴实体：Ctrl+C 复制选中的实体（连同后代、组件），Ctrl+V 粘贴成选中的实体的兄弟（紧跟在后面），Ctrl+Shift+V 粘贴成它的子实体，Ctrl+D 复制一份放在原来的后面。新 id，拷贝之间的引用跟着换，实例还是引用加覆盖；取舍见 docs/decisions.md 的"编辑器里复制、粘贴实体"。
- 试玩是不带 `stride-edit` 重新打开游戏页面（先保存）。
- 资源浏览器：选中资源可以移动、改名、删除（引用它的文件跟着改写）；场景、预制体可以打开（双击或"打开"按钮）。

### 预制体

场景文件里的实例只存引用和差异（格式和取舍见 [docs/prefabs.md](../../docs/prefabs.md)）。编辑器里看到、改的都是展开以后的场景：

- 场景树里实例后面标着预制体的名字（⟨Pillar0x5x0⟩），展开能看到成员（斜体）；视口里点到成员选中的是实例。
- 属性面板显示展开后的值（实例的根带着预制体的组件）；改成员的值、根的组件，记成实例 `prefab.set` 里的一条覆盖，改回和预制体一样时这条覆盖去掉；可选字段设回默认值时不写。删成员记进 `prefab.removed`。换算在引擎的 `editor/prefabEdits.ts`（`toDocumentEdit`）。
- 成员不在文档里：不能拖去别处、不能在它下面加实体。
- 单独打开预制体：视口里只有它（加两盏预览用的灯），改完保存，回到场景（工具条上的"回到场景"）时场景里的实例跟着变。游戏页面拿到的是编辑器展开好的场景，不自己读预制体文件。

## 后端

后端是一个 Vite 插件，挂在应用的开发服务器上（`tools/vite-app.ts` 的 `strideApp` 已经带上，所以每个 `apps/*` 的 `pnpm dev` 都有）：

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
