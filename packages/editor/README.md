# @stride-ts/editor

编辑器。现在只有 Node 后端和前端调它的封装；界面（场景树、属性面板、资源浏览器）还没做。

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
- **接口**（`src/protocol.ts`）：`/__stride/editor/` 下的 `GET project`、`GET assets`、`GET asset`、`PUT asset`；资源变了经 Vite 的 HMR 通道推送 `stride:assets`。只认本机同源页面发的、带 `x-stride-editor` 头的请求。前端用 `EditorClient`（`@stride-ts/editor/client`）。
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

## 在页面里编辑场景

运行时那一半在引擎里（`@stride-ts/engine` 的 `editor/`）：`SceneDocument`（场景文件是真相，修改、撤销重做）、`LiveScene`（实体跟着文档）、`EditorCameraController`、`game.pick`。合起来：

```ts
const client = new EditorClient();
const document = new SceneDocument(await client.readAsset<SceneFile>('scene', 'Game/MainScene'));
const undo = new UndoStack(document);
const live = await LiveScene.open(game, document);
undo.apply({ type: 'set', entity: id, path: ['position'], value: [0, 2, 0] });
await live.sync();
await client.saveAsset('scene', 'Game/MainScene', document.file);
```
