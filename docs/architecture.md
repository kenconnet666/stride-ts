# 架构：和 Stride 对齐的自有渲染器，数据导向，和 Jolt 共享内存

状态：设计，2026-11-17。用户的决定："我们就是要做长期工程，和 Stride 对齐的自己的渲染器，数据导向，和 Jolt 共享内存。"不使用 three.js，也不 fork PlayCanvas。

## 目标

1. **画面和桌面 Stride 一致**：同一个场景，截图逐项可比。
2. **数据导向**：每帧的热数据（变换、包围盒、实例数据）存成结构数组，批量处理，不按对象逐个调用。
3. **和 Jolt 共享内存**：物理结果直接写进渲染要用的数组，中间不经过 JS 拷贝。
4. **开发体验**：引擎逻辑和游戏脚本是 TypeScript，可以热重载；热循环放在 C++ 里，用 SIMD。

## 分层

```
游戏脚本（TS，Stride 风格的 API）
引擎层（TS）：实体、组件、脚本调度、场景加载、内容管理、输入、音频
渲染器（TS 负责组织，WGSL 来自 Stride 的效果）：RenderSystem、RenderFeature、RenderStage、Compositor
stride-native（C++，一个 wasm 模块）：变换数组、层级传播、剔除、动画求值、Jolt、Recast、解码
浏览器：WebGPU、Web Audio、Gamepad、Worker
```

分工原则：**TS 负责组织和决策**（哪些东西要画、按什么顺序、用什么效果），**C++ 负责每帧对每个对象都要做的循环**（层级传播、剔除、动画、物理）。

## 共享内存的数据模型

- **变换数组放在 stride-native 的线性内存里**，按结构数组布局：本地位置、旋转、缩放、父节点下标、世界矩阵。每个实体用一个稳定的下标（句柄）指向自己的那一格。
- **Jolt 直接写这些数组**：动态物体步进后，位姿写进对应实体的本地变换；运动学物体反过来从数组读。不再有"从 Jolt 读出来、再写进场景"的步骤。
- **TS 看到的是视图**：`transform.position` 是一个对象形式的访问器，背后读写的就是 wasm 内存里的那一格，不另存一份。
- **上传 GPU 不经过中间拷贝**：`queue.writeBuffer(instanceBuffer, 0, wasmMemory.buffer, worldMatrixPtr, byteLength)` 直接从 wasm 内存上传整段世界矩阵。
- **wasm 内存增长会让 TypedArray 视图失效**。两种做法：预先申请足够大的固定内存，关闭增长；或者每帧检查 `memory.buffer` 有没有换，换了就重建视图。原型先用固定内存，简单可靠。

## 渲染器：按 Stride 的结构

| Stride | 这里 |
|---|---|
| `RenderSystem`、`RenderView`、`RenderStage` | 同名，同样的分阶段流程：收集（Collect）、提取（Extract）、准备（Prepare）、绘制（Draw） |
| `RenderFeature`（MeshRenderFeature 及其子特性：变换、蒙皮、材质、前向光照、阴影） | 同样拆成子特性；每帧对象级的循环调用 stride-native |
| Effect 加排列组合（permutation） | 自己的 WGSL 着色器系统（见下文"编辑器和资源管线"）：着色器模块可以组合（类似 SDSL 的 mixin），排列组合由 Node 端的管线预编译并生成绑定的反射数据；运行时按效果名和排列组合键取用 |
| `ParameterCollection`、`ResourceGroup` | 按反射数据生成 bind group 布局；常量写进环形缓冲，用动态偏移，不必每个 draw 一个 bind group |
| Graphics Compositor（ForwardRenderer、后处理） | 移植它的结构，先做前向渲染器 |

GPU 驱动：
- 每帧把可见物体的世界矩阵整段上传成实例数据。
- 剔除先在 stride-native 里用 SIMD 做，以后可以移到计算着色器。
- 同网格加同材质的物体合成一次实例化绘制。

WebGPU 核心规范没有 multi-draw-indirect，所以合批以"网格加材质"为单位。

C# 移植版踩过的 WebGPU 坑，全部适用，见 [lessons.md](lessons.md)：`writeBuffer` 的生效时机、pass 内的状态去重、scissor 一直有效、调试组会切断 pass、没写的颜色目标要设 writeMask 0。

## TS 端的高性能写法和构建（2026-11-17；2026-11-18 改为不做编译期改写）

TS 加 C++ wasm 做高帧率可行。性能来自代码形态和数据流向，不来自转译工具：Babel 只是编译期改写源码，本身不让代码变快。

| 层面 | 做法 |
|---|---|
| JS 代码形态 | 对象结构固定，让 JIT 生成快速路径；热路径用 TypedArray；引擎路径每帧不分配内存；热循环里不用闭包和多态调用 |
| JS 和 wasm 的边界 | 粗粒度的批量调用；数据放在 wasm 内存里，JS 直接读视图，不拷贝 |
| 每个对象都要跑的循环 | 放进 C++：变换传播、剔除、动画求值、物理，用 SIMD |
| 渲染 | 实例化、整段上传；pass 内状态去重；管线在加载时预热 |
| 帧节奏 | `requestAnimationFrame` 跟随屏幕刷新率；165 Hz 每帧预算约 6 ms，CPU 端目标 2–4 ms |
| 主线程 | 只跑游戏循环；加载和解码放进 Worker；需要时整个引擎可以搬进 Worker（OffscreenCanvas） |

构建：**不做 SWC 插件，也不做任何编译期改写**（用户 2026-11-18 决定，取代 11-17 的 SWC 插件方案）。Vite 8 自带的 Oxc 只做 TS 类型擦除，开发版和正式版跑同一份代码。原先打算交给插件的事改成这样：

| 原计划由插件做 | 现在 |
|---|---|
| 数据组件生成结构数组存储和元数据 | `component()` 在运行时按属性 schema 建列（TypedArray），元数据就是 schema 对象本身 |
| 系统的查询循环改写成按下标遍历 TypedArray | 系统直接拿到按块切好的列，自己写 `for` 循环，列的类型由 schema 推导 |
| 向量运算内联 | 不做。脚本里的向量运算保持方法调用，临时向量预分配或从池里取（见下文）；大量实体的数学在系统里直接写标量 |
| 从 `@property` 生成序列化和编辑器面板的描述 | 属性用 `prop` builder 声明，序列化、校验、编辑器面板都读同一份 schema |
| 正式版删掉断言、日志、统计 | 写在 `if (import.meta.env.DEV)` 里，Vite 正式构建时替换成常量，死分支被删掉 |

不做的理由：
- 插件和 `swc_core` 的版本绑定，Rust 加 wasm 的维护成本高。
- "认不出来就退回运行时实现"意味着同一段代码有两种行为，要跑两套测试；source map 和断点也会变差。
- 类型推导已经够用：easy-query-ts（`C:\code\easy-query-ts`）的结果类型全靠 TS 推导，不做代码生成，运行时的 schema 对象是唯一的事实来源。这里照同样的路子做。

性能验证：同一个系统写成"每个实体一个对象"和"列加 `for` 循环"两种，在 1 千、1 万、10 万个实体下比较帧时间和 GC 次数。

## 组件 API：脚本、数据组件、系统（2026-11-18 设计草案，取代 11-17 的装饰器加插件方案）

原则（参考 easy-query-ts 的实体定义，见 `C:\code\easy-query-ts\packages\core\src\schema.ts`）：
- **一份声明，多处使用**：属性用 `prop` builder 声明，TS 类型、默认值、场景文件的编解码、加载时的校验、编辑器面板都从它来。类型靠推导，不靠代码生成、装饰器或反射。
- **引擎核心零依赖**：和校验库只通过 [Standard Schema](https://standardschema.dev)（`~standard.validate`）对接。zod、valibot 的 schema 能接进来，我们的 schema 也能导出给它们的生态用。
- **DSL 只在定义时跑**：builder、schema、查询只在模块加载和场景加载时求值；每帧的路径上没有代理、闭包和临时对象。
- **源码只用可擦除的语法**（`erasableSyntaxOnly`）：不用 enum、namespace、参数属性、装饰器；枚举一律写成字符串字面量联合。

| 写法 | 用途 | 数据存在哪里 |
|---|---|---|
| 脚本（`SyncScript`、`AsyncScript`、`StartupScript`） | 游戏玩法：角色控制、关卡流程、UI 逻辑，数量少，写起来要顺手 | 普通对象 |
| 数据组件（`component()`） | 大量实体共有的数据：血量、速度、AI 状态 | 按块存放的列：数值是 TypedArray，其余是普通数组 |
| 系统（`system()`） | 每帧对大量实体做的事：回血、移动、冷却计时 | 直接遍历块里的列 |

### 属性：`prop`

```ts
prop.number()  prop.f32()  prop.int()  prop.u8()  prop.bool()  prop.string()
prop.enum(['idle', 'run', 'jump'])     // 'idle' | 'run' | 'jump'
prop.vec3()  prop.quat()  prop.color()
prop.asset(Model)                      // AssetRef<Model>: the scene file stores the asset id
prop.entity()                          // EntityId
prop.component(() => CameraComponent)  // resolved after the scene is built; the thunk breaks import cycles
prop.list(prop.vec3())
prop.object({ min: prop.vec3(), max: prop.vec3() })
prop.union('kind', { box: { size: prop.vec3() }, sphere: { radius: prop.f32() } })  // discriminated union
prop.json(schema)                      // any Standard Schema (zod, valibot): checked on load and on edit
```

修饰方法都返回新对象，并把状态记在类型参数里（幻影类型参数，同 easy-query-ts 的 `Column<T, N, O, P>`）：

| 方法 | 作用 |
|---|---|
| `.default(v)` | 默认值；有默认值的属性在场景文件里可省 |
| `.optional()` | 值可以是 `undefined` |
| `.transient()` | 运行时状态：不存盘，不进编辑器面板 |
| `.min()`、`.max()`、`.step()`、`.unit()` | 只能用在数值属性上（用 `this` 参数限定），加载和编辑时校验，编辑器拿来做滑块 |
| `.label()`、`.group()`、`.description()`、`.hidden()` | 编辑器面板 |
| `.renamedFrom('oldName')` | 改名以后，旧的场景文件和热重载照样能读 |
| `.brand<'PlayerId'>()` | 只改类型，让不同用途的整数不能混用 |
| `.sealed()`、`.inherit()`、`.stat()`，`.default(fn)` | 和分层覆盖有关，见下文"属性的分层、合并和转发" |

**字面量简写**：属性直接写一个值，就是"这个类型加这个默认值"。`speed: 10` 等于 `prop.number().default(10)`，`name: 'hero'`、`visible: true` 同理；数据组件里的数字简写成 `f32`。

### 脚本

```ts
export class PlayerController extends SyncScript.props('Gameplay.PlayerController', {
  maxRunSpeed: prop.number().min(0).default(10).unit('m/s'),
  jumpHeight: 1.2,
  camera: prop.component(() => CameraComponent),
}) {
  private readonly move = new Vector3();
  private character!: CharacterComponent;

  override start(): void {
    this.character = this.entity.require(CharacterComponent);
  }

  override update(time: GameTime): void {
    this.move.set(0, 0, 0);
    if (this.input.isKeyDown('KeyW')) this.move.z -= 1;
    this.character.move(this.move.normalize().scale(this.maxRunSpeed));
    if (this.input.isKeyPressed('Space')) this.character.tryJump(this.jumpHeight);
  }
}

export class DoorOpener extends AsyncScript.props('Gameplay.DoorOpener', {
  trigger: prop.component(() => TriggerComponent),
}) {
  override async execute(): Promise<void> {
    for (;;) {
      await this.trigger.entered(this.signal);
      await this.delay(0.5);
    }
  }
}
```

- `SyncScript.props(name, shape)` 返回一个已经带好属性类型的基类，同时按名字登记。场景文件里的 `type` 和热重载都靠这个名字；类名在正式版会被压缩，不能当名字。名字的类型是 `` `${string}.${string}` ``。不需要属性的脚本直接 `extends SyncScript`。
- `entity.get(T)` 返回 `T | undefined`；`entity.require(T)` 拿不到就抛错，消息里带实体名和组件名。
- `AsyncScript` 有 `this.signal`（`AbortSignal`），脚本被移除或游戏退出时中止，对应 Stride 的取消。脚本自己的等待方法（`nextFrame()`、`delay()`）自动带上它；等别的东西时把它传进去。
- 按键用 `KeyboardEvent.code` 的字面量联合（`'KeyW'`、`'Space'`），不另造一套 `Keys`。

### 数据组件和系统

```ts
export const Health = component('Gameplay.Health', {
  max: prop.f32().min(0).default(100),
  current: 100,
});
export const Regen = component('Gameplay.Regen', { rate: 5 });   // per second
export const Dead = tag('Gameplay.Dead');

export const regen = system('Gameplay.Regen', {
  with: { health: Health, regen: Regen },
  without: [Dead],
  writes: [Health],
  update({ health, regen, count }, time) {
    for (let i = 0; i < count; i++)
      health.current[i] = Math.min(health.max[i], health.current[i] + regen.rate[i] * time.elapsed);
  },
});
```

- **存储按 archetype 分块**：组件组合相同的实体放在同一块里，块内每个字段一列、连续存放。`update` 每块调用一次，`count` 是这一块的实体数；列是预先建好的视图，每帧不分配。
- **`with` 写成对象**：键名就是 `update` 里解构出来的名字，列的类型从 schema 推出：`f32` 是 `Float32Array`，`int` 是 `Int32Array`，`bool` 是 `Uint8Array`，`entity` 是 `Uint32Array`，其余是普通数组。
- **`writes`** 声明会改哪些组件，用于变更检测（按块记版本）和以后的调度检查；`changed: [Health]` 只处理上次运行之后被写过的块。
- **结构性改动**（加删组件、创建销毁实体）在遍历时只能记进命令缓冲：`update(chunk, time, commands)`，系统跑完后统一执行。
- **顺序**：`phase`（物理之前、之后等）加 `after: [movement]`。
- **引擎自己的组件**（变换、刚体）在 wasm 内存里，按实体槽位存放，不按块：块里带一列 `slot`，写成 `transform.x[slot[i]]`。
- **脚本里访问单个实体**：`entity.get(Health)` 返回一个视图对象，`health.current -= 10` 直接读写那一格；每个实体缓存一个视图。
- 数据组件之间用实体句柄（`EntityId`，带品牌的整数）互相引用。

### 事件和服务

```ts
export const damaged = new EventKey<{ target: EntityId; amount: number }>('Gameplay.Damaged');

damaged.broadcast({ target, amount: 10 });
const rx = damaged.receiver();          // once, in start()
for (const hit of rx.drain()) { /* sync scripts, once per frame */ }
const hit = await rx.receive(this.signal);   // async scripts
```

扩展包用声明合并登记自己的服务，核心不依赖它们（同 easy-query-ts 的 `NumericExtensions`）：

```ts
declare module '@stride-ts/engine' {
  interface Services { navigation: NavigationSystem }
}
this.services.navigation;               // typed
```

### 属性的分层、合并和转发

参考两处：
- **vue-tsx-pro**（`C:\Users\Administrator\IdeaProjects\vue-tsx-pro`，`packages/ui/src/utils/props.ts`、`config/defaults.ts`，规范见 `packages/ui/COMPONENTS.md` §2）：UI 组件的值来自好几层（组件默认、`createUi`、`Provider`、使用方、组件受管），逐层合并后再转发给内部部件（`propsXxx`）。它的体系是 Vue 和 DOM，和我们不同；借鉴的是合并规则和类型做法。
- **Stride 自己的资源继承**：`OverrideType` 有 Base、New、Sealed 三种，集合的每一项带稳定的 `ItemId`（`Stride.Core.Assets/Reflection`）。

**一个属性的值从哪里来**（上面的层覆盖下面的层）：

| 层 | 例 | 存在哪里 |
|---|---|---|
| 运行时修饰（只对 `.stat()` 属性） | 减速 ×0.5，装备 +2 | 运行时，不存盘 |
| 实例覆盖 | 场景里这个敌人的 `maxHealth: 120` | 场景文件，只存差异 |
| 预制体链 | 精英兵预制体 → 士兵预制体，可以嵌套多层 | 预制体文件，只存差异 |
| 变体 | 组件定义里的 `variants: { elite: { maxHealth: 300 } }`，实例选 `variant: 'elite'` | 组件定义 |
| 作用域默认值（只对 `.inherit()` 属性） | 工程配置、关卡或某棵子树统一给的默认值，近的优先 | 工程配置、场景 |
| schema 默认值 | `prop.f32().default(100)`，或由别的属性算出 | 组件定义 |

合并规则：
- **`undefined` 不表态**：覆盖层里没写的键沿用下面的层。`null` 只对 `.optional()` 属性有意义，表示明确地"没有值"，盖掉下面的层（同 vue-tsx-pro 的 `mergeProps`）。
- **按路径合并，不整个替换**：嵌套对象和部件（见下）逐层合并，只覆盖其中一项不会丢掉其他项。
- **集合项按 id 覆盖，不按下标**：基础预制体里插入或重排列表项，实例的覆盖不会错位（同 Stride 的 `ItemId`）。
- **只在加载、生成、编辑时合并**：合并结果写进组件的普通字段或列，运行时读值就是普通读取，不逐层查找。基础预制体改了（编辑器里或热重载），没覆盖这一项的实例跟着变。
- **编辑器显示每个值的来源**（实例、哪个预制体、变体、作用域、默认值），可以一键"重置到下一层"，对应 Stride Game Studio 里加粗显示的覆盖值。

和分层有关的属性修饰：

| 修饰 | 作用 |
|---|---|
| `.default((p) => p.radius * 2)` | 默认值由别的属性算出；那个属性变了，没覆盖的值跟着变（vue-tsx-pro 的默认值也可以引用别的 prop） |
| `.sealed()` | 由组件自己或系统驱动（受管），预制体和实例都不能覆盖：类型上从覆盖对象里去掉，编辑器里只读。对应 Stride 的 `Sealed` 和 vue-tsx-pro 的受管层 |
| `.inherit()` | 允许作用域默认值统一设置。只给调参和外观类的属性用（摩擦、音量、颜色），状态类的不行；vue-tsx-pro 也只让外观类的选项进 `defaults` |
| `.stat()` | 允许运行时修饰 |

**作用域默认值**：

```ts
game.defaults.set(RigidBody, { friction: 0.6 });   // only .inherit() props are accepted by the type
```

关卡或子树的根实体上挂一个 `Defaults` 组件，作用于它下面的实体，近的优先（同 vue-tsx-pro 的 `Provider`）。

**部件：组合组件把覆盖转发给内部的部件**（对应 vue-tsx-pro 的 `propsXxx`）：

```ts
export const Wheel = component('Vehicles.Wheel', {
  radius: prop.f32().min(0).default(0.4),
  friction: prop.f32().default(1).inherit(),
  steerAngle: prop.f32().sealed(),          // driven by the vehicle
});

export class Vehicle extends SyncScript.props('Vehicles.Vehicle', {
  maxSteer: 35,
  wheels: prop.parts(Wheel, ['frontLeft', 'frontRight', 'rearLeft', 'rearRight']),
}) {
  steering = 0;   // -1..1, set by the driver script

  override update(): void {
    this.wheels.frontLeft.steerAngle = this.steering * this.maxSteer;   // the owner may write sealed props
  }
}

await scene.spawn(CarPrefab, {
  position: [0, 0, 5],
  props: {
    maxSteer: 30,
    wheels: { all: { radius: 0.45 }, rearLeft: { friction: 0.8 } },   // `all` first, then each part
    // or per part: wheels: (name) => ({ radius: name.startsWith('rear') ? 0.45 : 0.42 })
  },
});
```

- 部件是预制体里按名字找到的子实体；`prop.parts` 给出带类型的访问，并负责转发覆盖。
- 覆盖对象的类型是 `Overrides<typeof CarPrefab>`：深层可选，去掉 `.sealed()` 属性，部件名写错就是类型错误。
- 部件的覆盖按同样的规则再合并一次（vue-tsx-pro 的嵌套 `propsXxx`）：组件给部件的默认值不会因为使用方也写了这个部件就整个丢掉。

**可拦截的钩子：使用方先处理，可以接管内置行为**（同 vue-tsx-pro 的事件合并）：

```ts
door.opening.on((e) => {
  if (!player.hasKey) e.preventDefault();   // the door's own opening logic is skipped
});
```

钩子是同步的，按登记顺序先调使用方的处理函数，调用了 `preventDefault()` 就跳过组件自己的行为。广播给很多接收者、可以异步等待的消息仍用 `EventKey`。

**运行时修饰：`.stat()`**（游戏里最常见的"层层合并"：加成和减益）：

```ts
maxRunSpeed: prop.number().min(0).default(10).stat(),

using slow = this.stats.maxRunSpeed.multiply(0.5);     // removed at the end of the block
this.stats.maxRunSpeed.add(2, { duration: 5 });          // removed after 5 seconds
```

- 计算顺序固定：(合并后的基础值 + 所有加值) × 所有乘数，最后按 `min`、`max` 截断；需要时再加带优先级的"直接改成某值"。
- 只在修饰增减或到期时重算，结果写回字段，读取不花额外时间。

**状态用标签表达**（vue-tsx-pro 用 `data-state` 属性表达组件状态，样式直接按状态选择）：`Stunned`、`Dead` 这类状态写成标签组件，系统用 `with`、`without` 直接选；编辑器和调试工具也能看到。加删标签会让实体换块，所以每帧都在切换的开关仍用 `bool` 列。

**类型测试补充**：覆盖 `.sealed()` 属性、部件名写错、覆盖值类型不对，都要有 `@ts-expect-error` 的负例；vue-tsx-pro 还用一个静态检查脚本核对受管属性都从使用方的类型里去掉了，我们的 `Overrides` 由类型推出，不需要这一步。

### 向量和临时对象

- `Vector3` 等是可变的类：实例方法原地修改并返回 `this`，可以链式调用；要新对象就显式 `clone()`。参数接受 `Readonly<Vec3Like>`（`{ x, y, z }`），wasm 内存里的变换视图也能直接传。
- 临时向量从池里取，配合 `using`：`using v = temp.vec3();`，作用域结束自动还回池，没有分配。

### 校验放在哪里

- **定义时**：`component()` 和 `props()` 检查重名、默认值是否满足 `min`/`max`、`renamedFrom` 是否冲突，报错带组件名和字段名。
- **加载和编辑时**：场景文件按 schema 解码，问题带路径（`entities[3].Gameplay.Health.max`）。`validators(Health)` 产出符合 Standard Schema 的校验器，给编辑器和 Node 后端用。
- **公共 API 的选项**：在边界上检查一次（`createStrideNative`、`NavConfig`），内部不重复。
- **每帧路径不校验**；开发期的断言写在 `import.meta.env.DEV` 里。

### 热重载（Vite HMR，不重启）

- **脚本**：按名字找到新类，把已有实例的原型换成新类的原型（`Object.setPrototypeOf`），属性按新 schema 重新解码（`renamedFrom` 生效），运行时状态的字段保留。
- **数据组件**：schema 变了，就按字段名把旧列拷进新布局，新字段取默认值。
- **系统**：按名字替换。

### 类型测试

做法同 easy-query-ts：
- `*.check.ts` 只给 tsc 检查：正例用 `Equal` 断言推导出的类型，负例用 `@ts-expect-error` 固定"必须报错"。
- 用脚本生成上百个组件和系统的压力样例，记录 tsc 的检查时间和实例化次数，防止类型推导拖慢编辑器。

## 原生模块的 TS 接口（2026-11-18 设计草案）

现在的绑定层（`native-module.mjs`、`stride-native.mjs`、`stride-tools.mjs`）和手写的 `.d.ts` 放在 fork 里，类型和实现迟早对不上。计划把绑定层搬进本仓库的 `packages/native/src/`，用 TS 重写；fork 只产出 Emscripten 的核心模块和 wasm。fork 里的 Node 测试和浏览器测试页改成引用本仓库的绑定层，或者只留一层很薄的测试外壳。

接口按下表调整：

| 现在 | 改成 |
|---|---|
| `addBox(position, halfExtent, dynamic: boolean)` | `addBox({ position, halfExtent, motion: 'dynamic' })`：位置参数里夹布尔值，调用处看不出含义 |
| `TextureTarget.bc7 = 1`、`mode?: number` | 字符串字面量联合，如 `'bc7'`；数字只在绑定层内部用 |
| 返回裸 `number` 的物体编号、代理编号 | 品牌类型 `BodyId`、`AgentId`，不同编号不能混用，运行时零开销 |
| `destroy()` | 同时实现 `[Symbol.dispose]`，可以写 `using world = native.createPhysicsWorld(...)` |
| 公开的 `handle: number` | 改为内部字段 |
| `NativeError.code` 是负整数 | 字符串联合：`'out-of-memory'`、`'invalid-argument'`、`'capacity'` 等 |
| `decodeMeshopt` 有 5 个位置参数，和 `MeshoptRequest` 重复 | 单个调用和批量调用用同一个请求对象 |
| `globalThis.strideGame` 没有类型 | 用 `declare global` 声明 |

## 物理：Jolt 作为内核，Stride 风格的那一层自己用 C++ 写

不从零写物理引擎，也不把 Bepu 移植成 C++（2026-11-17 讨论后的建议）：
- **从零写**：稳定堆叠、连续碰撞检测、约束求解、鲁棒的碰撞几何，每一项都是专门的难题，以年计，而且很难做到 Jolt 的水平。
- **移植 Bepu**：代码量大，SIMD 宽向量布局要重新实现，上游继续用 C# 演进。即使求解器同源，不同编译器的浮点结果也不会逐位相同，"和桌面完全一致"依然做不到。

"像 Stride"落在游戏代码看得到的那一层，这一层在 `stride-native` 里用 C++ 写，内核是 fork 进来的 Jolt：

| Stride 的物理 | 我们的实现 |
|---|---|
| `BodyComponent`、`StaticComponent` | 场景加载时一次建好 Jolt 物体，位姿直接写进共享的变换数组 |
| 32 个碰撞层的矩阵 | Jolt 的对象层加层对过滤表 |
| 触发器 | Jolt 的传感器（sensor） |
| 接触事件处理器 | 步进中缓存，结束后批量交给 TS，语义和 Stride 一致 |
| `CharacterComponent`（Bepu：动态刚体加支撑约束） | 在 Jolt 的刚体角色 `JPH::Character` 之上，照 Stride 的行为用 C++ 实现，参数名一致；手感最容易不同，值得自己做 |
| 材质参数：摩擦、弹性、弹簧（频率、阻尼比） | 摩擦和弹性直接对应；弹簧参数换算到 Jolt 的对应概念，再逐个游戏调参 |
| 射线、扫掠、范围查询 | 同名接口，支持批量 |
| 仿真设置：固定步长、子步数、插值 | 和 Stride 一致 |

只有当 Stride 依赖的某个特性 Jolt 的模型做不到、而且这个需求很重要时，才评估局部替换或扩展。

### 怎么 fork 和维护 Jolt（2026-11-17 定）

- **引入**（2026-11-17 用户改为独立 fork 仓库，取代原先的 git subtree 方案）：Jolt 的 fork 是单独的 git 仓库，本地在 `C:\Users\Administrator\CLionProjects\jolt-native-fork`。远程 `upstream` 指向 `jrouwe/JoltPhysics`（禁止推送）；`master` 只跟踪上游；我们的工作分支 `stride` 固定在上游发布标签上（当前 `v5.7.0`），补丁提交在它上面。远程 `origin` 是 GitHub 上的 fork `kenconnet666/JoltPhysics`，`stride` 分支推送到这里。`stride-native` 的源码就放在这个仓库的 `StrideNative/` 目录（2026-11-17 用户决定），见 [own-stack.md](own-stack.md) 的"结构"。
- **Jolt 本体尽量不改**：我们的代码放在 `StrideNative/Source/`，通过 Jolt 的公开 API 和扩展点接入（对象层过滤、接触监听器、自定义形状）。非改不可的，作为少量独立提交留在 Jolt 代码之上，每个提交写明原因，升级时重新应用。
- **构建选项**：
  - 按需关掉用不到的功能，调试渲染器只在调试版开启。
  - 只出多线程版（`-pthread`，Jolt 自带任务系统），开 SIMD（`-msimd128`）。单线程路线已放弃（用户 2026-11-17 决定）：部署必须带 COOP/COEP 响应头。
  - 单精度。跨平台确定性（`JPH_CROSS_PLATFORM_DETERMINISTIC`）有性能代价，等需要联网同步或回放时再开。
  - Emscripten 参数、内存和多线程配置参考 JoltPhysics.js 的构建脚本。
- **测试**：物理层是纯 C++，先原生编译，在桌面上跑单元测试（编译快，能用 IDE 断点）；同一套测试编成 wasm 用 Node 再跑一遍，确认两边一致。大部分调试不用进浏览器。
- **wasm 构建（2026-11-17 在本机跑通）**：
  - Jolt 自带 Emscripten 支持：`Build/CMakeLists.txt` 加 Emscripten 的 CMake 工具链文件即可，上游 CI 用 emsdk 6.0.8 编 `UnitTests`，再用 `node UnitTests.js` 跑。SIMD 由 `USE_WASM_SIMD` 控制（`-msimd128 -msse4.2`：Jolt 写的是 SSE 指令，由 Emscripten 翻译成 wasm SIMD）；Jolt 的构建不带 `-pthread`，多线程要我们自己加。
  - JoltPhysics.js 在 Jolt 之上用 WebIDL 生成绑定（`webidl_binder.py`），关掉 RTTI、异常、自定义分配器和 ObjectStream，链接参数有 `MODULARIZE`、`EXPORT_ES6`、`INITIAL_MEMORY=128MB`、`STACK_SIZE=1MB`，多线程版加 `-pthread`、`SHARED_MEMORY`、`PTHREAD_POOL_SIZE`。`stride-native` 不用 WebIDL，其余参数可以照搬。
  - 我们的构建（只出多线程版）：在 Jolt 的 CMake 之外加 `-DCMAKE_CXX_FLAGS=-pthread`，链接加 `-pthread -sPTHREAD_POOL_SIZE=navigator.hardwareConcurrency`，并开 `USE_WASM_SIMD`。Worker 池必须预先开好：Jolt 默认开"核数 − 1"个工作线程，而且是同步创建的，池不够大时主线程会死锁。共享内存要求最大内存固定，UnitTests 用的是 128 MB 初始内存、不扩容。
  - 本机工具链：emsdk 在 `C:\Users\Administrator\emsdk`（6.0.8，和上游 CI 一致）；CMake 和 Ninja 用 CLion 自带的。一条命令编译并测试：`tools/build-jolt-wasm.ps1 [-Config Debug|Release|Distribution]`。
  - 结果：多线程加 SIMD 的 Distribution 版，644 个用例在 Node 里全部通过（比当初的单线程版多出的 1 个是多线程测试 `TestMultithreadedAddRemoveAndQuery`）；12 核首次全量编译约 2 分钟。原生 MinGW Debug 版 648 个用例全部通过，多出的是 GPU 计算（DX12）相关的测试。
  - Jolt 自己的单元测试仍然从 `Build/` 编（上面的脚本）。
- **StrideNative 两个模块（2026-11-17 跑通）**：`StrideNative/Scripts/build-wasm.ps1` 编出 `stride-native` 和 `stride-tools` 两个多线程加 SIMD 的模块，再在 Node 里跑 8 个端到端测试（管线产出资源、运行时消费）；原生 MinGW 下两个 doctest 可执行文件（运行时 4 个、管线 6 个用例）全部通过。浏览器测试页（`Tests/Browser/serve.mjs`，带 COOP/COEP）在 Chromium 里 6 项全部通过：11 个工作线程，100 个箱子每步 0.17 ms，8 份 2 万顶点的 meshopt 并行解码，256×256 KTX2 的 9 级 mip 并行转码，分块并行建导航网格加 16 个代理的群体移动，256 个角色并行采样动画。
  - CLion 里打开 `jolt-native-fork`，CMake 根目录现在是 `StrideNative/`，两个配置：`Debug`（MinGW，跑 `StrideNativeRuntimeTests`/`StrideNativeToolsTests`，可下断点）和 `WASM-Release`（emsdk 工具链），构建目录都在被忽略的 `StrideNative/Build/` 下。
- **升级**：跟随 Jolt 的发布按计划进行：`git fetch upstream --tags`，把 `stride` 分支 rebase 到新标签上（补丁自然重新应用）、跑原生和 wasm 两套测试，再跑游戏的回归截图。

只有 Jolt 这样持续同步上游。Recast、Basis、meshopt 等是复制一次后由我们维护，或者自己写（2026-11-17 用户决定），见 [own-stack.md](own-stack.md) 的"依赖策略"。它们和 Jolt 一样编进同一个模块、走同一套 C API；2026-11-17 已全部导入 `StrideNative/ThirdParty/`。

## 编辑器和资源管线：自己做，Node.js 加 Web（2026-11-17 用户决定）

不依赖 Stride Game Studio。编辑器和资源管线都是我们自己的：
- **编辑器前端在浏览器里**，视口用的就是游戏运行时的同一套引擎和渲染器，所见即所得，编辑器里看到的就是游戏里的画面。场景树、属性面板、资源浏览器都是 Web UI。以后可以用 Electron 或 Tauri 打包成桌面应用。
- **Node.js 后端**：
  - 管理工程文件。工程用文本格式（JSON 或 YAML），方便 diff 和合并。
  - 运行资源管线。
  - 提供开发服务器：Vite，负责脚本热重载。
  - 编辑器里点"播放"，就在同一个页面里运行游戏。
- **资源管线在 Node 端**，输入是通用格式，输出是运行时的二进制：
  - 模型：glTF（cgltf）和 FBX（ufbx）直接导入，不经过 Assimp 或 FBX2glTF。
  - 纹理：编码成 KTX2 加 Basis（Basis 的编码器）。
  - 网格：meshoptimizer 做优化和简化，碰撞用的凸包分解用 VHACD。
  - 字体：msdfgen 生成 MSDF 图集。
  - 导航网格：离线可以预烘焙。
  - 音频：用 ffmpeg 转成 Opus。
- **工具用的原生库进同一个 C++ 工程**：Basis 编码器、meshoptimizer 的简化和编码、VHACD、msdfgen 这些只在编辑和构建时用。它们编成第二个 wasm 模块 `stride-tools`，给 Node 用，和运行时模块 `stride-native` 在同一个 CMake 工程里，共享核心代码和导航网格构建。
- **着色器系统**：用 WGSL 写，自己做模块组合、条件编译和排列组合，思路参考 Stride 的 SDSL（mixin 加组合）。排列组合在 Node 端预编译，并做绑定的反射。起点是把 C# 移植版编出来的 Stride 效果（WGSL）作为参考移植进来，所以画面能和 Stride 对齐；之后就在我们自己的系统里维护。
- **Stride 工程导入器**（迁移工具，不是主要的创作路径）：读取 Stride 工程的 YAML 资源（场景、预制体、材质、组件参数），源素材（FBX、PNG、WAV）交给我们的管线重新导入。用于把 Stride 的样例和游戏的内容搬过来。

## 内容：为这个运行时量身定制的格式

渲染器是我们自己的，内容就不必绕道 glTF 运行。资源管线直接写运行时要的二进制：
- **网格**：顶点和索引按 GPU 布局排好，加载后直接上传；碰撞形状的数据放在同一个文件里，进 wasm 一次，Jolt 和 Recast 共用。
- **材质**：效果名、排列组合键、按 WGSL 反射布局排好的参数块和纹理引用。
- **纹理**：KTX2 加 Basis。
- **场景**：实体、组件和参数；物理部分直接是 `world_create` 能读的布局。
- **动画**：压缩曲线格式（参考 Stride 的），在 stride-native 里求值。

这正是"一个东西不处理多次"：导入时一次转换到位，运行时只做上传和拷贝。

## 对齐的验证方法

- **截图比对**：同一场景、同一相机位置，用桌面 Stride、C# 移植版和这里各截一张，算差异图。
- **复用 Stride 的图形测试**：`Stride.Graphics.Tests` 的场景和 gold 图可以作为渲染器的回归测试，从最基本的开始（几何体、精灵、字体）。
- **样例清单**：沿用 C# 移植版验证过的那批（SpriteFonts、AnimatedModel、GameMenu、MaterialShader、Third Person Platformer……），C# 版可以当参考实现。

## 里程碑

1. **静态场景**：用 Stride 工程导入器和资源管线，把 Third Person Platformer 的场景搬过来并渲染出来。包括前向渲染器、PBR 材质（复用 Stride 的 WGSL）、方向光和阴影、天空盒、相机，以及共享内存的变换数组。截图和桌面 Stride 比对。
2. **可以玩**：Jolt 世界从场景建立，角色控制器，输入，脚本系统和热重载，角色控制脚本从 C# 翻译过来。
3. **动起来**：骨骼动画（stride-native 求值，GPU 蒙皮）、动画混合。
4. **编辑器的最小可用版本**：工程浏览、场景树、属性面板、视口（同一个渲染器）、资源导入、播放和热重载。
5. **界面和声音**：字体（MSDF）、UI 系统、音频。
6. **效果**：粒子、后处理。
7. **铺开**：按样例清单逐个对齐，每个都有截图比对。

## 风险

- **工作量**：这是长期工程，要守住范围，按里程碑推进，每个里程碑都要有可量化的验证。
- **编辑器是另一个大工程**：场景编辑、属性面板、资源浏览、撤销重做、预制体，这些要和引擎并行建设；按里程碑先做最小可用的版本。
- **着色器系统要自己做**：从移植 Stride 的 WGSL 起步，组合和排列组合系统要自己设计。
- **只支持 WebGPU**：不做 WebGL 兜底。
- **TS 和 C++ 之间的边界**：每加一个热循环都要判断该放哪边；原则是只把"每帧对每个对象都做"的循环放进 C++。
