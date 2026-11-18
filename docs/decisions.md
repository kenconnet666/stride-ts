# 决定记录

无人值守执行路线图（docs/roadmap.md）时自己做的决定，按时间倒序。每条写：决定了什么、为什么、考虑过的别的做法、影响到哪里。路线图的范围和 D10 里"停下来问"的事不在这里定，要问用户。

## 2026-11-19 Platformer2D：精灵表不重新打包，角色用 body() 控制

- **精灵表不打包成图集**：Stride 编译精灵表时把所有精灵重新打包进图集（Packing，默认开），我们每张源图导出成一张贴图，精灵记下它在源图上的区域。画出来一样；省掉打包，源图原样可查。代价是一个精灵表有几张源图就绑几张贴图（Platformer2D 的每个精灵表只有一张）。九宫格的边框（Borders）等 UI 用到时再做，导入时警告。
- **帧号放在 Sprite 组件上**：Stride 的 CurrentFrame 在 SpriteFromSheet（精灵提供者）上，脚本写 `SpriteSheet.CurrentFrame`；我们的 Sprite 是数据组件，`sheet`、`frame` 是它的两列，脚本写 `entity.require(Sprite).frame`。
- **角色也能用 `simulation.body()`**：Stride 的 CharacterComponent 继承 BodyComponent，Platformer2D 用 Orientation（瞬移）转身。我们的 BodyControl 接受带 Character 的实体，gravity 写回 Character 的列，Character 没有的 kinematic、sleepThreshold 记在控制对象里；原生侧的瞬移和读速度也接受角色（0.18.1），设速度、冲量仍只对动态和运动学物体（角色的速度由移动目标每步设）。
- **音效先不放**：CollectCoin 的 SoundEffect 是 P2 的音频，导入时警告并写 null，脚本里不声明这个属性。

## 2026-11-19 BepuSample 的比对：后处理按效果开关，缺法线补平面法线，工具脚本不移植

- **后处理按效果开关**：以前合成器只导入"有没有后处理"，效果一律按 Stride 的默认全开。BepuSample 和 Platformer2D 的合成器关掉了色调映射（ColorTransforms 里的 ToneMap），我们照样做 Hejl2 映射，整个画面比桌面版暗约 40/255。现在导入每个效果的 Enabled（`ScenePostEffects`：亮部提取、泛光、光芒、镜头光晕、色调映射、FXAA），色调映射关掉时 HDR 画面加上叠加层直接输出（超过 1 的截断，同 Stride）。我们还没有的效果（环境光遮蔽、屏幕空间反射、景深、雾、描边、胶片颗粒、暗角）不导入；BepuSample 开着环境光遮蔽和屏幕空间反射，P4 做。
- **缺法线的网格补平面法线**：Stride 导入模型时用 Assimp 的 aiProcess_GenNormals（逐面法线，OBJ 的平滑组 `s 1` 不管），glTF 规范对缺法线的网格也要求平面着色。我们以前 FBX、OBJ 让 ufbx 按平滑组生成平滑法线，glTF 留空（法线是 0）。BepuSample 的 bridge.obj 没有法线，桌面版是一块块平面，我们是平滑过渡。现在原生导入统一补平面法线（stride-native 0.17.2），被法线不同的三角形共用的顶点拆开。
- **没有材质的网格用 DefaultMaterial 槽位**：OBJ 没写 `usemtl` 时，Assimp 给网格一个叫 DefaultMaterial 的材质，Stride 的模型资源里就是这个槽位；我们的导入器照这个名字找槽位，找不到时和别的不认识的材质名一样用槽位 0。
- **压缩的贴图宽高补到 4 的倍数**：照 Stride（TextureHelper.FindBestTextureSize，`IsCompressed` 默认开）用 Lanczos3 缩放到 4 的倍数再编 KTX2（原生 0.18.0 的 `st_image_resize`，用 basisu 自带的重采样器）。要缩放的源文件在 `source`、`smallest` 策略下也不原样复制，否则运行时的尺寸和 Stride 不同，按点采样的图案会错开。这样的贴图也就能用上压缩格式（以前运行时只能退回不压缩的 rgba8）。BepuSample 因此要加载贴图转码模块。
- **没用到的工具脚本不移植**：BepuSample 的 Utils 里 CollisionComponent、RayCastComponent、OverlapTesterComponent、TriggerUsageComponent、TestComponent、ConstraintEditorComponent、ConstraintToggleComponent 在七个场景里都没挂，只是给用户抄的示例代码；它们演示的接触事件、射线、触发器、约束开关我们都有并有单测；重叠测试（Stride 的 BepuSimulation.Overlap）还没有，等游戏用到时做。GameProfilerComponent 打开 Stride 的性能叠加层，我们用 `stride perf` 代替。

## 2026-11-19 BepuSample：接触的软度不映射，调试文字先不画

- **接触的软度**：Bepu 按物体设接触的弹簧（SpringFrequency、SpringDampingRatio）和最大恢复速度（MaximumRecoveryVelocity），Material Properties 场景靠它们演示"软"和"陷进去"。Jolt 的接触是刚性的，全局用 Baumgarte 恢复，没有按物体的接触软度；只映射摩擦。和 Stride 不同：这几项的效果看不到。别的做法：在接触回调里改 Jolt 的接触约束（ContactSettings 没有软度参数），或者自己写软接触——代价大、收益只在这一个演示上。
- **调试文字**：BepuSample 的脚本大量用 Stride 的 DebugText.Print 当界面。文字渲染（字体、矢量）是 P2 的大件，P1 先做 `game.debugText`（记下每帧打印的文字，`stride call debug-text` 读），P2 做文字渲染时画出来。
- **伺服和马达**：Bepu 的伺服有最大速度、基础速度，马达有阻尼（MotorSettings.Damping，速度误差到力的软度）；Jolt 的马达只有弹簧（位置马达）和力的上限，所以这几项不映射，速度马达是"在力的上限内尽快达到目标速度"。重力枪、搅拌机的效果一致，只是起步更硬。
- **约束组件**：每种约束一个脚本类（BallSocketConstraintComponent 等，名字同 Stride），启动时加约束、移除时去掉，场景卸载时跟着去掉；同一个实体上可以挂几种不同的约束，但同一种只能挂一个（我们的实体按类存脚本）。样例里同种约束挂在同一实体上的只有 RopeSpawner 的代码，它直接调 `simulation.addConstraint`。ConstraintToggleComponent、ConstraintEditorComponent 在样例的场景里没用到，没有移植。
- **同类脚本**：Stride 的实体上可以挂几个同类的组件（Ropes 场景的一个实体上有 5 个 RopeSpawnerComponent），我们的实体按类存脚本，每类一个。加载场景时第二个起挂到自动建的子实体上（单位变换），脚本里的 `this.entity` 是那个子实体。别的做法：让实体按列表存脚本——`entity.get`、热重载、调试命令都要跟着改，等真有脚本需要在同一实体上多实例时再做。
- **模型实例化**：Stride 的 InstancingComponent 把实例的变换收集起来一次实例化绘制；我们的渲染器本来就把同网格同材质的物体合批，所以 `Instance` 只是"借用主实体的模型"，主实体自己不画。多网格的模型（拆成子实体）只借用主实体那一个网格。

## 2026-11-19 PhysicsSample 的材质和验收

- **材质分两批**：PhysicsSample 的材质用到透明（混合）、遮蔽贴图、镜面工作流（镜面颜色乘强度）、贴图乘颜色的自发光（`ComputeBinaryColor`），都能化成固定着色器里"一张贴图乘一个常量"的形状，P1 做了（没有贴图的槽绑白图，不加变体）。`LogoD` 有材质层（`MaskC` 按贴图的 alpha 混进来），材质层要按层生成着色器，按 D3 由 P2 的着色器系统做；在那之前导入器警告并只用底层材质，Logo 方块缺贴花图案。别的做法：在固定管线里为两层的材质加特例——P2 还要整个换掉，不划算。
- **验收**：Stride 仓库里 4.4.2 标签的 PhysicsSample 还是 Bullet 版（`Stride.Physics`），我们移植的是 master 上的 Bepu 版，没有能直接比的桌面截图。做法：材质做完后用 master 的 PhysicsSample 加 4.4.2 的 nuget 包（`stride.bepuphysics` 4.4.2 在本机 nuget 缓存里）编桌面版截图比对；编不起来时以冒烟脚本（玩法）加目视为准，在进度里写明。

## 2026-11-19 AnimatedModel 分两次验收；多个方向光先只有一个投阴影

- **AnimatedModel 分两次验收**：这个样例除了动画，还用了 UI 页面（Idle、Run 两个按钮）和"第二个相机渲染到纹理、两个精灵显示这张纹理"。UI 系统是 P2 的大件（矢量渲染、.sduipage、字体），只为两个按钮提前做不划算。P1 先做动画、2D 背景、多个方向光、相机槽位、指针输入，按钮暂时用调试命令（`stride call idle`、`run`）代替；渲染到纹理和精灵属于 P1 的"合成器的最小数据化"和"精灵"，接着做；UI 按钮在 P2 做 UI 时补上并重新验收。别的做法：用 HTML 按钮临时顶替（D4 已定 UI 照 Stride 自己做，临时的 HTML 以后还要拆）。
- **多个方向光**：一个视图最多 4 个方向光（`MAX_DIRECTIONAL_LIGHTS`），只有第一个打开阴影的投阴影，其余不投。Stride 每个投阴影的方向光各有一组级联。AnimatedModel 只有一个方向光开了阴影，结果和 Stride 一样；多个投阴影的方向光等有场景用到时再做（阴影图集按光源分块）。

## 2026-11-19 路线图的取舍全部按推荐定（用户决定）

D2 到 D16 按 docs/roadmap.md 第四节的推荐执行。用户的原则：有意义的功能都尽量做，意义不大的可以不做；可以加 Stride 没有的功能；WebGPU 没有的用计算着色器模拟；矢量优先、清晰优先；canvas 里的文字要有选中、无障碍、输入法这些 Web 原生能力。
