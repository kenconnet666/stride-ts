# 进度的详细记录

docs/roadmap.md 的"进度"只留结论；这里是已完成各项的过程记录（每一步做了什么、补了哪些引擎能力、比对时修掉了什么），按完成的顺序。2026-11-19 从路线图里挪过来，之后完成的项也把细节记在这里。决定和取舍在 [decisions.md](decisions.md)，实现的样子在 [architecture.md](architecture.md)，截图比对的做法和结果在 `tools/stride-capture/*/README.md`。

## P1 运行时补齐 3D 游戏的基础

1. ~~场景脚本导入~~（2026-11-19 完成）：导入器把 Stride 的脚本组件写进场景（属性名改成小写开头，实体和资源的引用写成 `$entity`、`$asset`）；运行时按类名在登记表里找翻译过来的 TS 脚本（`loadScene` 的 `scripts` 选项可以显式对应），找不到的脚本和属性警告后跳过；新的属性种类 `prop.asset(kind)`；`InputManager` 也认 Stride 的键名。TPP 改成由场景挂脚本。顺手修了热重载在有私有成员的脚本上崩溃的问题。
2. ~~骨骼动画~~（2026-11-19 完成，ModelNodeLink 留到 FPS、TopDownRPG 用到时做）：ufbx 导出骨架、蒙皮、动画剪辑；ozz 采样和混合；蒙皮顶点格式、GPU 蒙皮；AnimationComponent 和 TPP 的 AnimationController。TPP 的角色动起来了。见 architecture.md 的"骨骼动画和 GPU 蒙皮"。
3. ~~AnimatedModel~~（2026-11-19 P1 部分完成，`apps/animated-model`，端口 5186；见 decisions.md 的"AnimatedModel 分两次验收"）：
   - 做了：导入和运行（角色跑步、Idle/Run 淡入淡出、拖动转身）；2D 背景（Background 的 Is2D）；一个视图最多 4 个方向光；相机槽位（Camera.slot）；合成器的最小数据化（主画面的清屏色、后处理开关、透明阶段开关，相机画进渲染目标贴图 RenderTextureSceneRenderer）；渲染目标贴图（Texture.renderTarget）；精灵（Sprite 组件、SpriteRenderFeature，普通和 billboard，透明阶段，从远到近）；指针事件（`input.pointerEvents`）；关掉后处理时原样拷贝。
   - 验收：和桌面 Stride 4.4.2 比（动画停在第 0 帧，去掉 UI 按钮的区域）平均每通道差 0.148/255，差超过 10 的像素 0.31%（`tools/stride-capture/animated-model`）；冒烟脚本 `pnpm --filter @stride-ts/animated-model smoke` 通过。
   - P2 补：UI 页面的 Idle、Run 按钮（现在用 `stride call idle`、`run` 代替）。遗留：画进渲染目标贴图的相机不用阴影、不做后处理；精灵没有 Swizzle、sprite sheet、billboard 的 Z 旋转。
4. ~~PhysicsSample~~（2026-11-19 P1 部分完成，Bepu 版，`apps/physics-sample`，端口 5188；三个场景，`?scene=PhysicsSample/VolumeTrigger` 这样选，NextSceneScript 在场景之间换）：
   - 做了：Body 组件和 `simulation.body(entity)`（运动学、唤醒、瞬移、速度、冲量、重力、睡眠阈值；物体移除后只记设置），凸包碰撞体，程序模型（照 Stride 4.4.2 生成），`screenToWorldRaySegment`；触发器和接触事件（`TriggerHandler`、`setContactHandler`），实体销毁时移除物体和连着的约束；约束（球窝、铰链、齿轮马达、点在线上、线性限位、摆动和扭转限位、焊接，语义照 Bepu，映射到 Jolt；刚性，和 Bepu 的软约束不同）；换根场景（`game.setRootScene`，`prop.asset('scene')`），运行中改重力；材质的透明混合、环境光遮蔽、镜面颜色工作流、贴图乘颜色的自发光，贴图引用记 sRGB；正交相机（`Camera.projection`、`orthographicSize`）。原生到 0.14.0。
   - 验收：和桌面 Stride（master 的样例配 4.4.2 的包）比，去掉 UI 后平均每通道差 0.13 到 1.32/255，差超过 10 的像素 0.56% 到 2.40%，都在箱子的发光标志（材质层，P2）上（`tools/stride-capture/physics-sample`）；冒烟脚本 `pnpm --filter @stride-ts/physics-sample smoke` 走完三个场景的玩法和换场景。
   - P2 补：各场景的 UI 文字和按钮（现在用调试命令 `next`、`previous`、`next-scene`、`previous-scene` 代替）。遗留：透明物体不投阴影、同一批的透明实例不排序。
5. ~~BepuSample~~（2026-11-19 P1 部分完成，`apps/bepu-sample`，端口 5190；主场景加七个演示子场景，`?scene=Colliders` 选，或 `stride call scene '"Ropes"'`）。分步：
   1. ~~骨架~~（2026-11-19）：子场景的加载和卸载（`game.unloadScene`），模型实例化（`Instancing`、`Instance`，Stride 的 InstancingComponent、InstanceComponent），程序模型补上圆柱、圆锥，OBJ 模型（原生 0.15.0，ufbx 读），空碰撞体（EmptyCollider），贴图的采样器（Point、各向异性、寻址模式，每张贴图各自的），`Simulation.timeScale`、`enabled`，`Quaternion.slerp`，`game.debugText`（先不画，`stride call debug-text` 读），脚本属性的 Vector2 是数组；脚本 SceneSelector、FindAndAttachCamera、BasicCameraController、TimeControl、SceneDescription。Colliders、Material Properties 场景能看能飞；冒烟脚本 `pnpm --filter @stride-ts/bepu-sample smoke`。
   2. ~~预制体、生成器、重力枪~~（2026-11-19）：预制体（导入成 `.prefab.json`，`prop.asset('prefab')` 得到加载好的 `Prefab`，`instantiate` 建实体；导入器的层级上下文不再放在实例字段上），原生 0.16.0 的单体约束（线性伺服、角度伺服、角马达）、距离限制、球窝马达，约束句柄的 `enabled`、`update`，`simulation.onStep`（ISimulationUpdate），`input.mouseWheelDelta`，脚本类可以一层层 `props()`（继承基类的属性）；脚本 Spawner、SpawnerComponent、ThrowerComponent、GravityGunComponent。Cube Fountain 能玩（几百个实例化的方块 60 fps），Colliders 里能扔、能用重力枪抓；冒烟脚本覆盖。
   3. ~~约束组件和绳子~~（2026-11-19）：场景里的约束组件导入成实体上的约束脚本（`BallSocketConstraintComponent` 等，名字同 Stride，启动时加约束、移除时去掉，`enabled` 开关、`update` 改参数；脚本基类的 `enabled` 改成访问器加 `onEnabledChanged`），同一个实体上的同类脚本第二个起挂到自动建的子实体上，RopeSpawnerComponent，`Quaternion.lookRotation`（平行时也是单位四元数）。原生 0.16.1 到 0.16.3：移除的物体编号复用（以前只增不减，会用完容量）、临时分配器超出时退回 malloc（大容量世界不再 abort）、变换槽位的世界矩阵不是旋转时报错（以前把 NaN 交给 Jolt，宽相卡死）。Constraint、Ropes 能看；冒烟脚本覆盖。
   4. ~~点光和聚光~~（2026-11-19）：`Light` 的 point、spot（Stride 的 LightPoint、LightSpot：距离衰减、聚光的角度衰减，公式照 LightUtil），每帧最多 256 个，放在存储缓冲里逐像素遍历；着色器的单个光源的 BRDF 抽成 `shadeLight`。Cube Mixer 能看（三盏彩色聚光灯，几千个方块 50 fps）；冒烟脚本覆盖。还没做：点光和聚光的阴影（样例里没开）、分簇（灯多的场景再做）。
   5. ~~动态网格和比对~~（2026-11-19）：动态的网格刚体（原生 0.17.0，封闭网格按体积积分算质心和惯量）、网格对网格的碰撞（0.17.1）；后处理按效果开关（`ScenePostEffects`，色调映射能关），缺法线的网格补平面法线（0.17.2），没有材质的网格用 DefaultMaterial 槽位，压缩的贴图宽高补到 4 的倍数（Lanczos3，0.18.0 的 `st_image_resize`）。场景里没挂的工具脚本不移植（见 decisions.md）。
   - 验收：和桌面 Stride（master 的样例配 4.4.2 的包，停住物理）比，七个场景平均每通道差 0.37 到 1.11/255，差超过 32 的像素都在 0.05% 以内（`tools/stride-capture/bepu-sample`）；冒烟脚本 `pnpm --filter @stride-ts/bepu-sample smoke` 走完七个场景的玩法。
   - ~~P2 补：场景选择和说明的 UI、调试文字的渲染~~（2026-11-19：调试文字随 GameMenu 画出来了；选场景的页面在 CustomEffect 之后补上：导入器的 `--stride <仓库>` 带上 Stride 自带的资源包（`/Stride.Engine/...` 的默认字体、`/Stride.UI.Assets/...` 的精灵表），SceneSelectorComponent 用 UI 库的 TextButton 给每个场景建按钮，Tab 显示、隐藏，冒烟加两项）。P4 补：环境光遮蔽、屏幕空间反射（样例的合成器开着）。遗留：接触的软度不映射（见 decisions.md）；重叠测试（BepuSimulation.Overlap）还没有；点光和聚光的阴影、分簇。
6. ~~Platformer2D~~（2026-11-19 P1 部分完成，`apps/platformer2d`，端口 5192）。样例不用 Bepu 的 2D 模式：平台、金币、角色都在 Z=0 上，3D 物理照常；角色转身是把 CharacterComponent.Orientation 绕 Y 转 180°，精灵跟着实体翻过来。分步：
   1. ~~精灵表和骨架~~（2026-11-19）：导入 .sdsheet（每张源图一张贴图，精灵记下区域、PixelsPerUnit、中心；默认不生成 mip，同 Stride），`SpriteSheet` 资源（`frame` 循环取，同 SpriteFromSheet.GetSprite），`Sprite` 的 `sheet`、`frame`（Stride 的 CurrentFrame）和 `enabled`；场景能看。
   2. ~~脚本和玩法~~（2026-11-19）：PlayerController（左右走、跳、按状态切帧、转身）、CoinRotation、CollectCoin（触发器、AsyncScript、拿到后隐藏精灵、3 秒后移除实体）；`simulation.body()` 也接受角色（Stride 的 CharacterComponent 继承 BodyComponent，转身用 teleport，原生 0.18.1），`Quaternion.invert`。音效属于 P2，导入时警告跳过。冒烟脚本 `pnpm --filter @stride-ts/platformer2d smoke` 走完待机、跑、转身、跳、拿金币。
   3. ~~和桌面 Stride 比对~~（2026-11-19，`tools/stride-capture/platformer2d`，两边都不挂脚本）：平均每通道差 2.17/255，精灵的形状和位置一致，差都在精灵内部——Stride 把精灵表压成 BC 格式，像素画的颜色被带偏；我们的精灵表源图原样用 PNG。
   - P2 补：拿金币的音效。遗留：九宫格的精灵边框（Borders）。
7. ~~TopDownRPG~~（2026-11-19 P1 部分完成，`apps/topdown-rpg`，端口 5194）。点地面走路（寻路）、打箱子掉金币、走到地图边上按触发器的深度流式加载相邻的分块场景。粒子特效（VFXPackage 的点击、尘土、拿金币）和音乐、音效属于 P2，导入时警告跳过。分步：
   1. ~~骨架~~（2026-11-19）：导入主场景（GameSettings 的默认场景是 MainScene，整张地图都在里面；分块流式加载的是另一个 DynamicScene，第 3 步做），Packs（PrototypingBlocks、mannequinModel、SamplesAssetPackage、VFXPackage）的模型；挂到骨骼节点（`ModelNodeLink`，原生 0.19.0 的变换链接：世界矩阵 = 目标的世界 × 节点矩阵 × 本地，不看父节点）；去掉 Static、Body、Character 组件时移除物体（以前只在实体销毁时）。场景能看，出拳的碰撞体挂在右手上。
   2. ~~导航~~（2026-11-19）：`game.navigation`（Stride 的 RecastMeshSystem）用物理世界里的静态体（不含触发器，按 IncludedLayers）运行时建导航网格：原生 0.20.0 的 `staticTriangles` 用 Jolt 三角化各种形状（0.20.1 补上复合形状的叶子），Recast 分块并行建；GameSettings 的 RecastNavigationConfiguration 随场景导入；`RecastNavigationComponent`（引擎自带的脚本）的 tryFindPath、path、state。TopDownRPG 的地面建网格 142 ms。
   3. ~~接触深度和流式加载~~（2026-11-19）：接触处理器的 `onTouching` 每个物理步收到这一步最深的穿透深度（Stride 的 IContactHandler.OnTouching，原生 0.21.0），SceneStreaming（按触发器里的深度预加载、加载、卸载分块场景；`content.preloadScene` 只取资源；加载期间停住物理仿真，对应 Stride 同步加载卡住的那一帧），EnableDynamicNavigation（`game.scenesChanged` 钩子，场景加载、卸载后重建导航网格）。顺带补上：场景的偏移（Stride 的 Scene.Offset，分块靠它摆位置）、GameSettings 的碰撞矩阵（Layer0 到 Layer31）、带类型标签的脚本属性引用（`!BodyComponent ref!! Id`），脚本基类的 Priority 不导入。`?scene=DynamicScene` 选流式加载的版本，冒烟脚本覆盖。
   4. ~~玩法脚本~~（2026-11-19，先于第 3 步做：默认的 MainScene 用不到流式加载）：PlayerInput（屏幕射线、点击、高亮）、PlayerController（寻路、出拳）、AnimationController（自己搭混合栈）、CrateScript、CoinScript、LootCoinScript、Trigger；MusicScript 是 P2 的音频，不挂。顺带补上：脚本属性引用的脚本排在后面也能挂上（同 Stride）；`nextFrame`、`delay` 挪到脚本基类（同 Stride 的 Script.NextFrame，所有脚本都能等）；挂在会动的刚体下面的运动学刚体、挂在骨骼节点上的刚体每步跟着实体走（掉落金币的拾取触发器、出拳的碰撞体）；节点名照 Stride 的 CleanNodeName 处理（Punch.fbx 的节点带 FBX 命名空间，以前对不上，出拳是静止姿势）。冒烟脚本 `pnpm --filter @stride-ts/topdown-rpg smoke` 走完点地面寻路、高亮、出拳打碎箱子、拾取掉落的和场景里的金币。
   5. ~~和桌面 Stride 比对~~（2026-11-19，`tools/stride-capture/topdown-rpg`，两边都不挂脚本）：平均每通道差 2.45/255，差超过 8 的像素 0.13%，差在格子贴图的颜色上（Stride 压成 BC 格式，我们用原样的 PNG）。
   - P2 补：粒子特效（点击、尘土、拿金币）、音乐和音效。遗留：RecastNavigationComponent 的排队寻路和直接移动；场景的父子层级（偏移不累加）。
8. ~~FirstPersonShooter~~（2026-11-19 P1 部分完成，`apps/first-person-shooter`，端口 5196），P1 的最后一个游戏。第一人称：WASD 走、鼠标转视角（点画面锁定鼠标，Esc 解锁）、左键开枪（射线打到动态刚体给冲量）、9 发打完或按 R/E 换弹，枪口火焰、弹孔、受击拖尾是 VFXPackage 的粒子预制体（P2，导入时警告跳过，生成照常）。需要的能力引擎大都有了（射线、冲量、鼠标锁定、列表和对象属性、精灵表、ModelNodeLink、自己搭混合栈）。分步：
   1. ~~骨架~~（2026-11-19）：导入 MainScene 和 Packs（PrototypingBlocks、mannequinModel、SamplesAssetPackage、VFXPackage）、Gun 模型、Bullets 精灵表、准星贴图；场景能看：枪挂在手臂模型的 MachinegunBone 上，准星（IgnoreDepth 的精灵）在画面中央，子弹数精灵在枪上。
   2. ~~玩法脚本~~（2026-11-19）：PlayerInput（键盘、鼠标锁定、手柄）、PlayerController、FpsCamera、WeaponScript（射线、冲量、冷却、换弹、子弹数精灵的帧）、AnimationController（待机、走、开枪、换弹）、EffectController 和 TriggerScript（TriggerGroup 是嵌套对象属性，生成的特效预制体定时移除）。顺带补上：`InputManager.thumbAny`、`triggerAny`（Stride 模板的 InputManagerExtensions，TPP 也改用）、`Quaternion.setYawPitchRoll`、`betweenDirections`（TopDownRPG 也改用）；调试 CLI 的 `mouse left --trusted`（DevTools 协议的真实点击，页面能锁定指针）。冒烟脚本 `pnpm --filter @stride-ts/first-person-shooter smoke` 走完锁定鼠标、第一枪换弹、转视角、走动、开枪推箱子、特效生成和移除、换弹动画、Esc 解锁。
   3. ~~和桌面 Stride 比对~~（2026-11-19，`tools/stride-capture/first-person-shooter`，两边都不挂脚本）：平均每通道差 2.69/255，差超过 8 的像素 1.3%，超过 32 的 0.09%；我们整体亮约 2/255，格子贴图有 BC 压缩的颜色差（同 TopDownRPG）。第一次比时角色比 Stride 低 2 cm（相机跟着矮，地面网格线错开 4 像素）：Jolt 默认的穿透容差 2 cm，Bepu 的软接触静止时几乎不陷进去；原生 0.21.1 降到 1 mm，角色和放在地上的物体的静止高度和 Stride 一致。回归脚本 `pwsh tools/regress.ps1` 把所有样例的冒烟脚本挨个跑一遍（各自起开发服务器、开无头 Chrome），全部通过；Platformer2D 的起跳检查改成轮询（刚打开的浏览器帧率不稳，固定等 250 ms 时偶尔才刚离地）。
   - P2 补：枪口火焰、弹孔、受击拖尾的粒子。
9. ~~P1 收尾~~（2026-11-19）：
   - 整理：导入器拆出材质、贴图、天空盒（`stride/materials.ts`，七个样例的导入产物逐字节不变），YAML 值的读取归到 `yaml.ts`；`Transform.localMatrix()`、`setLocalMatrix()` 取代游戏里三处手写的组合和拆分；knip 查出的多余导出去掉，入口补上 `AssetTypes` 和材质描述的类型；AnimatedModel 去掉用不到的依赖。
   - 测量工具：`tools/measure.ps1`（导入、构建、下载量、启动各阶段、帧时间），`Game.startup`（`stride status` 报启动各阶段的时刻），桌面版各截图工程共用的 `tools/stride-capture/Benchmark.cs`（`--benchmark N [--gpu-profile]`，游戏照常跑）。
   - 测帧时间时发现 AnimatedModel 的合成器没有阴影渲染器，Stride 不画阴影而我们画了：改成按合成器关掉，帧时间 1.21 → 0.82 ms，截图差 0.148 → 0.083/255。
   - 没有游戏用到、挪到后面阶段的（见 decisions.md 的"P1 收尾"）：点光和聚光的阴影与分簇（P2）、SVG 精灵按矢量画（P2 的矢量底座）、动画剪辑的非骨骼曲线（P2）、调试渲染（P3，和编辑器的 Gizmo 一起）、Bepu 的 2D 模式（不做，有样例用到再说）、预先烘焙的导航网格。
   - 验收数字（2026-11-19，RTX 3050 笔记本，TPP 的桌面基准 6.87 ms，没有降频；下载量是页面实际请求的文件，本机 preview；第一帧是页面开始加载到第一帧画完；帧时间两边都不限帧率，游戏照常跑、没有输入，窗口同截图工程）：

     | 游戏 | 导入 | 构建 | 下载（brotli） | 第一帧 | 桌面 Stride 帧时间 | stride-ts 帧时间 | 比值 |
     |---|---|---|---|---|---|---|---|
     | ThirdPersonPlatformer | 2.0 s | 7.5 s | 4.07 MB（1.09） | 1234 ms | 6.87 ms（静态：去掉脚本、动画） | 5.48 ms | 0.80 |
     | AnimatedModel（640x1061） | 2.4 s | 4.9 s | 1.62 MB（0.73） | 1115 ms | 0.95 ms | 0.82 ms | 0.86 |
     | PhysicsSample | 1.4 s | 6.3 s | 2.69 MB（0.69） | 1050 ms | 1.05 ms | 0.49 ms | 0.47 |
     | BepuSample（1600x900） | 5.7 s | 8.3 s | 5.59 MB（1.31） | 895 ms | 9.38 ms（含 UI 和调试文字） | 4.90 ms | 0.52 |
     | Platformer2D | 1.4 s | 6.1 s | 2.49 MB（0.52） | 1114 ms | 3.80 ms | 2.52 ms | 0.66 |
     | TopDownRPG | 2.4 s | 8.4 s | 4.54 MB（1.51） | 1182 ms | 5.73 ms | 5.57 ms | 0.97 |
     | FirstPersonShooter | 2.4 s | 7.9 s | 3.97 MB（1.10） | 1148 ms | 5.90 ms | 4.95 ms | 0.84 |

     画面比对的结果见各游戏那一条和 `tools/stride-capture/*/README.md`；平均每通道差 ≤ 1/255 的验收线只有 TPP、AnimatedModel、PhysicsSample、BepuSample 达到，Platformer2D、TopDownRPG、FirstPersonShooter 在 2.2 到 2.7/255，差在 Stride 压成 BC 格式的贴图颜色上（我们用 `--textures source` 原样的 PNG），属于有意的偏差。
   - 回归：`pwsh tools/regress.ps1` 六个样例的冒烟脚本全过；类型检查、单元测试（164 个）全过。

**P1 完成（2026-11-19）。**

## P2 界面、声音、效果

1. ~~SpriteFonts~~（2026-11-19 完成，`apps/sprite-fonts`，端口 5198）。样例没有场景：合成器的根是游戏自己的 `FontRenderer`（SceneRendererBase），用 SpriteBatch 画背景图和八屏文字（静态字体、动态字体、粗体斜体、三种抗锯齿、日文、左中右对齐、旋转缩放的动画），属性是 10 个 .sdfnt（Arial 的编译期和运行时字体、Times New Roman、Source Han Sans 的 OTF）和一张背景贴图。按 D16 做矢量文字：字形轮廓（二次贝塞尔，CFF 的三次曲线导入时拆成二次）在片元着色器里算覆盖率，算法用 Slug（专利 2026-03-17 捐给公有领域，参考着色器 MIT/Apache，`C:\code\refs\Slug`，分发时要署名），任何缩放都清晰；Stride 的编译期字体是位图、运行时字体用 FreeType 栅格化，画面会有差，比对时记成有意的偏差。分步：
   1. ~~字体导入~~（2026-11-19）：stride-tools 的 `describeFont`、`fontCodepoints`、`glyphOutlines`（stb_truetype，CFF 的三次曲线按 1/4096 em 的误差拆成二次，原生 0.22.1）；管线把 .sdfnt 导入成 `.font.json` 加按码位块（码位 >> 8）分的 `.glyphs`（每个字形的点和 Slug 的横竖分带，偏移相对字形，`pipeline/src/font.ts`），系统字体照 Stride 按家族名和粗斜体在系统字体目录里找、找不到试度量兼容的替代；`import-stride --asset` 导入不挂在场景上的资源。SpriteFonts 的 10 个字体导入 31 秒；Arial 的运行时字体 30 块 3.2 MB，日文字体 384 块 118 MB（页面只下载用到的块）。
   2. ~~矢量文字和 SpriteBatch~~（2026-11-19）：`SpriteFont`（码位块用到时才下载）、`layoutText`、`measureText`，Slug 的像素着色器移植成 WGSL（`rendering/text`），`SpriteBatch`（Stride 的 API），`Game.rootRenderer`（`SceneRenderer`）。排版照 Stride 的度量，改掉它的两处毛病（字距、原点的单位，见 decisions.md）。画布 1×、2×、4× 时边缘的半覆盖像素约 86% 只有一个像素宽。
   3. ~~SpriteFonts 能看~~（2026-11-19）：导入游戏设置（`--asset SpriteFonts/Shared/GameSettings`），合成器的根是游戏渲染器时写出类型名和属性，字体、贴图（`.texture.json`）随属性导入；`Game.loadGameSettings(path, { renderers })` 按类型名建渲染器。FontRenderer 带背景图跑通八屏；冒烟脚本 `pnpm --filter @stride-ts/sprite-fonts smoke` 走完自动换屏、暂停继续、左右换屏、八屏都有字、日文字体只下载用到的块。
   4. ~~和桌面 Stride 比对~~（2026-11-19，`tools/stride-capture/sprite-fonts`）：八屏逐屏比，平均每通道差 0.25 到 1.01/255 的有六屏；对齐那屏 2.72（Times New Roman 19 像素，Stride 的笔画按 hinting 吸附到像素，字的位置差不到 1 像素），抗锯齿那屏 4.93（Aliased 的字 FreeType 用完整的 TrueType hinting 算宽度，三行整体差 5 像素），动画那屏的旋转原点和字距是有意的偏差。比对中修掉的：字体要求整数 ppem 时照 FreeType 取整（原生 0.23.0 读 head 表的 flags），之前正文每行宽 3%。也发现 Stride 4.4.2 的这个样例原样运行是黑屏（有启动画面、没有默认场景时合成器永远换不上），截图工程不放启动画面绕开。帧时间：桌面 Stride 0.42 ms，我们 0.39 ms（排版加了缓存、SpriteBatch 每个字不再建临时数组以后，对齐那屏从 2.1 ms 降到 0.39 ms）。导入 31 s，构建 89 s（日文字体的 384 块都要预压缩），页面下载 9.7 MB（brotli 2.9 MB），第一帧 1.2 s。
   - P2 补：UI 系统的文字排版（换行、富文本）、世界空间的文字（MSDF）、点存成 f16 减小字体文件。
2. ~~GameMenu~~（2026-11-19 完成，`apps/game-menu`，端口 5200）：两个场景（启动页 SplashScene 点一下进 MainScene），各有一个 UIComponent（页面 .sduipage、分辨率 640x1136、ResolutionStretch）；Main 页面用到 Grid、UniformGrid、StackPanel、Canvas、ContentDecorator（精灵表的九宫格背景）、ImageElement、TextBlock、Button、ModalElement（两个弹窗）、ScrollViewer（选飞船）、EditText（改名字），UI 库（.sduilib，脚本里按名字实例化模板），两个字体（Western、日文）。脚本：MainScript（按名字找元素、改文字和图片帧、按钮的 Click 和 IsEnabled、Grid 的列宽动画、弹窗显隐）、SplashScript（换场景）、InputCaptureMonitor（UI 捕获输入时脚本看不到，F9 切换屏蔽，DebugText.Print 画调试文字）。按 D4 照 Stride UI 自己做：布局规则照 Stride（Measure、Arrange），字和图都在 WebGPU 上画，文字是矢量的；EditText 后面接影子 DOM（隐藏的输入框负责输入法、选中复制，无障碍树对应 UI 元素）。分步：
   1. ~~UI 资源导入~~（2026-11-19）：管线的 `stride/ui.ts` 把 .sduipage、.sduilib 导入成 `UIFile`（`.ui.json`：元素平铺成数组，Children、Content 换成下标，属性名首字母小写、值换成 JSON，附加属性 row、column、zIndex、Canvas 的位置；UI 库的 `templates`），布局只导入两维（见 decisions.md）；场景的 `ui` 组件（UIComponent）、脚本属性的精灵表和 UI 库（`spriteSheet`、`uiPage`、`uiLibrary`）；精灵表记下九宫格的边框。GameMenu 两个场景导入无警告。
   2. ~~UI 运行时的布局~~（2026-11-19）：`packages/engine/src/ui`：UIElement（尺寸、最小最大值、外边距、对齐、Visibility、不透明度、启用、画的先后，Measure、Arrange 带缓存和失效传播，世界矩阵以元素中心为原点）、附加属性做成 UIElement 上的属性（gridRow、panelZIndex、canvasRelativePosition……），面板 Grid（固定、auto、星号，照 Stride 的算法）、UniformGrid、StackPanel（含在 ScrollViewer 里按子元素滚动）、Canvas，控件 ContentControl、ContentDecorator、Button、ImageElement（拉伸方式、九宫格边框的最小尺寸）、TextBlock（按真实像素的字号量、换行）、ModalElement、ScrollViewer（滚动条、惯性）、EditText（布局），精灵提供者（SpriteFromSheet、SpriteFromTexture），UIPage、UILibrary（按模板新建），`content.loadUIPage`、`loadUILibrary`。单测 24 个（Grid 的用例照 Stride 的 GridTests、StackPanel 的滚动照 TestOffset、TestScrollOf，Canvas 照 TestArrangeOverrideRelative）；GameMenu 的两个页面能建出来、排出合理的大小。导入时修掉：YAML 里不带引号的 `Text: 000` 读成了数字（`scalarSource` 取原文）。
   3. ~~UI 渲染~~（2026-11-19）：`UIComponent`（引擎自带的脚本组件，场景的 `ui` 组件挂它）、`game.ui`（UISystem：每帧画完场景之后，全屏 UI 按虚拟分辨率和 ResolutionStretch 布局，再用 SpriteBatch 画：背景色、图片、九宫格的框、按钮图、文字（Slug，照 Stride 的 UI 文字：字号按真实像素、在元素宽度里对齐、对齐到像素）、弹窗的遮罩、滚动条，ClipToBounds 用剪裁矩形）。顺带修掉：字体按块下载，下完新的块时文字要重新量（TextBlock、EditText 看 loadedBlocks）；贴图按 Stride 的预乘 alpha 用（精灵、SpriteBatch 的着色器采样后乘 alpha，以前半透明的边发亮）。调试文字画出来了（P1 遗留：Stride 的 8x16 调试字体嵌在引擎里，画在最上面）。GameMenu 的启动页和主菜单在 Chrome 里看过（脚本还没翻译，数字是页面的默认值）。偏差见 decisions.md。
   4. ~~UI 输入~~（2026-11-19）：输入的占用（`input/capture.ts`，照 Stride 的 Input Capture：UI 悬停时占鼠标、输入框有焦点时占键盘，`maskCapturedInput` 开着时脚本看不到；开始占用时按着的键给脚本一个松开，结束时还按着的键松开前继续藏着）；UI 的路由事件（`ui/events.ts`：隧道、冒泡、直接，类处理函数）、指针路由（`ui/UIPicking.ts`：找元素、按下移动松开、移入移出、悬停状态）；Button 的按下和 Click、ModalElement 挡住后面并发 OutsideClick、ScrollViewer 拖动（过阈值才滚，滚动时里面的按钮不算按下）和滚轮（多做的）；EditText 接影子输入框（`ui/TextInputBridge.ts`：隐藏的 `<input>`/`<textarea>` 负责键盘、输入法、选中、复制粘贴，EditText 显示它的值、选区、拼字和闪烁的光标，点、拖放光标选文字，Enter、Esc 结束）。单测 8 个（指针路由、占用）。还没做：除输入框以外的无障碍树（按钮、文字对应 DOM 节点给读屏软件）、给有焦点元素的按键路由事件（KeyPressed 这些，样例没用到），放进 P2 的 UI 补充。
   5. ~~脚本翻译和冒烟~~（2026-11-19）：`apps/game-menu/src/game` 的 UISceneBase（虚拟分辨率跟着画布大小）、SplashScript、MainScript（按名字找元素、改文字和精灵表的帧、按钮的 Click、IsEnabled、弹窗显隐、UI 库实例化飞船按钮、血条：缩短精灵的区域、改网格的列宽）、InputCaptureMonitor（调试文字印出脚本看到的输入，F9 开关屏蔽）。冒烟脚本 15 项（启动页、改名字、升级、选飞船、滚轮、锁着的飞船、屏蔽、血条）。顺带修掉：`game.exit()` 在一帧里面调用（Quit 按钮）时推迟到帧末，以前这一帧剩下的部分会用到已经释放的变换存储；精灵的区域可以改（SpriteFrame.region）；冒烟脚本的输出上限放大（截图的 PNG 超过 1 MB）。
   6. ~~和桌面 Stride 比对~~（2026-11-19，`tools/stride-capture/game-menu`）：540x960 截启动页、欢迎弹窗、主菜单、选飞船的弹窗（飞船属性固定、血条一半），桌面版另外导出每个元素的布局：40 个元素的大小和位置和 Stride 一致（差不到 0.6 像素）。截图平均每通道差 3.5 到 4.6/255（关掉字距 3.4 到 4.0），来自 Stride 把精灵表压成 BC 格式（背景 2/255、细节多的图 4/255）和文字的 hinting（4 到 5/255）。比对中修掉的：Thickness、颜色里文件没写的成员保持元素类型的默认值（Stride 反序列化只覆盖写了的成员；Button 的 `Padding: {Left, Top, Bottom}` 右边是默认的 10，以前当 0，当前飞船的按钮大了 10 像素）；字体开关字距（和下完新的块一样）让文字重新量（`SpriteFont.layoutVersion`）。帧时间（启动页，640x1061，不限帧率）：桌面 Stride 0.52 ms，我们一开始 0.57 ms；场景、UI、调试文字改成录进同一个命令编码器、每帧只提交一次（`GraphicsDevice.frameEncoder`，后备缓冲的视图每帧只建一次）以后 0.43 ms（所有游戏都受益）。导入 34 s，构建 73 s，页面下载 3.8 MB（brotli 2.3 MB），第一帧 1.0 s。
   - P2 补：除输入框以外的无障碍树（按钮、文字对应 DOM 节点给读屏软件）、给有焦点元素的按键路由事件、Slider、ToggleButton 等没用到的控件。（放在 3D 场景里的 UI 在 UIElementLink 里做了。）
3. **UIElementLink**（`apps/ui-element-link`，端口 5202）：三个场景（FullScreen 默认、BillboardedScreen、TiltedScreen），点跟着走的按钮换下一个。每个场景：Splash 实体的 UIComponent（页面由 SplashScript 用代码建：Canvas 里一个左右来回移动的长按钮"ElementName"、四角各一个方按钮，图来自精灵表 SplashScreenImages），FollowingEntity 带 UIElementLinkComponent 跟着 UI 元素"ElementName"走，它的子实体是跑步的骑士（AnimationStart 脚本播动画）、程序生成的球、烟的粒子；UICamera（正交，720）。FullScreen 是全屏 UI；BillboardedScreen 是放在 3D 里、面向相机的 UI（Size 12.8x7.2），TiltedScreen 是不面向相机的倾斜 UI。分步：
   1. ~~导入~~（2026-11-19）：场景的 `uiElementLink` 组件（Target、Camera 换成所在的实体），粒子系统跳过（导入时计数）；`apps/ui-element-link` 导入三个场景无警告。顺带修掉：模型的材质槽位按 Stride 清理过的名字找（FBX 的命名空间 `c100:chr:x`，新版 Stride 只留最后一段，旧版把 : 换成 _，骑士的材质以前都落到槽位 0）；去掉 PremultiplyAlpha: false 的警告（只对精灵、UI 有影响，网格的贴图本来就不预乘）。
   2. ~~放在 3D 里的 UI~~（2026-11-19）：不是全屏的 UIComponent 按 Size 和实体的世界矩阵放进场景（`ui/UIProjection.ts`，照 Stride 的 UIElementState.Update：IsBillboard 正对相机、保留实体的缩放，IsFixedSize 按到相机的距离放大），按主相机从远到近画、和场景的深度缓冲比较（前向渲染器在场景里有 UI 时留着深度缓冲）；SpriteBatch 改用 4x4 的 虚拟坐标 → 裁剪空间 矩阵，可以带深度测试；ClipToBounds 的剪裁矩形按投影算；指针用相机的射线和 UI 平面求交，换成虚拟坐标。单测 6 个（摆放、旋转缩放、面向相机、固定大小、射线求交）。顺带修掉：画布的大小在帧开头（和启动时）就跟上窗口，以前在画之前才调，脚本 start 时读到的是默认的 300x150（SplashScript 按它摆角上的按钮）。
   3. ~~UIElementLink~~（2026-11-19）：`UIElementLink` 组件和系统（`ui/UIElementLink.ts`，同 ModelNodeLink 走变换存储的链接），`game.ui.elementWorldMatrix` 照 Stride 的 UIElementTransformLink 算元素在世界里的矩阵（全屏按像素放在原点，3D 里按 UI 实际的摆法、元素的位移换成世界单位）。和 Stride 不同的两处见 decisions.md：先布局再算（不晚一帧），面向相机按实际画 UI 的相机。
   4. ~~脚本翻译和冒烟~~（2026-11-19）：UISceneBase、SplashScript（用代码建 Canvas、精灵表的帧当按钮图、按钮左右来回移动、点了换场景）、AnimationStart（加 AnimationComponent、叠加播放剪辑、移除自己）。冒烟 20 项：三个场景轮一圈，每个场景 UI 画出来了、FollowingEntity 和按钮对齐（全屏差不到 0.5 像素，3D 里差不到 0.005）、骑士在跑、点角上的按钮不换场景、点跟着走的按钮换下一个（放在 3D 里的 UI 按射线点中）。
   5. ~~和桌面 Stride 比对~~（2026-11-19，`tools/stride-capture/ui-element-link`）：1280x720 截三个场景（按钮定在一处、动画停在第 0 帧、去掉烟的粒子）。UI 的位置、大小、3D 里的透视和朝向，跟着走的球和骑士的位置两边一致。平均每通道差 6.81（全屏）、4.62（倾斜）、4.46（面向相机）/255，来自两处已知的差：Stride 的 UI 被色调映射（这个暗场景的自动曝光把 UI 提亮，也因为量亮度时算上了 UI，背景暗 4 到 7/255；我们的 UI 画在后处理之后，有意的偏差）；4.4.2 的样例把骑士的法线贴图当成 sRGB 颜色贴图（样例的毛病，后来改了），骑士几乎是黑的。帧时间（全屏场景，1280x720，不限帧率，高性能电源模式）：桌面 Stride 1.24 ms（含烟的粒子），stride-ts 1.10 ms（没有粒子）；导入 1.5 s，构建 6.7 s，页面下载 4.3 MB（brotli 2.7 MB），第一帧 0.94 s。UIElementLink 完成（烟的粒子等 ParticlesSample 做完粒子再补）。
4. **UIParticles**（`apps/ui-particles`，端口 5204）：一个场景（SplashScene），全屏 UI 由 SplashScript 用代码建（Grid 布局：标题、"重新开始"和"恭喜"两个按钮、底部的导火索进度条），点按钮在按钮的位置生成命中特效的预制体（翻页动画，2 秒后移除）；场景里五个粒子系统（Confetti、Stars、Hit、ConfettiBig、Fire），导火索的火跟着进度条走，"恭喜"时放大彩纸。正交相机按窗口大小调。合成器：ForwardRenderer（不带后处理）之后用 SingleStageRenderer 画"Particles"阶段，粒子在 UI 上面。要做的是粒子系统（P2 的"粒子"，ParticlesSample 再补全）。分步：
   1. ~~导入~~（2026-11-19）：粒子系统组件按 Stride 的对象树原样导入（`pipeline/src/stride/particles.ts`：类型名、属性名首字母小写，向量和颜色换成数组，Spawners 这些集合换成数组，贴图导出成 TextureRef），只留运行时认识的模块类型，其余的警告后去掉（形状、材质去掉时写 null，发射器不画）；预制体里的粒子一样；合成器里粒子的透明阶段由 SingleStageRenderer 画时记 `particlesOverUI`。原生 0.24.0：图片解码支持 DDS（BC1 到 BC5、BC7、不压缩的 24、32 位，块用 basisu 的解码器；样例的爆炸贴图是 DXT1 的 .dds）。`apps/ui-particles` 导入无警告，单测 2 个。
   2. ~~粒子模拟~~（2026-11-19）：`particles/`：照 Stride 的 ParticleSystem、ParticleEmitter 在 CPU 上做（粒子池按字段分列存、Stack 策略，模块要哪些字段建哪些；每帧的顺序、生成器的状态机、种子的取法照 Stride，RandomSeed 和 .NET 算的逐位对上），生成器 PerSecond、PerFrame，初始化器 Size、Position、Velocity、3DRotation、Color 的种子，更新器力场（球形）；`ParticleSystemComponent`（播放、暂停、停止、超时、速度、颜色）和 `game.particles`（变换更新之后模拟）。单测 7 个。偏差见 decisions.md（力场衰减的毛病改掉了；组件的 Control 只在 Stride 的编辑器里起作用，不导入运行时）。
   3. ~~粒子渲染~~（2026-11-19）：`particles/ParticleRenderer.ts`：照 Stride 在 CPU 上把粒子展开成顶点（Billboard、Quad 按粒子的朝向、Hexagon 两个四边形；翻页 UV；局部模拟的换到世界），所有发射器的顶点一个缓冲、每帧写一次，每个发射器画一次；颜色 = 组件颜色 × 材质（贴图按预乘用、粒子颜色或常量），alpha 乘 1 - AlphaAdditive，预乘混合、比深度不写深度；系统从远到近，发射器按 DrawPriority，ByDepth 的粒子从远到近。一般在前向渲染器的透明阶段里画，合成器的 `particlesOverUI` 时在 UI 之后画进后备缓冲（前向渲染器留着深度缓冲）。Chrome 里看过彩纸（顶点颜色的 Quad）和火（翻页、加法）。单测 1 个（翻页）。
   4. ~~脚本翻译和冒烟~~（2026-11-19）：UISceneBase、SplashScript（用代码建 Grid 布局的 UI，按钮在按钮上实例化命中特效的预制体、2 秒后移除，导火索按比例缩短、火跟着烧到的地方，新游戏和结束两种状态切换火和彩纸）；引擎补了 `SpriteFromSheet.create(sheet, name)`（Stride 的 SpriteFromSheet.Create，UIElementLink 的脚本也改用它）。冒烟 10 项（UI、导火索、火跟着走、点"恭喜"和"重新开始"、命中特效出现和移除）。
   5. ~~和桌面 Stride 比对~~（2026-11-19，`tools/stride-capture/ui-particles`）：600x600、固定步长，导火索设成一半、发射器改成固定种子并重置后走 60 步截新游戏，进入结束后同样截一张。UI 的布局、火的位置和翻页、彩纸的范围和颜色一致；平均每通道差 4.65、4.68/255，来自精灵表的 BC 压缩和文字的 hinting（同 GameMenu），彩纸每个粒子的位置差一点（生成器的小数部分在重置时不清零，两边生成的时刻差一帧）。帧时间（新游戏，不限帧率）：桌面 Stride 0.79 ms，stride-ts 0.47 ms（一开始 1.28 ms：展开顶点时每个粒子分配小数组，画面外的系统也展开；改成标量、按包围盒剔除）；导入 7 s（重新导入，第一次 17 s），构建 7 s，页面下载 4.9 MB（brotli 3.3 MB），第一帧 1.0 s。UIParticles 完成。
5. **SimpleAudio**（`apps/simple-audio`，端口 5206）：一个场景，全屏 UI 页面（背景、居中的 DJ 图、左右两个波形图），SoundScript 一开始循环放背景音乐（mp3，StreamFromDisk），每次点击重放音效（wav，Spatialized 但场景里没有 AudioEmitter，按 2D 放）并让两个波形图从中间往两边散开、渐隐。要做的是音频（P2 的"音频"的第一段：音效和音乐，空间化等用到的样例再做）。分步：
   1. ~~导入~~（2026-11-19）：.sdsnd 导入成 `.sound.json`（SoundFile：编码、是否流式、是否空间化），源文件是浏览器能解的格式（mp3、ogg、wav、flac、aac）时原样复制到旁边（D9 的 (c)），别的格式报错；脚本属性引用声音（kind `sound`）。`apps/simple-audio` 导入无警告，单测补在 UI 的导入测试里。
   2. ~~音频运行时~~（2026-11-19，`audio/`）：`game.audio`（AudioEngine：一个 AudioContext 加主音量；第一次点击、按键时恢复出声，之前开始放的声音恢复后接着放），`content.loadSound`、脚本属性 `prop.asset('sound')`，`Sound`（不流式的整个解码成 AudioBuffer，流式的每个实例一个 `<audio>` 元素经 Web Audio 输出），`SoundInstance`（Play、PlayExclusive、Pause、Stop、IsLooping、Volume、Pan、Pitch、PlayState、Position，语义照 Stride）。单测 4 个（假的 AudioContext：状态、位置、循环、独占、恢复出声）。
   3. ~~脚本翻译和冒烟~~（2026-11-19）：SoundScript（AsyncScript：循环放音乐，点击重放音效、波形图散开渐隐）。冒烟 8 项（UI、音乐在放、AnalyserNode 量到主音量的输出不是静音、点击后音效和波形图、音效放完停止）；`tools/regress.ps1` 开 Chrome 时带 `--autoplay-policy=no-user-gesture-required`（合成的点击不算用户操作）。
   4. ~~和桌面 Stride 比对~~（2026-11-19，`tools/stride-capture/simple-audio`）：1280x720 截静止和波形图不透明两张，平均每通道差 1.53/255（背景图的 BC 色带、文字的 hinting），布局一致；声音两边是同一个源文件，冒烟核对播放和输出。帧时间：桌面 Stride 0.48 ms，stride-ts 0.39 ms；导入 2.4 s，构建 7 s，页面下载 2.6 MB（brotli 1.0 MB），第一帧 1.1 s。SimpleAudio 完成。
6. ~~ParticlesSample~~（2026-11-19 完成，`apps/particles-sample`，端口 5208）：七个场景（MainScene、AnimatedParticles、ChildParticles、CustomMaterials、CustomParticles、Lasers、RibbonParticles），NextSceneScript 换场景，加上相机绕转、旋转、预制体实例、激光朝向这些脚本。粒子用到约四十种模块：曲线（ComputeCurveSampler/ComputeAnimationCurve 的 Float、Vector3、Color4、Quaternion）、按寿命改大小、颜色、旋转，重力、速度方向、碰撞（圆柱、球），朝向的四边形、飘带（Ribbon）、拖尾（Trail），UV 滚动，生成顺序，子粒子（SpawnerFromParent 和三种触发、从父粒子继承位置、颜色、速度、顺序），材质的颜色树（ComputeBinaryColor、ComputeTextureScalar、参数），还有样例自己写的模块（CustomParticle 的生成器、初始化器、更新器、形状）和自定义材质（自己的着色器）。分步（每步按场景验收）：
   1. ~~应用和导入~~（2026-11-19）：`apps/particles-sample` 导入七个场景（还不认识的粒子模块警告后去掉，激光的网格材质有 ComputeShaderClassColor 和加法透明，留到第 5 步），程序模型补上圆环（Torus，照 Stride 的 GeometricPrimitive）；脚本翻译：NextSceneScript（<<、>> 按钮和调试命令）、CameraOrbitScript、RotationScript（Stride 用代码建的四元数曲线是匀速转，直接按时间算）、RotateEntity、AnimationStart、PrefabInstance、LaserOrientationScript、GameProfiler（只印帧率；Stride 的 Enabled 和脚本自己的 enabled 重名，换名字读进来）。UIScript 在场景里没用到，不翻译。MainScene 在 Chrome 里能画出来。
   2. ~~MainScene~~（2026-11-19）：曲线采样器（`particles/curves.ts`，关键帧按切线类型插值再烘焙成 32 个采样点，同 Stride），更新器拆进 `particles/updaters.ts`（重力、按寿命改大小、速度方向、碰撞，后置的在生成新粒子之后跑），力场和碰撞的形状拆进 `particles/fieldShapes.ts`（球、圆柱），InitialRotationSeed，形状拆进 `particles/shapes.ts`（加上 OrientedQuad 和各形状的 SamplerPosition/Size/Rotation），BoundingSphereStatic；材质的颜色树编译成 WGSL（`particles/material.ts`：贴图、贴图标量、粒子颜色、常量、二元运算，每种树一个着色器，同样的树共用流水线）。MainScene 导入没有警告，在 Chrome 里画出火、烟、火花，CPU 每帧不到 1 ms。
   3. ~~飘带和拖尾~~（2026-11-19，RibbonParticles、Lasers、AnimatedParticles、预制体）：ShapeBuilderRibbon、ShapeBuilderTrail（`particles/ribbons.ts`：按生成顺序的组连成带子，平滑照 Stride 的 Catmull-Rom 和圆弧，三种 V 坐标，UVRotate、EdgePolicy），粒子池的整数字段（Order），排序 ByOrder、ByAge，InitialSpawnOrder、InitialDirectionSeed、InitialPositionArc（目标是场景里的实体：粒子模块里的 `ref!!` 导入成 `$entity`，运行时按 ParticleContext 找），UVBuilderScroll，按寿命改颜色、转角，颜色树的 Overlay。顺手修了场景里的脚本属性不认 `renamedFrom` 的旧名字（GameProfiler 的 Enabled）。三个场景导入没有这一步的警告，在 Chrome 里看过（飘带、闪电弧、曲线各列），RibbonParticles 的 CPU 每帧约 1.3 ms（平滑改成不分配内存后，圆弧插值从 0.5 ms 降到 0.05 ms）。激光的网格材质挪到第 5 步。
   4. ~~子粒子~~（2026-11-19，ChildParticles）：`particles/children.ts`：SpawnerFromParent（寿命、死亡、碰撞、距离四种触发，个数按父粒子累积），InitialPositionParent（按顺序对应时沿父粒子这一帧走过的路排开）、ColorParent、VelocityParent、OrderParent（父粒子的序号放高位，飘带按父粒子分组）；子模块按 ParentName 连到父发射器，给父粒子池加字段（生成控制、ChildOrder、触发要的），有子粒子生成器时父粒子寿命到了多留一帧（DelayParticleDeath）；圆环的力场和碰撞（FieldShapeTorus）。ChildParticles 导入没有这一步的警告，四组演示（飘带、碰撞冒烟、烟花、碰撞生成同类）在 Chrome 里都有子粒子；顺手把飘带的顶点生成改成不分配内存（这个场景的飘带从约 0.66 ms 降到 0.25 ms）。
   5. ~~自定义~~（2026-11-19，CustomParticles、CustomMaterials、Lasers 的网格材质）：游戏继承 ParticleSpawner、ParticleInitializer、ParticleUpdater、ParticleShapeBuilder、ParticleMaterial 写模块，导出就按类名登记（`Registry.particleModule`），导入器照样导入引擎没有的模块；游戏自己的粒子字段（`particleField`）；着色器类写成 WGSL（`shaderClass`，`Registry.shaderClass`），颜色树（`rendering/colorTree.ts`，粒子材质和网格材质共用）调用它，共用的流 MaterialStreams 可以改；粒子顶点加第二套 UV；网格材质的自发光可以是整棵颜色树（按代码分着色器变体，贴图在绑定组 3），加法透明（漫反射和镜面两个系数），两面画（CullMode None）。三个场景在 Chrome 里看过（自定义形状和更新器、红色和径向的着色器类、两套 UV 的自定义材质、激光的滚动纹理和加法混合）。原来的计划：游戏代码登记自己的粒子模块和粒子材质（按类型名，同脚本），样例的 CustomParticle* 翻译成 TS，自定义材质的着色器写成 WGSL。激光的网格材质也在这一步（从第 3 步挪来）：自发光是颜色树（ComputeShaderClassColor 的 ComputeColorTextureScroll 按时间滚 UV、按高度淡出，乘贴图和常量），透明是加法（MaterialTransparencyAdditiveFeature）；网格材质现在只有"一张贴图配一个颜色"，要换成和粒子材质一样编译成 WGSL 的颜色树，着色器类按名字登记 WGSL，两边共用。
   6. ~~冒烟和桌面比对~~（2026-11-19，`tools/stride-capture/particles-sample`）：冒烟脚本把七个场景轮一圈（`next-scene`），查各场景演示的东西；桌面 Stride 换场景、固定种子后截七张，每通道平均差 0.70 到 2.09/255（MainScene 1.74、AnimatedParticles 0.70、ChildParticles 1.42、CustomMaterials 0.91、CustomParticles 2.09、Lasers 1.85、RibbonParticles 1.19）。比对中找到并修掉：网格材质的光泽度贴图（平台发黑）、镜面颜色工作流的能量守恒（漫反射乘 1 - 镜面，以前不变暗，平台偏亮；PhysicsSample 重比过没有变差）、换场景时后台任务的未处理拒绝（脚本的 `addTask`）。帧时间（MainScene，1280x720，不限帧率）：桌面 Stride 1.02 ms，stride-ts 0.86 ms；构建 10.6 s，页面下载 4.4 MB（brotli 2.85 MB），第一帧 1.12 s。
   - 同时做的工具改进：浏览器验证用装了 Claude 插件的 `stride open` Chrome（和 CDP 的剖析同一个浏览器）；回归用自己的状态目录和端口（`~/.stride-ts/regress`，端口加 1000），截图和测量脚本用自己的无头 Chrome（`STRIDE_BROWSER_DIR`），都不关开着的窗口。
   - 回头补：UIElementLink 场景里烟的粒子（现在有粒子系统了，重新导入、比对）。
7. ~~JumpyJet~~（2026-11-19 完成，`apps/jumpy-jet`，端口 5210）：2D 横版小游戏：点屏幕或空格让飞机往上跳，穿过不断生成的管子，撞到就结束，UI 有开始、计分、结束三个页面（用代码建）。背景是游戏自己的渲染器（JumpyJetRenderer，SceneRendererBase）用 SpriteBatch 画四层视差，飞机和管子是精灵加 Bepu 的刚体（管子是预制体），撞管子用形状的重叠查询（Simulation.Overlap），状态用事件键（GameGlobals 的 EventKey）广播。分步：
   1. ~~导入和骨架~~（2026-11-19）：`apps/jumpy-jet` 导入游戏设置和场景；合成器的根相机下面是游戏的渲染器时也按类型名建（导入器的 `gameRenderer`），渲染器的属性能引用精灵表；前向渲染器加了 `background` 钩子（清屏之后、不透明阶段之前在主画面的 pass 里画），JumpyJetRenderer 借它画视差背景、再画场景；BackgroundSection 翻译成 TS。在 Chrome 里看过：四层背景在滚，飞机画出来了。原来的计划：JumpyJetRenderer 和 BackgroundSection 翻译成 TS（视差滚动、SpriteBatch 的 VirtualResolution）；场景能看。
   2. ~~物理~~（2026-11-19）：精灵上的 Bepu 刚体（运动学）、复合碰撞体随场景和预制体导入；形状的重叠查询 `simulation.overlap`（原生 0.25.0 的 `sn_physics_overlap`，Jolt 的 CollideShape）。原生 0.26.1：运动学刚体的世界变换被物理以外改过（脚本移动了它或父实体）就在步进前移过去，这一步没动的运动学刚体不写回变换（以前每步写回，PipesScript 移动管子组的根时管子被拉回原处）；写回时父节点的世界矩阵现算。TS 里原来"挂在会动的刚体下面的运动学刚体"的跟随换成原生侧的这条通用规则，Simulation 只留骨骼节点上的刚体（`followNodeLinks`）。
   3. ~~脚本~~（2026-11-19）：CharacterScript（AsyncScript 加两个 `addTask`：空格或点击往上跳、重力、换精灵帧和角度，按碰撞体的形状查重叠：层 0 结束、层 6 的触发器计分）、PipesScript（按画布宽度实例化几组管子预制体，往左移、出了左边接到最后、高度随机）、UIScript（用代码建主菜单、计分、结束三个页面）、BackgroundScript（结束时背景停住），事件键加了 `EventReceiver.tryConsume()`（Stride 的 TryReceive）。引擎修了 Canvas 的附加属性：设相对位置时改用相对位置、设绝对位置时改用绝对位置（同 Stride 的 SetCanvasRelativePosition），UI 文件里存的 `canvasUseAbsolutePosition` 放到最后设。在 Chrome 里玩过：开始、跳、管子滚动、撞管子和落地结束、Retry。冒烟 11 项（菜单按钮的位置、计分页面、管子组移动而管子的本地位置不变、进触发器加一分、落地后结束页面和背景停住、Retry 重新开始）。
   4. ~~冒烟和桌面比对~~（2026-11-19，`tools/stride-capture/jumpy-jet`）：冒烟 11 项；截主菜单和游戏中两张，布局一致，平均每通道差 4.04、5.79/255，主要来自贴图的块压缩（两边编码器不同）。帧时间两边都是 0.57 ms。比对中修掉的：异步脚本的续体在当帧画之前跑完（以前 AsyncScript 的移动晚一帧才画出来）；背景的设计分辨率取游戏设置的默认后备缓冲（`game.settings.defaultBackBufferSize`，导入器带上 GameSettings 的 RenderingSettings），页面的画布保持 640:1136；相机下面是游戏的渲染器时，借用的前向渲染器不做后处理（导入器给主画面 `postEffects: null`）。
8. ~~SpaceEscape~~（2026-11-19 完成，`apps/space-escape`，端口 5212）：3D 跑酷。
   - 玩法：角色沿走廊往前跑，左右换道、跳、滑铲躲障碍；关卡按段程序生成、跑过去的段回收；按距离计分。
   - UI 三个页面（主菜单、计分、结束），用代码建。
   - 走廊往远处弯下去、远处起雾，是自定义着色器：效果 SpaceEscapeEffectMain 在 StrideForwardShadingEffect 上加 TransformationBendWorld（世界位置的 x、y 加 z² 项）和 CustomFogEffect（按深度和高度往雾色插值）。参数由渲染特性 BendFogRenderFeature 设。

   分步：
   1. ~~导入和骨架~~（2026-11-19）：`apps/space-escape` 导入游戏设置、场景（Scene、LevelBlocks）、模型、骨架、动画、材质；在 Chrome 里看过，角色画出来了。导入器补上：重名的节点照 Stride 的 GenerateUniqueNames 加 `_1`、`_2`（深度优先先序，第一个也加；以前骨架找不到 `jet_F_R_1` 这类节点，动画只对第一个同名节点），骨架、动画、蒙皮都按这个名字（`strideNodeNames`）；Alpha 裁剪（MaterialTransparencyCutoffFeature，材质的 `alphaCutoff`，不透明阶段里丢掉 alpha 低于阈值的像素，深度预通道和阴影也丢）。
   2. ~~着色器~~（2026-11-19）：网格效果 `meshEffect`（`rendering/meshEffect.ts`）：游戏导出、按导出名登记，合成器里 MeshRenderFeature 的 EffectName 是它时网格都用它画（导入器写进场景合成器的 `meshEffect`）；四个 WGSL 钩子（投影前改世界位置、改 UV、顶点算给片元的值、改最终颜色），没定义的用默认；每个网格 16 个参数（Stride 的 Mesh.Parameters，`Mesh.setEffectParameters`）。SpaceEscapeEffectMain 照 BendFogRenderFeature 的值写弯曲、雾、UV 区域（Stride 把弯曲的 X 系数写进了 X、Y 两个位置，照它画出来的样子取）。加载 LevelBlocks 看过：走廊、远处的雾。顺手：网格着色器编译出错时把出错的行打到控制台（以前只看到管线无效、全黑）。
   3. ~~脚本~~（2026-11-19）：CharacterScript（三条道，左右键或横着划换道、下键或往下划滑铲，按动画进度插值换道，包围盒随状态换）、BackgroundScript 加 LevelGenerator、Section、BackgroundInfo、ObstacleInfo（关卡一段段往前移、回收、随机接新段，障碍物按包围盒、洞按矩形判断）、GameScript、UIScript、PlayAnimationScript。引擎补上：场景模板 `content.loadSceneTemplate`（Stride 里脚本属性引用的 Scene：加载了不放进游戏，从里面 Clone 实体；`prefab(名字)` 实例化模板实体，`scriptProps` 读模板上脚本的属性）、`content.addModel`（给实体挂加载好的模型，同 `new ModelComponent(model)`）、脚本的列表属性收到 `{}` 时当空列表（Stride 的 YAML 把空集合写成 `{}`）。拖动手势先在 CharacterScript 里按指针事件识别（引擎还没有手势）。在 Chrome 里玩过：主菜单、开始、换道、滑铲、撞管子结束、Retry。
   4. ~~冒烟和桌面比对~~（2026-11-19，`tools/stride-capture/space-escape`，4.4.2 的样例）：冒烟 9 项；关卡换成固定的几段后截主菜单和跑动中两张，平均每通道差 3.14、5.30/255，关卡、弯曲、雾、天空板、角色、UI 一致。帧时间：桌面 0.91 ms，stride-ts 0.78 ms。
9. ~~MaterialShader~~（2026-11-19 完成，`apps/material-shader`，端口 5214）：一个场景，一块程序化平面（32x32 细分）上的水面材质。
   - 材质用游戏自己的着色器类：位移贴图（MaterialDisplacementMapFeature，顶点阶段）是 ComputeColorWave（按到中心的距离和时间算正弦波），法线贴图是 ComputeColorWaveNormal（同一个波的导数）。
   - 还有漫反射贴图、光泽度、没有贴图的镜面贴图（只有回退值）。
   - 没有脚本，水面靠 Global.Time 动起来。

   分步：
   1. 导入和骨架：`apps/material-shader` 导入场景、材质、贴图；平面能看（暂时没有位移、法线树）。
   2. ~~颜色树推广到法线和位移~~（2026-11-19）：材质的 `emissiveShader` 推广成 `shaderTrees`（自发光、法线、位移三棵树用同一个编译器，贴图共用绑定组 3、顶点着色器也能读）；导入器导出 `normalTree`（法线贴图是着色器类时）和 `displacementTree`（顶点阶段的位移贴图，别的阶段警告），有法线树的网格也生成切线；位移在顶点着色器里沿模型空间的法线推（深度预通道和阴影同样推），顶点阶段的贴图用第 0 级 mip。ComputeColorWave、ComputeColorWaveNormal 写成 WGSL。在 Chrome 里看过：水面一圈圈起伏、高光跟着波纹。
   3. ~~冒烟和桌面比对~~（2026-11-19，`tools/stride-capture/material-shader`）：冒烟 4 项（材质带着法线树和位移树、水面在动）；桌面在第 120 帧（1.999992 秒）截图，我们用新加的 `stride time --total` 把时钟拨到同一个时间再截，平均每通道差 0.36/255。
10. ~~CustomEffect~~（2026-11-19 完成，`apps/custom-effect`，端口 5216）：没有场景，合成器的根是游戏的 CustomEffectRenderer（SceneRendererBase）。
   - 先清成绿色，再用 SpriteBatch 画背景图和 Stride 的标志。
   - SpriteBatch 带着自定义效果（Effect.sdsl，继承 SpriteBase 重写 Shading）：从中心放出水波纹，按波扭曲 UV 再采样、按波调亮度，相位随时间变；混合是 NonPremultiplied。

   分步：
   1. ~~导入和骨架~~（2026-11-19）：`apps/custom-effect` 导入游戏设置（渲染器的属性 Background、Logo 是贴图）。
   2. ~~SpriteBatch 的自定义效果~~（2026-11-19）：`spriteEffect`（`rendering/text/SpriteEffect.ts`）：WGSL 着色函数（`sampleTexture0` 采样正在画的贴图，同 Stride 的 Texture0，取回贴图里存的值）、16 个参数、采样器（默认线性钳位，同 Stride 的 SpriteBatch）、混合（预乘或 NonPremultiplied）；`SpriteBatch.effect`。CustomEffectRenderer 和水波纹（`WaveEffect.ts`）写成 TS，宽高比每帧按画布算（Stride 只在初始化时取一次）。在 Chrome 里看过：标志和背景一圈圈扭曲。
   3. ~~冒烟和桌面比对~~（2026-11-19，`tools/stride-capture/custom-effect`）：冒烟 5 项；第 120 帧（2.000 秒）平均每通道差 0.64/255。比对时发现标志贴图透明区里透出两条横线（UASTC 把黑白相间的透明块的 alpha 压出了误差），导入器加了 alpha 渗色（见 architecture.md 的贴图）；剩下的差在字母边缘：Stride 的边缘有一圈暗边（源图透明区是黑的，Stride 不渗色），我们没有。
11. ~~MorphTargets~~（2026-11-19 完成，`apps/morph-targets`，端口 5218）：Stride master 新加的样例（4.4.2 没有，形变也只在 master 里）。三个模型：甜甜圈（有骨骼、四个形变目标，glTF 和 FBX 两份可以切换）、立方体和二十面球（只有形变，各四个目标），各自播放形变权重的动画剪辑。左上角是代码建的 UI 面板（SampleUI）：选模型的单选按钮、每个目标一个滑条（-1 到 2，零点有刻度）、重置、播放暂停、时间轴、glTF/FBX 切换，F1 隐藏面板。
   - Stride 这边的 API：ModelComponent 的 MorphTargetNames、FindMorphTarget、Get/SetMorphWeight、SetAllMorphWeights；.sdm3d 的 MorphTargetNames（目标改名）；动画剪辑里的形变权重曲线；ModelDeformationRenderer 在 GPU 上形变。

   分步：
   1. ~~原生~~（2026-11-19，0.27.0）：场景导入读形变目标（glTF 的 targets，名字取 extras.targetNames；FBX 的 blend channel，按控制点焊接；位置和法线增量烘焙进模型空间），glTF 的动画也能烘焙（STEP、LINEAR、CUBICSPLINE 按 30 帧每秒重采样），烘焙结果带每个目标的权重曲线（glTF 的 weights、FBX 的 DeformPercent）。管线读源场景统一走 `loadSourceScene`（.gltf 的外部 .bin 换成 data URI）。
   2. ~~管线~~（2026-11-19）：模型文件带稀疏的形变增量（`MeshMorph`，float，按顶点再按目标排，跟着顶点重排、拆切线）和模型的目标表（同名目标合成一个槽；.sdm3d 的 MorphTargetNames 只是编辑器的元数据，不用）；动画剪辑可以没有骨架，带按目标名的权重曲线。顺手：DataContract 起了短名的游戏脚本（`!MorphTargetsController`）也当脚本导入，glTF 没材质的网格认 Material 槽。
   3. ~~引擎~~（2026-11-19）：`ModelMorphs`（`game.animation.morphs(entity)`：morphTargetNames、findMorphTarget、get/setMorphWeight、setAllMorphWeights），权重每个模型实例一组、连成一个缓冲上传；顶点着色器按权重加增量（管线常量 MORPHED，没有形变的网格整段去掉），先形变后蒙皮；混合栈的形变部分 `MorphStack` 和骨架的轨道一起算，只有形变的模型由 `morphSystem` 推进。在 Chrome 里看过：立方体扭、二十面球随剪辑压扁、甜甜圈骨骼和形变一起动。和 Stride 不同：Stride 在计算着色器里形变（ModelDeformationRenderer），我们在顶点着色器里（每个通道都重算，模型小时更省事）。
   4. ~~UI~~（2026-11-19）：新控件 Slider（拖动取值、吸附刻度、ValueChanged；轨道前景按比例裁、刻度、悬停的滑块；只有水平的）、Border（四条边）；`ContentManager.removeModel`（换模型：去掉网格、子实体、骨架和形变权重）。SampleUI、MorphTargetsController 写成 TS（纯色小贴图用 `new Texture(..., { format: 'rgba8unorm' })`）。冒烟 10 项（三个剪辑在播、Pause/Play、选立方体后拖滑条到头、Reset、切到 FBX 留着权重和时间、F1）。
   5. ~~桌面比对~~（2026-11-19，`tools/stride-capture/morph-targets`）：桌面用本机编的 4.5.3-dev4（NuGet 缓存里的），第 58 帧（剪辑都在 0.967 秒）截图，我们把各剪辑拨到同一时间再截，平均每通道差 3.98/255；模型的形变一致，差都在左上角的面板上：Stride 的 UI 在透明阶段里画、跟着色调映射走，我们的 UI 画在后处理之后（decisions.md 里的取舍，按钮的纯色贴图 Stride 显示 88、我们 125），加上文字的栅格化。试过照 Stride 在后处理之前画 UI（平均差降到 1.27），没有采用：和那条取舍冲突，UI 的颜色会跟着场景的自动曝光变。帧时间：桌面 4.10 ms。
12. ~~FPS 的粒子和材质层~~（2026-11-19 完成）：FirstPersonShooter 在 P1 时跳过的部分。
   - 粒子：VFXPackage 的枪口火焰、弹孔用 SpawnerBurst（一次喷一批），受击拖尾用 SpawnerFromDistance（按移动距离生成），导入时现在警告后去掉。
   - 材质层：SamplesAssetPackage 的 LogoA、LogoD（FPS 里的箱子）有 Layers（子材质按 BlendMap 的遮罩混进来），现在只画底层。

   分步：
   1. ~~生成器~~（2026-11-19）：SpawnerBurst（每次活跃喷一批，Stride 的 NotifyStateSwitch 做成 `onStateSwitch`）、SpawnerFromDistance（按粒子系统移动的距离，生成器经 `SpawnTarget.systemTranslation` 拿位置），单测；FPS 冒烟加一项（三个特效的粒子都生出来）。顺手修掉：没有关键帧的曲线分量数按第一个关键帧取，颜色曲线成了 1 个分量、另外三个通道 NaN，受击拖尾画成大黑块；现在按采样器的类型定（Stride 的空曲线是 0）。
   2. ~~材质层~~（2026-11-19）：导入器把 Layers 导出成 `MaterialFile.layers`（遮罩和子材质的漫反射、镜面、金属度、光泽度、法线、自发光，都是颜色树；没写 BlendMap 是 Stride 的默认 ComputeTextureScalar，整层盖上），运行时编成 `layer{i}...` 函数，片元着色器里 `materialLayers`、`layerNormal`、`layerEmissive` 按遮罩逐层线性混合（Stride 的 MaterialStreamLinearBlend），没有层的材质这几个函数原样返回。在主 Chrome 里看过：FPS 的 BoxE（LogoD）红框里的青色面板发光。还没做：层的遮蔽、透明、UVScale 覆盖、层里再套层（记警告）。
   3. ~~比对~~（2026-11-19）：FPS 起始视角重截，平均差 2.70/255（之前 2.69，起始视角里没有带层的箱子、也没开枪）；BepuSample 其实没用材质层（之前记错了）。冒烟在第 1 步加过。
13. **CSharpBeginner**（`apps/csharp-beginner`，端口 5220）：Stride 的入门教程。主场景 MainScene 的 TutorialUI（UI 页面，按钮表从占位按钮复制出 15 个，点了把教程场景作为子场景加载、相机插值移过去，左上角回菜单）加 15 个教程场景，每个一个演示脚本（取实体、子实体、位置、属性、取组件、加组件、DeltaTime、克隆、移除、键盘、鼠标、虚拟按钮、插值、加载内容、实例化预制体），大多用 DebugText 打印。

   分步：
   1. ~~导入和骨架~~（2026-11-19）：导入主场景和 15 个教程场景；TutorialUI 写成 TS（按钮照占位按钮复制、加载子场景、相机 2 秒插值）。导入器补上：程序模型 Teapot、材质的贴图用到时才导入。
   2. ~~演示脚本和引擎能力~~（2026-11-19）：15 个演示脚本。引擎补上（细节见 docs/decisions.md 同日的条目）：`entity.clone()`（实体层的通用克隆）、`entity.scene`（运行时建的实体放进场景、随场景卸载）、虚拟按钮、`input.absoluteMousePosition`、C# 风格的数值文字（`formatFloat` 等）、`Quaternion.lerp`；调试文字改成按 CSS 像素和设计分辨率摆（高分屏上清楚，字跟着物体）。
   3. ~~冒烟和桌面比对~~（2026-11-19，`tools/stride-capture/csharp-beginner`）：冒烟 11 项（15 个教程都能进、键盘和虚拟按钮、克隆、代码加载、预制体、换一圈教程实体数不变）；截克隆、键盘、属性三个教程，物体的位置、大小、阴影一致，第一次比 UI 以下的场景平均每通道差 2.35、2.27、5.98/255（见第 4 步）。顺带：调试文字加 `visible`（同 Stride 默认只在开发版画）、`stride shot --diff` 加 `--region` 和每通道平均、`tools/stop-dev.ps1`。
   4. ~~箱子的光晕~~（2026-11-19）：逐个效果和桌面版比，找到并修掉三处（docs/decisions.md 的"贴图的颜色键和 1 位 alpha；泛光的权重"）：泛光的权重强了 4 倍、贴图的颜色键和 `Alpha: Mask` 没导入、比对时亮度适应没关。三张降到 1.44、1.24、1.55/255；别的有截图脚本的样例重比没有变差。
   - 回头补：P1 的七个样例（TPP、FPS、TopDownRPG 等）是修正泛光之前截的，没有 `capture-ours.ps1`，要各补一个脚本重截（预计也会降，它们和这里用的是同一套素材和合成器）。
14. **CSharpIntermediate**（`apps/csharp-intermediate`，端口 5222）：进阶教程。主场景 IntermediateTutorials 的 TutorialUI 有"开始"和"完成"两列按钮，点一个就把根场景换成那个教程的场景；11 个主题各有 Start-、Completed- 两个场景（场景加载另有 SceneB 和一个子场景），共 26 个，脚本 23 个。

   分步（按主题分组，每组先看 Stride 的脚本和我们缺什么）：
   1. ~~导入和骨架~~（2026-11-19）：26 个场景都导入了、在 Chrome 里都能进，TutorialUI 写成 TS（换根场景，`stride call tutorial`）。导入器补上：没有模型的 ModelComponent 不画（以前报错）、单独导入脚本用代码加载的资源（`--asset` 也认材质、预制体、声音等）。导入时跳过的组件：AudioListenerComponent、AudioEmitterComponent（第 3 步做）；UI 的渲染组 Group4 当 Group0 用。
   2. ~~界面和物理~~（2026-11-19，脚本写好、场景能进，按键的玩法留到第 5 步的冒烟里走）：01 UIByCode、UIByEditor；02 CollisionTriggerDemo、Teleport；03 RaycastDemo、RaycastPenetratingDemo（原生 0.28.0 的穿透射线，`simulation.rayCastPenetrating`）；04 ProjectDemo、UnprojectDemo（`worldToScreen`，`debugText.fromScreen`）；05 AsyncCollisionTriggerDemo、AsyncWebApi（fetch）。工具脚本 ObjectSpawner、OmniDirectionMovement。
   3. ~~场景、动画、声音~~（2026-11-19）：06 LoadScene、LoadChildScene（`game.loadScene` 的 `parent`、`offset`：子场景随父场景卸载）；07 AnimationBasics；08 AudioDemo、LoadMusic。引擎补上声音的发射器和听者（`AudioEmitterComponent`、`AudioListenerComponent`：按实体的位置空间化，指向性，HRTF 时的混响），场景里的同名组件导入成它们。
   4. ~~相机、角色、导航~~（2026-11-19）：09 FirstPersonCamera、CharacterMovement；10 ThirdPersonCamera（相机避障的射线，Stride 的脚本会穿墙，见 docs/decisions.md）；11 NavigateCharacter（寻路、沿路径走、拐点上放球）。引擎补上：`body.setOrientation`（原生 0.29.0，只改朝向、不打断位置的插值）、`entity.findChild`、`Quaternion.toEulerXYZ`。
   5. 冒烟和桌面比对：
      - ~~冒烟~~（2026-11-19）：22 项。22 个教程场景都能进，11 个主题完成版的玩法各走一遍（UI 的按钮和输入框、触发器、两种射线按层过滤、投影和点地面克隆、异步脚本换材质、子场景和换根场景、动画的淡入和暂停、音乐和发射器、两个相机的锁鼠标和转视角、导航），换一圈教程实体数不变。冒烟脚本共用的页面帮手放进了 `tools/smoke.ts`（`PAGE_HELPERS`）；别的样例的冒烟还各带一份自己的，回头换成共用的。
      - 桌面比对（`tools/stride-capture/csharp-intermediate`）：截图工程用官方 4.4.2 的包，去掉导航教程（它用的 Stride.BepuPhysics.Navigation 没有 4.4.2 的包）；截射线、投影、场景加载、声音四个教程的完成版。第一次比平均每通道差 26 到 67/255，查出材质导入的五处问题并修掉（docs/decisions.md 的"材质：着色模型、停用的特性、化不成固定槽的属性"）：没有镜面着色模型的材质不该有镜面反射（木地板成了镜面）、停用的特性照样导入了（激光发白光）、光泽度是运算时退成了 0、没给材质的程序模型没有材质槽（实体的覆盖用不上）、`findChild` 只找直接子实体（激光的长度没改）。现在投影 0.55、场景加载 0.66、声音 1.05、射线 1.71。
      - ~~玻璃材质~~（2026-11-19，`MaterialSpecularThinGlassModelFeature`，教程里绿色的箱子）：透明阶段分两遍画（透射乘到背景上、反射加上去），两面都画时四遍；背面的法线翻过来；没有漫反射着色模型的材质不算漫反射光照。射线那张从 2.11 降到 1.71。
      - ~~清漆材质~~（2026-11-19，`MaterialClearCoatFeature`，教程里蓝色的箱子）：两遍（金属碎片加底漆、清漆加在上面），输入都是颜色树。射线那张从 1.71 降到 1.00，蓝箱子各个面的平均颜色两边差不到 2/255。
15. **P2 收尾**（CSharpIntermediate 是 P2 清单里最后一个样例；这一项把 P2 里记下没做完的补齐，再测一遍验收数字）。分步：
   1. ~~重截 P1 的七个样例~~（2026-11-19）：各补了 `capture-ours.ps1`（共用 `tools/stride-capture/ours.ps1`），`capture-all.ps1` 一步跑完；按每通道平均差重记进"已完成"的表。除 TPP 的默认设置（1.84，后处理把贴图的小差放大了）外都在 1.1 以内。
   2. 样例里记着"P2 补"的：~~AnimatedModel 的 Idle、Run 按钮和 PhysicsSample 各场景的文字、按钮~~（2026-11-19：按钮绑到 UI 上，PhysicsSample 的三个脚本照 Stride 用代码建页面，调试命令去掉，冒烟改成点真的按钮）；~~Platformer2D 拿金币的音效；TopDownRPG 的粒子特效、音乐和音效~~（2026-11-19：金币、箱子、掉落金币的音效和 MusicScript 的背景音乐接上；粒子特效的预制体原来就在放，冒烟补了检查）；~~UIElementLink 场景里烟的粒子~~（2026-11-19：重新导入就有了，冒烟检查粒子在冒；截图比对时两边都去掉）。
   3. P2 清单里还没做的引擎能力，每项先看 Stride 怎么做、有没有样例用到（2026-11-19 查过 Stride 的全部样例）：
      - ~~点光和聚光的阴影~~（2026-11-20，CSharpIntermediate 的 SceneB 有一盏投阴影的点光）：点光是立方体的六个面、聚光一个透视视图，和级联共用一张图集（按矩形分配）；盏数和视图数不设上限。SceneB 和桌面比 1.23，阴影对得上。做法和取舍见 decisions.md 的"点光、聚光的阴影"。
      - MSAA（只有没移植的 VRSandbox 开了）、渲染组和渲染掩码（样例的合成器全是 All；UI 上写的 Group4、Group25 没有效果）：没有样例用到，挪到后面——MSAA 进 P4，渲染掩码进 P3（编辑器的辅助图形要用）。
      - ~~用代码建的动画剪辑（属性曲线）~~（2026-11-20）：`AnimationClip.fromCurves` 加 `propertyCurve(组件, 属性, 关键帧, 插值)`，`AnimationComponent` 照常播放和混合；没有模型的实体也能播，带骨架的模型能叠播只有曲线的剪辑。ParticlesSample 的 RotationScript 换回了 Stride 的写法。见 decisions.md 的"用代码建的动画剪辑"。
      - ~~触摸手势~~（2026-11-20，`input/gestures.ts`）：照 Stride.Input 的 Gestures 移植了点、长按、拖动、轻扫、双指组合五种识别器，`game.input.gestures` 加配置、`game.input.gestureEvents` 每帧给事件；SpaceEscape 换回手势的写法。见 decisions.md 的"手势识别"。TouchInputs 样例（专门演示手势）记进 P3 之后的样例清单。
      - 没有样例用到、挪走的：分簇（P4）；画进渲染目标贴图的相机的阴影和后处理（AnimatedModel 的那台相机本来就没开，P4）；透明物体的阴影（P4）；精灵的 Swizzle（样例的资源里全是 null）；精灵组件的九宫格边框（Stride 的边框只在 UI 的图片上起作用，UI 那边已经做了；Platformer2D 的精灵表没有边框，这一条划掉）。
      - ~~透明实例的排序~~（2026-11-20，`rendering/transparentOrder.ts`）：透明的实例逐个从远到近画，不同批的可以交错，同一批里连着的一次画完。见 decisions.md 的"透明实例逐个从远到近画"。
      - ~~RecastNavigationComponent 的排队寻路和沿路径走~~（2026-11-20）：`setTarget`、`startFollowingPath`，见 decisions.md。
      - ~~场景的偏移~~（2026-11-20）：场景在变换存储里占一个隐藏的根（`SceneRoot`），根实体挂在它下面，子场景的根挂在父场景的根下面；实体的本地位置不再带偏移，`scene.offset` 可以运行时改。见 decisions.md 的"场景的偏移在场景上"。
   4. UI 和文字：换行和富文本、世界空间的文字（MSDF）、~~文字的描边~~（2026-11-20：按到轮廓的距离画，粗细不限）、~~按键的路由事件~~（2026-11-20：发给 `game.ui.focusedElement`；两项见 decisions.md 的"文字的描边按到轮廓的距离画"）、~~还没用到的控件~~（2026-11-20：ToggleButton、ImageButton、ScrollingText、ContentPresenter，Stride 能写进页面的元素类型都有了，见 decisions.md 的"UI 控件补齐"）、~~输入框以外的无障碍树（影子 DOM：选中复制、读屏）~~（2026-11-20：`game.ui.semantics`，见 decisions.md 的"影子 DOM"；放在 3D 里的 UI 还不进）。剩下的：富文本（Stride 没有，挪到 P3 之后和编辑器的文字需求一起做）；世界空间的文字不另做 MSDF（字形本来就是按轮廓现算的，放进 3D 的 UI 里任何大小都清楚）；SVG 精灵按矢量画等 [vector-assets.md](vector-assets.md) 第一节的两个问题定下来（运行时用不用"画法树加条带"的模型）。
   5. ~~导入器里报"not supported"的逐条过一遍~~（2026-11-20）：把 20 个样例全部重新导入，收集警告（共 59 条，4 种）：
      - 材质层的环境光遮蔽（PhysicsSample 和公共素材包的 Logo 材质）：补上了，层的遮蔽和它对直射光的影响跟别的属性一样按遮罩混。
      - 游戏自己的渲染器引用渲染阶段（JumpyJet）：以前当成实体引用、报找不到；现在导出成阶段的名字。
      - ~~UI 的渲染组（Group4、Group25，27 条）~~（2026-11-20）：渲染组和渲染掩码做了模型、UI 和相机的掩码这一部分，见 decisions.md 的"渲染组和渲染掩码"；精灵、粒子、背景的渲染组在 P3 和编辑器的辅助图形一起补。
      - 粒子的自定义模块（ParticlesSample）：是提示不是缺失，游戏用 TS 登记同名的模块。
      - 没有样例触发的那些（代码里还报警告，P4 做材质和画面时逐个补，先有用到它的内容再做）：材质——曲面细分、非微表面的镜面模型、镜面颜色用贴图、透明的贴图色调和别的透明类型、正面剔除、标量用贴图、颜色树里两张贴图合成和少数运算、层的 UVScale 覆盖、层的 cavity、透明、位移和嵌套的层、清漆加透明；别的——根运动和非标准的动画资源类型、凸分解、精灵的 Swizzle、手动的阴影级联分割、导航网格的别的分区方式、UI 的列表值。
      - 导入的警告每次都要看：CSharpIntermediate 的木地板成了镜面，导入时其实报了警告。~~导入没有缓存，每次都重编贴图~~（2026-11-19：贴图编码的结果按内容哈希缓存在 `~/.stride-ts/cache/pipeline`，`packages/pipeline/src/cache.ts`；一张 2048 的法线贴图编成 KTX2 要两分钟，重新导入不再等）。
      - ~~比对时发现要查的：SceneB 的拱顶内侧两肩比桌面亮 12/255~~（2026-11-20：拱的缩放不等比，法线要用世界矩阵的逆转置变换，以前直接乘世界矩阵；改了以后这张从 1.23 降到 0.29）。
   6. 整理：~~各样例冒烟脚本里自带的页面帮手换成 `tools/smoke.ts` 的 `PAGE_HELPERS`~~（2026-11-20：等帧、合成指针事件、按名字找和点 UI 元素都用共用的，样例只留自己特有的；TPP 以前没有冒烟，补了一个：落地、跑、跳）；文档只留结论。
   7. ~~P2 的验收数字和全量回归~~（2026-11-20）：全部样例重截图、重测，桌面版的基准同一时段重跑（表在下面）。
      - 画面：和记录的数字一致（SpriteFonts 八屏完全相同，字形的新格式无损；SceneB 0.29）。csharp-beginner（1.38 到 1.59，原来 1.24 到 1.55）、morph-targets（4.16，原来 3.88）略升，A/B 过材质层的遮蔽和法线的逆转置（各关掉截一次），csharp-beginner 的三张数字都不变，不是它们；还没找到是哪次改动。
      - 帧时间：第一轮拿当天的数字去比各 README 里以前记的桌面数字，五个样例"超了"；其实桌面那边当天的数字也不一样（UIElementLink 以前记 1.24 ms，当天实测 4.42 ms）。同一时段重跑桌面基准以后再比才算数，以后每次验收都这样做。
      - 借这次查帧时间做的优化（各自有提交）：网格的着色器不再给每个像素算用不到的贴图、环境光、天空盒光和玻璃（SpaceEscape 1.40 → 1.06 ms），深度预通道之后只比较深度相等；没有后处理时直接画进后备缓冲、没有网格时不开深度预通道（JumpyJet 0.74 → 0.50 ms）。
      - 下载量：csharp-beginner、csharp-intermediate 的页面下载 21、22 MB，其中 15 MB 是公共素材包里木桌的一套 2K 贴图（两张颜色贴图是原样的 PNG，各 4 MB）。

### P2 收尾的验收（2026-11-20）

2026-11-20，RTX 3050 笔记本，没有降频；桌面 Stride 用各截图工程的 `--benchmark 1200`，我们用 `tools/measure.ps1`（preview 构建、无头 Chrome 不限帧率），两边同一时段测；下载量是页面实际请求的文件；第一帧是页面开始加载到第一帧画完。

| 样例 | 构建 | 下载（brotli） | 第一帧 | 桌面 Stride 帧时间 | stride-ts 帧时间（p95） | 比值 |
|---|---|---|---|---|---|---|
| animated-model | 4.3 s | 1.96 MB（0.83） | 1109 ms | 1.08 ms | 0.84 ms（1.31） | 0.78 |
| bepu-sample | 9.9 s | 5.96 MB（1.40） | 1202 ms | 9.26 ms | 4.98 ms（5.67） | 0.54 |
| csharp-beginner | 15.4 s | 21.38 MB（16.76） | 1528 ms | 5.48 ms | 5.06 ms（5.96） | 0.92 |
| csharp-intermediate | 17.6 s | 22.41 MB（17.67） | 1451 ms | 3.66 ms | 3.15 ms（3.96） | 0.86 |
| custom-effect | 5.6 s | 2.27 MB（0.84） | 1296 ms | 0.38 ms | 0.42 ms（0.69） | 1.12 |
| first-person-shooter | 8.2 s | 6.39 MB（3.17） | 1208 ms | 5.69 ms | 5.03 ms（5.83） | 0.88 |
| game-menu | 47.7 s | 3.91 MB（2.35） | 1046 ms | 0.59 ms | 0.52 ms（0.87） | 0.88 |
| jumpy-jet | 8.9 s | 7.08 MB（4.21） | 1498 ms | 0.72 ms | 0.50 ms（0.77） | 0.70 |
| material-shader | 5.7 s | 2.53 MB（1.09） | 1110 ms | 0.55 ms | 0.45 ms（0.69） | 0.83 |
| morph-targets | 6.8 s | 2.87 MB（0.80） | 1061 ms | 4.46 ms | 2.92 ms（4.02） | 0.66 |
| particles-sample | 10.0 s | 4.69 MB（3.13） | 1219 ms | 1.30 ms | 0.82 ms（1.29） | 0.63 |
| physics-sample | 7.3 s | 3.04 MB（0.78） | 1085 ms | 0.91 ms | 0.61 ms（1.05） | 0.67 |
| platformer | 8.2 s | 4.34 MB（1.16） | 1099 ms | 6.36 ms | 5.62 ms（6.42） | 0.88 |
| platformer2d | 6.0 s | 2.84 MB（0.64） | 1228 ms | 3.33 ms | 2.51 ms（3.10） | 0.75 |
| simple-audio | 7.2 s | 2.63 MB（1.01） | 1176 ms | 0.48 ms | 0.51 ms（0.84） | 1.07 |
| space-escape | 7.8 s | 5.77 MB（4.02） | 1187 ms | 1.13 ms | 0.94 ms（1.46） | 0.83 |
| sprite-fonts | 44.8 s | 5.74 MB（2.02） | 1153 ms | 0.42 ms | 0.45 ms（0.72） | 1.07 |
| topdown-rpg | 8.8 s | 7.50 MB（3.98） | 1379 ms | 5.68 ms | 5.67 ms（6.43） | 1.00 |
| ui-element-link | 14.9 s | 8.03 MB（6.34） | 1173 ms | 4.42 ms | 2.61 ms（3.56） | 0.59 |
| ui-particles | 7.5 s | 4.97 MB（3.39） | 1241 ms | 1.01 ms | 0.53 ms（0.81） | 0.52 |

20 个样例，帧时间是桌面 Stride 的 0.52 到 1.12 倍；超过 1 的：simple-audio 1.07、sprite-fonts 1.07、custom-effect 1.12。

**P2 完成（2026-11-20）。**

### P2 收尾的结论和遗留（2026-11-20，原在路线图的"进度"里）

~~**P2 收尾**~~（2026-11-20 完成，过程和验收表在 progress-log.md 的"P2 收尾"）：重截了 P1 的七个样例；补上样例里记着的遗留（按钮、音效、粒子）；引擎补上点光和聚光的阴影、用代码建的动画剪辑、手势、透明实例的排序、排队寻路、场景的偏移；UI 和文字补上剩下的控件、文字的描边、键盘事件、影子 DOM；导入警告清查（材质层的遮蔽、渲染阶段的引用）；法线改用逆转置；字形块的文件小一半；冒烟共用页面帮手、TPP 补上冒烟；帧时间的两处优化（网格着色器、没有后处理时直接输出）。
   - 验收：20 个样例的冒烟全过；帧时间是桌面 Stride 的 0.52 到 1.12 倍（同一时段测），17 个不慢于桌面，SimpleAudio、SpriteFonts、CustomEffect 这三个最轻的 2D 样例高 0.03 到 0.05 ms（都在每秒 2000 帧以上，我们这边剩下的时间主要是浏览器自己的帧循环）。
   - 没查完的：csharp-beginner、morph-targets 的截图差比以前的记录高 0.04 到 0.28。A/B 过两处（关掉材质层的遮蔽、法线换回直接乘世界矩阵），csharp-beginner 的三张数字都不变，不是它们；剩下要试的是点光和聚光的阴影、场景的偏移、重新导入后的内容。
   - 挪走的：MSAA、分簇、透明物体的阴影、画进渲染目标贴图的相机的阴影和后处理、没有样例触发的材质特性（P4）；精灵、粒子、背景的渲染组，调试渲染（P3）；富文本（P3 之后）；TouchInputs 样例（P3 之后）。
   - 等用户定的：SVG 精灵按矢量画（[vector-assets.md](vector-assets.md) 第一节的两个问题）；编辑器前端用什么框架（D10：新的重型依赖）。

## 几何表示的实验（2026-11-19，原在路线图的"进度"里）

**几何表示的实验**（用户 2026-11-19 要求：矢量化的几何先做实验再定；和第 14、15 项穿插着做，不等 P6）。设计和判定标准在 [vector-assets.md](vector-assets.md) 的"几何"一节，结果写回那份文档：
   1. ~~E1 存储~~（2026-11-19，`packages/pipeline/experiments/displacement-storage.ts`）：七个模型（含斯坦福的两个稠密扫描），"基础网格加位移微图"是同误差普通网格的 0.5 到 0.7 倍，稠密扫描上持平。没过三分之一的线。
   2. ~~E2 运行时~~（2026-11-19，`apps/bench` 的 `displacement.html`）：顶点着色器里现算位置和静态网格一样快（1.0 倍），显存小 14 到 16 倍；每个基础三角形各选一级、边上吸附到低的一级，没有裂缝。
   3. ~~E3 程序化位移~~（2026-11-19，`apps/bench` 的 `procedural.html`）：同样画面质量下和视差遮蔽一个档次的开销，多出真的轮廓和深度。~~E4 生成器~~（`packages/pipeline/experiments/sweep-generator.ts`）：一公里的路和护栏，描述 598 字节，生成 11 毫秒，同样的网格下载要 162 毫秒。
   4. 结论（vector-assets.md 的"结论"）：任意几何的默认表示仍是簇 LOD 的网格；位移用在材质图驱动的表面和地形，规则几何用生成器。**等用户确认这个分工**，连同那四个格式问题。

## P3 编辑器：和界面框架无关的部分（2026-11-20）

**P3 编辑器**（进行中；和前端框架无关的部分 2026-11-20 做完，界面等用户定框架，见第 4 小项）。等的时候做第 5 小项里的事：
   1. 运行时这边编辑器要用的：~~渲染组和渲染掩码~~（2026-11-20：模型、UI、相机、精灵、粒子、背景）；~~调试渲染~~（2026-11-20：`game.debugDraw` 画固定像素宽的抗锯齿线，盒子、球、胶囊、网格、坐标轴、视锥等形状，`simulation.showColliders` 显示碰撞体；见 decisions.md 的"调试渲染"。网格的线框模式还没做）；~~视口里选物体~~（2026-11-20：`game.pick(x, y)` 在 GPU 上画编号、读回一个像素，`stride pick`；只认网格，见 decisions.md 的"点选"）；~~编辑相机~~（2026-11-20：`EditorCameraState`、`EditorCameraController`，见 decisions.md 的"编辑相机"）；~~场景、预制体的保存~~（2026-11-20，改了做法：不从运行时的实体反推文件，场景文件本身是编辑器里的真相——`SceneDocument` 上做修改和撤销重做，`LiveScene` 让实体跟着文档，保存就是把文档写成 JSON；见 decisions.md 的"场景文档"）。这一步做完了；~~网格的线框~~（2026-11-20：`graphicsCompositor.wireframe`、`stride wireframe`，叠在主画面上）和~~精灵的点选~~（2026-11-20）也补了，没做的小项：粒子、场景里的 UI 的点选。
   2. ~~工程格式和 Node 后端~~（2026-11-20，`packages/editor`，说明在它的 README，取舍在 decisions.md 的"编辑器的后端"）：工程清单（可以没有）、资源数据库（引用关系和运行时预加载是同一份逻辑）、文件监视（用 Vite 的）、HTTP 接口加 HMR 通道的推送、`assets.gen.ts`（现在句柄只带种类）。后端是 Vite 插件，`strideApp` 带着，20 个样例的内容目录都扫过，没有解析不了的资源和悬空的引用。没做的：资源的改名、移动、删除（要改引用它的文件），源文件（glTF、PNG）的导入和导入设置，句柄里的结构类型（预制体的组件、模型的材质槽）。
   3. 前端骨架（等框架定下来）：场景树、属性面板（`prop` 的 schema 驱动）、撤销重做、Gizmo、资源浏览器、预制体、播放。和框架无关的先做：~~游戏页面的编辑状态和页面里的代理~~（2026-11-20：`?stride-edit`、`game.editing`、`game.editor`；界面在外面的页面里、把游戏页面嵌进去，试玩是重新打开页面，见 decisions.md 的"编辑器怎么带着游戏跑"）；~~Gizmo~~（2026-11-20：`TransformGizmo` 加代理里的视口操作，点选、拖把手移动、旋转、缩放，一次拖是撤销的一步）；~~属性面板要的字段描述~~（2026-11-20：`editor/fields.ts`，引擎的组件照文件格式的类型手写并在类型上核对，脚本的从 `prop` 换算，`checkEntity` 把 20 个样例的 99 个场景和预制体文件查过）。和框架无关的部分到这里做完了，剩下的是界面本身。
   4. 等用户定的（除了前端框架）：资源之间按路径引用还是按 id 引用。现在按内容路径，改名、移动要把引用它的文件一起改（数据库知道是哪些，模型文件里的引用是二进制的也要重写）；按 id 引用则改名不用动别的文件，但所有文件格式都要改、文件不再能一眼看出引用的是谁（docs/architecture.md 的"资源的强类型"当初设想的是 id 加重定向）。定之前不做改名和移动。
   5. 界面等用户期间接着做的（都不依赖框架）：第 1 小项的遗留（~~粒子、场景里的 UI 的点选~~，2026-11-20 做了，过程见下面的"粒子和 3D UI 的点选"）；预制体在场景文档里怎么表示（实例、覆盖、嵌套，docs/architecture.md 的"属性的分层合并"）先写方案；然后是 P4 的底座，它不依赖编辑器：~~各系统的预算和统计~~（2026-11-20：`game.metrics`、显存记账、`stride metrics`，每个样例的基线进回归，见 decisions.md 的"统计量和预算"）；~~管线的预热~~（2026-11-20：加载场景、预制体时模型的管线在后台编好再建实体，TPP 启动后的停顿从约 1.05 秒降到约 0.38 秒；后处理和背景的管线还是第一次用时当场建，等渲染图；见 decisions.md 的"管线的预热"）；~~渲染图的核心和后处理~~（2026-11-20：`rendering/graph/`，通道声明读写、裁掉没用的、临时贴图轮着用；后处理接上以后截图逐像素不变，中间贴图从 33.8 MB 降到 18 MB，见 decisions.md 的"渲染图"）。接着：主画面的各遍也接到图上；阴影图集按用到的大小建（现在固定 64 MB）。

资源的移动、删除（2026-11-20，用户定了按路径引用以后）：在 TPP 的内容上挪了一个材质（17 个模型的文件头改写）、整个 mannequinModel 文件夹（动画、骨架、模型、场景都改写）和天空盒，数据库里断掉的引用仍是 0；挪过去以后开游戏，截图和挪之前逐像素相同；再挪回来，内容目录 46 个文件的 SHA-1 和挪之前完全一样。第一次试时挪空的文件夹留在原处，改成跟着删掉。

编辑器界面的骨架（2026-11-20）：在 TPP 上打开 `/__stride/editor/`（主 Chrome），场景树列出 294 个实体，点选以后视口里出现操纵器、属性面板列出名字、变换、静态碰撞体的字段；在面板里改位置，视口跟着动，Ctrl+Z 撤销回到文件里的值（19.999996，逐位一样）；撤销以后 Ctrl+S 保存，场景文件和原来的 SHA-1 相同；经游戏页面里的代理改（操纵器走的路），面板跟着刷新；试玩、停止以后重新接上。主 Chrome 的窗口在后台时整个标签页的动画帧只有每秒一两帧，量帧率用无头 Chrome：编辑器里的游戏 60 帧。`stride open` 打开编辑器的地址时原来等的是编辑器页面自己（不是游戏），改成认同源的游戏页面。

场景树和资源浏览器的操作（同一天稍后，TPP）：加实体（选中了才能马上选中它：游戏页面里的实体是异步建的，代理只认建好了的，第一版加完选不上，改成等同步完再选）、加 Model 组件并填模型路径（输入框列出 19 个模型）、挪到 Wall_East 下面、删掉、撤销三次，文档和磁盘上的文件逐字相同；在编辑器里挪一个材质（改写 17 个模型）、把场景所在的文件夹整个挪走（场景和天空盒改写，编辑器在新路径重新打开场景，278 个实体），再都挪回来，内容目录的 SHA-1 和挪之前一样，没留下空文件夹。主 Chrome 的标签在后台时页面加载慢，刚打开就点场景树会点在加载中的骨架上。verify44 有一项 topdown-rpg 的"拾取掉落的金币"失败（金币停稳的判断和瞬移之间的时序），单独重跑通过。

预制体实例（同一天，格式照 prefabs.md）：加载器展开实例；第一版把实例做成容器（预制体的根挂在实例下面），转 Stride 的场景时多出一层父实体，改成实例就是预制体的根。导入器把 Stride 的实例转成引用，转完再展开一遍和原来展开着的场景逐个实体比：TPP 的 134 个实例全部转成引用（8 个带覆盖），场景文件 194 → 101 KB，编辑状态的截图和转之前逐像素相同（294 个实体）。全部样例重新导入时有 6 个场景照旧展开着（CSharpIntermediate 的 5 个、FPS 的主场景）：成员的 `Base` 指着预制体里已经删掉的实体，改成这样的成员当普通实体以后都转了。

编辑器里改实例（同一天）：在 TPP 上关掉一个 Pillar 实例的 isShadowCaster，实例的 `prefab.set` 多一条覆盖；再打开，这条覆盖去掉——第一次试时留下了 `isShadowCaster: true`（预制体里没写，默认是开），改成属性面板把可选字段设回默认值时写成不写。在 TopDownRPG 上选中 LootBox 实例的成员 CollisionWall，改名字和碰撞层，覆盖按它在预制体里的 id 记下，游戏页面里的实体跟着改名；删掉它记进 `removed`，游戏里的实体没了，撤销回来。场景树里实例后面标着预制体名，成员是斜体。单独打开预制体（同一天）：在 TPP 的编辑器里打开 Pillar0x5x0，视口里只有这根柱子（预览的灯照着，相机对准它）；把材质换成 GridMTPlatform，回到场景时先保存，场景里 7 个实例都换了材质；再改回去保存，预制体和场景文件的 SHA-1 和改之前一样。

屏幕空间反射（同一天）：BepuSample 里四步都跑通，但地面太粗糙看不出效果；在 TPP 上开（最大粗糙度临时 0.6），调试视图（`stride ssr --debug reflection`）满是黑点——时间累积被邻域夹成 0，加了空间上复用邻居的光线以后平滑了。暂停后开关各截一张，差平均每通道约 1/255，放大 12 倍的差异图里地面靠墙处、角色身上和脚下有平滑的变化，没有噪声和块状瑕疵。

接触阴影和运动模糊的画面（换机器以后，TPP，无头 Chrome 1280x720）：
- **接触阴影**：暂停后开关各截一张，第一版在掠射的面上（房子的侧墙）满是规则的网点——光线从表面出发、贴着表面走，深度缓冲按像素取样的量化让表面"挡住"了自己。改成：用深度重建法线，背光的面不算；起点沿法线抬起到相机距离的 0.2%；挡住要比光线上的点靠前至少 0.05%（线性深度比）、不超过厚度。改完差异只剩角色鞋底和地面的接触处、身上的褶缝、台阶和屋檐的边，平均差 1.37 → 0.04、差超过 8 的像素 2.9 万 → 600 个；侧墙放大看和关着时一样。
- **运动模糊**：暂停后单步，开关的差只在播待机动画的角色身上，背景不变。转相机（页面里每帧发横向的鼠标移动）时背景沿转动方向糊开，跟着相机的角色清楚、轮廓不把背景带进来；轮廓上有一圈很细的颗粒（采样抖动），不明显，先不管。

屏幕空间全局光照（同一天，TPP，无头 Chrome 1280x720）：开关各截一张，开着时台阶底下、台阶和墙的交界、房子的墙角多了柔和的遮蔽，台阶下的墙被旁边的粉墙照得偏暖；整体平均差约 -0.3 到 -1.4（被挡住的主要是偏蓝的天空光）。SSGI 一共约 0.2 ms。调试时先后是全黑（WGSL 保留字 `from`）、几秒后整片黑（边上的法线 NaN 经过累积和模糊扩散）、环境光几乎全没（视图 uniform 写早了，着色器把间接光的 r 当成了遮蔽），见 decisions.md。

屏幕空间次表面散射（同一天，TPP，无头 Chrome 1280x720）：`stride sss on --entity MannequinModel` 给角色的六个材质都加上皮肤散射，开着时身上的明暗过渡变柔，背景不变；把宽度加到 0.08 时头盔的高光糊成了十字（第一版和 Stride 一样把整个颜色一起糊），改成只糊漫反射光以后高光清楚、身上照样柔和。关掉时和改动前比只有角色（在播待机动画）那块有差。两遍模糊约 0.06 ms。透射：透光度调到 0.97 时角色背光一侧薄的地方（手臂、腿的边）透出偏红的光，红通道平均 +0.06，别的通道几乎不变；没有着色器报错。

PCSS（同一天，TPP，无头 Chrome 1280x720，暂停后单步）：太阳的角直径 0.53° 时和 PCF 5x5 差不多（半影本来就不到两三个阴影图像素）；3° 时身体的影子边缘略软；15° 时脚下的影子硬、躯干的影子很软，接触硬化看得出来，16 个采样有颗粒。第一次跑时着色器编译失败：WGSL 里 `filter` 是保留字。GPU 的不透明通道 0.084 → 0.124 ms。

反射探针（同一天，TPP，无头 Chrome 1280x720）：`stride call probe '{"at":"0,1.5,0","size":40}'` 放一个 40 m 的盒子，六帧后拍好、着色时用上（整体略亮，地面粗糙看不出细节）；用 `eval` 把地面材质临时改成粗糙度 0.05 的金属，开着探针时地面映出墙、窗、楼梯和房子，方向对、没有左右反；关掉时只有天空盒的颜色。倒影和实物有些错位，是盒子没对上真的墙（视差校正按盒子算）。`everyFrame` 时拍一个面的两遍约 0.01 ms，不透明通道 0.085 → 0.09 ms。

物理天空（同一天，TPP，无头 Chrome 1280x720，`stride call sky`）：30° 时阳光偏暖、天顶偏蓝；3° 时地平线橙色、场景暗下来偏蓝；70° 时和原来接近。第一版墙上的窗口外是黑的：视线朝下打到星球表面，天空视图表里只算了大气，加上被照亮的地面以后窗外是灰褐色的地面。第一次加载失败：`AtmosphereRenderFeature` 和 `Atmosphere` 在一个文件里，RenderSystem 引用它、它又在模块加载时继承 RenderSystem 的基类，循环引用，拆成两个文件。重算的开销：只算天空视图约 0.47 ms，连环境光（立方体、球谐、预滤波）约 1.34 ms，所以分成两档。

空气透视（同一天，`stride call sky '{"aerial":300}'`）：第一版地面上一圈圈的环，改成每列沿视线走一遍以后还在——关掉空气透视也有，只在受光面上、太阳 70° 时没有，原来是太阳 20° 时的阴影痤疮；先后怀疑过天空立方体的 mip（逐点求值 → 改成 4x4 平均）、镜面贴图太小（64 → 128，按级给采样数），这两处也是真问题顺带改了，最后加按坡度的深度偏移环才没了。距离放大 300 倍时远处的地面和墙蒙上平滑的蓝灰；整帧 GPU 0.404 → 0.424 ms（合成那遍没单独计时）。

日夜循环和夜空（同一天，TPP，无头 Chrome 1280x720，`stride call sky '{"moon":true,"time":20.5}'`）：20:30 太阳在地平线下，颜色是 0、从光照里拿掉了，投阴影的换成了月亮；星星、银河、月亮周围的光晕都出来了，亮的星星带上了后处理的光芒。月亮放大到 8° 看：凸月（月相 0.65）看得到月海和明暗交界线，蛾眉月（0.06）亮边朝着落下去的太阳、背光面有淡淡的地球反照、星星被月面挡住。17:51（太阳 1.8° 高）地平线一片红、没有星星；18:27（地平线下 5.5°）西边还有暮光、星星出来了。第一版背光面太亮（地球反照是固定的 0.4%）、亮面过曝看不出月海，改成反照跟着月相、`moonDiskIntensity` 默认从 4 降到 1。天空里一圈圈的环是 8 位输出的量化色带（相邻带的像素值只差 1），不是查找表的问题。着色器改了以后热更新不会重编（要重新加载页面）。

体积云（同一天，TPP，无头 Chrome 1280x720，`stride call clouds '{"on":true}'`）：正午是一朵一朵灰白的积云，远处的沉到地平线、淡进天空的颜色；日落逆光时云身是暗紫色、边上一圈发亮的橙色；月夜的云被月光照成蓝灰，后面是星星。过程里改的：第一版覆盖 0.5 时头顶几乎没云（阈值的范围取窄了）；云是灰棕色的（多次散射的能量不够，云底的环境光用了地面反上来的颜色）；云面上有抖动的点状纹理（云里的步子太大），改成进了云换小步以后，稀薄的云里步数不够、出现透出天空的缝，步数上限放到两倍；64³ 的噪声在小块的云上看得出纹素，换成 128³ 并分 8 帧生成。

云的影子（同一天，TPP）：真实大小的云在几十米的场地上看不出影子的图案，验证时把云缩成玩具大小（`stride call clouds '{"scale":0.002,"bottom":20,"thickness":12,"density":200}'`）：地面和墙上是一块块的暗影，隔 5 秒的两张截图里影子跟着风挪了位置。中间走了两次弯路，都是测试参数的问题不是代码的：第一次云只有 40 米厚、光学厚度小，影子本来就淡；第二次云块有几十米大，整个场地落在同一块里。把影子图画进一张小贴图读回来（一半是 0.06、一半是 1）才确认图是对的。

环境光里的云（同一天，TPP，`stride call clouds '{"on":true,"coverage":0.9}'`）：晴天有清楚的影子、背光面偏蓝；覆盖 0.9 时整个场景光线均匀柔和、角色的影子几乎没了，环境光从偏蓝的 (0.05, 0.09, 0.19) 变成灰白的 (0.42, 0.40, 0.41)；覆盖 0.4 时又有影子，环境光是蓝灰色。关掉云以后环境光回到晴天的值。帧时间没变（8.33 ms，99 分位 8.5）。

体积雾（同一天，TPP，`stride call fog '{"on":true,"density":0.06}'`，太阳压到 18°）：朝着太阳看，雾里一团亮光，房子在雾里投出一块暗的楔形、墙的影子也在；横着看时阴影里的雾更暗。天空部分的渐变是平滑的，没有体素的格子；阴影里的雾在对比度拉大四倍时看得出一点斑驳。和物理天空、云一起开也正常。

天气状态（同一天，TPP，物理天空、体积云开着，`stride call weather '{"on":true,"preset":"rain","instant":true}'`）：晴天有清楚的影子；雨天整片灰白、影子几乎没了、下着雨；雾天远处的墙淡成灰色；雪天一开始一片雪都看不见——`stride particles` 显示 7 万多片雪活着、全在下风 30 米外（3 米每秒的风，雪 10 秒才落到相机的高度），把雨雪的体积往上风挪以后正常。过渡：时间常数 10 秒，5 秒时云量从 0.9 走到 0.58。帧时间 8.33 ms 不变，更新 0.41 ms。

湿的表面和积雪（同一天，TPP，物理天空和体积云开着，`stride call weather` 的 rain、snow）：雪天屋顶、楼梯的踏面、地面积了雪，竖着的墙没有；原来角色脚下有一块方的没积雪（天空遮挡把角色当成了遮挡物），蒙皮的网格不进天空遮挡以后没了。雨天第一次整帧是黑的：湿地面对着太阳的高光超过 float16 的上限，泛光摊成 NaN，网格着色器的输出限在 60000 以内后正常；接着雨点一生成就死：网格的视图绑定组带上天空遮挡的深度图以后，画天空遮挡那一遍也绑了它（正当着深度附件），画阴影投射者时改用不带它的绑定组以后正常。墙、屋顶淋湿后明显变暗；TPP 的地面是半金属的（metalness 0.5），湿了几乎不变，阴天下本来就看不出地砖的纹理（同一帧干、湿比，地面平均只差 1.3/255）。帧时间 8.33 ms 不变，不透明的画 0.106 ms，天空遮挡的那一遍量不出来。

贴花（同一天，TPP，`stride call decal`，贴图是命令里程序生成的）：一个 3x1x3 米的橙色圆环贴在地上，边缘按 alpha 干净地切开；换成纯色加圆凸起的法线贴图，凸起的明暗朝向对（贴图的右边朝 +X、上边朝 -Z）；16x16 个铺满地面，远处的 mip 正常、没有图集里的串色。不透明的那一遍：没有贴花 0.086 ms，一个 0.091 ms，256 个 1.252 ms（每个像素看所有贴花，下一步分簇）；帧时间都是 8.33 ms。这台机器每个着色阶段能绑 48 张贴图，图集仍然只占一个绑定（默认上限 16）。

分簇（同一天，TPP，`stride call lights '{"count":16}'` 摆 256 个彩色点光，`stride call decal '{"on":true,"count":16}'` 摆 256 个贴花）：开、关分簇（`stride call clusters`）各截一张图逐像素比，只有角色和它的影子不同（待机动画在动），墙、地面、所有的光和贴花都一样。不透明的那一遍：不分簇 4.393 ms，分簇 0.29 ms，分簇的计算 0.059 ms；场景里没有光和贴花时 0.09 ms（不分簇、不算）。帧时间都是 8.33 ms（120 Hz 的垂直同步）。

光泽和各向异性（同一天，TPP，按默认上限开的页面，`stride call lights '{"count":3}'` 摆三个点光）：`stride call material '{"name":"GridMTx10","anisotropy":[0.8,0]}'` 地面的点光高光拉成长条，转 90° 以后条换了方向；`stride call material '{"name":"Wall","sheen":[1,1,1,0.4]}'` 墙在掠射角上亮一层（房子的侧面、远处的墙）。控制台没有着色器的报错。不透明的那一遍 0.145 ms，满屏的地面各向异性 0.163 ms，墙上光泽 0.146 ms。

渲染目标贴图的相机（同一天，TPP，用 `stride eval` 加一个槽位 1 的相机，画进 640x360 的贴图挂在精灵上，`textureCameras` 里开泛光和色调映射）：第一次贴图里没有方向光的阴影——TPP 的方向光是最大的档位，主视图的四个级联（2048²）占满了 4096² 的图集，这个相机的级联放不下被丢掉（Stride 也是这样）；改成放不下时一起缩一半以后，两个视图各四个级联、都是 1024²，贴图里有角色脚下的影子。阴影那一遍 0.089 → 0.085 ms，帧时间 8.33 ms 不变。

GPU 粒子按深度表面碰撞（同一天，TPP，无头 Chrome）：一开始火星的脚本在页面里报"entity 已声明"——`stride eval` 的作用域里有页面帮手 `entity()`，脚本里的变量换个名字。雨：`stride call weather` 下雨 3 秒后读回粒子缓冲，活着的 41894 个里 4768 个撞过（Particle.bounces），4405 个速度朝上（正在溅起）；GPU 粒子那一遍 0.015 ms。火星（主视图的深度）：3296 个里 1056 个撞过，画面里落在地上散开；飞出画面的 1425 个掉到地面以下（主视图的深度只有看得见的表面）。

水洼（同一天，TPP）：第一版在任何积水量下整片地面都是浅色，看不出水洼。按 0、0.01、1 三档量地面同一行的亮度：0.01 时就从 132 跳到 196，说明不是水洼的大小问题。查出是积雪那一行：积雪 0 时朝上的面也算出 0.9 的雪（见 decisions.md），以前下雨的地面发白也是它。修了以后三档是 132、132、131（水洼在远处），暴雨下地面是湿的深色。

GPU 粒子的力场（同一天，ParticlesSample）：样例里用力场的 Smoke 发射器这时候没在生成（两边都是 0 个），改成自己建：同一个文件建 CPU、GPU 各一个，读回 GPU 的粒子缓冲、读 CPU 的粒子池，统计到中心的平均水平距离、平均和最大高度、绕轴转的方向。四种形状两边一致（圆柱 1.81/1.82、1.32/1.31、4.47/4.53、-0.94/-0.94）。

GPU 粒子的预热和排序（同一天，ParticlesSample）：预热 2 秒、往上 1 米每秒的发射器 CPU、GPU 各一个，两边 1512、1516 个，平均高度 1.5、1.51 米。排序：先写了 JS 的模拟（照着色器的块内、全局两种派发）放进单测，第一版模拟的循环 `jj /= 2` 在 JS 里到 0.5 不停（着色器的 u32 到 0 就停），改成 `jj >= 1`。页面里 20 万个按深度排序的粒子读回排好的键全部有序；改之前没量过耗时，用 git stash 临时退回旧的排序量了一次：GPU 粒子那一遍 0.466 ms，新的 0.34 ms，不排序 0.061 ms。

顺带发现场景树单击选不中（vue-tsx-pro 的拖动工具按下就捕获指针，click 落在树的根上），在 vue-tsx-pro 里修了，随 0.30.0 发布；升级以后在 TPP 的编辑器里真点场景树选中了 Wall_South，拖动换父实体也照常（撤销回去）。

回归里遇到的两件事：
- space-escape 的冒烟"往右划换道"偶尔失败：关卡是随机生成的，等滑铲放完的那两三秒里角色可能撞上障碍物。脚本改成先把已经生成的障碍物挪走。
- 2D 样例进编辑状态时画面是空的：编辑相机没照场景相机的正交投影，接手位姿时第一帧还没跑、世界矩阵还没算过（相机落在原点，精灵全在近平面以内）。两处都改了，Platformer2D 的冒烟加了精灵的点选。

复制、粘贴实体（2026-11-20，p3-editor 分支，无头 Chrome 1400x900 上的 TPP 编辑器，页面里发 Ctrl+键）：Ctrl+D 复制 Wall_South 下的 Wall0x2x5Window (3)（带一个预制体实例子实体），文档 278 → 280 个实体，复制的排在原来的后面，实例还是引用（`prefab.path`），游戏页面里的实体 294 → 296；复制一个墙的实例，Ctrl+Shift+V 粘贴成刚复制的那个的子实体，再 Ctrl+V 粘贴成兄弟紧跟在后面；撤销、重做各一步；焦点在输入框里时 Ctrl+V 不粘贴实体。粘贴出来的实体选中了但场景树没展开到它，加了"选中变了就展开祖先"。TPP 的预制体都只有一个实体（没有成员），拷成员、粘贴到成员下面报错只在单测里测。验证时没保存（内容目录联接着主检出）。

加脚本组件（同一天，同样在 TPP 的编辑器里）：Wall_North 上从"添加组件"选 ThirdPersonCamera，场景文档里多了 `{ type: 'game/camera/ThirdPersonCamera#ThirdPersonCamera', props: {} }`，面板照脚本的 9 个属性画（没写的淡色显示默认值），改 defaultDistance 写进 props；墙的实例上加 PlayerInput 记成实例 `prefab.set` 里整个脚本列表的覆盖，Ctrl+Z 撤回。第一版的列表里混着引擎自己登记的 AudioEmitterComponent、UIComponent 这些（场景组件的实现），改成只列游戏模块里的。看截图时发现属性面板一长，场景树、视口跟着整排一起滚（分栏里套的分栏按内容定高），套着的分栏改成绝对定位铺满那一栏，各栏自己滚。

多选一起改（同一天，TPP 编辑器，经 CDP 发真的鼠标、键盘事件）：场景树单击、Ctrl+单击、Shift+单击、Ctrl+单击去掉一个，选中的依次是 [North]、[West]、[West, North]、North 到 GridBase10x10 (9) 的一段 5 个、去掉 Ramp 剩 4 个。选中四面墙：名字、位置的 x 和 z、旋转显示"多个值"，y = 0、缩放 1 照常显示，静态碰撞体是共有的组件；往位置 y 的框里打 2 回车，四面墙的 y 都是 2，Ctrl+Z 一步全部回到 0；旋转的 x 打 10，南北墙（朝向 90°）和东西墙（0°）各自保留朝向、都俯仰 10°；加 Model 组件四个都有、一步撤回。单选时改位置、旋转照旧。第一版窄的数字框里"多个值"显示不下，改成"—"、悬停提示"多个值"。

粒子和 3D UI 的点选（2026-11-20，scene-picking 分支，无头 Chrome 1280x720，`stride pick`）：
- **粒子**（particles-sample）：点火、烟返回 Big Fire、Burning Fire，喷泉的白点返回 Simple Fountain，白点之间的空隙点空、点到后面的台子。
- **3D UI**（ui-element-link 的倾斜场景，暂停后点）：角上的面板、按钮返回 UI 的实体，按钮前面的球、跟着的骑士、烟各自返回自己的实体，页面中间透明的地方点空。全屏场景里点按钮返回它后面的球，点角上的面板点空。
- **编辑器**（无头 Chrome 1600x900，在视口的画布上派发真的鼠标事件）：particles-sample 里点选 Big Fire、Burning Fire、Simple Fountain，选中框是包围形状；Lasers 场景里点中飘带 Lightning Arc White，没有包围形状的拖尾按活着的粒子画出了框。simple-audio 的全屏 UI 点不到；在编辑器里把它改成放在 3D 里（不保存）以后点它选中 UIText，框是 Size 那块板。这时发现选中框和操纵器被 3D UI 盖住（调试线在 UI 之前画），改成调试线在 UI 之后画（同调试文字）。
- 样例里放在 3D 里的 UI 都是脚本运行时建的页面（ui-element-link），编辑状态不挂脚本，所以编辑器里看不到也点不到它们；animated-model 按代码加载根场景，编辑器打不开它。这两件都和点选无关，没改。

往实例的成员下面加实体（同一天，TopDownRPG 的编辑器，内容目录在工作树里换成拷贝再保存）：选中 CoinGold 实例的成员 Point light，工具条的"加实体"加出 UnderTorchLight（场景文件里父实体是 `<实例>/<成员>`，排在实例后面），再把一个 Box3x1x1 实例 Ctrl+Shift+V 粘贴到它下面、位置设成 (0, 1, 0)，视口里箱子出现在火把上方；保存、重新打开编辑器，层级原样；试玩时游戏里的层级是 Box3x1x1 → UnderTorchLight → Point light → CoinGold。主检出的场景文件没动。

富文本的运行时（2026-11-20，scene-picking 分支，无头 Chrome 1280x720，SpriteFonts 的第九屏）：截图里粗体、斜体用样例自带的字体，粗斜体合成，删除线、行内代码（颜色和底色）、橙色、放大缩小、下划线、两层列表、链接都对。第一版两处不对：文字没居中（Canvas 不管子元素的对齐，样例换成 Grid）；代码的底色是实心白（UI 的颜色是预乘 alpha 的，默认值写成了不预乘的，Markdown 里写的颜色也改成画的时候预乘）。在画布上发真的指针事件点"next screen""previous screen"换到第 0、第 7 屏，点链接以外的文字照常暂停、继续；影子 DOM 里两个链接是 `role=link`，Enter 也换屏。这些都写进了 SpriteFonts 的冒烟。

操纵器的吸附（同一天）：无头 Chrome 里经 CDP 拖 TPP 的柱子：吸附开着（步长 0.5）拖 X 轴到 6.5，开着按住 Ctrl 到 6.33，关着按住 Ctrl 吸到步长上。再在用户的主 Chrome 里用插件真拖：第一次怎么拖都没反应——标签页在后台只有 4 fps，按下、拖动、松开都在一帧里，按下的位置用的是这一帧最后的鼠标位置，点不到把手；改成用按下事件的位置以后，工具条上把步长输成 0.1、打开吸附，拖 Z 轴，柱子的 z 从 -7 到 -6.7，Ctrl+Z 撤回；关掉吸附同样拖到 -6.6886。游戏页面重新加载以后吸附设置还在。

脚本的 requires（同一天）：单测覆盖加载时缺组件跳过、要的脚本排在后面也行、子类接基类、场景组件反查键。在用户的主 Chrome 里开 PhysicsSample 的编辑器：给 Ground 从"添加组件"加 GuiScript，UI 组件一起加上，Ctrl+Z 一步全撤回、重做又都回来；再去掉 UI，工具条上提示"GuiScript 要它，试玩时这些脚本不挂"。没保存。

反射探针和物理天空在编辑器里（同一天，用户的主 Chrome，TPP，内容目录先 protect 再保存）：建一个空实体、从"添加组件"加 Reflection probe，选中时视口里画出探针的盒子（亮青）和过渡距离（外面一圈淡青）；F 聚焦原来按"没有模型就是一个点"贴到跟前，改成把探针的盒子算进包围盒。属性面板把 size 的 x 打成 20，盒子马上变宽、游戏里的组件同步；保存、重新打开还在，试玩时探针在。再给它加 SkyAtmosphere，把方向光的俯仰从 -70 改成 -8：天空变成日落的橙色、影子拉长。这时发现探针盒子里的地面一大块很亮——探针是中午拍的，灯光变了它不重拍；改成编辑状态下文档每变一次就让探针重拍（`EditAgent.sync`），再试亮斑没了。

场景自己的设置（同一天，用户的主 Chrome，TPP，内容目录先 protect）：不选实体时属性面板显示 Physics、Compositor。点后处理的 ×（设成 null），视口马上变成没有色调映射的过曝画面，游戏里 `postEffects.enabled` 是 false；Ctrl+Z 回来。给后处理"添加" ambientOcclusion，游戏里 GTAO 开了；"添加设置"加 Offset、y 打 3，整个场景抬高 3 米；撤销三步，文档和游戏都回到原样。重力改成 -20、保存、试玩，`simulation.settings.gravity` 是 [0, -20, 0]。第一版里没写的 ambientOcclusion 把里面的字段画成红色的"必填没设"，改成先显示"添加"按钮。

日夜循环和夜空在编辑器里（同一天，用户的主 Chrome，TPP，没保存）：新建实体 Sky，"添加组件"选 Day-night cycle，Sky atmosphere 一起加上（组件之间的依赖，`COMPONENT_FIELDS` 的 requires）；天空的 sun 下拉选 Directional light，timeOfDay 打 17.3：太阳低、光偏暖、影子拉长，方向光的朝向由日夜循环驱动（文档里的旋转不变）；18.6 点太阳落山、没设月亮，画面全黑。去掉 Sky atmosphere 时工具条提示 Day-night cycle 要它。

这一轮收尾（同一天）：EditAgent 拆出视口的操作（`EditorViewport.ts`）和选中框的几何（`worldBoxes.ts`），编辑器的 `client/` 并到 `src` 根上（用户定了文件夹要扁平，只有几个文件的不单独成文件夹）；拆完用 `tools/editor-accept` 在 platformer、topdown-rpg 上复跑。回归里 simple-audio、csharp-intermediate 的声音两条一度失败，是 `regress.ps1` 拼 Chrome 参数时 `--autoplay-policy` 没传进去（ce30ce2 修了），不是机器的声音设备；修后重跑都过。没做完的清单在 roadmap.md"进度"的 P3 那一条。

### P3 编辑器的验收：用编辑器打开、改、保存、试玩 P1、P2 的样例（2026-11-20）

做法：每个样例的内容目录在验证工作树里临时换成拷贝（保存只写拷贝，主检出不动，验完换回联接），开发服务器 +1000 端口，无头 Chrome 1400x900 开编辑器，脚本经 CDP 操作会话：打开根场景，逐个实体选中让属性面板画一遍（看控制台有没有错），不改就保存（文件应逐字节不变），再改（根下第一个带模型的实体上移 1、改名，加子实体、给它加游戏的第一个脚本，复制粘贴这个实体，撤销到底再重做到底），保存、检查文件，重新打开、检查改动还在，依次打开资源里的其他场景各画一遍属性面板，最后试玩、检查游戏里有加的实体。另外在 Node 里用 `checkEntity` 照字段描述查了所有样例的全部场景和预制体文件（20 个样例、3000 多个实体），0 个问题。

| 样例 | 场景 | 结果 |
|---|---|---|
| platformer（TPP） | 1 | 通过（278 个实体逐个画面板；粘贴 Wall_North 带 17 个子实体） |
| animated-model | 1 | 第一次打不开：入口用 `loadScene` 加的场景不是根场景，编辑器不知道开哪个文件；改成 `setRootScene`（同 Stride 的默认场景）后通过。试玩时有它原来就有的警告：导入的 UIScript 的 `font` 属性 TS 脚本里没有 |
| physics-sample | 3 | 第一次试玩起不来：加的 AutoResetRigidbody 的必填属性 triggerEntity 没设，整个场景加载失败；修了（见 decisions.md），现在这个脚本报错跳过、游戏照常，面板上标红、保存时提示 |
| bepu-sample | 8 | 通过 |
| platformer2d | 1 | 同 physics-sample（CoinRotation 的 sprite），修后通过 |
| topdown-rpg | 7 | 通过（另外手动试了往实例成员下面加实体，见上） |
| first-person-shooter | 1 | 通过 |
| game-menu | 2 | 通过 |
| ui-element-link、ui-particles | 3、1 | 通过（ui-particles 加的脚本要求实体上有 UIComponent，试玩时脚本自己报错，属于测试的用法） |
| simple-audio、morph-targets | 1、1 | 通过（同上：加的脚本缺它要的声音、模型，脚本自己报错，游戏照常） |
| particles-sample | 7 | 通过 |
| jumpy-jet、space-escape、material-shader | 1、2、1 | 通过 |
| csharp-beginner | 17 | 通过（同上，加的脚本要 UIComponent） |
| csharp-intermediate | 26 | 通过（同上，加的脚本要 AnimationComponent） |
| sprite-fonts、custom-effect | 0 | 场景是代码建的，没有场景文件，编辑器打不开（视口上显示原因）；要编辑得先把场景做成文件 |

验收里顺带看到的：新起的开发服务器第一次开编辑器要预构建依赖，页面起来要一分钟左右；每个样例"不改就保存"都逐字节不变。

GPU 粒子（2026-11-20，scene-picking 分支，无头 Chrome 1280x720）：particles-sample 的 MainScene 里 `game.particles.simulation = 'gpu'` 以后，火、篝火、大火的烟（按深度排序）、喷泉六个发射器到了 GPU 上，单独的烟和碰撞的那组留在 CPU 上（力场、碰撞没有 GPU 版）；截图和切换前看不出差别，点选点到大火。运行时加一个 20 万粒子的发射器对比 CPU 和 GPU（数字见 decisions.md）。第一版的管线是同步编的，冒烟的统计量超了预算，改成后台编；点选那条后台编时第一次点不到，改回当场编。这些写进了 particles-sample 的冒烟。

风场和雨雪（2026-11-20，无头 Chrome 1280x720，particles-sample 的 MainScene，代码里建 Precipitation 和 WindZone）：第一次建内部发射器是在系统遍历时建实体，报错停了，改成遍历时只记下、遍历完再建。雨下起来以后风吹向 +X 看着没斜，一查是相机正对 +X、风顺着视线；改成沿相机右边吹，雨往右斜。雪第一版是方块（没有贴图的四边形是实心的），加了运行时生成的软圆点贴图。截图看过雨、雪、风吹斜，量了耗时（见 decisions.md）。

天空遮挡（同一天，TPP，无头 Chrome 1280x720）：遮挡第一版叫 PrecipitationOcclusion、挂在雨雪上，主会话要求名字取宽（以后湿润、积水积雪也查它）、按阴影投射者筛选、按纹素吸附、没人用不画、画质档位能关，改成 `renderSystem.skyOcclusion`。在角色旁边用代码搭一块悬空的板当屋檐，下雨：从截图看不清板子正下方（被板子挡着，地上的深色是太阳投的影子，不在正下方），所以给 GPU 发射器加了调试用的读回（`GpuEmitter.read`），数板子下面和旁边活着的雨点：0 和 27。

GPU 粒子的间接绘制（同一天，particles-sample，无头 Chrome 1280x720）：先只做了间接绘制，容量 50 万、每秒 5000 个时主画面不再随容量变，但粒子的计算通道还是 0.102 ms（一次派发跑满容量），于是派发也只跑最近"最长寿命"秒生成的那段环（寿命正好到期的粒子要在窗口里判死，窗口多留两帧）。改完 0.007 ms；不排序、按深度、按新旧三种排序各截图看过，画面和改之前一样，控制台没有报错。

### P3 编辑器的验收：用编辑器从零搭一个小游戏（C1，2026-11-20 到 11-21）

`apps/collect-dodge`（端口 5224）。缺什么补什么，每步在 Chrome 里用编辑器走一遍，结论在 decisions.md：

| 步 | 做了什么 | 看过、测过 |
| --- | --- | --- |
| 1 | JSON 写的 `.model`（基本形状，运行时生成网格） | 立方体、球、地面在视口里 |
| 2 | 新建工程的模板 `stride-editor new` | 模板场景（相机、太阳、天空、1000 m 的地面）、冒烟 |
| 3 | 资源浏览器的新建、做成预制体、导入声音和图片、资源热重载、属性面板编辑材质和模型、导入 glTF/FBX/OBJ（原生 0.33、0.34） | 改材质颜色视口跟着变；BoomBox.glb 0.6 秒导入 |
| 4 | 玩法脚本：PlayerController、FollowCamera、Coin、MovingObstacle、Door、Goal、GameRules；导入字体（Open Sans） | 无头 Chrome 里按键、瞬移走完一局 |
| 5 | 用编辑器的接口搭关卡（材质 6 个、模型 8 个、21 个实体、金币的预制体、体积云和天气）；冒烟加玩法检查 | 冒烟 8 项连过三遍；编辑器里打开、选中金币看属性面板 |

搭的时候发现、修掉的：大气、云、雾的光照单位（暗了 π 倍，阴影全黑）；角色不能设速度（原生 0.35）；睡着时挂起的接触醒来后不报结束、触发器失灵（原生 0.36）；触发器的取法七处重复（`simulation.trigger`）；手柄没有"刚按下"；字体单测一直跳过。主 Chrome 的标签页这次只有 1～4 fps（窗口被挡着时 Chrome 节流），试玩和冒烟在无头 Chrome 里跑，编辑器的界面在主 Chrome 里看。

## P4 底座（2026-11-20 起）

1. **统计量和预算**：`game.metrics`（`debug/Metrics.ts`）、显存和管线的记账（`graphics/GpuMemory.ts`，套在设备的 create* 上）、`stride metrics`；`tools/smoke.ts` 的 `finish()` 把冒烟跑完时的统计量和 `tools/budgets.json` 的基线比。基线记的时候的数（1280x720）：贴图 5.6 MB（CustomEffect）到 185 MB（CSharpBeginner），TPP 126 MB；当场建的管线 4 到 94 条（CSharpIntermediate 最多）。
   - 第一次记基线是直接在主检出跑回归，同时我还在改主检出的代码，开发服务器热更新到改了一半的状态，几个样例失败。之后记基线都走验证工作树（`STRIDE_UPDATE_BUDGETS=1 pwsh tools/verify.ps1`），跑完把 `tools/budgets.json` 拷回来。
2. **管线的预热**：`MeshRenderFeature.warm` 用 `createRenderPipelineAsync`，`SceneBuilder.preload` 的最后调（`ContentManager.pipelineWarmer`）。
   - 第一版在建实体之后等编译：等的那几帧里新旧两个场景的实体同时存在，ParticlesSample 换场景时旧脚本把新脚本登记的调试命令注销了。改成建实体之前等。
   - TPP（开发服务器、无头 Chrome，各三次）：启动后第 4 帧的停顿 1.02 到 1.07 秒 → 0.37 到 0.40 秒；加载内容 0.43 到 0.52 秒 → 0.96 到 1.10 秒。剩下的是后处理 12 条、背景 1 条和加载时一次性的计算（DFG 表、天空盒预滤波、mip 生成）。
3. **渲染图**：`rendering/graph/RenderGraph.ts`、`GraphTexturePool.ts`；后处理的各效果改成往图里加通道。
   - 显存按标签分（`graphicsDevice.memory.groups()`，TPP 改之前）：阴影图集 64 MB、主画面 10.5 MB、后处理的中间贴图合计 33.8 MB（亮部 8.8、FXAA 7、光芒 6.2、镜头光晕 5.3、模糊 4、缩放 1.8……）。
   - 改之后（编辑状态、等画面稳定）：TPP、FirstPersonShooter 的截图和改之前逐像素相同；后处理的中间贴图 18 MB，贴图总量 118.9 → 103.1 MB、122.2 → 106.4 MB。
   - 前向渲染器的一帧也接上以后：TPP 一帧 27 个通道、24 张临时贴图占 15 张真的；TPP、FirstPersonShooter、AnimatedModel、SpaceEscape 的截图逐像素相同，贴图总量不变（HDR 颜色缓冲从单独留着变成池里的）。
   - TAA（2026-11-20）：TPP 上和 FXAA 比，桌子、阴影的边平滑得多；第一版只按深度重投影，跑动的角色身上的条纹拖成两道，加了运动向量以后清楚了。
4. **阴影图集按用到的大小建**：TPP、FirstPersonShooter 用的是四个 xlarge 的级联，图集照旧 4096²、截图逐像素相同；BepuSample 的图集 64 → 16 MB（贴图总量 119.8 → 55.9 MB），CSharpBeginner 184.8 → 111.3 MB。预算的基线跟着重记。
5. **画质档位**（TPP，1280x720，编辑状态，无头 Chrome）：

   | 档位 | GPU 每帧（不限帧率） | 阴影 | 不透明 | 贴图总量 | 通道 | 和极高的截图差（平均 / 最大） |
   |---|---|---|---|---|---|---|
   | 极高 | 5.07 ms | 1.09 | 1.55 | 108.1 MB | 27 | 0 / 0 |
   | 高 | 4.5 | 0.48 | 1.56 | 57.7 | 27 | 0.46 / 64 |
   | 中 | 3.1 | 0.32 | 1.43 | 36.4 | 13 | 2.46 / 91 |
   | 低 | 2.6 | 0.21 | 1.38 | 33.6 | 7 | 7.45 / 133 |

   - 按 60 帧跑的时候 GPU 的频率跟着负载变，同一档前后量出来差到 1.6 倍（6.5 和 10.3 ms），档位之间没法比；不限帧率（`--disable-frame-rate-limit --disable-gpu-vsync`）时两轮之间差不到 1%。
   - 第一轮高档的贴图没有变少，查出图集缩小的判断看的是"占到哪"（级联排成一行），改成在一半大的图集里试排；同时查出 `stride perf` 里阴影和主画面的耗时记在"ToneMap"名下。

## 创作线 F 组（2026-11-21 起）

### F4 离线渲染和成片导出（2026-11-21）

在 RX 9070 GRE 上、主 Chrome 里（窗口被挡住），collect-dodge 的开场过场 Intro（6 秒，180 帧）：

| 出片 | 子帧 | 渲染耗时 | 文件 |
|---|---|---|---|
| 横屏 1920x1080，试玩页面 | 8 | 5.7 秒 | 3.6 MB，H.264 High + AAC-LC 48 kHz 立体声 |
| 竖屏 1080x1920，试玩页面 | 8 | 6.2 秒 | 2.6 MB |
| 横屏，编辑器页面（看不见的试玩 iframe） | 4 | 4.9 秒 | 3.6 MB |
| 方形 1080x1080，MCP 工具 | 4 | 4.5 秒 | 2.1 MB |
| PNG 序列 1280x720，30 帧 | 4 | 7.2 秒（PNG 编码占大头） | 每张约 400 KB |

- ffprobe 读出 180 帧、30 fps、时长 6.0 秒，音频 282 块；ffmpeg 整个解码没有报错；音量峰值 −16 dB（开门声）。抽帧看：相机绕场时墙和硬币有真的运动模糊、边缘干净，字幕在；编辑器出的和试玩页面出的第一帧一样。
- 第一版跟着 requestAnimationFrame 走，窗口被挡住时降到每秒一帧，5 分钟没出完（CLI 的 HTTP 请求先超时了）；改成接管帧循环以后如上。编辑器里第一次出片第一帧没有天空光、没有 UI、相机不对（新开的页面一帧都没跑过），加了 30 帧预热。

### S2 SDF 建模（2026-11-21）

- StrideNative 0.39：原生测试（单位球的体积差 3% 以内、法线朝外；两个挨着的球平滑并起来比硬并的体积大；六种形状和三种运算都能建；大小是 0、没有加的形状、格子太多都报错）和 Node 测试过；第一次写的"融合更大"的用例两个球离得太远（中间空 0.6 米，0.8 的融合带在正中间只拉近 0.2，没连上），挪近了。
- 编辑器里：资源浏览器"新建 → SDF 模型"建出 `NewBlob` 和它的模型，路径框改成 `Level/Mushroom` 两个一起挪；属性面板显示形状列表（种类下拉、融合宽度、三个半径都有中文）；改成蘑菇（圆角圆柱的柄、椭球的脚和伞盖、挖空的伞盖底、五个白点）放进场景；在属性面板上点"融合宽度"的 + 三下，文件存下、模型重烘、视口热重载。近看伞盖光滑、脚和柄融成一体。
- 烘焙耗时（Node，蘑菇 9 个形状）：精度 0.05 米 88 毫秒、0.03 米 293 毫秒、0.02 米 869 毫秒；简化前 0.03 米的模型 183 KB，简化后 12 KB。

### S2 序列帧烘焙（2026-11-21）

- greybox 的喷泉：`stride call bake`（4×4 帧、每格 256、2.5 秒）0.49 秒；编辑器粒子窗口的"烘成序列帧"16 帧 1024² 0.58 秒（模拟、32 次绘制、读回两张浮点图、合成、编 png、存），图集 126 KB；旁边加的实体一个粒子放出喷泉的样子。
- 第一次放出来看不见：贴图引用没写 `encoding: 'png'`，按 KTX2 找；补上以后能看见但是灰的——粒子叠起来最亮 14.8，截到 1 存了。改成除以最亮的、组件颜色乘回去，放出来和原来一样亮。
- 单元测试：黑底白底合成（普通混合、加法、超过 1、空的）和放序列帧的组件。

### 编辑器的布局照 JetBrains IDE 重排（2026-11-21）

- 主 Chrome 里看 greybox：主工具条、两侧竖条、文档页签、视口工具条、状态栏都在；选中喷泉点"粒子编辑器"，下边出来粒子窗口、竖条上多一个粒子图标；"+"菜单加"风"模块、文档页签带上 •、撤销；竖条收起场景、资源、属性，视口占满。全程在游戏页面上放的标记没丢（视口没有重新加载）。第一版换布局时开粒子编辑器视口重开了一次（分栏的结构变了），改成分栏一直在、折叠那一栏。
- 顺手修的：打开资源后的状态写死了中文（"打开了 …"），换成翻译表里的。
- 滚动条换成 vue-tsx-pro 的 ScrollArea 以后，页面上查不到原生的滚动区域（可滚动、overflow 是 auto/scroll、滚动条没藏起来的元素一个都没有）。

### 编辑器的部件换成 vue-tsx-pro、加载的骨架屏（2026-11-21）

- 库里新加并发版：CurveField、GradientField（0.32.0）、Workbench（0.33.0）；Diagram 的有名字的端口和贝塞尔连线、Splitter 的命中区修复、能拖动平移的画布滚轮改成缩放（0.34.0）。编辑器删掉自己写的 ToolWindow、layout、CurveEditor，节点图面板改画在 Diagram 上。
- 主 Chrome 里看 greybox：粒子面板拖曲线的点、渐变的色标，场景文件跟着改、一次拖动撤销一步；Workbench 的竖条开关、下边窗口跟着节点图、粒子自动出来，视口的 iframe 不重载。节点图：27 个端口、14 条连线都是曲线没箭头；从"颜色"的输出拖到"乘"的 B，文件里 b 换成 mortar 的 color；拖节点、按 Delete 删节点（10 → 9，连到它的线一起去掉），验完把材质文件还原。滚轮缩放（0.49 → 0.90）、拖空白处平移、光标是小手；视口的左、右、下三条分隔条都拖得动（之前点到的是分隔条所在的格，拖不动）。
- 属性面板换成库的 PropertyGrid（0.35.0）：主 Chrome 里看 greybox，场景设置、Ball 的名字、位置、旋转（欧拉角）、缩放、模型（资源路径）、材质列表的“添加”都对；Ball 和 Sky 一起选，名字、位置显示“多个值”和“—”，改缩放 X 为 2 两个都变（视口里球拉宽）、撤销回来；材质的字段、节点图卡片里的参数（卡片高度正好装下）、粒子编辑器的发射器和模块的字段都照常。
- 骨架屏：重新加载编辑器，场景树、文档页签、属性面板、视口（不透明的底加扫光，盖住游戏页面的启动日志）在游戏页面起来前是骨架，起来后换成内容；资源列表读得快，Tree 的防闪烁不画骨架。

### 精灵表编辑器（2026-11-21）

- 主 Chrome 里 platformer2d（导入的内容验完还原）：到处搜打开 knight_sheet，属性面板是精灵表的字段，底部出现精灵表面板：左边 80 个精灵，右边骑士图上画着各个框。滚轮缩放（第一次在框上滚不动：平移的过滤把按在框上的滚轮也挡了，改成只挡按下）；点一个框选中（knight_run_1，40、40、16、20），拖右下的把手到 40、40、35、30；"自动切"切出 80 个紧贴的框（比如 9、9、13、19），20 毫秒，视口里的骑士照常画。新建一个精灵表，填 coin 的贴图"从这张贴图开始"，自动切出 12 帧硬币。
- 单测：按格子数、格子大小、偏移间隔切，跳过透明格子；自动切的 8 邻接、合并重叠、去噪点和排序；MCP 的 `slice_sprites`（导入 PNG、自动切两块、按网格切替换、精灵表不存在时建）。

### CI 的两个时序问题（2026-11-21）

- collect-dodge 的开场过场在 CI 上两次没放完（游戏时间走完 6 秒超过页面帮手的墙钟上限）：冒烟看过放着的样子就跳到快放完（ddf3bbc）。
- csharp-intermediate 的声音一项在 CI 上两次是 Stopped 不是 Paused：背景音乐只有 17 秒左右，软件渲染上先调音量、声像再按空格暂停时音乐已经放完。改成放起来马上暂停、再调音量和声像；本机 `regress.ps1 -Slow 300`（每帧多忙等 300 毫秒）复现 CI 的慢帧跑过。

### 编辑器验收接进回归（2026-11-21）

- 先单独跑 `tools/editor-accept/run.ps1 -Apps platformer,greybox`：两个都过（这几天的编辑器改动没弄坏验收）。
- `pwsh tools/regress.ps1 -Apps greybox -Editor`：冒烟五项过了以后"ok 编辑器验收：1 个场景"，共 71 秒；报告里不改就保存逐字节不变、改名加子实体粘贴撤销重做、保存重开、试玩都对，截图（`~/.stride-ts/regress/greybox/editor-accept/`）里是改过的场景；跑完内容目录还原（git 里没有改动）。
- `node tools/affected.ts <base> --editor`：改了编辑器时打印 platformer,greybox，不然是空的。

### 预制体句柄的结构类型（2026-11-21）

- 重新生成全部样例的 assets.gen.ts：有预制体的（bepu-sample、csharp-intermediate、first-person-shooter、platformer……）带上结构，`pnpm typecheck` 全过（第一次 csharp-intermediate 报"接口没用到"：同名兄弟、没名字的实体也写了接口，改成只写够得着的）。
- 主 Chrome 里 collect-dodge 的游戏页面：`content.load(assetRef('prefab', 'Prefabs/Coin')).spawn(...)` 的 `roots.Coin.scripts.Coin` 是 Coin 脚本、挂在根实体上，挪到玩家前面画面上看得见；spawn、销毁 100 次 7.4 毫秒。
- 单测：运行时 spawn 按名字取根、子实体和脚本（Stride 的类型名取类名）；类型检查（types.check.ts）写错子实体、脚本的名字编译失败；生成器的输出（import type、ScriptComponent、嵌套实例、同名和没名字的）。

### 贴图的导入设置（2026-11-21）

- 主 Chrome 里 bepu-sample：到处搜找到 GithubNicogo（二维码贴图，没有导入设置），属性面板显示默认的导入设置（源文件 png、压缩 none、mipmap、最大尺寸 0、sRGB）。打开 Constraint 场景、对准一个二维码方块；经编辑器接口把压缩改成 uastc：写出 KTX2，四个 QRMat 材质的编码改成 ktx2，视口热重载后画面一样；再改成 etc1s，页面请求的是 GithubNicogo.ktx2、画面照常；改回 none，KTX2 删掉，材质和改之前逐字节一样（验完删掉导入设置）。
- 后端的单测：拖进来的 PNG 带默认设置；压成 KTX2（文件头对）时材质和贴图资源的编码改成 ktx2；改回 none 删掉 KTX2、编码改回 png。

### 源模型的导入设置（2026-11-21）

- 编辑器的接口导入 three.js 的 Soldier.glb 到 greybox（验完删掉）：`Imported/Soldier.glb`（源文件）、`Soldier.import.json`（默认设置）、模型、两个材质、骨架、四个动画剪辑，0.78 秒。场景里加一个用它的实体，主 Chrome 里是绑定姿势的士兵；到处搜里找到这个模型，属性面板显示它的导入设置（源文件、缩放、材质、动画剪辑、采样率）；缩放改成 2，后端重新导入，视口里的士兵变成两倍大、蒙皮没走样；放 Run 动画，跑步的姿势也对（骨架、动画的平移跟着缩放）。经接口改设置重新导入三次：536、419、402 毫秒。
- 缩放框一开始显示 2.0001：字段的下限 0.0001 和步长 0.01 对不齐（数字框按下限加整数个步长取整），改成下限、步长都是 0.001。
- 后端的单测：导入后有设置文件和源文件；改了设置模型重写、改过的材质不动；缩放写 0 报错；挪模型时设置和源文件一起挪。

### 吸附到顶点（2026-11-21）

- 主 Chrome 里 greybox：选 Crate，打开吸附到顶点，从移动操纵器的平面把手拖到圆柱顶上松开：箱子的一个底角落在圆柱顶的边上（位置 2.5、3.5、−3.1）。
- 第一次试时箱子停在半路（−1.3、0.5、−8）：松开时最后一次点选还没回来就结束了拖。改成松开时再点选一次、回来再结束。第二次试时落在圆柱脚下的地板上：点选报的是 Room，而圆柱在 Room 的另一个网格（ModelPart 子实体）上，只找了第一个网格的顶点。改成连子实体的网格一起找。
- 耗时见 decisions.md。

### 到处搜（2026-11-21）

- 主 Chrome 里 greybox：焦点在视口里按 Ctrl+K，命令面板出来；输入 mush，列出场景里的实体 Mushroom 和资源 MushroomCap、MushroomSpots……（材质、模型、SDF），回车选中了 Mushroom（属性面板换成它）；连按两下 Shift 也打开，输入"吸附"列出两个开关，回车后工具条上的吸附按钮从关变开、面板关上；再执行一次关回去。

### 多选时数值的相对改（2026-11-21）

- vue-tsx-pro 0.36：NumberField 认 `+=`、`-=`、`*=`、`/=`（也认全角和 ×、÷），按当前值算，再夹到范围、对齐步长；`onRelative` 交出算法；PropertyGrid 的数字、向量、颜色的 alpha 把它变成按原来的值算的修改。库里补了解析、精确运算（Decimal、bigint）、NumberField、PropertyGrid 的单测，文档加了"相对的输入"的示例；输入类示例的 axe 检查（亮、暗）通过。
- 主 Chrome 里 greybox（本地包）：Crate、Ball 一起选，位置 X 输入 `+=1` 回车：Ball 1.5 → 2.5，Crate −1.5 → −0.5；Crate 的旋转 Y 先设 20，再两个一起输入 `+=15`：Ball 是 15，Crate 是 35。

### 预制体删了成员后挂着的实体有提示（2026-11-21）

- 父实体不在了挂哪是一条规则 `availableParent`（引擎 `content/prefabInstances.ts`）：加载场景（`SceneBuilder` 的 `parentOf`）和编辑器的场景树都用它。原来场景树把这种实体放在最上层，游戏里却挂在最近的实例下面。
- 主 Chrome 里 collect-dodge：临时把场景文件里 Rules 的父实体改成 `<Coin1 的 id>/gone`（验完还原）。场景树里 Rules 挂在 Coin1 下面，名字前一个黄色的警告标记；选中它，属性面板最上面是"挂着的 Coin1/gone 不在了（预制体删了这个成员？），先放在最近的实例下面；拖到要放的地方"。把它拖到别的实体下面，标记和提示都没了。

### 多选时旋转按角显示"多个值"（2026-11-21）

- 原来多选时几个实体的值按四元数逐个分量并，一个角不同四个分量都不同，三个角都显示"多个值"。改成照字段类型并（编辑器 `values.ts` 的 `mergeField`）：旋转换成欧拉角再逐个角并（`MixedRotation`），对象、列表、几种之一往里照类型走，组件里的旋转（碰撞体形状的）也按角。
- 主 Chrome 里 greybox：Crate 的旋转设成 10、20、0，Ball 设成 10、50、0，两个一起选：旋转显示 10、—、0；把 X 改成 30，单独看 Ball 是 30、50、0，Crate 是 30、20、0。
- 耗时：选中 1000 个实体时实体字段并一次 1.48 毫秒（原来 1.02），属性面板每画一次多不到半毫秒。

### 复制的实体进系统剪贴板（2026-11-21）

- 主 Chrome 里开两个编辑器：greybox（5228）和 collect-dodge（5224）。greybox 的视口里点蘑菇，Ctrl+C：iframe 里的 copy 事件写进剪贴板的是 `{"format": "stride-ts/entities", ...}`；切到 collect-dodge 的标签页，Ctrl+V：paste 事件读到同一段文字，场景树里多了 Mushroom，文档标成改过。
- 第一次粘贴时蘑菇的模型（greybox 的 Level/Mushroom）这边没有：同步失败、没选中粘贴出来的实体，控制台报未处理的异常——于是改了 LiveScene 的同步（见 decisions.md）。改完重新粘贴：控制台只有一条"left out model"的警告，游戏页面里的 Mushroom 实体在（24 个实体）；撤销、Ctrl+Y 重做，实体跟着删了又建，没有异常。
- 单元测试：剪贴板的文字写出去读回来不变，别的文字、别的 JSON 不认，字段不对时报出哪里；LiveScene 的测试改成"资源加载不了时那个组件先不建，同一次的别的修改照样跟上，路径改对以后加上"。

### 按值推字段的 record 种类（2026-11-21）

- 主 Chrome 里开 bepu-sample 的编辑器，资源浏览器里双击 Scenes/Constraint 打开（双击能开场景，之前怀疑的问题没复现）；选 Stiff Pendulum：约束 0 的设置画成 localOffsetA、localOffsetB 两个向量和 springFrequency、springDampingRatio 两个数，约束 1（ballSocketMotor）是它自己的四项；springFrequency 点加号 3 → 3.1，撤销按钮亮了，撤销回 3。
- custom-effect 的编辑器（没有场景）：属性面板里游戏设置的根渲染器是类型加属性，属性里 background、logo 两个资源字段照旧。
- `node tools/editor-accept/check-fields.ts` 查所有样例的场景文件：0 个问题。

### 子场景在编辑器里一起看（2026-11-21）

- 重新导入 topdown-rpg：DynamicScene 的 `children` 是五个分块。主 Chrome 里开编辑器、打开 DynamicScene：场景树里实体下面列着五个子场景，各有一个眼睛；点中央、东边两块，视口里出现两块地面，东边的在 x −30 到 −10、中央的在 −10 到 10，接在一起（实体多了 18 个）；再点东边的眼睛，那 9 个实体卸掉；双击中央那块，文档页签换成 CentralChunk，参考场景清空。
- 顺手：场景树源文件里文档节点的键是一个裸的 NUL 字符开头（文件被当成二进制，grep、编辑工具都不认），换成 `\0` 转义（值不变）。

### 吸附到表面（2026-11-21）

- 主 Chrome 里开 greybox 的编辑器：视口工具条点"吸附到表面"，选中箱子，拖移动操纵器的 XZ 面片：落到斜坡上时位置的 y 是 1.32（斜坡那里的表面 0.82 加原点到底面的 0.5），再拖到地板上 y 是 0.500138（地板 0 加 0.5），箱子贴着地面。第一版点选全落空：深度贴图不能只拷一个像素（WebGPU 要整张），改成计算着色器读。
- 点选读表面：箱子正面读回 z = 3.0（箱子 1 米宽、中心在 2.5），没有校验错误；一次两帧约 17 毫秒；一直点选时 CPU 每帧多约 0.24 毫秒，GPU 在误差里。greybox 的冒烟加了一条：地板、平台顶上的点投到画面上再点，读回的点在原处。

### 编辑器的视口按需出帧（2026-11-21）

- 主 Chrome 里开 greybox 的编辑器：静止 5 秒 `game.frames` 不变（以前 600 帧）；鼠标在视口上挪一下出了 91 帧、停下后又不动，画面一直是最后一帧；视口工具条点"实时"后 2 秒 240 帧，再点回来又停；静止时 `stride wait --game 3` 照样等到 3 秒游戏时间（调试命令跑着时一直出帧）。

### C3 没有场景的游戏在编辑器里打开（2026-11-21）

- 主 Chrome 里开 custom-effect 的编辑器：以前卡在"正在打开游戏"之后报错（找不到根场景），现在视口照常画波纹，场景树说这个游戏没有场景，属性面板是游戏设置：名字、默认场景（"设置"）、根渲染器的属性 background、logo（贴图）、设计分辨率 1280×720。logo 改成背景的贴图、回车：视口里标志没了、只剩背景；经接口改回来：存 33 毫秒，52 毫秒时新的根渲染器已经换上，属性面板跟着显示改回的路径。
- 单测：按值推字段（资源、实体、数、开关、文字、向量、对象、JSON），游戏设置的字段照文件检查没有问题；编辑器的中文字段表补了新字段。

### S2 轻量多边形编辑（2026-11-21）

- greybox 加了一个多边形网格的箱子（`Level/Crate.poly.json`，经编辑器后端新建，场景里的实体 Crate）。主 Chrome 里：选中 Crate，模型组件上点"编辑多边形"，工具条换成点、边、面和各个操作，状态栏说怎么用；点箱子的顶面选中（橙色）、操纵器在它中间；"挤出"0.25 以后 10 个面、12 个顶点，着色的模型跟着变高；拖操纵器的 Y 轴把顶面拉到 1.41，松开后文件里是它、模型跟着变；撤销回到 0.75；按 2 换到边、点一条竖边，倒角在这个角上做不了（四个面相交），状态栏说明原因。
- 第一次拖完没存：拖的过程中每帧的网格已经写进了界面的状态，松开时和它比没有变化；改成和上一次存的比。点面也点不中：耳切给的是面里的下标，没换成顶点的下标。都补了单测（`engine/test/polyEditTool.test.ts`）。
- 耗时：存文件加烘模型 20–60 毫秒；编辑模式下脚本每帧 0.28 毫秒（关掉时 0.22），帧 8.33 毫秒（垂直同步）。

### S2 粒子编辑器（2026-11-21）

- greybox 里经 MCP 加了一个粒子系统（喷泉），在编辑器里点属性面板的"粒子编辑器"：数量 20 改 80、加重力模块（y 改成 −1）、拖大小曲线的峰、把渐变的第一个色标改成蓝色，每一步场景文件里都对，`stride particles` 看活着的粒子数跟着变（80 个每秒、约 160 个活着）。第一次面板改了不重画：面板读文档内容时没有依赖文档的版本号，补上。
- 耗时（主 Chrome，RX 9070 GRE）：一帧 8.3 毫秒（垂直同步），更新 0.42、绘制 1.05 毫秒，GPU 0.36 毫秒。

### S2 在模型上画贴图（2026-11-21）

- `apps/greybox` 里加了一个 UV 球（Ball，9216 个三角形）和材质 `Level/Materials/Painted`。编辑器里：选中 Ball、选中材质、"加绘制层"（1024² 的黑遮罩）、颜色改红、"画"，在视口里拖一笔，球上出现红色的笔画；勾"擦除"再拖一笔擦掉一道。100 下笔刷（半径 0.15 米）CPU 6.6 毫秒、连 GPU 17.3 毫秒，一下约 0.17 毫秒。
- MCP 的 `game_command paint`：按三个点画一道线 45 下、再画一道 35 下，重新加载编辑器后两道都在（第一次试的时候重新加载后全没了，查出是图片贴图不能拷出去，见 decisions.md）。

### S2 材质节点图（2026-11-21）

- `apps/greybox` 的墙改成节点图做的砖墙（9 个节点：UV、砖块、噪声、两种颜色、混合、乘、从高度算法线、色阶），经 MCP 写入；主 Chrome 里看：灰浆缝、每块砖的深浅、砖面的颗粒和缝边的明暗都在，圆塔上也对。无头 Chrome 1280x720（RX 9070 GRE）：不透明通道 0.09 毫秒，换成普通的贴图材质也是 0.09 毫秒，量不出差别。
- 编辑器里：打开节点图面板，点"列数"的 + 改成 3、拖动噪声节点、从噪声拉线到金属度、加一个 Voronoi 再选中按 Delete 删掉、点金属度的口断开，每一步文件里都对、视口跟着变。拖动时界面文字会被选中：画布加了禁止选字。底部面板太矮：打开节点图时让出一半高度。

### S2 关卡白盒（2026-11-21）

- StrideNative 0.38：Manifold 3.5.2 进工具模块，`stride-tools-core` 的包大 116 KB（压缩后）；原生测试（方块减方块的坑：坑底、四个坑壁各两个三角形归第二个笔刷）、Node 测试都过。
- `apps/greybox` 的房间（19 个笔刷：地板、四面墙、门洞、三个窗洞、平台、斜坡、台阶、柱子、中空的圆塔、坑）：Node 里烘一次中位数 24.6 毫秒，模型 11 KB；经 MCP 写入加烘焙（含 MCP 启动）1.5 秒。编辑器里在属性面板改柱子的半径，视口里一两秒内变了（存的延迟加烘焙加热重载）。网格图按自动 UV 铺得上、跨面连续。射线检查碰撞：平台顶 1.5 米、地板 0、斜坡中间 0.75、圆塔里 0.2、坑挖穿了地板。

### F4 验收：30 秒短片《Evening》（2026-11-21）

`apps/short-film`，1920x1080 和 1080x1920，30 fps，900 帧，主 Chrome 里（窗口被挡住）：

| 出片 | 子帧 | 渲染耗时 | 文件 |
|---|---|---|---|
| 草稿（MCP） | 2 | 17.0 秒 | 38 MB |
| 横屏 1080p（MCP） | 8 | 28.3 秒 | 39 MB，H.264 + AAC，音量峰值 −6.6 dB |
| 竖屏 9:16（MCP） | 8 | 29.1 秒 | 41 MB |
| 竖屏 9:16（编辑器的"出片"，看不见的试玩页面） | 8 | 27 秒 | 41 MB |

- 第一次出草稿机器人只露出腿：RobotExpressive 高 4.44 米，缩到 0.3；第二次跟拍太近、结尾特写太紧，调了机位。第一次出正式版没有音轨（从 0 秒开始的配乐不放），修了重出。
- 抽帧看：远景里路灯亮着、太阳在落、挥手；跟拍走路；环绕跳舞；特写竖大拇指和挥手，片段之间平滑过渡；景深、体积云和雾都在。冒烟按时刻检查机位、剪辑、位置和字幕。

## CI 的全量冒烟（2026-11-20 的记录，从 roadmap.md 的"正在做和下一步"挪过来）

**CI 的全量冒烟**（2026-11-20，`.github/workflows/ci.yml`，设计见 tools/README.md 的"CI"）：SwiftShader 上 WebGPU 的上下文丢失查清修掉（缺 `--use-vulkan=swiftshader`，见 lessons.md 的 WebGPU 一节），冒烟改成一个样例一台运行器，等待改成按状态和游戏时间（lessons.md 的"冒烟测试的等待"）。8c5cda9 那次：18 个跑完的冒烟过了 16 个，没过的 simple-audio（波形图的动画按帧走，按游戏时长等不够）和 platformer2d（运行器上 Chrome 20 秒没起来）随后改了（等状态；Chrome 的启动上限放到 60 秒）。当时失败的七个都是时序类，修复分别在 701a442（bepu-sample）、ce30ce2（topdown-rpg、simple-audio）、44fd3bd（platformer2d、morph-targets）、3c6c62c（first-person-shooter、csharp-intermediate）和收尾的那次提交。没有发现引擎行为类的失败，也没有要因为 SwiftShader 本身跳过的检查。顺手修的工具缺陷：`regress.ps1` 没设 `STRIDE_CHROME_ARGS` 时丢了 `--autoplay-policy`（PowerShell 单元素数组展开成空，本地的声音检查因此失败）；`stride mouse --trusted` 固定按 100 ms，帧慢时锁不上鼠标（改成按住到游戏跑过一帧）。修复后的第一次完整运行：待确认。还没过的（fc13aa0 在验证槽位 3 上用真显卡跑全部样例，机器忙）：
   - platformer2d："W 起跳，放跳的帧"、"碰到金币：精灵马上隐藏"、"拿到的那个金币放了音效"——收尾的提交改了（等离地且换到跳的帧；按住 D 到拿到金币为止再读），本地真显卡和 SwiftShader 都过；
   - first-person-shooter："枪口火焰、弹孔按时移除（受击拖尾 6 秒）"——收尾的提交改了（开枪以后在一次 eval 里等完、读完），本地真显卡和 SwiftShader 都过；
   - bepu-sample 的预算（entities 457 > 366、render.instances 2522 > 2023）、space-escape 的预算（render.instances 130 > 127）——没人看过；可能是冒烟改成按游戏时间、状态等以后量预算的时刻变了，也可能和物理一帧补 0.25 秒有关；
   - ui-particles："火跟着导火索往左走"（fire1 = [10,0,0]）——没人看过；
   - csharp-intermediate：收尾的提交改了动画（淡入、出拳逐帧看）和导航（按游戏时间等）的等法，本地真显卡过，SwiftShader 上没跑完。下一步：看最新一次完整运行，还有失败就照 lessons.md 的做法改等法；样例里按帧走的动画（SimpleAudio 的波形图，同 Stride）以后可以改成按时间走（和 Stride 不同，要记进 decisions.md）。

## WebGPU 能力实测（2026-11-21，给 G 组定取舍）

页面 `apps/bench` 的 `capabilities.html`（`node tools/run-page.ts http://localhost:5182/capabilities.html capabilitiesResults --error capabilitiesError --screenshot <png>`），无头 Chrome 157，RX 9070 GRE（RDNA 4），1080p，GPU 时间戳取中位数。页面底下画出各项的画面，看过是对的。

| 项 | 做法 | 结果 |
|---|---|---|
| 高斯泼溅 | 12 × 4 × 16 米的屋子，97% 贴在表面、3% 飘着；每帧按视深 16 位计数排序（清桶、计数、一个工作组的前缀和、散开），再照 3DGS 投成椭圆、从后往前混合进 rgba16float | 100 万个：排序 0.35、画 1.17 毫秒；300 万：0.85、2.09；600 万：2.75、3.64。飘着的大泼溅占 15% 时 600 万个要画 8.3 毫秒：开销看重叠层数 |
| 群演 | 一个人 4000 个三角形，32 帧的位置和法线烘成两张 rgba32float，一次实例化画完，深度测试、背面剔除 | 2000 人 0.52 毫秒，一万人 2.59，五万人 11.0；每毫秒 1500 万到 1800 万个三角形 |
| 视频贴图 | 画布画 120 帧编成 H.264（avc1.640028），WebCodecs 硬解，每帧 `importExternalTexture` 铺满 1080p 画一遍 | 只解码每秒 750 到 800 帧，解码加导入加画每秒 310 到 335 帧；帧是 NV12，每帧 CPU 0.25 到 0.29 毫秒，GPU 0.016 毫秒 |
| 路径追踪 | 方块楼的城，JS 里分 8 桶按表面积启发式建 BVH2，计算着色器遍历：主光线、一次漫反射反弹、太阳的阴影光线 | 10 万个三角形：建 0.75 到 1.1 秒，一个样本 2.28 毫秒，每秒 17 亿条光线；100 万个：建 7 秒，2.55 毫秒，每秒 15 亿条 |

特性：atomic-vec2u-min-max、bgra8unorm-storage、clip-distances、depth-clip-control、dual-source-blending、float32-blendable、float32-filterable、indirect-first-instance、primitive-index、rg11b10ufloat-renderable、shader-f16、subgroup-size-control、subgroups、texture-component-swizzle、texture-compression-bc（含 sliced-3d）、texture-formats-tier1/2、timestamp-query。上限：缓冲和单个存储缓冲绑定 2 GB，每阶段 16 个存储缓冲，工作组共享内存 32 KB、一个工作组最多 1024 个线程，2D 贴图 16384。结论见 decisions.md 的"未来城市和现实仿真：路线图加 G 组"。

## 音效生成器（2026-11-21）

- 主 Chrome 里 collect-dodge 的编辑器：资源浏览器选 Sounds/CoinPickup（wav 的），属性面板上方是音效生成器（试听放旁边的 wav），编码改成 synth 出现八个类别按钮和"变一点"，点"拾取"参数填进下面的字段、时长 0.37 秒、放了一遍；"变一点""爆炸""受击"各放一遍（起初按钮放一遍、参数变了又自动放一遍，改成按钮放过的不重放）；字段里把衰减改成 0.45，存进文件、自动放一遍。视口里的游戏加载这个声音 20.8 毫秒（0.46 秒的噪声）。不带 `?stride-edit` 打开游戏，三个合成的音效（0.30、0.18、0.55 秒）加载、播放，控制台没有错误。
- 单测：默认参数的长度和峰值、volume 只缩放；同样的 seed 出同样的噪声；往下滑到最低音高提前结束、往上滑过零点更密；每个类别 20 个种子：同种子同参数、都在范围里、0.02 到 8 秒、没有 NaN（包络里长度 0 的一段原来出 NaN，修了）；变一点不换波形、每个参数最多挪 0.05；合成的声音不引用音频文件。MCP 的 `generate_sound`：同种子同参数、存成 synth、没有缺失的引用、变一点、不存在的不能变。

## 材质库和特效库（2026-11-21）

- 缩略图：`node tools/library-thumbnails.ts` 24 张约 40 秒（材质 0.6 到 1.3 秒一张，节点图的要编管线；特效等 2 秒游戏时间），共 37 KB。看过一遍：玻璃起初是白的（缺 `diffuseShading: false`）、大理石没有纹（改成噪声等于 0.5 的那条线）、石板有黑点（Voronoi 的距离在格子中心是 0，换成不错缝的砖）、布有摩尔纹（格子太密）、特效全是白的大团（大小随时间是直接设的大小，同 Stride；柔和圆点不乘粒子颜色——修在引擎里），都改了重画。
- 主 Chrome 里 greybox 的编辑器：右下的"库"窗口，材质 17 张、特效 7 张卡片；把"金"拖到视口里的球上（拖放事件在页面里派发：扩展合成的鼠标拖动不触发 HTML 的原生拖放），球变成金的，状态栏"金 用在了 1 个实体上"；"篝火"拖到前墙顶上，加了 Campfire 实体（位置是放下处的表面）、选中；选中 Crate 点"铜"再点"用在选中的实体上"，箱子变成铜的；类别多时折行。都撤销了，拷进去的 Materials/Library 删了。
- 单测：id 不重、每个都有缩略图和中英文的名字、类别；材质照字段描述没问题、节点图编得过、不用贴图；特效的组件照字段描述没问题、每个发射器有颜色和大小随时间。MCP：`list_library`，`use_library` 把金用在球的两个材质槽上、工程里改过的那份不覆盖、篝火加在给的位置、缺场景和不存在的报错。

## S2 的验收：营地（2026-11-21）

- `node packages/editor/src/server/cli.ts new apps/campsite` 建工程，`node apps/campsite/scripts/build.ts` 经 MCP 搭：第一次 `edit_scene` 报"scripts 不是实体的字段"（脚本放在 components.scripts 里，照字段描述的检查拦下来了），改了重跑。主 Chrome 里看：第一版太阳在木屋正后方、正面逆光，小路没对着门；太阳挪到侧面、小路从门口通到火塘，重搭。
- 编辑器里：资源浏览器列出全部资源；选中 Cabin 的模型原来报"二进制模型读不了"（修了，显示白盒的字段）；UV 缩放改成 0.5，视口里木屋重烘。
- `stride perf`：120 帧每秒（垂直同步），GPU 1.58 毫秒（不透明 0.90），CPU 画 1.38 毫秒、更新 0.25 毫秒。
- 冒烟 4 项都过（噼啪声 0.06 秒，起初的检查按 0.1 秒以上写错了）；预算在验证工作树里记。

## 矩形面光源（2026-11-21）

- 营地的木屋里加了面板灯（`Cabin light`，1.4 × 0.8 米朝下）。第一版强度按发光面的亮度，6 几乎看不出来，200 才看出屋里亮了（光照对了）；改成和点光同一个意思以后用 12。
- 测试场景（营地页面里 `setRootScene` 拼的，没留文件）：深色亮面的地面（粗糙度 0.15）、一块 2.4 × 0.5 米的面板、一根 1.6 × 0.08 米的蓝色灯管、一个球。第一次两盏光都朝着背离相机的方向（本地 -Z）；转过来以后地面上是面板和灯管拉长的矩形高光、球的一侧是蓝的，同 LTC 该有的样子。
- 耗时在无头 Chrome 里量（主 Chrome 的窗口被挡住时 requestAnimationFrame 停了，`stride perf` 等不到帧）：不透明一遍 0.229 毫秒（两盏矩形光）对 0.123 毫秒（两盏点光）。
- 编辑器里选中 Cabin light：属性面板是矩形光的字段（宽、高、范围），视口里有它的操纵器。

## 视频贴图（2026-11-21）

- 测试视频用 ffmpeg 生成（`mandelbrot` 滤镜加色相旋转，1280 × 720、30 帧、6 秒，1.2 MB；只用来测，没留）。营地页面里拼了一个场景：一块 3.2 × 1.8 米的平面，材质的自发光槽接这个视频。无头 Chrome 里隔一秒截两张图，平均每通道差 12 到 18（在放）；画面是曼德博集合的屏。主 Chrome 的窗口那时被挡着，页面没连上中枢（同上回的 requestAnimationFrame 停了），改在无头的里量。
- 每秒 `copyExternalImageToTexture` 30 次，每次 CPU 0.275 毫秒；`stride perf` 一帧 GPU 0.12 毫秒。
- 单测：编辑器导入 mp4 成贴图资源（`encoding: 'mp4'`）、不写 `.image.json`；字段描述里贴图编码的枚举改成从 `TEXTURE_EXTENSIONS` 推（原来是手写的一串，漏了新的就对不上）。

## 平面反射（2026-11-21）

- 测试场景在营地的页面里拼（深色亮面的地面、两个红箱子、一块矩形光、一个 12 × 1 × 12 米的平面反射），无头 Chrome 里截图。第一次 Vite 报解析错（`typeof this.#candidate` 这种写法 oxc 不认，tsc 认），换成具名的接口；第二次整个画面是黑的，关掉平面反射就正常——镜像的视图画进反射图时视图绑定组里也绑着它，改成只给主画面绑。之后箱子的倒影和箱底对得上，远处的天空也映在地上，掠射的地方更亮（菲涅耳）。
- 中途 CLI 连到了主 Chrome 里开着的同一个页面（窗口挡着、不出帧，截图一直等），把那个标签页挪开、只留无头的。
- `stride perf`：镜像那一遍 0.011 毫秒，一帧 GPU 0.148 毫秒（不开 0.129）。

## 3D 世界里的文字（2026-11-21）

- 单测：A、o 各一个外轮廓一个洞，I 没有洞；整段以中心为原点、按 align 对齐；OPEN 烘成字面和侧面两个网格，80 毫秒。
- collect-dodge 经 MCP 加了发光的 GOAL 招牌（SignNeon 字面、库里拷来的拉丝钢侧面），挂在终点上。第一版 O 的洞里一道道细条：方块减方块的试验里 Manifold 的结果是对的，O 的原始结果里也没有字面三角形落在洞里——是洞的柱子和字的前后面共面，改成前后各长出去一点，无头 Chrome 的近景干净了；编辑器视口里还有细条，是开发服务器的进程还在用改之前的烘焙代码，重启后重烘就好了。
- 编辑器里：属性面板改文字（GOAL→EXIT→GOAL）视口马上跟着变；"新建 → 3D 文字"原来字体是空的、后端拒绝，改成用工程里的第一个字体以后建得出来。

## 折射（2026-11-21）

- 营地的页面里拼测试场景（石板地面、一排彩色方块、一个实心的玻璃球、一个磨砂带吸收的球、一块薄玻璃板），无头 Chrome 截图。第一次整帧全黑：HDR 缓冲没有 COPY_SRC 用途，拷贝让整帧的命令作废；这一帧要拷时给它加上。第二次玻璃根本没画：测试场景的合成器没写 `transparent`（场景格式里它不默认开）。之后球里是放大的方块和地砖（Filament 的球近似不倒像，真的玻璃球远处的东西是倒的），磨砂的糊、带蓝绿色；薄板挡住的地方看不见后面的球——透射只取不透明的画面，同 HDRP，记进了限制。
- 开了平面反射的场景里一起看：地上的倒影照旧（第 26 个绑定不透明阶段是反射图、透明阶段是拷的画面，按管线常量 `TRANSPARENT_STAGE` 分），玻璃球里折射着地上的倒影。顺手修了透明的东西在平面反射的盒子里也去取反射图（透明阶段绑的是空图，取到黑）。
- 按 WebGPU 默认上限（`?stride-limits=default`）开：没有第 26 个绑定，第一版退回取环境光，玻璃成了一团不透明的蓝；改成退回普通的透明混合（透过的比例当 alpha），看得见后面的方块和菲涅耳的边。
- 耗时（RX 9070 GRE，1280 × 720）：拷贝 0.007 毫秒，拷贝加 10 级 mip 0.035 毫秒（时间戳）；两个球加一块板的透明那一遍 0.045 毫秒。CPU 上每帧编码 0.116 毫秒，多半是 MipmapGenerator 每级每帧重建视图和绑定组，按贴图缓存以后 0.046 毫秒（平面反射也受益）。
- 库里加了磨砂玻璃和水晶（透射），缩略图的玻璃类在球后面摆三个彩色方块；磨砂玻璃第一版几乎不糊（取级按粗糙度线性），换成 Filament 的 2·log2(粗糙度) 加偏移。

## 路线图清单的原文（A–F）

2026-11-21 整理路线图时从"正在做和下一步"挪来的，各项做完时写的结论原样留着（路线图里只留每组一句和遗留的尾巴）。

**A. 稳住**
1. ~~CI 全绿~~（2026-11-21：de8a3dd 那次完整运行 23 个任务全过，划掉。之前的记录：2026-11-20：9d94b2e 那次完整运行 22 个任务只有 physics-sample 失败——点 >> 换场景按墙钟等 1.5 秒，软件 WebGPU 上场景没换完，eb7d743 改成等到新场景跑过几帧；bepu-sample、space-escape 的预算、ui-particles 的火都过了。等下一次完整运行全绿就划掉）：c614824 那次的 platformer 在 CI 上一次 eval 超过两分钟（跑、站各看 20 帧骨骼，TPP 在软件 WebGPU 上一帧几秒），改成各看 8 帧（本机每帧多忙等 1 秒也过了），看下一次完整运行；4174f30 那次五个失败是片元阶段的贴图超了默认上限（c614824 修了）；复查旧账：bepu-sample、space-escape 的预算超了，ui-particles 的"火跟着导火索往左走"。CI 的来龙去脉见 progress-log.md 的"CI 的全量冒烟"。
2. ~~csharp-beginner 的截图差变大~~（2026-11-20：阴影的法线偏移按实际的图集算了，修掉；输出的抖动在比对时关掉；剩下的是有意的——颜色键的遮罩贴图无损存，见 decisions.md）。还剩：morph-targets（要先从源码编 Stride 4.5.3-dev4 再重截参考图）；茶壶背光一侧的环境镜面反射比 Stride 亮（11-19 就有）。
3. ~~整理~~（2026-11-20）：`particles/gpu/` 的四个文件并回 `particles/`（`GpuEmitter.ts`、`gpuKernel.ts`、`gpuDraw.ts`、`gpuSort.ts`）；内核的 PCG 不换（它是一维的 u32 哈希，HASH3 是三维的，没有重复）；页面里的帮手只剩引擎的一份（`debug/pageHelpers.ts`，`stride eval` 直接能用，冒烟的 `PAGE_HELPERS` 只是把它装成全局变量）；SimpleAudio 的波形图按时间走（见 decisions.md）。

**B. 补 P1、P2 落下的引擎能力**
1. ~~画进渲染目标贴图的相机用阴影和后处理~~（2026-11-20：各自的方向光级联、各自的后处理；最大的图集放不下时阴影图一起缩一半，见 decisions.md）。~~这些视图也分簇，放开点光、聚光的上限~~（2026-11-20：每个视图一个槽，每簇是紧凑的索引表，点光、聚光和每簇的个数都不设上限，见 decisions.md）。
2. ~~透明物体投阴影~~（2026-11-20：按 alpha 抖动着投，同 Stride，材质可以关掉抖动；见 decisions.md）。
3. ~~Stride 材质特性~~：清单在 decisions.md 的"Stride 材质特性的清单"。~~微表面模型的各项~~（2026-11-20）。~~卡通着色~~（同一天：渐变统一成最多 8 个节点，贴图在导入时化简）。贴图的镜面颜色这类"只认常量"的槽接到颜色树上：2026-11-20 查了 CI 的导入日志，所有样例的材质都没有这类警告（只有字体换替代字体、自定义粒子模块），等有内容用到再做；头发着色、曲面细分放到 E（头发做角色时一起做）。
4. ~~csharp-intermediate 的 UI 渲染组~~（2026-11-20 核对：已经由"渲染组和渲染掩码"做了，`DefaultScenery` 预制体里 UI 的 Group4 导入成 `renderGroup: 4`，导入没有警告）。

**D. 把 P4 开了头的功能补完整**（上表"没做"的那些）
1. ~~GPU 粒子的深度缓冲碰撞，雨点落地溅起~~（2026-11-20：`UpdaterDepthCollision` 撞天空遮挡或主视图上一帧的深度，雨点反弹成小水花，见 decisions.md）。~~水洼~~（同一天：积水量跟着雨走，按噪声在平的、淋得到的地方积出水面，下雨时有涟漪；顺手修了积雪公式让下雨的地面发白的 bug）。~~GPU 粒子的力场~~（同一天：照 CPU 的逐行搬，四种形状 CPU、GPU 的分布一致）。~~GPU 粒子的预热~~（同一天：每步一次派发，CPU、GPU 的分布一致）。~~排序进工作组共享内存~~（同一天：26 万个槽 171 次派发变成 55 次，排序 0.405 → 0.279 ms）。D1 做完。
2. ~~反射探针分进簇~~（2026-11-20：簇头多一个探针数，16 个探针时不透明那一遍 0.234 → 0.179 ms，见 decisions.md）。
3. ~~体积雾：点光、聚光照雾，带噪声的雾，远处的高度雾~~（2026-11-20：按主视图的簇照雾，噪声跟着风飘，distance 以外解析积分；见 decisions.md）。点光、聚光在雾里的阴影（同一天：光和阴影一个缓冲以后，雾按阴影取一次比较样本）。
4. ~~天气：雪的斑驳、角色身上不积雪~~（2026-11-20：噪声的斑块、法线盖平细节、蒙皮的网格不积雪，见 decisions.md）。天空遮挡按变了的槽位重画（2026-11-20：原生的变换存储报变了的槽位，范围里的遮挡物动了才重画）。雪的真实厚度（位移）挪到 E 第 1 项（要密的网格或细分，见 decisions.md）。
5. ~~屏幕空间反射：粗糙的表面按锥角取颜色的 mip~~（2026-11-20：颜色金字塔，闪烁少了约 13%，多 0.04 ms；见 decisions.md）。
6. ~~片元阶段的绑定再省一些~~（2026-11-20：光和阴影一个缓冲、DFG 表换 uniform，存储缓冲 7 → 5；顺手去掉了剔除、背景、天空、精灵"最多 8 个视图"的上限，见 decisions.md）。
7. ~~贴花不设上限~~（2026-11-20：缓冲按需变大，没变的不重新打包，1024 个时每帧 2.27 → 0.15 ms；见 decisions.md）。还剩：图集最大 4096²（要多页）。

**C. P3 编辑器的验收**（清单见上面 P3 那一条）
1. ~~用编辑器从零搭一个小游戏~~（2026-11-21 做完：`apps/collect-dodge`，冒烟把玩法走一遍；见 decisions.md）（P3 验收标准的第二条）：3D 收集加躲避（用户 2026-11-20 定）——角色控制、收金币、会动的障碍、门和触发器、UI 计分、声音，用上物理、预制体、脚本、UI、声音、光照和天气；搭的过程中暴露的问题顺手修。
   2026-11-20 查了一遍：编辑器能打开、改、挪、删资源，但一样都建不出来（没有新建场景、预制体、材质、基本形状的模型、UI 页面，不能导入声音、glTF），也没有新建工程的模板。按这个顺序补，每步做完在 Chrome 里用编辑器走一遍：
   1. ~~基本形状的模型~~（2026-11-21 做了，见 decisions.md）：`.model` 文件可以是一段 JSON（形状、尺寸、细分、材质），运行时按它生成网格（Stride 的程序模型，生成器从导入器挪进引擎，导入器和运行时共用）；资源数据库、改引用照常认。
   2. ~~新建工程的模板~~（2026-11-21：`stride-editor new apps/<名字>`，建了 `apps/collect-dodge`；见 decisions.md）：能跑的空游戏，一个有相机、光、天空、地面的场景。
   3. 编辑器里新建资源：~~场景、材质、基本形状的模型、UI 页面~~（2026-11-21：资源浏览器的"新建"，接口 `PUT /asset?create=1`）；~~把选中的实体做成预制体~~（同一天：工具条上的按钮）；~~导入声音、图片~~（同一天：拖进资源浏览器，`POST /import`）；~~资源热重载~~（2026-11-21：资源文件改了，视口里用到它的实体就地重建）；~~选中材质、基本形状的模型时在属性面板里编辑它们~~（同一天：引擎的 `ASSET_FIELDS`，改了马上存、视口热重载）；~~导入 glTF、FBX~~（同一天：拖进资源浏览器或 `POST /import`，成模型加材质加贴图；StrideNative 0.33、0.34 报出材质的 PBR 参数和贴图）。第 3 步做完；~~导入带骨骼、动画的模型~~（2026-11-21：骨架、每个动画一个剪辑、形变目标，见 decisions.md）。
   4. ~~游戏的脚本（TS）~~（2026-11-21：角色控制、金币、会动的障碍、门和终点、计分的 UI 和声音）。
   5. ~~在编辑器里搭场景、存、试玩~~（2026-11-21：用编辑器的接口搭，编辑器里看过；暴露的问题修了：物理天空、雾、云的光照暗了 π 倍，角色不能设速度，睡着时挂起的接触醒来以后不报结束，编辑器不能导入字体）。还剩：实体的缩放不缩放碰撞体。
2. ~~场景树、视口里选中场景本身的入口~~（2026-11-21：场景树最上面一个节点是场景（预制体）本身，选中它或者在视口里点空处，属性面板显示场景的设置；实体拖到它上面挂到根上）。
3. ~~场景是代码建的样例（sprite-fonts、custom-effect）编辑器能打开~~（2026-11-21 按推荐的 B 做完：编辑器认没有场景的游戏，属性面板里改游戏设置，根渲染器的属性按文件里的值推出字段，改了页面马上重建根渲染器；样例不动；见 decisions.md）。原来的分析：Stride 的这两个样例本来就没有场景，内容全在合成器的根渲染器里（游戏设置引用的 GraphicsCompositor，FontRenderer、CustomEffectRenderer 的属性是字体和贴图）。两条路：A 改写成场景（自定义效果的精灵加 UI 文字页，样例的结构和 Stride 不一样了，桌面 Stride 的截图比对要重做）；B 编辑器能打开、编辑游戏设置和合成器（根渲染器的属性按字段描述改，P3 清单里"按 JSON 改的那几种"的一部分），样例不动。推荐 B：别的游戏也会有不靠场景的根渲染器，编辑器认它比改样例有用。先接着做 F 组。
4. ~~编辑器的多语言~~（2026-11-21 做了，见 decisions.md；按这一项说的，先于 C2、C3 做）（P3 清单第 14 项，用户 2026-11-20 加的）：界面文字走翻译表，自带英语和中文。排在从零搭小游戏之后、别的编辑器功能之前——界面的文字越来越多，越晚改越费事。
5. P3 清单其余各项按用处排在后面（各种子编辑器）。~~剪贴板~~（2026-11-21，见上面 P3 那一条的第 7 项）。~~按 JSON 改的那几种~~（2026-11-21，见上面 P3 那一条的第 5 项）。~~多场景~~（2026-11-21 第一版，见上面 P3 那一条的第 3 项）。~~吸附到表面~~（2026-11-21，见上面 P3 那一条的第 9 项）。~~按需渲染~~（2026-11-21 做了，见上面 P3 那一条的第 12 项）。
6. ~~编辑器的布局照 JetBrains IDE 重排~~（2026-11-21，用户要的：主工具条、停在四周的工具窗口和两侧的图标竖条、文档页签、视口工具条、状态栏；控件全换成 vue-tsx-pro 的；见 decisions.md）。~~搜索和命令面板~~（2026-11-21：主工具条上的"到处搜"，Ctrl+K 或连按两下 Shift，搜操作、场景里的实体和资源，回车执行、选中、打开；vue-tsx-pro 的 CommandPalette）。~~工具窗口拖到别的边、浮动窗口~~（2026-11-21：vue-tsx-pro 0.37 的 Workbench——竖条上的图标拖到另一组就停到那边，标题栏的 ⋯ 菜单"移到"五处、"浮动"、"停靠"；浮动的拖标题栏挪、拖右下角改大小；位置和大小记在保存的布局里）。

**F. 创作线：镜头、时间轴、成片，然后是资源的创作工具**（用户 2026-11-21 加，见第三节的"创作线"；每一项同时给人的界面和 agent 的接口）
1. ~~编辑器的 MCP 服务和命令行的底座~~（2026-11-21：`stride-editor mcp [工程]`，工具是资源的读写、新建、删除、移动、导入，场景和预制体的修改（照字段描述检查），字段描述的 JSON Schema（引擎 `editor/fieldSchema.ts`），截图和页面命令（经调试中枢）；见 decisions.md。还剩：让开着的编辑器界面打开某个场景）：现有的编辑器接口（资源的读写、新建、导入）加上场景文档的修改、打开场景、预览截图；字段描述导出成 JSON Schema。后面每一项的操作都挂在它上面。
2. ~~时间轴资源和编辑器~~（2026-11-21 做完）：轨道（变换、属性、动画剪辑、相机切换、声音、字幕、事件）、关键帧和曲线编辑器、在视口里预览和拖时间；游戏里当过场播放。~~时间轴资源和游戏里播放~~（`.timeline.json`，引擎 `timeline/`：`Timeline.evaluate` 无状态求值、`TimelinePlayer` 脚本当过场放，主画面的相机切换 `graphicsCompositor.mainCamera`；collect-dodge 的开场过场是用 MCP 做的；见 decisions.md）。~~编辑器里的时间轴面板~~（同一天：资源浏览器里打开时间轴，下面显示轨道；拖时间视口预览（不改场景文档）、从时间轴的相机里看；拖关键帧、加删关键帧、给选中实体的位置旋转打关键帧）。~~曲线编辑器~~（同一天：选中的属性轨道按分量画曲线，上下拖关键帧改值，拖手柄改切线，自动、平切线，插值方式；关键帧可以带 in、out 切线，cubic 按 Hermite）。留到后面的：片段的剪切和交叉淡化（做剪辑时，S3）、在面板里加相机、声音、字幕轨道（现在在属性面板里加）、切线两侧分开调。
3. ~~物理相机和景深~~（2026-11-21 做完）：焦距、光圈、对焦距离、快门角、曝光；画幅和安全框；镜头系统（跟随、注视、手持晃动）。~~物理相机和景深~~（Camera 组件的 physical：焦距换视角、光圈和对焦距离驱动景深（薄透镜的弥散圆，半分辨率的散景）、快门角驱动运动模糊、曝光补偿；`stride call lens`；见 decisions.md）。~~画幅和安全框~~（同一天：Camera 的 aspectRatio，主画面框成这个宽高比、以外画黑边，比画布宽时竖直视角相应加大；编辑器工具条的画幅参考线：框出画幅、动作和字幕安全框）。~~镜头系统~~（同一天：CameraRig 组件，跟随、注视、手持晃动，半衰期平滑；是数据组件，时间轴能驱动它的参数）。留到后面的：避障、构图（目标放在画面的几分之几处）、镜头之间的混合、虚拟摄影机（手机的陀螺仪）。
4. ~~离线渲染和导出~~（2026-11-21 做完，验收见下）：~~固定时间步、子帧累积（抗锯齿、运动模糊），WebCodecs 编码加 MP4 封装、混进声音（OfflineAudioContext），图像序列；预设（横屏、9:16 竖屏）~~（2026-11-21 做了：引擎 `offline/`，调试命令和 MCP 工具 `render`、时间轴面板的"出片"，存进工程的 `exports/`；1080p 的 6 秒过场 8 个子帧 5.7 秒出完；见 decisions.md。不做 WebM；渲染队列不单独做，一次一条）。~~验收：S1 的 30 秒短片~~（2026-11-21：`apps/short-film` 的《Evening》，四个机位、角色动画、配乐、字幕、太阳落山；agent 只用 MCP 搭和出片，横屏、竖屏各一份，各约 29 秒出完；人在编辑器界面里拖时间检查、改字幕、按"出片"导出竖屏。为它补了导入带骨骼动画的模型、动画轨道无状态求值，修了从 0 秒开始的声音不放、时间轴面板和属性面板两份内容互相覆盖、嵌套字段太窄、时间轴的实体引用要手敲 id；见 decisions.md）。人那一遍没有从零在界面里重搭一次（逐项确认了每一步界面上都有入口），短片的场景是 agent 搭的。
5. ~~S2 的资源创作工具~~（2026-11-21 做完，验收是 `apps/campsite`；下面是各项），按第三节 S2 那一行的顺序（材质和基本形状在属性面板里编辑已经在 C1 里排了）；每个工具做之前先读 creation-tools.md 里对应的参考。
   1. ~~关卡白盒~~（2026-11-21 第一版：`.brush.json` 存笔刷——方块、挤出的多边形、圆柱、球，按顺序加、减、求交；编辑器后端用原生工具模块里的 Manifold（StrideNative 0.38）烘成同名的模型，平直法线、按朝向投影的世界坐标 UV、每个笔刷一个材质槽；属性面板、MCP 改了马上烘、视口热重载，19 个笔刷烘一次约 25 毫秒；演示 `apps/greybox`；见 decisions.md）。还剩：视口里直接点面加方块、拖手柄改尺寸（CubeGrid 式的交互，现在在属性面板、MCP 里改数）、笔刷的线框和选中高亮、导出成可编辑的网格。
   2. ~~通用节点图框架和材质节点图~~（2026-11-21 第一版：引擎 `graph/nodeGraph.ts` 是通用的格式和排序，`rendering/mesh/materialGraph.ts` 是材质的节点库（输入、噪声、Voronoi、砖块、棋盘格、渐变、圆、运算、色阶、颜色渐变、从高度算法线、UV 变换）和编译器；材质文件的 `graph` 编成 `materialGraph()`，当最后一层材质层接进网格着色器，在着色器里直接求值；没有切线的网格按导数现算切线框架；编辑器的节点图面板：拖节点、连线、断开、加删节点、节点上改参数，改了马上热重载；见 decisions.md）。还剩：每个节点的预览图、要烘焙的滤镜（模糊、扭曲）、三平面映射、多段的颜色渐变、把图烘成贴图页、材质库。
   3. ~~在模型上画贴图~~（2026-11-21 第一版：绘制层是一个材质层，遮罩是一张线性 png；`rendering/paint/MeshPainter.ts` 在 UV 空间里光栅化世界空间的球形笔刷（三角形的边再画一遍线补接缝），笔刷落点 CPU 上射线求交；编辑器材质的属性面板有图层栏（加绘制层、每层的颜色粗糙度金属度、画、笔刷的半径硬度强度擦除），视口里拖着画，一笔画完存 png；agent 用调试命令 `paint`（世界坐标的点列）；见 decisions.md）。还剩：节点图做画笔、按曲率和 AO 自动生成遮罩、智能材质（带遮罩规则的图层组）、投影绘制、没有独立 UV 的网格（白盒）先展一套 UV、撤销。
   4. ~~粒子编辑器~~（2026-11-21 第一版：编辑器底部的粒子面板，照 Niagara 的发射器模块栈——发射器页签（加、删）、发射器参数、形状和材质（换种类）、生成、初始化、更新三栏（加模块、上下挪、删）；模块的参数照引擎的模块库 `editor/particleModules.ts` 画，曲线参数是小曲线编辑器（拖点、双击加、右键删），颜色曲线是渐变编辑器；每次修改是场景文档的一步，能撤销、视口里的粒子马上重建；新发射器默认是柔和的圆点（颜色树加了 `computeSoftCircle`）；greybox 加了一个喷泉；见 decisions.md）。还剩：特效预设库、在面板里预览单个发射器（暂停、重播、慢放）、子粒子和导入的游戏模块按 JSON 改。~~序列帧烘焙~~（2026-11-21：粒子窗口的"烘成序列帧"、调试命令 `bake`，引擎 `offline/FlipbookBaker.ts`：另建一份粒子系统固定种子在 CPU 上模拟，正交相机把每一帧画进图集的一格，黑底白底各画一遍反推透明度，按最亮的分量缩进 8 位、放的时候组件颜色乘回去；旁边加一个用一个粒子放它的实体；greybox 的喷泉 16 帧 1024² 烘一次约 0.6 秒；见 decisions.md）。还剩：法线、自发光等别的图，体积流体（EmberGen 那样）。
   5. ~~SDF 建模~~（2026-11-21 第一版：`.sdf.json` 存形状——球、圆角方块、胶囊、圆角圆柱、圆环、椭球，按顺序平滑地并、差、交，`smoothness` 是融合带的宽度；编辑器后端用原生工具模块的 `st_sdf_mesh`（StrideNative 0.39，Manifold 的等值面）烘成同名的模型：光滑的法线（距离场的梯度）、每个三角形用离它最近的形状的材质槽，再按几何误差简化；属性面板、MCP 改了马上烘、视口热重载；greybox 加了一个蘑菇，精度 0.03 米烘一次约 0.3 秒、模型 12 KB；见 decisions.md）。还剩：视口里直接拖形状（操纵器摆每个形状、拖手柄改尺寸）、颜色按融合过渡（顶点色）、展 UV、更多形状（圆锥、多边形挤出、样条扫掠）。轻量多边形编辑是下一项。
   6. ~~轻量多边形编辑~~（2026-11-21 做完：`.poly.json` 存顶点和 n 边形的面，后端烘成同名的模型（三角化、按光滑角的法线、自动 UV、可选镜像，引擎 `modeling/polyMesh.ts`）；编辑操作——挤出、内插、倒角（三个面相交的角）、合并、切割、连接、移动、删面、翻面、换材质——是纯函数（`modeling/polyEdit.ts`），MCP 的 `edit_poly` 调它们；编辑器里模型组件上点"编辑多边形"进视口的编辑模式：点、边、面三种选择（1、2、3，Shift、Ctrl 加选），操纵器拖选中的顶点（移动、旋转、缩放），工具条上的操作按选中的东西可用，松开、做完一步存文件、后端烘（约 20–60 毫秒）、视口热重载，撤销、重做是网格的一步；见 decisions.md）。还没做：环选、刀切、UV 编辑、软选择、顶点吸附、镜像那一半的预览。
   7. ~~音效生成器~~（2026-11-21：声音资源的 `encoding: 'synth'` 存 sfxr 的参数（几十个字节），加载时合成，不要音频文件（引擎 `audio/soundSynth.ts`，噪声按种子、同样的参数出同样的波形）；属性面板上方的音效生成器——拾取、激光、爆炸、升级、受击、跳跃、点选、随机，"变一点"，试听，字段改了自动再放一遍；"新建 → 音效"；MCP 的 `generate_sound`；collect-dodge 的三个音效换成了合成的，删了 wav；见 decisions.md）。
   8. ~~材质库和特效库~~（2026-11-21：编辑器自带 17 种材质（金属、塑料和漆、玻璃、霓虹，混凝土、砖、石板、木头、大理石、布用材质节点图算，都不用贴图）和 7 种特效（篝火、烟柱、蒸汽、火花、魔法光球、浮尘、喷泉），`packages/editor/src/library/`；"库"窗口按类别列出带缩略图的卡片（缩略图用引擎画，`tools/library-thumbnails.ts`），材质拖到视口里的物体上或者选中再点就用上，特效拖到视口里放在放下处的表面上；用的时候拷一份进工程；MCP 的 `list_library`、`use_library`；顺手修了粒子的柔和圆点不乘粒子颜色（颜色随时间不起作用），greybox 的序列帧重烘；见 decisions.md）。
   9. ~~S2 的验收~~（2026-11-21：`apps/campsite`，黄昏的营地——木屋是白盒、石头火塘木头提灯是 SDF、箱子是多边形编辑、屋顶瓦片石头草地是自己写的材质节点图、木头石板拉丝钢和篝火从库里拿、噼啪声是音效生成器做的，一张外部的图、一个外部的模型都没有；agent 那遍全程用 MCP（`apps/campsite/scripts/build.ts`，十几秒搭完），人那遍在编辑器里看过、改过白盒；内容一共 67 KB（platformer 导入的超过 1.1 MB）；1080p 的 GPU 每帧 1.6 毫秒；见 decisions.md）。S2 做完。

## 换机器交接时的快照（2026-11-20）

2026-11-21 整理 handover.md 时挪来的：那次换机器时写的"做到哪了"和"交接时的状态"，原样留着。

### 现在做到哪了，接着做什么

#### 2.1 各阶段

- **P1、P2**（Stride 样例的运行时）：完成。20 个样例都移植了，TPP 和桌面 Stride 逐像素比对过。
- **P3 编辑器**：界面（Vue 加 vue-tsx-pro）、场景树（加删、拖动换父实体）、属性面板（照字段描述画，加删组件）、视口（点选、操纵器）、资源浏览器（移动、改名、删除，改写引用它的文件）、撤销重做、试玩都做了；**预制体**这一轮做完了：场景里只存引用和差异、导入器把 Stride 的实例转成引用、编辑器里改删实例的成员落成覆盖、单独打开预制体编辑、覆盖里的资源路径随移动改写。
- **P4 现代画面**：底座（统计量和预算、管线预热、渲染图、阴影图集按需、画质档位）做了；画面功能做了 TAA 加运动向量、GTAO、屏幕空间反射、接触阴影、运动模糊。

#### 2.2 这一轮（2026-11-20 下午）新做的，按提交

| 提交 | 内容 | 验证 |
|---|---|---|
| `d5d39a2`、`78ed87e` | 预制体实例就是预制体的根；导入器把 Stride 的实例转成引用（TPP 134 个，场景文件 194 → 101 KB） | 全量回归通过，已推送 |
| `9d5be40` | 编辑器里改、删实例的成员（`editor/prefabEdits.ts`） | 全量回归通过，Chrome 里在 TopDownRPG 上验过，已推送 |
| `8c6fea7` | 单独打开预制体编辑；覆盖里的资源路径算引用 | Chrome 里在 TPP 上验过（改了再改回，文件 SHA-1 不变），已推送 |
| `406457e`、`aee40c7` | 后处理、GTAO、背景的管线加载时预热（TPP 当场建的管线 22 → 5） | 全量回归通过，已推送 |
| `1b9adeb` | 绘制次数按渲染通道数（`stride draws`） | 全量回归通过，已推送 |
| `0039cd1`、`c5e2115` | 屏幕空间反射第一版 | 全量回归通过，已推送 |
| `8749132` | 编辑器升级到 vue-tsx-pro 0.30.0（场景树单击能选中了） | Chrome 里验过，全量回归通过，已推送 |
| `9c2cdde` | 屏幕空间反射：空间上复用邻居的光线（粗糙表面上不再满是黑点） | Chrome 里在 TPP 上看过，全量回归通过，已推送 |
| `a2792fe` | 接触阴影、运动模糊（默认关） | 单测、类型检查、全量回归通过，已推送；**没在 Chrome 里看过画面** |

同一天在 vue-tsx-pro 那边修了两件事并发了 0.30.0：`css` 改成只有静态方法的类（JetBrains 里按类着色）；拖动工具 `startMove` 设了阈值时过了阈值才捕获指针（能拖动的 Tree 里单击选不中）。

#### 2.3 接着做什么（按顺序）

1. **看接触阴影和运动模糊的画面**（`a2792fe`，第一件事）：
   - TPP（5184）上 `pnpm exec stride contact on`：看角色脚下、墙根、台阶边上的影子是不是贴上去了、没有漏光；不对就调 `--length`（默认 0.3 世界单位）、`--thickness`（默认 0.005）、`--steps`（16）。开关各截一张做差：`pnpm exec stride pause`，`stride contact off`，`stride shot off.png`，`stride contact on`，`stride shot on.png --diff off.png`。
   - `pnpm exec stride blur on`：静止时画面应该和关着时一样（差 0）；按住方向键跑动、转相机（`stride key KeyW --hold 1000`、`stride mouse move 300 0`）时角色和背景糊得对不对，轮廓不该把背景糊进前景。
   - 看过以后把结果写进 progress-log.md（"同一天"那一段后面），有问题就修；然后更新 roadmap 进度里的"运动模糊""接触阴影"两行。
2. **P4 画面功能接着往下**（roadmap 第三节的阶段表）：SSGI、屏幕空间次表面散射；然后阴影（PCSS、缓存的级联）、大气和天气、材质扩展、GPU 粒子……每项照"做法：先读 Stride 的实现和参考仓库 → 写 → 单测 → Chrome 里看 → 回归 → 推送 → 更新进度"。
3. **P4 底座的剩余**：精灵、TAA 的管线还是第一次用时当场建（精灵透不透明要看贴图，从文件推不出来；TAA 运行中才打开）。
4. **P3 编辑器的剩余**：多选一起改、复制粘贴实体、加脚本组件、往预制体成员下面加实体；然后用编辑器把 P1、P2 的每个样例打开、改、保存、试玩一遍当验收。
5. **遗留的小项**（roadmap 进度第 3 条）：~~粒子和场景里 UI 的点选~~（做了）、富文本（运行时做了，剩编辑器里的可视化编辑）、TouchInputs 样例、MSAA、分簇光照、透明物体的阴影……；csharp-beginner、morph-targets 的截图差比早先的记录高 0.04 到 0.28，原因没查完。

#### 2.4 交接时没跑完的

- 全量回归：跑完了，全部通过（见第 7 节）。唯一没收尾的是接触阴影和运动模糊的画面（2.3 的第 1 条）。

### 交接时的状态

- 定时任务：已停（2026-11-20 10:40 左右）。
- 推送：交接时把 `main` 全部推到了 origin（用户要求），包括还在跑全量回归的 `8749132`、`9c2cdde`、`a2792fe`。
- 全量回归：`99b2cfe`（含 `8749132`、`9c2cdde`、`a2792fe`）在旧机器上 20 个样例全部通过；预算基线跟着重记了（每个样例多两个 GPU 缓冲：接触阴影、运动模糊各自的参数缓冲）。新机器上第一次 `pwsh tools/verify.ps1` 是确认新环境，只有帧时间可能要重记。

## Memory64（2026-11-21）

- 内存上限的测试页 `apps/bench/memory.html`：第一次没封顶、又和 Jolt 的编译并行，机器死机；重启后编译的产物和 emscripten 缓存里 64 位的系统库都写坏了（`libJolt.a` 截断、`libc.a` 认不出），删掉重编。封顶 24 GB、单独跑以后：32 位 4 GB，64 位 16 GB。
- 测速用 Jolt 的 PerformanceTest，Node 里单线程跑三个场景（数字在 decisions.md）。在用户的 Chrome 里跑时测试占满主线程，插件读不到页面；无头 Chrome 里也没拿到结果，没再追：Node 和 Chrome 是同一个 V8。
- 原生模块 0.40.0 起只有 64 位的一份。

## 圆盘、管状光源（2026-11-21）

- 测试场景在营地的页面里拼：一面墙、一块亮面的地板，并排一盏矩形光（暖）、一盏圆盘光（冷）朝下照，一根管状光（粉）。截图里矩形、圆盘只照亮墙的下半截，管子上下都亮；地板上的倒影矩形是方的、圆盘是圆的、管子是一条横的。
- 和点光比亮度：5 厘米长的管子换成同强度的点光，墙上正前方的像素 193 对 177，顺着管子的轴看暗一半（线光源该这样）。
- 耗时：三盏一起照满画面，不透明那一遍 0.091 → 0.428 毫秒；单独开：矩形 +0.10、圆盘 +0.20、管状 +0.06。圆盘的漫反射改成正 6 边形以后 +0.11。

## IES 配光曲线（2026-11-21）

- 单测：绕轴对称的筒灯（水平 1 格、按角度插值、倍数和归一）、四象限对称的灯展开成一圈、TILT=INCLUDE 跳过倾斜数据、不是 IES 和 B 型配光报错。
- 营地的页面里两盏朝下的点光对比：带配光的光斑是窄的、往 +X 拉长、15° 那圈最亮。第一次中心有一道接缝：自己编的测试文件在正下方（0°）不同水平角的值不一样（真的 IES 文件不会这样，那是同一个方向），改了数据就平滑了。
- 编辑器接口导入：合法的 `.ies` 成了 `lightProfile` 资源，乱写的文件报"no TILT= line"、什么也不写。开发服务器第一次起不来：编辑器后端在 Node 里直接加载这个模块，相对导入要写 `.ts` 扩展名。

## 高斯泼溅：第一步（2026-11-21）

- 单测：标准 3DGS 的 .ply（对数缩放、sigmoid、f_dc）写成 .splat 再读回来；PlayCanvas 示例里的 guitar.compressed.ply（参考仓库有的时候跑）解出来的四元数是单位的；不是 .ply、不是二进制小端报错。
- 真实数据：`C:\code\refs\playcanvas-engine\examples\assets\splats\hotel-culpture.compressed.ply` 经编辑器接口导入营地的一个临时目录（2.5 秒），实体绕 X 转 180°（3DGS 的 y 朝下），无头 Chrome 第一次就画对了：雕塑、电梯、楼梯、地砖的反光都在。放一个红盒子进去，雕塑的泼溅挡住盒子的一边，盒子挡住后面的墙。测试的数据没进仓库。
- 耗时：静止 1.86 毫秒（主画面那一遍），相机一直转（每帧重排）时排序 0.41 + 那一遍 1.89 毫秒。
- 第二步高阶球谐：skull.compressed.ply（24.7 万个、3 阶）导入 18.8 MB；无头 Chrome 里同一个角度开、关球谐对比，开着的头骨有一块块金属的高光，平均每像素差 3 个色阶；开销 +0.017 毫秒。导入的单测加了压缩格式的 element sh。
- 验证时 4 个样例的"启动时同步建的管线"超了预算：泼溅渲染器构造时就建了排序的计算管线，改成第一次用到时才建。
- 第三步 `.spz`：PlayCanvas 示例里的 biker.spz（版本 4、15.3 万个、每段 zstd）解开 67 毫秒；和同一场景的 biker.compressed.ply 逐点比：位置差不到 0.1 毫米、颜色差一两个色阶、四元数同向。第一次对比 y、z 是反的（SPZ 是 RUB），读的时候换成 RDF 以后一致。经编辑器接口导入营地的临时目录，两个文件转出来的 `.splat` 一样大（4.3 MB），无头 Chrome 同一个相机下画面平均差 0.63 个色阶、最大 30（量化）。单测：手写一个版本 3（gzip、1 阶球谐）的文件查定点、旋转、坐标换算和球谐变号，示例文件有时比两种格式。
- 第四步 `.sog`：先发现原生工具模块解不了 WebP，StrideNative 0.42.0 加了 libwebp 的解码器（原生的 Node 测试加了一张 1×1 的无损 WebP 和一个坏的）。单测读 PlayCanvas 示例的 bicycle.sog（版本 2、100 万个、3 阶球谐）：四元数是单位的、缩放为正。经编辑器接口导入营地：bicycle.sog（14.8 MB）4.0 秒转成 76 MB 的 `.splat`，无头 Chrome 里自行车立着、辐条清楚；apartment.sog（66 万个）2.1 秒，相机在屋子中间时近处的大泼溅糊满画面（数据本来如此）。

## W1 大世界的底座：第一步（2026-11-21）

- `.world.json`（`content/worldFormat.ts`：格子、图层、索引，`checkWorldFile` 检查）和流式加载（`world/WorldStreaming.ts`，`game.world.load(路径)`、`StreamingSource` 组件、`stride call world`）。
- 新样例 `apps/open-world`（用 `cli.ts new` 建的）：`scripts/generate-test-world.ts` 生成 4 公里见方的测试世界 Worlds/Test（512 个格子场景，1.6 MB）；常驻场景 MainScene 有相机、太阳、物理天空。无头 Chrome 里地面和方块按格子出现；冒烟：相机附近的格子都在，挪到 1.2 公里外那边的加载、原来的卸载。
- 飞过去的测量见 decisions.md 的同名条目。
- D18：Jolt 的 PerformanceTest 用当前 fork 编单精度、双精度两份（wasm64、Distribution、单线程）：Ragdoll 25.13 / 25.12、ConvexVsMesh 111.5 / 110.5、Pyramid 33.2 / 33.5 步每秒；LargeMesh 两份都在 wasm 里内存不够（PerformanceTest 默认的堆）。

## W1 第二步：双精度（D18，2026-11-21）

- 原生（StrideNative 0.43.0）：Jolt 开 `DOUBLE_PRECISION`；变换存储的本地位置、世界矩阵是双精度（`DMat44` 算层级），另存单精度的 `renderWorld`（平移相对渲染原点，`sn_transforms_set_render_origin`）；剔除用它；物理的世界位置按 double 传（物体描述、命中点、射线和球扫掠的起点、瞬移、positions()、重叠查询的原点）。原生测试 20 组、Node 测试 39 个全过，新加一条：2 万公里外的位置留得住毫米，远处的物理和射线照常。
- TS：`Transform.world` 是 Float64Array，多了 `renderWorld`；`Matrix` 的输入接受双精度（`MatrixSource`），multiply、invert 能写双精度；渲染的代码改读 `renderWorld`，玩法的照旧读 `world`；`game.renderOrigin`、调试线、射线、点选、粒子、云、地面天气的图案按原点换算。
- 实测（无头 Chrome，open-world）：相机和方块放到 1000 万米外，渲染原点跳到 (10000384, 0, 10000384)，方块的渲染位置 -383.75（0.25 米的零头保住了），画面和近处一样；相机挪 1 厘米，画面只在方块边上差亚像素（平均差 0.67）。冒烟照过。
- 顺手修的：`stride eval` 的 `frames(n)` 一直是坏的——页面 eval 的作用域"有同名全局就用页面的"，而浏览器自己有 `window.frames`；改成只认函数。`stride eval --check` 的作用域加上样例挂的 `strideEngine`。

## W1 第三步：精度审计、反向 Z、着色器的时间（2026-11-21）

- 用户讲清楚了精度的方向（各种类型的值都按需要做到足够高，见 decisions.md 的"精度"）；过了一遍各种值，不够的两项这一步改了：反向 Z 的深度、着色器的时间按 3600 秒取模。
- D18 那次提交的验证里 ui-element-link 的 FullScreen 场景"跟着按钮"差了 1024：全屏 UI 的元素矩阵在 UI 自己的坐标里，不在渲染空间，链接要按 UI 实体的 `world` 换算；放在 3D 里的 UI 照旧按 `renderWorld`（乘回去正好是世界坐标，远处也准）。
- 单测改了三条（相机的投影反向、视锥平面正反两种都测、粒子点选的管线 greater-equal）。

## W1 第四步：agent 建世界（2026-11-21）

- 后端 `createWorld`、`placeInWorld`，MCP 的 `create_world`、`place_in_world`、`world_info`。
- `apps/open-world/scripts/build-town.ts`：只经 MCP 建世界 Worlds/Town（格子 128 米，地面图层 900 米、楼图层 600 米的加载半径），写材质和模型，按世界坐标放 144 块街区的地面、576 栋楼（离中心近的高），分进 128 个格子的场景，一共约 3 秒。`?world=Worlds/Town` 打开，无头 Chrome 里从城边高处看过去 106 个格子加载着，街道、楼、影子都对。
- 反向 Z 那次提交的验证（14 个样例）全过。
- 第五步编辑器的世界视图：主 Chrome 里开编辑器，资源浏览器双击 Town：常驻场景打开、编辑相机附近的楼一起显示；加一个实体、位置设成 (300, 0, 300)，点"放进世界"，状态栏"1 个实体放进了世界的 1 个格子"，场景树里它没了，磁盘上在 Worlds/Town/ground/2_2 里、本地 x 是 44（300 − 2 × 128）。
- 这一步的验证里 topdown-rpg 的"鼠标指着箱子时高亮"挂了：反向 Z 以后屏幕射线的起点终点反了，修了射线和 3D UI 的指针；topdown-rpg、csharp-intermediate、physics-sample、ui-element-link 重跑都过。



## W2 矢量地形：第一步（2026-11-21）

- 原生：`sn_terrain_create`、`sn_terrain_height`、`sn_terrain_heights`（任务，输出一页 float），JS 的 `createTerrain`、`TerrainEvaluator`；测试：压平的多边形里逐位等于目标高度、页和单点同值、相邻页接缝逐位相同、两万公里外隔半米的两个点高度不同又连续。单线程每百万个点 0.7 秒（10 层），64 页 131² 并行 114 毫秒。临时版 `native-dev-3515fee7ef`。
- 引擎：`.terrain.json`（`checkTerrainFile`）、`Terrain` 组件、`TerrainAsset`、`game.terrain`（`terrain/TerrainSystem.ts`，四叉树和网格是纯函数 `terrain/terrainTiles.ts`），调试命令 `stride call terrain`（`height: [x, z]` 问地面高度）；`Mesh.dispose`、`ResourceTable.remove`。
- 编辑器：资源浏览器能新建地形，属性面板改噪声的参数（地物、笔画先按 JSON 改），改了热重载。
- `apps/open-world` 的 `?world=Worlds/Valley`（常驻场景 Valley：16 公里见方、10 层噪声、一个 240 × 160 米的广场压平、一笔抬高 260 米的山）。主 Chrome 里看过：山、压平的台地、抬起来的山包都对；328 块、静止 8.4 毫秒一帧（120 Hz 封顶），GPU 2.4 毫秒，绘制 1262 次（阴影 1047）。无头 Chrome 里每帧挪 25 米（3 公里每秒）飞 240 帧：p50 8.4、p95 16.6 毫秒，地形的每帧更新 1～2 毫秒、最多 4.2；缓存满 768 块以后按最久没用的释放。
- 编辑器（主 Chrome）：打开 Valley 场景，地形在视口里流式画出来；选中地形实体，属性面板是中文的地形字段；资源浏览器点地形资源，属性面板改噪声的偏移 -60 → 200，存盘、视口里的山整体抬高（328 块重建完、没有在算的）。编辑相机在地下时只看得到裙边（从下往上看地面是背面），不是错。

- 第二步（同一天）：块改成实例化（共用高度场网格加高度页，见 decisions.md）。主 Chrome 里看过画面和第一步一样（台地、抬起来的山、噪声的形状）；无头 Chrome 量（同一个场景、1400 × 800）：一帧的绘制 1262 → 28 次（阴影 1047 → 4、深度预通道 1、不透明 2），CPU 画 3.2 → 0.98 毫秒，GPU 2.4 → 0.83 毫秒（阴影 0.37、不透明 0.29）；每帧挪 25 米飞 240 帧 p50 8.3、p95 9.8 毫秒，超过 14 毫秒的只有两帧（开头建状态那帧地形 6.2 毫秒）。主 Chrome 量出一秒一帧是窗口被挡住、Chrome 节流（更新 1 毫秒、画 2 毫秒），不是地形慢。另：Valley 地形文件里提交进去的噪声偏移是热重载测试时的 200（验收的内容备份还原把它带回来了），改回 -60。

- 第三步碰撞（同一天）：测试浏览器里在相机前方 30 米的地面上空 20 米放一个半径 0.5 的球，4 秒后停在 y = -9.538（地面 -10.045 加半径 0.5），滚了 1 米；从上往下的射线打到 -9.574（求值器 -9.5737，高度场量化差 0.7 毫米），报的实体是地形。帧率 119.5、p99 8.5 毫秒。

- 第四步雕刻的增量重算（同一天）：测试浏览器的编辑器里打开 Valley，编辑相机放到广场前上方，经 MCP 的 `sculpt_terrain` 在广场前抬一笔（半径 80 米、40 米高）：视口里马上鼓起一座小山，别处和之前的截图一样；重算 19 块（画着 292 块、缓存着 587 块），碰撞块不在范围里、没动。相机正下方压一笔（半径 30 米）：重算 15 块、碰撞块 6 块。`undo: 2` 撤掉两笔：重算 25 块、碰撞块 6 块，文件和提交的逐字节相同。`stride call terrain` 加了累计的 `built`（算过几块、几个碰撞块），看雕刻时重算了多少。
- 第五步视口里的雕刻笔刷（2026-11-22，无头 Chrome 里的编辑器）：打开 Valley、选中地形，属性面板点"雕刻"：视口工具条换成抬高、压低、压平、磨平，半径 40、强度 4，"1 笔"、"完成"，状态栏是操作说明；光标下贴着地面画出笔刷的圈。从 (600, 600) 拖到 (850, 560)：文件多了 14 笔（坐标留厘米），重算 130 块；强度改成 40 再拖一遍，视口里沿着拖过的地方鼓起一道土埂，拖的过程中帧时间 p50 8.3、p95 8.5、最长 16.6 毫秒（120 Hz）。Ctrl+Z 一步撤掉一拖（40 → 15 笔），Ctrl+Shift+Z 重做；撤到底文件和提交的逐字节相同，点"完成"退出。
- 第六步视口里拖地物（2026-11-22，测试浏览器里的编辑器，用户看着）：雕刻的工具条换到"地物"，广场的轮廓贴着地面画出来、角上有小圈。拖右前角：文件里那个角变成 (139.75, 202.58)，压平的范围跟着变；按在广场里拖：四个角一起挪了 (-38.77, 79.45)，重算 259 块，拖的过程中帧时间 p50 8.3、p95 8.5 毫秒。"新建地物"在光标指过的地面上放了一个 80 米的方块（高度取那里的 23.04 米），工具条上改成 60 米；在它的边上双击加了一个角（边的中点 (77.12, 371.53)），拖出去成五边形；"删除地物"、Ctrl+Z 撤回来。调的时候发现两个毛病：在 600 米外点边按米算差了 9 米（改成按屏幕像素）；同一帧里按下又松开时拖没结束，第二下点不进来（拖的状态改成处理按下之后再读）。都是用 `stride debug` 的日志点在编辑器视口的 iframe 里查出来的（先修了日志点在 iframe 里不工作的毛病，见下面调试工具一节）。
- 第七步材质按坡度和高度的规则（2026-11-22，测试浏览器里的 Valley，用户看着）：相机放在 (250, 300, 450) 看抬高 260 米的山。换上"高山地形"之前整片是一样的绿；换上以后平地是有斑块的草，山坡陡的地方是岩石（边界跟着坡度、山脚是自然的波浪），山顶较平、高过 180 米的地方是雪；岩石第一版太亮发粉，调暗了一档。同一个视角量 GPU：不透明那一遍草 0.94 毫秒、高山地形 1.53 毫秒，一帧 8.4 毫秒（120 Hz）。顺手核对了节点图每个像素只算一次（`layerNormal` 先调 `materialGraph()`，后面各层的函数只读算好的变量）。单测加了一条：坡度、高度遮罩和世界 UV 编出来的代码、两个遮罩共用一份 `graphRange`。材质库的缩略图（球）上看出两个毛病：朝下的面夹角超过 90° 又落回平地那一档（球的下半是草）——改成朝下的面算 90°；过渡以边界为中心，范围顶到 0° 或 90° 时平地、竖直面上的遮罩只有 0.5（下半是草和岩石各一半的橄榄色）——顶到头的那一头不过渡。修完缩略图只有球顶一圈是草。
- 第八步侵蚀（2026-11-22）：原生的冲沟（native-dev-4479dd11e9）。第一版在测试浏览器里看，平地上冒出一片片带尖的小坎；写了个离线的山影图（Node 里用本地编的原生模块求 3 公里见方、600 × 600 个点，画成 PNG），一眼看出满地弯弯曲曲的断线——是方向场的跳变：第一层的方向取自带棱的底，下一层按条纹坡的符号转向。方向改成三层的底、隔 125 米中心差分，按 sin 本身转向以后断线没了、冲沟成了分叉的树枝状；剩下的细棱（截断、绝对值的折痕）在 3D 里是锯齿，改成平滑的版本。Valley 的冲沟定成深 22 米、最粗间距 500 米、三层：同一个视角不带冲沟是一片缓坡，带上以后坡上一道道顺着下坡的沟，只有一处陡的地方还有一点锯齿。每秒 3 公里飞过去 p50 8.3、p95 10.3、最长 17 毫秒（之前 p95 9.8），算的块排满 8 个。求值每百万点（单线程）不带冲沟 0.77 秒、带上 3.73 秒（第一版 4.85：指数换成多项式的核、方向只算一半的层数）。原生测试加了一条：确定性、和不带冲沟的差不超过深度、页和单点一致、压平照旧。
- 顺手修的编辑器问题：资源浏览器只在名字的文字上接双击，点行的空白处打不开——vue-tsx-pro 的 Tree 加了 `onActivate`（双击整行、回车），资源浏览器和场景树的子场景改用它；资源浏览器选中时才出来的"移动、改名"一栏让下面的列表往下跳一行，双击的第二下落到别的行上（`stride page click --count 2` 记录的事件：第一下点在 MainScene、第二下点在 Worlds），改成这一栏一直占着位置。另：编辑器打开 Valley 时编辑相机在 (0, 30, 0)（还是页面先打开的 MainScene 的视角），广场是 40 米高，相机在地下、看到的是地形的背面和裙边——改成编辑相机按文档记视角（`EditAgent.open` 的 key，编辑器给资源路径）：没看过的文档从它的主相机看起，看过的回到上次的视角。无头 Chrome 里：打开 Valley 是 (0, 180, 600)；挪到 (500, 400, 500) 后开 MainScene 是 (0, 30, 0)，再开 Valley 回到 (500, 400, 500)。

## 调试工具：像人一样操作页面、调试桥多会话（2026-11-21，用户要的）

- 调试桥扩展装进了测试浏览器（`stride open` 的配置目录），0.2.0 起改了文件自己重新加载（0.2.0 → 0.3.3 一路没人点刷新）；0.3.0 起多会话（同一个标签几个会话一起用，最后一个断开才真断开；两个 `cpu-profile` 同时跑，第二个等 Tracing 空出来再录，分别 415、592 帧）；内容脚本也注入编辑器视口的 iframe。
- `stride page`（照 Claude in Chrome 的能力）：无障碍树带编号、按文字找、真实的点击、悬停、拖动、滚轮、按键、打字、截图（按 CSS 像素，高分屏也对得上坐标）、在编辑器界面那层求值；操作时画一个 agent 的橙色指针（平滑移动、点击波纹、按键标签）。在编辑器上实测：读出主工具条、场景树、资源树、视口工具条的按钮和字段；点资源树、库窗口滚轮、Ctrl+K 搜 valley 都对。`stride front` 把后台的游戏标签切到前面（后台标签不出帧）；`stride open` 的 Chrome 加了不节流被挡住窗口的参数。
- 顺手修的编辑器问题（用 `page eval` 找出来的）：库窗口声明了自己管滚动却没有滚动区，下面的材质滑不到，改成卡片网格在 ScrollArea 里、上面的切换按钮固定；编辑器页面的 html、body 不再滚动（整页多出来的浏览器滚动条）。

- 调试桥 0.4 直连中枢（同一天）：扩展的 service worker 拿页面转交的桥票连开发服务器的中枢，CLI 的 DevTools 会话经中枢直接到扩展，不经过页面的 JS（断点停住时也能发命令、事件收得到）。实测时修了三处：扩展重新加载后新的内容脚本错过了票（页面只发一次）→ 内容脚本向页面要（0.4.1）；中枢把扩展的回复整个展开转给 CLI，回复里中枢自己的编号盖掉了 CLI 命令的编号，`front` 一直等到超时；`stride page` 里 `await using` 的会话在 `return pageEval(...)`（没 await）时就释放了，WebSocket 先关、命令没回复（经页面转发的旧路径同样有竞争，只是 detach 慢一步没暴露）。修完测试浏览器里 `front`、`page eval`、`page click`、`cpu-profile` 都经直连走通，编辑器的视口 iframe 也连上了。0.4.2：`front` 把最小化的窗口还原；直连的命令也查文件指纹自己更新。

## W3 样条网络：第一步（2026-11-22）

- 格式和几何：`content/splineFormat.ts`、`modeling/spline.ts`（采样、拉伸、立柱、导线）、`pipeline/src/splineModel.ts`；编辑器后端的烘焙表、新建资源（一段弯的 6 米宽的路）、字段描述（横截面是按 type 分的联合）、中文。单测：路径经过控制点、等距、right 水平、侧倾、首尾相连；道路的宽度、三角形朝着法线；围栏立柱数、导线中点下垂；烘出电杆、导线两个槽。
- open-world 的 Valley：广场上一条 S 形的路（7 米宽）、一圈圆角的围栏（每 3 米一根立柱、两根横杆）、一条架空线（每 40 米一根 10 米的电杆、三根导线下垂 1.2 米）；写进文件以后开发服务器的编辑器后端马上烘出模型（13、141、32 KB）。测试浏览器里看过：路、围栏、电杆和导线都在，帧时间 p50 8.33、p95 8.47 毫秒，绘制 36 次。字段检查（`check-fields.ts`）所有工程 0 个问题。

- 第二步地形贴着样条（同一天，native-dev 见 pnpm-workspace.yaml）：原生的折线地物（贴合、只削、只填，每个点的高度，线段的格子）加测试（路面上逐位是路的高度、过渡带、只削只填、2000 个点 20 公里的长路）；地形文件的 `splines`、加载时解析（`terrainPath`）、增量重算比较路径、资源引用、字段和中文。Valley：广场上的路压平（本来就在广场上），从广场东边下去一条 7 米宽的路翻过起伏（控制点的高度按路线上量的地面定，最低处路比地面高二十多米），过渡 25 米。测试浏览器里看：之前是广场边上自然的坡，之后路贴着地、下面填起一道路堤，边坡陡，按高山地形的材质规则成了岩石；控制点处地面正好比路面低 0.1 米（3.899、1.9）。编辑器里只改样条文件（末端挪 10 米）：地形跟着重新加载，重算 29 块（画着 300 多块），挪过去的末端下面地面 -1.1。
- 第三步视口里编辑控制点（同一天）：`editor/SplineEditTool.ts`（点路径、加点删点、拖的结果落到点上），多边形编辑拖顶点的 `transformVertices` 改成通用的 `transformPoints`（顶点、控制点共用），`modeling/spline.ts` 拆出 `splinePoint`、`splineCurve`（画路径、加点用）；`EditAgent.splineEdit`、视口的样条模式、编辑器的"编辑样条"按钮和工具条（几个点、删除点、完成），撤销重做、Delete 删点。测试浏览器里 Valley 的 EastRoad：点选第二个点、拖 Y 轴从 26 米抬到 73.7 米，文件存了、模型重新烘、路堤跟着隆起；Ctrl+Z 回到 26；双击第二、三点之间的路径加了 (258.262, 15.017, -62.203)，在路径上；Delete 删掉它回到原样。
- 第四步路口（同一天，native-dev 见 pnpm-workspace.yaml）：`.spline.json` 的 `branches`、道路横截面的 `cornerRadius`，`modeling/spline.ts` 的 `roadNetwork`（焊点、路口的截断、轮廓和路缘，拉伸去掉路口剩下的段）、`splineCenterlines`（地形贴的线），地形的 `terrainPaths` 改用它；原生的 `ApplyPaths`（连着的折线地物一起算）加测试（丁字路口：主路的路面上和没有岔路时差不到 1 毫米）；编辑器的样条模式认分支（扁平下标、焊着的一起拖和删、加点加在对的路径里），工具条"拉出分支"、点数算上分支。Valley 的 EastRoad 在 (320, 6, -75) 往南岔出一条（丁字路口）、在 (500, 4, -40) 穿过一条南北向的路（十字路口）。测试浏览器里看：第一版路口东边那条路埋在地下（岔路的过渡带把地面拉高了 0.55 米）→ 原生一起算以后路面下处处 0.1 米；路口里转角冒出草 → 地形加了端口 → 中心的辐条（一条路径一条折线，不然端头重叠又冒出来）和路缘（多压 0.2 米），之后近看、俯视都干净。路网烘一次 12.6 毫秒（6434 个三角形），中心线 2.5 毫秒；画面 120 Hz、p99 8.5 毫秒。编辑器里选中点、点"拉出分支"文件多一条分支、地形跟着重算，Ctrl+Z 回去。
- 第五步车道图（同一天）：`modeling/roadLanes.ts`（路段的车道按方向和下标偏移、路口的连接车道、焊点直连、首尾相连的路径接回起点）加测试；道路横截面的 `lanes`、`oneWay`（字段、中文）；`ContentManager.loadSpline`（地形贴样条也改用它，资源改了照常 evict）；页面命令 `lanes`（报车道、连接车道、总长、尽头，按时长画出来，带方向箭头）；编辑器的样条模式画车道（按样条对象缓存）。测试浏览器里 `stride call lanes {"spline":"Splines/EastRoad","entity":"EastRoad"}`：12 条车道、18 条连接车道（丁字路口 3 × 2、十字路口 4 × 3）、5 个尽头、总长 3132 米；俯视十字路口：两个方向的箭头靠右，每条驶入的车道右转、直行、左转各一条，没有掉头。算一次 1.9 毫秒（30 条、1744 个点）。
- 第六步列车（同一天）：`trains/Train.ts`（`trainSchedule`、`trainStateAt`，`Train`、`TrainDoor` 脚本，在 Game 里登记）加测试（停站开门、梯形曲线、往返、短距离加不到限速、没车站时两头往返、绕圈）；样条成了脚本能引用的资源种类（`prop.asset('spline')`，SceneAssetKind、场景的预加载）；编辑器的中文字段名。Valley：一条 1 公里的铁路（`Splines/RailLine`，坡度 4% 左右，地形贴着它），西站（260 米）、东站（760 米）各一个站台（顺着轨道的坡）和 6 扇屏蔽门，一列三节的车（每节两扇门）。测试浏览器里看：停站时车门、屏蔽门一起滑开 1.3 米，25 秒后关上，车加速开走（50 秒时 19.9 米每秒、在 580 米处），120 Hz、每帧 update 0.17 → 0.25 毫秒；编辑器的属性面板画出 Train 的字段（车站的列表、最高速度……）。第一版生成场景时把脚本写在了实体上（应该在 `components.scripts` 里），加载时被悄悄忽略——`tools/editor-accept/check-fields.ts` 本来就会报这个，生成完先跑它。

## W4 程序化摆放和植被（2026-11-22）

- `content/scatterFormat.ts`（ScatterFile、检查）、`terrain/Scatter.ts`（`Scatter` 组件、`ScatterAsset`、纯函数 `scatterCell`、`ScatterSystem`）加测试（密度、格子怎么切都一样、换种子不一样、坡度高度离路成片的筛选、顺着坡的旋转、文件检查）；`ContentManager.loadScatter`、场景的组件、资源引用（场景 → 摆放 → 模型）、`Game.scatter`（地形更新以后、变换更新以前）、调试命令 `scatter`；编辑器：新建"程序化摆放"、字段描述、中文（`cellSize` 的中文名改成通用的"格子大小"，体素也用它）。第一版的网格范围算错了（四个 32 米的格子拼不出一个 64 米的），测试抓到的。
- Valley：SDF 的松树（树干加四层针叶，0.2 米的网格，6 KB）和石头，`Scatter/Valley.scatter.json`：松树每公顷 120 棵、坡 32° 以内、170 米以下、成片盖住 45%，石头每公顷 12 块、坡 12°～60°、顺着坡、埋进去一点。测试浏览器里看：广场里、路上没有，松树一片一片的，石头在坡上；1700 个实例，静止 120 Hz（update 0.44 毫秒，其中原生的变换和剔除 0.63），每秒 50 米飞过去 120 Hz、update 的 p99 4 毫秒（撒格子的 2 毫秒预算加建实体）。编辑器里改密度（120 → 40）马上重撒：1704 → 704 个，改回来又是 1704 个。观察点没挪、格子都撒好时不重选格子（update 0.51 → 0.44 毫秒）。
- 工具：CI 上 csharp-intermediate 的失败查清了——不是卡住：过了的那些次作业也要 12～29 分钟（随运行器的快慢），最近两次是被每个样例 1500 秒的上限掐断的；作业的时限改成 45 分钟、每个样例 2400 秒（5d93890）。

- 第二步参数化的树（同一天）：`content/treeFormat.ts`、`modeling/tree.ts`（生长、枝的圆管、叶片卡片，加测试：顶点数、同种子同一棵、换种子不同、绕向、针叶树的树干收到梢和侧枝越往上越短、文件检查），`modeling/meshBuilder.ts`（从 spline.ts 挪出来，样条和树共用），`pipeline/src/treeModel.ts`，编辑器后端的烘焙种类 `tree`、新建"参数化的树"、字段、中文、资源引用（树 → 材质）。Valley：`Trees/Oak.tree.json`（三层，叶簇的 SVG）、`Trees/Pine.tree.json`（针叶树，针叶的 SVG、枝条略下垂），摆放里的松树换成它、加一层橡树（每公顷 40 棵、成片）。测试浏览器里看：林子里橡树一团团的叶子、松树一层层的枝；针叶第一版太密（卡片像实心的方块），第二版太稀（远处像枯树：细线在 mip 里被挖没），第三版粗一点的针叶加更多卡片。3900 个实例、84 次实例化的绘制，120 Hz（GPU 上阴影 2.0、不透明 1.6 毫秒）。
- 第三步植被的风（同一天）：材质的 `wind`（资源格式、`Material.wind`、`setWind`、加载、字段描述和中文），`RenderSystem.wind`（Game 每帧从 game.wind 写：速度乘阵风），视图的 uniform 多一个 `wind`（VIEW_FLOATS 288 → 292），材质的 uniform 多一个（576 → 592 字节）、顶点阶段也看得见（第一次没开可见性，管线校验报错，页面里看出来的），网格着色器的 `windSway`（transformVertex 和上一帧的位置都过它）。Valley：树皮、橡树叶、针叶的材质 bend 0.45、叶子抖 0.08 和 0.03，加一个 7 米每秒、阵风 ±50% 的风区。测试浏览器里看：隔 0.7 秒的两张截图相减，树冠的边都在动、地面不动，叶子不离开枝；14 米的松树顶上摆 0.4～0.6 米；120 Hz。
- 第四步草（同一天）：摆放层的 `grass`、`material`、`cellSize`（格式、检查、字段、中文），`ScatterAsset` 带每层的材质，`ScatterSystem` 撒草的格子（`#buildGrass`：先建格子的实体，工作线程上的高度页好了再撒、合成网格挂上去，那时格子已经拿掉就不挂；拿掉格子时放掉网格），`gridGround`（高度页插出高度和法线）、`grassBlades`（草叶合成网格）加测试；材质的风加 `mode: 'grass'`（着色器的 windSway 多一个 UV 参数）；成片的阈值按点抖 ±0.08（斑块的边渐稀，树、石头也是）。Valley：`Textures/GrassBlade.svg`（根深梢浅的渐变）、`Materials/GrassBlades`（两面画、风的草模式），摆放加一层草：每平方米 40 片、50 米以内、坡 35° 以内、成片盖住 70%。测试浏览器里看：第一张在地下（相机比地面低），双面的草叶从下面看像飘在天上；第二张在广场上（压平的地物里不撒，对的）；第三张在橡树林边：一片草地、斑块的边是硬线 → 抖阈值以后渐稀。隔 0.6 秒的两帧相减，草梢和树都在动。120 Hz，不透明那一遍 1.8 → 2.1 毫秒。
- 第五步细节层次（同一天）：摆放层的 `lods`（格式、检查、字段、中文），`lodTier`（带回差）、`keepOf`，`ScatterAsset.models` 变成每层每个层次，格子记着层次、变了重撒，草的格子换层次时旧的留到新的好了；`scatterCell` 多一个 keep；树的每根枝自己的随机数（测试：少长一层，树干和第一层枝除了梢以外逐位相同）；草合网格挪进 update 的预算（`#ready` 队列，编辑器按需出帧时叫醒一帧）；`scatterCell`、`grassBlades` 去掉逐点建的对象（实例带上地面的法线，草叶不再取一次地面）：一个 16 米格子 4755 片草，摆 9 → 7 毫秒、合网格 14 → 3.5 毫秒。Valley：`Trees/OakFar.tree.json`、`PineFar.tree.json`，松树、橡树 120 米外换远处版，草 25、38 米外留 1/2、1/4，草的格子 8 米。测试浏览器里：同一个俯瞰的视角阴影 2.22 → 1.09 毫秒、不透明 2.14 → 1.97；飞过去第一版一帧卡到 92 毫秒（草在回调里合网格）→ 挪进预算 33 → 再去掉对象、格子 8 米以后 p99 8.5 毫秒；地面上看草往远处渐渐变稀。中途电脑死机重启：工作区的改动都在（文本文件没有截断、零字节），重跑类型检查、测试、字段检查都过，页面里重看一遍 120 Hz。
- 第六步细叶子保覆盖率（同一天）：网格着色器的 `baseColor` 里有 Alpha 裁剪时按 mip 级放大 alpha（`ALPHA_MIP_SCALE` 0.25，导数在材质参数决定的一致分支里求）。测试浏览器里同一个远看林子的视角 A/B：关掉时后排的树、远处的松树稀、透得见后面，开着时树冠是满的；帧时间不变（不透明 1.52、阴影 1.19 毫秒）。CI 上 261486c 的 physics-sample 冒烟"点中的箱子被推起来"第三次尝试没过（软件 WebGPU 的时序，和这几步无关），看下一次还出不出。
- 第七步只重撒改到的（同一天）：`ScatterSystem.#carryOver`（规则、模型、材质、种子、格子大小都没变的层留下格子；地形用 `changedRegions` 求改动范围，盖到的格子加上离路的距离标成 stale，下次选格子时重撒、新的好了再拿掉旧的；地形的底变了全部拿掉），调试命令 `scatter` 报上一次换版本时留下、重撒、拿掉了几个（`lastChange`）。测试浏览器的编辑器里：在相机附近的地形文件里加一笔，374 个格子标 6 个、重撒 6 个；加在撒的范围外：一个都不重撒；只改石头那层的密度：304 个留着、70 个重撒。
- 第八步局部风区也吹植被（同一天）：`RenderSystem.wind.locals`（Game 每帧取离相机最近的 4 个，强度乘它自己的阵风），视图的常量多 4 个中心加半径和一个强度（VIEW_FLOATS 292 → 312），着色器的 `windAt`、`VEGETATION_LOCAL_WINDS`；`WindField` 的说明写明坐标是渲染空间的（第一版把中心再减了一次渲染原点，测出来差 1024 米，查下来风场本来就在渲染空间里，和粒子一致，改的是植被这边）。Valley 加 `Downwash`（球形、20 米每秒、半径 30 米、阵风 ±30%）。测试浏览器里暂停后比较：风区开着和强度设成 0 的两张截图相减，只有风区里的橡树和草在变（地上亮的是它们的影子跟着动）；120 Hz，阴影 1.18、不透明 1.90 毫秒，和没有风区时一样。
- 第九步远处卡片（同一天，W4 做完）：`rendering/mesh/Impostors.ts`（`ImpostorBaker`，`renderSystem.impostors`）：模型临时挂在烘焙的渲染组（`RENDER_GROUP_BAKE` = 30，相机的视图按场景的掩码再去掉它，`RenderView` 默认的掩码也不含它）上，下一帧前向渲染器多 8 个正交视图（`RenderView.windless`：烘的时候不吹风），用新的阶段 `RenderStage.impostor` 画进一张 2048×256 的图集（网格着色器的 `fsImpostorBake`：材质层混过的漫反射色、Alpha 裁剪；第二张是视图框架里的法线加粗糙度），透明的像素按最近的不透明像素填色（往下的 mip 不混黑），再下一帧 `replaceLevel0` 拷进卡片材质的两张贴图、GPU 上出 mip。卡片的网格 `MeshData.impostor`：四个顶点都在中心、法线的 xy 是角的偏移，`vsImpostor` 按相机绕竖直轴转（正交的视图——阴影、天空遮挡——整个转向光），按方位角选格子，切线框架就是卡片的右和上，植被的风照常弯。摆放层的 `lods[].impostor`（格式、检查、字段、中文），`ScatterSystem.#modelOf`：第一次要时开始烘，烘好前用近一层的，烘好后各个摆放重选格子；编辑状态下按需出帧时烘焙期间一直出帧（`holdFrames`）。调试命令 `scatter` 报还在烘的个数。第一版循环引用（RenderSystem → Impostors → meshShader → RenderSystem）页面里报 `MAX_DIRECTIONAL_LIGHTS` 没初始化，格子数挪进 `Mesh.ts`。Valley：松树、橡树 220 米外换卡片、可见距离 350 → 700 米。测试浏览器里看：烘出来的图集 37% 不透明、颜色是叶子的绿；180 米高俯瞰时视野里的树全是卡片（把卡片的实例藏起来，树就全没了），和近处的真模型看不出分别；地面高度看远处山坡上的林子和近处的树接得上；5800 张卡片一共 1.2 万个三角形，换掉的是约 800 万个三角形的远处模型（PineFar 1640、OakFar 506 个三角形一棵）；120 Hz、GPU 3.7 毫秒（3840×1810）。编辑状态（`?stride-edit`）下也烘完、画上。CLI 的 `pick` 等不到结果是因为页面在后台不出帧（`visibilityState: hidden`），不是缺陷。
- 工具：编辑器后端打开工程时补烘开着时没看到的改动（开发服务器停着时 agent 写了树、白盒这些的源文件，模型还是旧的）：按内容的哈希比上次烘的（记在工程的 `node_modules/.cache/stride-editor/bakes.json`；不用文件的修改时间，新检出的工作树里靠不住），没记过的模型在就当是对的。实测：第一次启动什么都不烘，停着时改了橡树的种子再启动烘 1 个，改回来再烘 1 个。
## W5 程序化建筑和城市（2026-11-22 起）

- 第一步单栋建筑的文法：`content/buildingFormat.ts`（BuildingFile、图案的解析 `parseFacadePattern`、检查）、`modeling/building.ts`（体块的底面和退台 `insetPolygon`、立面的框架（从外面看 u 从左到右）、一层的铺法 `layoutFloor`、构件的几何、屋顶），`pipeline/src/buildingModel.ts`，编辑器后端的烘焙种类 `building`、新建"程序化建筑"（三层的小楼）、字段（底面、屋顶、立面规则、构件按 JSON 改）、中文、资源引用（建筑 → 材质），MCP 的 `write_asset` 写文法出模型（加了测试），引擎的测试（图案、铺满、退台、高度、玻璃凹在墙里、三角形的绕向和法线一致、尖顶和圆的底面、检查）。第一版构件的窗框宽度和"窗框用哪个材质槽"都叫 `frame`，后端生成时报错才看出来，材质槽改成 `slots: { wall, glass, frame }`。Valley 的广场：`Buildings/Tower`（三层裙房、16 层玻璃幕墙退 4 米、两层冠顶的钢鳍片加玻璃穹顶）、`Rotunda`（28 边的圆楼、底层一圈门、上面退台、钢的穹顶）、`Apartment`（六层，窗和阳台交替、腰线、女儿墙）、三栋挨着的 `Shophouse`（店面、带小阳台的窗、尖顶）。测试浏览器里看：窗洞凹进去有阴影、阳台的栏板、腰线、穹顶的高光都对；尖顶从墙脚看不见（坡面在檐口后面），从高处看得见。全景 120 Hz，GPU 3.6 毫秒（不透明 1.8、阴影 0.8）。三角形：塔楼 2.3 万（窗框和幕墙骨架是 1.96 万），公寓 1.2 万。
- 第二步沿街摆楼（同一天）：`content/cityFormat.ts`（CityFile、检查）、`modeling/city.ts`（纯函数 `cityLots`：沿每条路径两边按 1 米取样、按权重挑楼、矩形和路的线段（网格加速）、和摆下的楼（分离轴）碰了就往前挪 2 米），`city/City.ts`（`City` 组件、`CityAsset`、`CitySystem`：等地形加载好（`TerrainSystem.settled`）、按四个角往下打的地面取最低的放楼、楼是子实体，城市文件、路、模型换了整个重摆，调试命令 `city`），场景组件、加载、资源引用（场景 → 城市 → 路、楼）、字段和中文、编辑器新建"城市"。程序化摆放避开楼：城市系统给出楼的占地矩形和版本、每次改动的范围（`obstacles`、`changesSince`），`ScatterSystem` 换到地形本地坐标，撒的时候离楼 avoidPaths 米以内不撒，楼变了只把盖到的格子标成要重撒。整理先单独提交了：摆放和树里各一份的整数哈希挪进 `data/hash.ts`（这次是第三处要用），样条占地的宽度挪进 `splineCorridorWidth`。Valley：`Cities/EastTown`（沿东路网、东边 500 米见方的范围，联排、店铺、公寓、办公楼多，圆楼、塔楼少）加两种楼 `Buildings/Townhouse`、`Office`。测试浏览器（无头）里看：124 栋楼沿路两边排开、路口留空，平视的街景两边是公寓和联排、路边一条草、远处是塔楼，树和草都没有长进楼里；120 Hz，GPU 2.2 毫秒（不透明 0.57、阴影 1.37）。
- 第三步填街区（同一天）：城市文件的 `fill`（`spacing`、`maxDistance`），`cityLots` 里放一栋楼的判断抽成一个函数，临街一排和填街区共用；填的时候在范围（或路网外扩 maxDistance）里每 spacing 米一个点、按哈希抖动，离最近的路中心线 maxDistance 以内的按由近到远排序，挨个挑楼、朝着最近的路（离路最近的点指向它的方向）放，碰到路、楼就跳过；摆下的楼按 32 米的网格存（以前是挨个比，几百栋时是平方的）。测试：临街那排不变，后面的楼更远、朝着路、不出 maxDistance、不重叠不压路。东路的小镇 `fill: { spacing: 14, maxDistance: 90 }`：340 栋楼（临街 124 栋），俯瞰像一片城，120 Hz，GPU 2.9 毫秒（阴影 1.65、不透明 0.81）。
- 第四步室内映射（同一天）：材质的 `interior`（资源格式、`Material.interior`、加载、字段和中文），材质常量多两个 vec4（592 → 624 字节），网格着色器的 `interiorLight`：只给竖直的面（|n.y| < 0.3），房间的格子按世界坐标（加渲染原点取模的部分）排，射线换到房间坐标里和盒子的五个面求交，按格子（和立面的平面）哈希出墙色、家具的位置、亮不亮灯；没亮灯的房间按窗外的天光（天空的球谐朝外的那一半、环境光）乘 0.35、越往里越暗，亮灯的加暖光；乘 1 − 环境镜面的比例加到颜色上。Valley 的 `Materials/Glass` 换成深色、少一点金属度的玻璃开室内（4 × 3.6 × 5 米的房间）。测试浏览器（无头）里看：白天平视的街上办公楼的幕墙后面一层层的房间、有视差、能看到靠墙的家具；夜里（`stride call sky {"time": 21.5}`）一片亮着的窗户，第一版亮度 2 在夜里的曝光下发白，改成默认 0.5 是暖色、看得出房间的层次（改材质文件以后要刷新页面：楼的模型引用的材质在试玩页不热更新）。同一个夜景视角 A/B：不透明那一遍 0.607 → 0.667 毫秒。
- 第五步构件的随机（同一天）：`.building.json` 的 `seed`，图案的位置可以是候选 `A|B`（`moduleChoices`，检查每个候选都在构件里），铺的时候宽度按第一个候选，生成时按种子、体块、立面、图案的文字和第几列哈希挑。第一版按"第几条楼层规则"挑，公寓的顶层和中间层图案一样却是两条规则，列对不上，改成按图案的文字。测试：同一列每层都一样、同种子同网格、换种子换网格、候选里有不存在的构件报错。Valley 的公寓 `[Window|Balcony Balcony|Window|Window]*`、店铺楼上 `Window|Window|Plain*`：测试浏览器里看公寓的阳台成竖条错落分布、顶层也接得上。
- 第六步双塔、连廊和招牌（同一天）：体块的 `base`（不写时照旧叠在上一段上；写了从那个高度起，之后不写的段叠在它上面；离地的段底下朝下盖一块），构件 `panel`（墙上突出的板：两边、离地、离层顶的距离，突出多少，材质槽），字段、中文、测试（双塔都从地面起到 30 米、连廊在 18～24 米、连廊的底朝下、招牌在第 5 个槽）。Valley 广场中间的 `Buildings/TwinTowers`（两座 22 层、退台、冠顶玻璃穹顶，52 米处 22 米长的连廊，顶层和连廊一圈 `Materials/LedCyan` 的灯带；塔身 `Pane|Pane|Panel` 的候选让幕墙里夹着实墙的竖条）。测试浏览器（无头）里看：白天两座塔、连廊架在中间、灯带一圈青色；夜里窗户亮灯、灯带发光；120 Hz。
- 环境：主 Chrome 里游戏页突然只有 2 fps（空白页 120，CPU、GPU 都闲着，换旧代码、换场景、新标签都一样），`stride open --headless` 起的 Chrome 里 89～120 fps：主 Chrome 的窗口被别的窗口挡住时 Chrome 把它的呈现节流了，不是代码的问题；测帧时间用无头的 Chrome。调试命令 `status`、`perf` 加了 `throttled`：页面看得见、帧间隔超过 100 毫秒而更新加绘制不到三成时，直接说是浏览器在节流、换无头的 Chrome 量；交接文档的坑和 CLI 的说明也写了。

## 调试工具：iframe 里的日志点、调试桥的提示条（2026-11-22）

- `stride debug` 在编辑器视口（iframe）里停下时局部变量全是"Cannot read properties of undefined (reading 'summarize')"，日志点一条也记不下来：值的摘要和日志点用的帮手只事先装在顶层页面里。改成用到时在当前执行上下文里建（`globalThis.__strideDebug ??= …`），收日志时挨个执行上下文（`Runtime.enable` 报的顶层和 iframe）收、清。修完在视口的 iframe 里日志点一次记了 201 条，拖地物的两个毛病就是这么查出来的。
- 调试桥 0.4.3：Chrome 附加调试器期间页面顶上有"正在调试此浏览器"的提示条，每条 CLI 命令附加、断开一次，条一出一收页面高度在 961 和 905 之间来回变、重新布局——截图上量的坐标下一条命令点下去就偏了（点地物的边偏了 45 像素）。最后一个会话断开以后先留着附加 5 分钟，连着的命令之间布局不变（实测：第一条命令以后一直是 905）。
- 调试桥自己更新的毛病：加载时的文件指纹记在变量里，Chrome 把闲着的 service worker 停了再起以后，拿已经改过的文件当基准，就再也发现不了改动（改了 0.4.3 一直还是 0.4.2）。指纹改记在 `chrome.storage.session`，磁盘上 manifest 的版本和正在跑的不一样也算改了。这次是经 `stride open` 的 Chrome 的调试端口让扩展的 service worker 执行 `chrome.runtime.reload()` 换上的。

- `stop-dev.ps1` 把 `~/.stride-ts` 下的 Chrome 都当无头的停，用户正看着的测试浏览器（有窗口、装着调试桥）也被关了；`-Keep` 只管开发服务器。改成按命令行有没有 `--headless` 分：有窗口的叫 test browser、默认留着（`-All` 才停），`-Keep` 按名字留任何一种。

- 测试浏览器的标签越开越多（用户 2026-11-22 指出）：`stride open` 在已经开着的浏览器里每次都开新标签，后台的游戏页还在按满帧率画。改成同源（同一个开发服务器）的标签、空白页优先换成新地址，同源多余的标签关掉，都没有才开新标签（实测连开两次：一直只有一个标签）；`stop-dev.ps1` 停开发服务器时把测试浏览器里开着本机页面的标签关掉（全是本机页面时先开一个空白页，窗口留着）。顺手修了它的一个坑：`Invoke-RestMethod` 把 JSON 数组当一个对象送进管道，要先放进变量再过滤。

## CI 卡住的冒烟（2026-11-22）

- 3b6688c 那次运行的 smoke (csharp-intermediate) 跑了 22 分钟没动静（别的冒烟最长 13 分钟），作业没设时限，GitHub 默认要等 6 小时；main 的并发组不取消正在跑的，后面每次推送都排在它后面（排队的被更新的顶掉，看起来是一串 cancelled）。日志里只有 "running 1 smoke tests"：regress.ps1 一个样例跑完才整段打印，卡住时什么也看不到。手动取消了那次运行。
- 改：CI 的冒烟作业 `timeout-minutes: 30`；regress.ps1 每个样例有时限（`-AppTimeout`，本机 600 秒、CI 1500 秒），子进程的输出写进临时文件，超时杀掉进程树（连开发服务器）、按状态目录关它的无头 Chrome，打印到那时为止的输出（看最后过的是哪一步），算失败。卡住的原因要等下一次复现时看输出。
- 顺手：CI 的 action 从 Node 20 的版本升到 Node 24 的（checkout v7、setup-node v7、cache v6、pnpm/action-setup v6；看过各大版本的说明，我们显式写了 `cache: pnpm`，不受 setup-node v6 只自动缓存 npm 的影响），日志里不再有 Node 20 弃用的警告。

- ac26d90 的 CI 挂在 simple-audio：`stride open` 60 秒没等到页面连上（新的输出捕获把整段日志打出来了），本机 31 秒就过。`open`、`wait` 等页面的时限是写死的 60、30 秒，没看 CI 设的 `STRIDE_TIMEOUT`（300 秒，别的命令都看）：改成也看它。

## W6 水体（2026-11-22 起）

- 第一步湖和海的水面：参考 WickedEngine 的 ocean（`wiOcean.cpp`、`oceanSurfacePS.hlsl`：FFT 的位移和梯度图、屏幕空间网格、平面反射、按水深吸收、岸边泡沫），先做不要计算着色器的那一半：`content/waterFormat.ts`（WaterFile、检查）、`water/Water.ts`（`Water` 组件、`WaterAsset`、`WaterRenderer`：相机为中心的极坐标网格（160 圈 × 192 段，近处 0.4 米、往外按几何级数铺到 extent），顶点里 6 组 Gerstner 波（按世界坐标加渲染原点取模的部分，远处几十个波长外压平），片元重算法线、近处叠 3 组短的波纹；天空的镜面立方体贴图反射、GGX 的太阳高光、菲涅耳混；水下是主画面不透明的拷贝（`Refraction`，现在也拷一份深度：主深度缓冲加 COPY_SRC），按水深偏开、按光在水里的路程吸收；岸边按竖直的水深起泡沫，和地面相交处按水深淡出），合成器在折射拷贝之后、别的透明物体之前画，有水时也要拷（`renderSystem.water.active`）。程序化摆放不往水下撒（`waterAreas`、`underWater`：水体变了整片重撒）。场景组件、加载、引用、字段和中文、编辑器新建"水体"。第一版的着色器里变量叫 `distance`，挡住了内建函数，页面里水的管线建不出来（Chrome 的日志里看出来）。Valley：`Waters/WestLake`（西边洼地，水面 −65 米，六边形的岸线），测试浏览器（无头，1080p）里看：浪、天空的反射、近岸变浅、岸边一圈泡沫、对岸的林子；第一次看湖里长着树，加了摆放避开水。120 Hz，水那一遍 0.087 毫秒。

## CI 提速和 csharp-intermediate 的导航（2026-11-22）

- CI 上 0c68a3f 的 csharp-intermediate 冒烟失败在"导航：角色走到目标"：角色走了 2 米就到了等待的上限。物理每帧最多补 0.25 秒（`maximumTimeToProcess`），CI 的软件 WebGPU 上一帧要零点几秒到一秒，物理只有游戏时间的几分之一，按 15 秒游戏时间等不够（按运行器的快慢时过时不过）。等待放宽到 60 秒游戏时间，快的机器上走到就返回。
- CI 的耗时：一次全量 70 分钟左右，最慢的是 csharp-intermediate（30 分钟）、内容导入（改了 `packages/pipeline` 时缓存整个失效，16 分钟）、csharp-beginner（14 分钟），别的样例 2～5 分钟；后面的推送排在它后面、被新的推送取消，实际只有最新的提交跑完。两个 C# 样例的冒烟只按 CSS 坐标点击、不看像素，CI 上改成半分辨率画（`STRIDE_DPR=0.5`，`regress.ps1` 传给 `stride open --dpr`；CSS 的大小、点击坐标、UI 的布局不变，片元少四倍）。本机按 0.5 跑这两个样例都过。CI 上的效果见下一次运行。
- 以后：内容缓存按样例分（改了导入器只重导受影响的）。

## CI 的软件 WebGPU 提速：调研（2026-11-21，没做完）

- CI 用 Chrome 带的 SwiftShader。它在 x86-64 上用 Subzero 编着色器（`src/Reactor/reactor.gni`：二进制小、只用 SSE4.1，不用 AVX），线程数默认 min(核数, 16)，`SwiftShader.ini` 的 `[Processor] ThreadCount` 能改。
- 想换成 Mesa 的 lavapipe（llvmpipe 的 Vulkan，LLVM 编着色器、用 AVX2，"256 bits"）：WSL 的 Debian 13 装着 Chrome 158 和 mesa-vulkan-drivers 25.0.7。Chrome 在 Linux 上默认只在合成器（Skia）走 Vulkan 时才让 Dawn 用 Vulkan，适配器还要能导入外部贴图（`webgpu_decoder_impl.cc` 的 `CanUseAdapter`）。试了 `--use-vulkan=native --use-angle=vulkan` 加 lavapipe 的 ICD：GPU 进程反复重启、WebGPU 没有适配器，还要再查（看 GPU 进程的崩溃日志、只开 Skia 的 Vulkan）。
- 小测试页（`--headless=new`，限 4 个核同 CI 的运行器）：SwiftShader 1280×720 画 2000 个立方体每帧 91 毫秒、100 万次的计算着色器 136 毫秒。lavapipe 跑通以后用同一页比。

