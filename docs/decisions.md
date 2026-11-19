# 决定记录

无人值守执行路线图（docs/roadmap.md）时自己做的决定，按时间倒序。每条写：决定了什么、为什么、考虑过的别的做法、影响到哪里。路线图的范围和 D10 里"停下来问"的事不在这里定，要问用户。

## 2026-11-19 SpriteFonts：文字按轮廓画（Slug），运行时字体导入全部字形、按码位分块下载

- **算法用 Slug**（Eric Lengyel，JCGT 2017）：每个像素对字形轮廓（二次贝塞尔）做横竖两条射线，按交点算覆盖率，带分块限制每个像素要看的曲线数。选它是因为数值上最稳（根的取舍按控制点的符号查表，没有浮点误差导致的漏点），2026-03-17 专利已捐给公有领域，参考着色器 MIT/Apache（`C:\codeefs\Slug`，要署名）。考虑过 Dobbie 的网格法（精度问题多）、Loop-Blinn（要三角化轮廓）、MSDF（缩放到很大时角会圆，D16 定它只给世界空间的字）。
- **运行时字体导入全部字形**：Stride 的运行时字体（RuntimeRasterized）带着整个字体文件，用到哪个字栅格化哪个；我们导入时把所有字形转成轮廓，按码位块（码位 >> 8，256 个一块）分文件，运行时用到哪块下载哪块。日文字体总共 118 MB，但一屏文字只用到几块。以后可以把点存成 f16 再减半。
- **系统字体**：照 Stride 在系统字体目录里按家族名（名字表的 1 号或 16 号）和粗斜体找，找不到依次试度量兼容的替代并警告。字形轮廓会进游戏的内容（同 Stride 把栅格化的字形放进内容），字体的授权由用游戏的人负责。

## 2026-11-19 P1 收尾：没有游戏用到的几项挪到后面，帧时间按游戏照常跑来比

- **挪到后面的**：P1 的阶段表列了点光和聚光的阴影与分簇、SVG 精灵按矢量画、调试渲染、2D 物理，动画剪辑的非骨骼曲线（Updater）在第一节也标了 P1。P1 的七个游戏都没用到它们（点光、聚光本身做了，样例里不投阴影、灯也不多）。按"下一个游戏缺什么就做什么"：阴影和分簇、非骨骼曲线放到 P2（教程场景、粒子样例用到时做）；SVG 精灵按矢量画是 P2 矢量渲染底座的一部分，和字体一起做，免得先做一个只给精灵用的版本；调试渲染（线框、物理形状）放到 P3，和编辑器的解析线 Gizmo、网格用同一套画线；Bepu 的 2D 模式不做（Platformer2D 用 3D 物理，平台和角色都在 Z=0 上），有样例用到时用 Jolt 锁定轴；预先烘焙的导航网格（.sdnavmesh）等有样例用它再做（TopDownRPG 运行时建）。
- **帧时间怎么比**：路线图要求"同一台机器、同一时段，帧时间不比桌面 Stride 慢"。两边都让游戏照常跑（脚本、物理、动画都在，没有输入），关垂直同步、不限帧率，窗口和截图工程一样大，先跑 600 帧再测；桌面 Stride 用截图工程共用的 `Benchmark.cs`，我们用 `tools/measure.ps1`（preview 构建、无头 Chrome、`stride perf` 5 秒）。TPP 的桌面基准沿用以前的静态模式（去掉脚本和动画，工作量比我们少，比值偏保守）。BepuSample 的桌面版多画 UI 和调试文字（我们 P2 才有）。比值都小于 1。
- **合成器没有阴影渲染器时不画阴影**：不是偏差，是以前漏读了合成器的设置（AnimatedModel 的 ForwardLightingRenderFeature.ShadowMapRenderer 是 null）。

## 2026-11-19 FirstPersonShooter：特效预制体照常生成，冒烟测试用真实点击拿指针锁定，穿透容差降到 1 mm

- **特效预制体照常生成**：枪口火焰、弹孔、受击拖尾都是 VFXPackage 的粒子预制体（P2），导入时粒子组件跳过，预制体只剩变换。EffectController 照 Stride 生成、定时移除，P2 有了粒子就直接能看，不用回头改脚本。
- **TriggerGroup 是脚本属性的嵌套对象**：Stride 里 TriggerGroup、TriggerEvent 是带 DataContract 的数据类；我们用 `prop.object` 和 `prop.list` 声明，场景导入的值照常对上，不为它们加新的资源或组件种类。
- **冒烟测试用真实点击**：浏览器只在用户操作里允许指针锁定，调试 CLI 的合成事件拿不到。`stride mouse left --trusted` 走 DevTools 协议的 Input.dispatchMouseEvent（stride open 启动的 Chrome），算用户操作；锁定后合成的 `mouse move` 照常进 mouseDelta。考虑过给 InputManager 加调试用的"假装锁定"，那样测不到真实的锁定路径，不选。
- **穿透容差降到 1 mm**：Jolt 默认允许物体陷进去 2 cm 才往外推（`mPenetrationSlop`），Bepu 的接触是软弹簧（样例里 30 Hz），静止时只压下去零点几毫米。结果是我们的角色和放在地上的物体都比 Stride 低 2 cm，FirstPersonShooter 的相机矮 2 cm，地面的网格线错开 4 像素。原生 0.21.1 对所有世界设成 1 mm（留一点免得堆叠的物体来回抖），所有样例的冒烟脚本回归通过。没有做成可配置：Stride 没有对应的设置。
- **共用的数学和输入**：Stride 模板各自带一份的 InputManagerExtensions（摇杆、扳机超过死区取平均）进了 `InputManager.thumbAny`、`triggerAny`；`Quaternion.betweenDirections`、`setYawPitchRoll` 同 Stride。TPP、TopDownRPG 改用它们。

## 2026-11-19 TopDownRPG：导航网格的输入取物理形状的三角化，路径给拐点

- **导航网格的输入**：Stride 的 RecastMeshSystem 把静态碰撞体按它自己的形状缓存（ShapeCacheSystem，球和胶囊有固定的细分）转成三角形。我们直接让 Jolt 把物理世界里的静态体三角化（`Shape::GetTriangles`，复合形状先收集叶子），各种形状都覆盖，和碰撞用的是同一份几何；球、胶囊的细分和 Stride 不完全一样，导航网格的边缘可能差一两个格子。
- **路径给拐点**：Stride 的 FindFollowPath 沿拐点按固定步长采样出一串平滑的点，我们给 Detour 的直线路径（拐点，含起点和终点）。TopDownRPG 的 PlayerController 自己按路径点走，拐点照样能用；点更少，转角处的减速逻辑按拐点算。
- **RecastNavigationComponent 只做了寻路**：Stride 里它还能排队寻路（SetTarget，由 RecastNavigationProcessor 处理）、按 Speed 直接移动实体，样例里没用到，等场景用到时再做。BepuNavigationBoundingBoxComponent 在 Stride 里本身没实现（源码里是 #warning），导入时忽略。
- **挂到骨骼节点用变换存储的链接**：ModelNodeLink 的实体世界矩阵 = 目标的世界 × 节点矩阵 × 本地，不看父节点（Stride 的 TransformLink）。做在原生的变换存储里（`setLink`），计算顺序按链接排，帧末一次算完；别的做法是在 TS 里每帧算好世界矩阵写回本地变换，但子实体和物理都要跟着处理，容易出错。
- **跟着实体走的刚体**：挂在会动的刚体下面的运动学刚体（掉落金币的拾取触发器）、挂在骨骼节点上的刚体（出拳的碰撞体）每个物理步先瞬移到实体当前的世界位姿。Bepu 里刚体由仿真驱动变换，这两种情况都停在原处（运动学的睡下后变换才跟父实体走，触发器仍在原处；出拳的碰撞体停在加进仿真时手的位置），样例的本意显然是跟着走。和 Stride 不同，记在 Simulation 的 followMovingParents 上。
- **脚本属性互相引用不要求顺序**：Stride 反序列化时引用总能解析；我们挂脚本时被引用的脚本还没挂上就推迟到下一轮（TopDownRPG 的 CrateScript 排在它引用的 Trigger 前面）。
- **节点名照 Stride 的 CleanNodeName**：FBX 的命名空间（`mannequinModel:CATRigHub001`）只留最后一段，去掉 `#`、`__` 之后的部分和空格；动画一个关节都对不上时导入警告（以前静默变成静止姿势）。
- **流式加载时停住物理**：Stride 的 SceneStreaming 用同步的 Content.Load，加载那一帧整个游戏停住；我们的场景加载是异步的（取文件、建实体），分块加载期间把物理仿真停住，角色不会在地面出现之前掉下去（DynamicScene 一开始就是这样：角色站在中央分块的触发器里，脚下还没有地面）。渲染和脚本照常跑。
- **正在接触只报最深的深度**：Stride 的 OnTouching 每步给全部接触点，原生侧按一对物体只报这一步最深的穿透深度（样例只用最深的）；物体要打开（设了带 onTouching 的处理器）才报，免得每步每对都产生事件。
- **场景的偏移加在根实体的本地位置上**：Stride 加在场景的世界矩阵上；我们没有场景的父子层级，加载时直接加进根实体的位置，脚本读到的本地位置因此带着偏移。
- **去掉物理组件就移除物体**：以前只在实体销毁时移除；Stride 里从实体上移除 BodyComponent 就离开仿真，TopDownRPG 出拳时靠它开关碰撞体。

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
