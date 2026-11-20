# stride-ts：Stride 的 TypeScript 孪生版

目标：做一个"形状像 Stride"、但比 Stride 做得更好的浏览器游戏引擎（2026-11-19 用户定：对齐 Stride 是底线，Stride 的毛病不跟，见 [docs/roadmap.md](docs/roadmap.md) 的"原则"）。
- 引擎和游戏脚本用 TypeScript 写：改完几百毫秒生效，支持热重载。
- 计算量大的部分用别人维护、预先编好的 C/C++/Rust WebAssembly 库，很少重编，按内容哈希长期缓存。
- 能用浏览器 API 的地方直接用。
- 编辑器也是自己的：Node.js 后端加 Web 前端，视口用的就是游戏运行时的同一套渲染器（2026-11-17 用户决定，不依赖 Stride Game Studio）。Stride 的工程通过导入器迁移过来。

## 现在做到哪了（2026-11-20）

- **P1、P2 完成**：Stride 的 20 个样例（Third Person Platformer、AnimatedModel、PhysicsSample、BepuSample、Platformer2D、TopDownRPG、FirstPersonShooter、SpriteFonts、GameMenu、JumpyJet、SpaceEscape、粒子、UI、声音、材质着色器、形变目标、C# 教程……）都移植了，导入器从 Stride 工程直接导入；TPP 和桌面 Stride 4.4.2 逐像素比对过（平均每通道差 0.7/255）。
- **P3 编辑器**：浏览器里的编辑器，视口就是运行着的游戏：场景树、属性面板、操纵器、资源浏览器（移动、改名、删除时改写引用）、撤销重做、试玩、预制体（场景里只存引用和差异，改实例的成员落成覆盖，单独打开预制体编辑）。
- **P4 现代画面**：画质档位、管线预热、渲染图；TAA 和运动向量、GTAO、屏幕空间反射、接触阴影、运动模糊。
- 进度和下一步见 [docs/roadmap.md](docs/roadmap.md) 末尾的"进度"；换机器、新环境上手见 [docs/handover.md](docs/handover.md)。

来由：Stride 的 C# 网页移植（`~\IdeaProjects\stride`，fork `kenconnet666/stride` 的 `web-experiment-base` 分支）能跑，但浏览器里的 .NET 没有 JIT，每次改动都要 AOT 编译，迭代慢，而且引擎和游戏被链接进同一个 wasm，没法分开缓存。2026-11-16 决定暂停那条线，转做这个。调研全文见 [docs/research.md](docs/research.md)，历史经验见 [docs/lessons.md](docs/lessons.md)。

## 开发

需要 Node 22+ 和 pnpm 10，浏览器要支持 WebGPU（Chrome）。原生模块（`@stride-ts/native`）由 `pnpm install` 从 Jolt fork 的 GitHub Release 装，不用自己编；只有改原生部分时才要在 Jolt 的 fork（`C:\code\JoltPhysics`）里用 `StrideNative/Scripts/build-wasm.ps1` 编（流程见下表的第一行）。

```bash
pnpm install
pnpm dev          # sandbox on http://localhost:5180 (COOP/COEP headers set)
pnpm test         # Vitest in Node
pnpm typecheck
pnpm build        # sandbox production build; `pnpm --filter @stride-ts/sandbox preview` serves it on 5181
```

跑一个样例（以 Third Person Platformer 为例；内容从 Stride 仓库导入，不提交）：

```bash
pnpm --filter @stride-ts/platformer import:stride
```

```bash
pnpm --filter @stride-ts/platformer dev
```

然后打开 `http://localhost:5184/?debug`（游戏，带 `?debug` 才连调试 CLI）或 `http://localhost:5184/__stride/editor/`（编辑器）。调试 CLI 在仓库根目录 `pnpm exec stride <命令>`（`status`、`shot`、`perf`、`metrics`……，见 [packages/cli/README.md](packages/cli/README.md)）。

全部样例的冒烟回归在单独的 git 工作树里跑（主检出可以接着改）：`pwsh tools/verify.ps1`，见 [tools/README.md](tools/README.md)。各样例的端口见 [docs/handover.md](docs/handover.md)。

| 目录 | 内容 |
|---|---|
| `@stride-ts/native` | 原生部分（Jolt、Recast、ozz、解码，多线程 SIMD 的 wasm 加 TS 绑定）。是 fork 仓库 `StrideNative/JS/` 里的 npm 包，还没发布到 npm，`pnpm-workspace.yaml` 的 override 让 pnpm 从 fork 的 GitHub Release 安装。更新：改 fork 的 `StrideNative/JS/package.json` 版本号 → `pwsh StrideNative/Scripts/build-wasm.ps1`（构建、测试、打包）→ 提交并推送 fork → `pwsh StrideNative/Scripts/release-native.ps1`（发布 GitHub Release `native-v<版本>`）→ 把本仓库 `pnpm-workspace.yaml` 里 override 的地址换成新版本 → `pnpm install` |
| `packages/engine` | `@stride-ts/engine`：引擎层，目录按 Stride 的命名空间分：`data/`（`prop` 和 schema）、`engine/`（实体、列存储、系统、脚本、登记）、`games/`、`graphics/`、`rendering/`、`content/`、`physics/`、`navigation/`、`input/`、`animation/`、`ui/`、`particles/`、`audio/`、`mathematics/`、`values/`（Decimal、日期时间）、`debug/`（调试命令、调试线、统计量）、`editor/`（编辑器在引擎里的那一半：场景文档、编辑状态、操纵器、字段描述）；源码直接以 TS 导出，不单独构建。`test/` 里有运行时测试、类型测试 `types.check.ts` 和类型压力测试 `stress.check.ts` |
| `apps/sandbox/src/game` | 沙盒的游戏代码，用 `import.meta.glob` 交给引擎登记：粒子组件和系统、生成粒子的 `Fountain` 脚本 |
| `packages/pipeline` | `@stride-ts/pipeline`：资源管线（Node 直接运行 TS）。现在是 Stride 工程导入器：读 Stride 的 YAML 场景、模型、材质、贴图、天空盒，源 FBX/glTF 经 stride-tools 导入，源图片编成 KTX2（Basis），HDR 天空盒算成球谐和预滤波的立方体贴图，写出运行时内容（格式在 `packages/engine/src/content/format.ts`） |
| `apps/platformer` | Third Person Platformer 的移植。`pnpm --filter @stride-ts/platformer import:stride` 从 Stride 仓库（默认 `~/IdeaProjects/stride`，可用 `STRIDE_REPO` 改）导入场景到 `public/content`（不提交，`content-overrides/` 里是代替源图片的 SVG），`pnpm --filter @stride-ts/platformer dev` 在 5184 端口（开发时用调试版原生模块） |
| `apps/<样例>` | 其余 Stride 样例的移植（animated-model、physics-sample、bepu-sample、game-menu、csharp-beginner 等），用法同 `apps/platformer`：`import:stride` 导入、`dev` 运行、`smoke` 冒烟。清单、端口和验收结果见 [docs/roadmap.md](docs/roadmap.md) 的"进度" |
| `packages/cli` | 调试 CLI `stride`：查看和操作正在运行的游戏（状态、实体、输入、截图比较、性能），见 [packages/cli/README.md](packages/cli/README.md) |
| `packages/editor` | `@stride-ts/editor`：编辑器。Node 后端（开发服务器上的 Vite 插件：工程、资源数据库、保存和移动资源、生成 `src/assets.gen.ts`）和界面（Vue 加 vue-tsx-pro：场景树、属性面板、视口、资源浏览器、预制体），样例 `pnpm dev` 以后开 `/__stride/editor/`；见 [packages/editor/README.md](packages/editor/README.md) |
| `apps/sandbox` | 冒烟测试页：跨源隔离、原生模块的工作线程、WebGPU、帧循环、Jolt 步进 |
| `apps/bench` | 数据布局和跨边界开销的基准（JS 对象、JS 堆的 TypedArray、wasm 共享内存、JS 到 wasm 的调用、上传 GPU、创建和每帧更新）。`pnpm --filter @stride-ts/bench dev` 在 5182 端口，`tools/bench.cjs` 在无头 Chrome 里跑并打印结果（`?only=render` 只跑渲染提交）；`gc.html` 是 GC 场景，用 `tools/gc-trace.cjs` 跑。结论见 [docs/architecture.md](docs/architecture.md) 的"实测"各节和"复杂场景的帧预算估算" |
| `tools/` | 回归、验证、测量的脚本，桌面 Stride 的截图工程（`tools/stride-capture`），调试桥扩展，见 [tools/README.md](tools/README.md) |

## 技术栈的组织方式（2026-11-17，用户的方向）

依赖分两类，详见 [docs/own-stack.md](docs/own-stack.md)：
- **JS/TS 的部分放在仓库内自己维护**：引擎层和渲染器都自己写。渲染器和 Stride 对齐、数据导向、和 Jolt 共享内存（用户 2026-11-17 决定，长期工程），设计见 [docs/architecture.md](docs/architecture.md)。不用 three.js，也不 fork PlayCanvas。
- **需要 wasm 的部分 fork 后维护成自己需要的样子，合成一个 C++ 工程**（`stride-native`）：Jolt、Recast/Detour、Basis 转码器、meshopt 解码器，一套我们自己设计的批量 C API，一个堆、一个线程池；同一份网格数据只进 wasm 一次，物理和导航共用。

下表"推荐方案"里的库选型不变，变的是使用方式：从"直接依赖现成的包"改成"源码进仓库、自己维护"。

## 推荐方案（2026-11-16）

| 方面 | 选择 | 理由 |
|---|---|---|
| 渲染和引擎层 | **自己写，和 Stride 对齐**（2026-11-17 用户决定） | 按 Stride 的 RenderSystem、RenderFeature、Effect 结构用 TS 实现，复用 C# 移植版编出来的 Stride WGSL 着色器，画面和桌面 Stride 一致；变换数组放在 wasm 内存里，Jolt 直接写，整段上传给 GPU。见 [docs/architecture.md](docs/architecture.md) |
| 语言和构建 | TypeScript 7 加 Vite 8（底层是 Rolldown 和 Oxc），不做编译期改写（2026-11-18 用户决定，见 [docs/architecture.md](docs/architecture.md)） | 毫秒级重新构建，开发时 HMR，发布时产物按内容哈希命名；开发版和正式版跑同一份代码 |
| 物理 | **Jolt**（JoltPhysics.js） | 功能覆盖 Stride 用到的角色、约束、软体、车辆、布娃娃；JS 绑定由作者本人维护；有带 SIMD 的多线程版本。备选 Rapier：有确定性版本，适合联网和回放 |
| 导航 | recast-navigation-js | 和 Stride 的 DotRecast 是同一套算法 |
| 纹理 | KTX2 加 Basis Universal 转码器，在 Worker 里转码 | glTF 标准扩展 |
| 网格 | glTF 2.0 加 meshoptimizer 压缩 | 解码器小而快 |
| 音频、视频、图片、文字、输入、VR | 浏览器 API：Web Audio、`<video>` 和 WebCodecs、`createImageBitmap`、Canvas 2D 加离线 MSDF 图集、DOM 事件和 Gamepad API、WebXR | 不需要任何库 |
| 线程 | **只用多线程版**（2026-11-17 用户决定，放弃单线程路线）：主线程驱动一帧，Jolt 的任务系统把物理步进分给 pthread 工作线程；Worker 另做无状态的重活（转码、解码、导航网格构建） | 物理查询保持同步，保留 Stride 的 API 形状；代价是部署必须带 COOP/COEP 响应头（跨源隔离） |
| 自己写的原生代码 | 新代码用 Rust，复用旧代码用 C++ | 不用 C#：要带 .NET 运行时、必须 AOT，而且 .NET 11.0.0 的 Mono 还有个 SIMD bug |

## 原型计划（2026-11-16 的计划，P1 已完成）

> 下面是开工时的计划，留着做对照。结果：导入器、运行时、TPP 的游戏逻辑都做了，TPP 和桌面 Stride 逐像素比对过；体积和启动的实测见 [docs/architecture.md](docs/architecture.md) 的"体积"。

用第三人称平台跳跃游戏（Third Person Platformer）做第一个对比。它在 Stride 仓库的 `samples/Templates/ThirdPersonPlatformer`，物理已经转换成 Bepu。

1. **导入器和资源管线**（Node.js）：Stride 工程导入器读取 Stride 的 YAML 资源（场景、预制体、材质、组件参数），源素材（FBX、PNG、WAV）交给我们的管线，产出运行时的二进制：GPU 布局的网格（含碰撞数据）、按 WGSL 反射布局排好的材质参数、场景、动画曲线、KTX2 纹理、Opus 音频。着色器从 C# 移植版编出的 Stride WGSL 移植进来。
2. **运行时**：自己写 Stride 风格的引擎层和渲染器（按 [docs/architecture.md](docs/architecture.md) 的里程碑），实现这些 API：`Entity`、`TransformComponent`、`ModelComponent`、`CameraComponent`、`LightComponent`、`SyncScript`、`AsyncScript`；物理组件背后接 Jolt。
3. **移植游戏逻辑**：角色控制、相机、动画控制，按 TypeScript 和我们的 API 重写（参考 C# 版，不是逐行翻译）。
4. **和 C# 移植版对比**，同一台机器、同一个场景：

| 指标 | C# 移植版的已知数字 |
|---|---|
| 帧时间 | FPS 枪战约 10–13 ms；Top Down RPG 约 13–15 ms；TPP 无头浏览器约 90 fps |
| 改一行脚本到看到效果 | 最好情况约 84–154 秒（AOT 加各种缓存） |
| 首次加载、体积 | TPP 按正式发布设置：代码约 63 MB（gzip 约 19 MB：`dotnet.native.wasm` 53 MB / gzip 15.4 MB，加 50 个程序集 9.8 MB / gzip 3.8 MB），内容 10.2 MB（gzip 6.8 MB），合计 gzip 约 26 MB；游戏一更新，整个 wasm 都要重新下载。TS 版估算：代码约 4 MB（gzip 约 1.5 MB），内容同一量级，合计 gzip 约 7–8 MB；更新时只下载游戏脚本和改过的内容 |
| 热重载 | 不支持（TS 版支持：改脚本、系统、数据组件，页面不刷新、状态保留，见 docs/architecture.md 的"热重载"） |

## 组件和脚本的写法（设计草案）

> 2026-11-18：不做 SWC 插件，改为纯 TS 的写法：属性用 `prop` builder 声明，类型全部由推导得出；大量实体的逻辑用数据组件加系统，系统直接遍历按块存放的列。完整设计（属性、组件的名字、脚本、数据组件和系统、生命周期、事件、属性的分层覆盖和转发、资源的强类型、材质参数的分层、校验、热重载、原生接口）见 [docs/architecture.md](docs/architecture.md) 的"组件 API"。

名字和结构沿用 Stride，熟悉 Stride 的人容易上手，迁移 C# 游戏时有现成的对应关系；但迁移不是逐行翻译：异步加载、没有值类型、物理行为（Jolt 和 Bepu 不同）、材质、UI 都要按系统重新移植。按 TypeScript 的习惯调整：属性用声明式的 schema，方法用小驼峰，异步用 Promise，枚举用字符串字面量。

```ts
import { SyncScript, AsyncScript, component, system, prop, Vector3 } from '@stride-ts/engine';

export class PlayerController extends SyncScript.props({
  // Shown in the editor and read from the scene, like a public C# property
  maxRunSpeed: prop.number().min(0).default(10).unit('m/s'),
  jumpHeight: 1.2,                       // shorthand: number with a default
}) {
  private character!: CharacterComponent;
  // Reused every frame: no allocation in update()
  private readonly move = new Vector3();

  override start(): void {
    this.character = this.entity.require(CharacterComponent);
  }

  override update(): void {
    this.move.set(0, 0, 0);
    if (this.input.isKeyDown('KeyW')) this.move.z -= 1;
    this.character.move(this.move.normalize().scale(this.maxRunSpeed));
    if (this.input.isKeyPressed('Space')) this.character.tryJump(this.jumpHeight);
  }
}

export class DoorOpener extends AsyncScript.props({
  trigger: prop.component(() => TriggerComponent),
}) {
  override async execute(): Promise<void> {
    for (;;) {
      await this.trigger.entered(this.signal);   // aborted when the script is removed
      await this.nextFrame();
    }
  }
}

export const Health = component({
  max: prop.f32().min(0).default(100),
  current: prop.f32().default(100).transient(),   // runtime state, not saved
});
export const Regen = component({ rate: 5 });

export const regen = system({
  with: { health: Health, regen: Regen },
  writes: [Health],
  update({ health, regen, count }, time) {
    for (let i = 0; i < count; i++)
      health.current[i] = Math.min(health.max[i], health.current[i] + regen.rate[i] * time.elapsed);
  },
});
```

| Stride（C#） | stride-ts |
|---|---|
| `Entity.Get<T>()` | `entity.get(Type)` 返回 `T \| undefined`，`entity.require(Type)` 拿不到就抛错：泛型在运行时不存在，把类本身传进去 |
| 公开属性和字段 | `SyncScript.props({ ... })` 里用 `prop` 声明，类型由推导得出；导出场景里的值在启动时写入 |
| `SyncScript.Update()` | `update()` |
| `AsyncScript` 加 `await Script.NextFrame()` | async 的 `execute()` 加 `await this.nextFrame()`；取消用 `this.signal`（`AbortSignal`） |
| `EntityProcessor<T>` | 系统 `system(name, { with, update })`，按块遍历列 |
| `Vector3` 等值类型 | 可变对象：预分配、每帧复用，临时的从池里取（`using v = temp.vec3()`） |
| `out`、`ref` 参数，如射线检测的结果 | 传入一个结果对象让它填写：`simulation.raycast(from, to, hit)` |
| `Content.Load`（同步） | `await content.load()`；预加载过的资源可以同步 `get()` |
| 导出场景中的组件 `type` | 默认由源文件路径加导出名推出（`gameplay/health#Health`，游戏入口交给引擎 `import.meta.glob` 的结果），引擎和库的组件手写名字；运行时按名字找到模块、创建实例并填入属性 |
| `EventKey<T>` | 同名，`broadcast()`、`receiver()` |
| 改脚本要重新编译、重启 | Vite HMR 只替换这个模块，已有实例换成新类，字段值保留，游戏不重启 |

## 实例化、懒加载、缓存（设计草案）

| 优化 | 做法 | 脚本写法的变化 |
|---|---|---|
| 实例化渲染 | 同网格加同材质的物体由引擎自动合批；大量物体（草、子弹、人群）用 `InstancingComponent`，变换放在 TypedArray 里 | 大量物体按下标改变换，不再一个物体一个实体 |
| 资源懒加载 | 按场景或区域分组打包，Worker 里解码，用到时加载（同 Stride 的场景流式加载） | `await content.loadGroup()`，之后同步 `content.get()` |
| 代码懒加载 | 按关卡拆分脚本，动态 `import()`。C# 版做不到：所有代码都链接在一个 wasm 里 | `const { BossAI } = await import('./levels/castle/BossAI')` |
| 网络缓存 | 引擎、wasm 库、资源都按内容哈希命名，`Cache-Control: immutable`；可选用 Service Worker 支持离线 | 无，构建时完成 |
| 内存缓存 | 资源引用计数，一份只加载一次（同 Stride 的 `Content.Load` 和 `Unload`） | 可以用 `using` 在作用域结束时自动释放 |
| GPU 缓存 | 渲染管线和着色器模块缓存；加载资源组时用 `createRenderPipelineAsync` 提前预热，避免第一次用到时卡一帧 | 无，由引擎在加载时完成 |
| 对象池 | 子弹、特效这类频繁生成的实体复用，避免触发 GC | `pool.take()` 和 `pool.give()` 代替创建和删除 |
| 数据布局 | 引擎内部把变换、包围盒按结构数组存进 TypedArray，便于批量计算和上传；脚本看到的仍是对象视图 | 无 |

```ts
const grass = this.entity.get(InstancingComponent)!;
grass.count = 20000;
for (let i = 0; i < grass.count; i++) grass.setTransform(i, x[i], 0, z[i], yaw[i], scale[i]);

await this.content.loadGroup('levels/castle');
const boss = this.content.get(Prefab, 'levels/castle/Boss');

{
  using music = await this.content.load(Sound, 'audio/castle');  // released at the end of the block
  music.play();
  await this.trigger.left();
}

const bullet = this.bullets.take();
// ...
this.bullets.give(bullet);
```

## 需要用户决定的事

现在没有（见 [docs/roadmap.md](docs/roadmap.md) 末尾的"等用户定的"）。原来列在这里的都定了：

- 游戏脚本只用 TypeScript，C# 脚本由 agent 逐个翻译（路线图的 D5，2026-11-19）。
- C# 网页移植版停止，只当参考实现（D6，2026-11-19）。
- 预制体在场景文件里只存引用和差异（[docs/prefabs.md](docs/prefabs.md)）；SVG 编成彩色字形、材质用 MaterialX 的节点、几何按实验结论分（[docs/vector-assets.md](docs/vector-assets.md)），都是 2026-11-20 照推荐定的。
- GitHub 仓库：2026-11-18 建成公开仓库 [kenconnet666/stride-ts](https://github.com/kenconnet666/stride-ts)，MIT 许可证。

## 许可证

MIT，见 [LICENSE](LICENSE)。原生模块在 Jolt 的 fork [kenconnet666/JoltPhysics](https://github.com/kenconnet666/JoltPhysics) 的 `stride` 分支（Jolt 本身是 MIT）。

用到的第三方代码：矢量文字的覆盖率计算移植自 Eric Lengyel 的 Slug 参考着色器（Copyright 2017 Eric Lengyel，MIT 或 Apache-2.0，
[EricLengyel/Slug](https://github.com/EricLengyel/Slug)，`packages/engine/src/rendering/text/slug.ts`）。原生模块用到的库见 fork 的
`StrideNative/ThirdParty/README.md`。
