# stride-ts：Stride 的 TypeScript 孪生版

目标：做一个"形状像 Stride"的浏览器游戏引擎。
- 引擎和游戏脚本用 TypeScript 写：改完几百毫秒生效，支持热重载。
- 计算量大的部分用别人维护、预先编好的 C/C++/Rust WebAssembly 库，很少重编，按内容哈希长期缓存。
- 能用浏览器 API 的地方直接用。
- 编辑器也是自己的：Node.js 后端加 Web 前端，视口用的就是游戏运行时的同一套渲染器（2026-11-17 用户决定，不依赖 Stride Game Studio）。Stride 的工程通过导入器迁移过来。

来由：Stride 的 C# 网页移植（`C:\Users\Administrator\IdeaProjects\stride`，fork `kenconnet666/stride` 的 `web-experiment-base` 分支）能跑，但浏览器里的 .NET 没有 JIT，每次改动都要 AOT 编译，迭代慢，而且引擎和游戏被链接进同一个 wasm，没法分开缓存。2026-11-16 决定暂停那条线，转做这个。调研全文见 [docs/research.md](docs/research.md)，历史经验见 [docs/lessons.md](docs/lessons.md)。

## 开发

需要 Node 22+ 和 pnpm 10；原生模块在 `jolt-native-fork` 里用 `StrideNative/Scripts/build-wasm.ps1` 编好（位置不同时设 `STRIDE_NATIVE_DIST`）。

```bash
pnpm install
pnpm dev          # sandbox on http://localhost:5180 (COOP/COEP headers set)
pnpm test         # Vitest in Node
pnpm typecheck
pnpm build        # sandbox production build; `pnpm --filter @stride-ts/sandbox preview` serves it on 5181
```

| 目录 | 内容 |
|---|---|
| `packages/native` | `@stride-ts/native`：`scripts/sync.mjs` 把 fork 编好的 `stride-native`/`stride-tools` 拷进 `src/`（不提交，`src/source.json` 记录来源提交；不用 `dist/` 是因为 WebStorm 会排除它，类型和自动导入就失效了） |
| `packages/engine` | `@stride-ts/engine`：引擎层，目录按 Stride 的命名空间分：`data/`（`prop` 和 schema）、`engine/`（实体、列存储、系统、脚本、登记）、`games/`、`graphics/`；源码直接以 TS 导出，不单独构建。`test/` 里有运行时测试、类型测试 `types.check.ts` 和类型压力测试 `stress.check.ts` |
| `apps/sandbox/src/game` | 沙盒的游戏代码，用 `import.meta.glob` 交给引擎登记：粒子组件和系统、生成粒子的 `Fountain` 脚本 |
| `apps/sandbox` | 冒烟测试页：跨源隔离、原生模块的工作线程、WebGPU、帧循环、Jolt 步进 |
| `apps/bench` | 数据布局和跨边界开销的基准（JS 对象、JS 堆的 TypedArray、wasm 共享内存、JS 到 wasm 的调用、上传 GPU、创建和每帧更新）。`pnpm --filter @stride-ts/bench dev` 在 5182 端口，`tools/bench.cjs` 在无头 Chrome 里跑并打印结果（`?only=render` 只跑渲染提交）；`gc.html` 是 GC 场景，用 `tools/gc-trace.cjs` 跑。结论见 [docs/architecture.md](docs/architecture.md) 的"实测"各节和"复杂场景的帧预算估算" |
| `tools/` | Playwright 脚本和原生构建脚本，见 [tools/README.md](tools/README.md) |

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

## 原型计划

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

- 游戏脚本是否只用 TypeScript。
- C# 移植版是否和这里并行推进。
- ~~这个目录对应的 GitHub 仓库~~：2026-11-18 已建成公开仓库 [kenconnet666/stride-ts](https://github.com/kenconnet666/stride-ts)，MIT 许可证。

## 许可证

MIT，见 [LICENSE](LICENSE)。原生模块在 Jolt 的 fork [kenconnet666/JoltPhysics](https://github.com/kenconnet666/JoltPhysics) 的 `stride` 分支（Jolt 本身是 MIT）。
