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
      - ~~冒烟~~（2026-11-19）：22 项。22 个教程场景都能进，11 个主题完成版的玩法各走一遍（UI 的按钮和输入框、触发器、两种射线按层过滤、投影和点地面克隆、异步脚本换材质、子场景和换根场景、动画的淡入和暂停、音乐和发射器、两个相机的锁鼠标和转视角、导航），换一圈教程实体数不变。冒烟脚本共用的页面帮手放进了 `tools/lib/smoke.ts`（`PAGE_HELPERS`）；别的样例的冒烟还各带一份自己的，回头换成共用的。
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
   6. 整理：~~各样例冒烟脚本里自带的页面帮手换成 `tools/lib/smoke.ts` 的 `PAGE_HELPERS`~~（2026-11-20：等帧、合成指针事件、按名字找和点 UI 元素都用共用的，样例只留自己特有的；TPP 以前没有冒烟，补了一个：落地、跑、跳）；文档只留结论。
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
   3. 前端骨架（等框架定下来）：场景树、属性面板（`prop` 的 schema 驱动）、撤销重做、Gizmo、资源浏览器、预制体、播放。和框架无关的先做：~~游戏页面的编辑状态和页面里的代理~~（2026-11-20：`?stride-edit`、`game.editing`、`game.editor`；界面在外面的页面里、把游戏页面嵌进去，试玩是重新打开页面，见 decisions.md 的"编辑器怎么带着游戏跑"）；~~Gizmo~~（2026-11-20：`TransformGizmo` 加代理里的视口操作，点选、拖把手移动、旋转、缩放，一次拖是撤销的一步）；~~属性面板要的字段描述~~（2026-11-20：`editor/fields/index.ts`，引擎的组件照文件格式的类型手写并在类型上核对，脚本的从 `prop` 换算，`checkEntity` 把 20 个样例的 99 个场景和预制体文件查过）。和框架无关的部分到这里做完了，剩下的是界面本身。
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

1. **统计量和预算**：`game.metrics`（`debug/Metrics.ts`）、显存和管线的记账（`graphics/GpuMemory.ts`，套在设备的 create* 上）、`stride metrics`；`tools/lib/smoke.ts` 的 `finish()` 把冒烟跑完时的统计量和 `tools/budgets.json` 的基线比。基线记的时候的数（1280x720）：贴图 5.6 MB（CustomEffect）到 185 MB（CSharpBeginner），TPP 126 MB；当场建的管线 4 到 94 条（CSharpIntermediate 最多）。
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
- `node tools/lib/affected.ts <base> --editor`：改了编辑器时打印 platformer,greybox，不然是空的。

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

页面 `apps/bench` 的 `capabilities.html`（`node tools/lib/run-page.ts http://localhost:5182/capabilities.html capabilitiesResults --error capabilitiesError --screenshot <png>`），无头 Chrome 157，RX 9070 GRE（RDNA 4），1080p，GPU 时间戳取中位数。页面底下画出各项的画面，看过是对的。

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

- 缩略图：`node tools/dev/library-thumbnails.ts` 24 张约 40 秒（材质 0.6 到 1.3 秒一张，节点图的要编管线；特效等 2 秒游戏时间），共 37 KB。看过一遍：玻璃起初是白的（缺 `diffuseShading: false`）、大理石没有纹（改成噪声等于 0.5 的那条线）、石板有黑点（Voronoi 的距离在格子中心是 0，换成不错缝的砖）、布有摩尔纹（格子太密）、特效全是白的大团（大小随时间是直接设的大小，同 Stride；柔和圆点不乘粒子颜色——修在引擎里），都改了重画。
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
1. ~~编辑器的 MCP 服务和命令行的底座~~（2026-11-21：`stride-editor mcp [工程]`，工具是资源的读写、新建、删除、移动、导入，场景和预制体的修改（照字段描述检查），字段描述的 JSON Schema（引擎 `editor/fields/jsonSchema.ts`），截图和页面命令（经调试中枢）；见 decisions.md。还剩：让开着的编辑器界面打开某个场景）：现有的编辑器接口（资源的读写、新建、导入）加上场景文档的修改、打开场景、预览截图；字段描述导出成 JSON Schema。后面每一项的操作都挂在它上面。
2. ~~时间轴资源和编辑器~~（2026-11-21 做完）：轨道（变换、属性、动画剪辑、相机切换、声音、字幕、事件）、关键帧和曲线编辑器、在视口里预览和拖时间；游戏里当过场播放。~~时间轴资源和游戏里播放~~（`.timeline.json`，引擎 `timeline/`：`Timeline.evaluate` 无状态求值、`TimelinePlayer` 脚本当过场放，主画面的相机切换 `graphicsCompositor.mainCamera`；collect-dodge 的开场过场是用 MCP 做的；见 decisions.md）。~~编辑器里的时间轴面板~~（同一天：资源浏览器里打开时间轴，下面显示轨道；拖时间视口预览（不改场景文档）、从时间轴的相机里看；拖关键帧、加删关键帧、给选中实体的位置旋转打关键帧）。~~曲线编辑器~~（同一天：选中的属性轨道按分量画曲线，上下拖关键帧改值，拖手柄改切线，自动、平切线，插值方式；关键帧可以带 in、out 切线，cubic 按 Hermite）。留到后面的：片段的剪切和交叉淡化（做剪辑时，S3）、在面板里加相机、声音、字幕轨道（现在在属性面板里加）、切线两侧分开调。
3. ~~物理相机和景深~~（2026-11-21 做完）：焦距、光圈、对焦距离、快门角、曝光；画幅和安全框；镜头系统（跟随、注视、手持晃动）。~~物理相机和景深~~（Camera 组件的 physical：焦距换视角、光圈和对焦距离驱动景深（薄透镜的弥散圆，半分辨率的散景）、快门角驱动运动模糊、曝光补偿；`stride call lens`；见 decisions.md）。~~画幅和安全框~~（同一天：Camera 的 aspectRatio，主画面框成这个宽高比、以外画黑边，比画布宽时竖直视角相应加大；编辑器工具条的画幅参考线：框出画幅、动作和字幕安全框）。~~镜头系统~~（同一天：CameraRig 组件，跟随、注视、手持晃动，半衰期平滑；是数据组件，时间轴能驱动它的参数）。留到后面的：避障、构图（目标放在画面的几分之几处）、镜头之间的混合、虚拟摄影机（手机的陀螺仪）。
4. ~~离线渲染和导出~~（2026-11-21 做完，验收见下）：~~固定时间步、子帧累积（抗锯齿、运动模糊），WebCodecs 编码加 MP4 封装、混进声音（OfflineAudioContext），图像序列；预设（横屏、9:16 竖屏）~~（2026-11-21 做了：引擎 `offline/`，调试命令和 MCP 工具 `render`、时间轴面板的"出片"，存进工程的 `exports/`；1080p 的 6 秒过场 8 个子帧 5.7 秒出完；见 decisions.md。不做 WebM；渲染队列不单独做，一次一条）。~~验收：S1 的 30 秒短片~~（2026-11-21：`apps/short-film` 的《Evening》，四个机位、角色动画、配乐、字幕、太阳落山；agent 只用 MCP 搭和出片，横屏、竖屏各一份，各约 29 秒出完；人在编辑器界面里拖时间检查、改字幕、按"出片"导出竖屏。为它补了导入带骨骼动画的模型、动画轨道无状态求值，修了从 0 秒开始的声音不放、时间轴面板和属性面板两份内容互相覆盖、嵌套字段太窄、时间轴的实体引用要手敲 id；见 decisions.md）。人那一遍没有从零在界面里重搭一次（逐项确认了每一步界面上都有入口），短片的场景是 agent 搭的。
5. ~~S2 的资源创作工具~~（2026-11-21 做完，验收是 `apps/campsite`；下面是各项），按第三节 S2 那一行的顺序（材质和基本形状在属性面板里编辑已经在 C1 里排了）；每个工具做之前先读 creation-tools.md 里对应的参考。
   1. ~~关卡白盒~~（2026-11-21 第一版：`.brush.json` 存笔刷——方块、挤出的多边形、圆柱、球，按顺序加、减、求交；编辑器后端用原生工具模块里的 Manifold（StrideNative 0.38）烘成同名的模型，平直法线、按朝向投影的世界坐标 UV、每个笔刷一个材质槽；属性面板、MCP 改了马上烘、视口热重载，19 个笔刷烘一次约 25 毫秒；演示 `apps/greybox`；见 decisions.md）。还剩：视口里直接点面加方块、拖手柄改尺寸（CubeGrid 式的交互，现在在属性面板、MCP 里改数）、笔刷的线框和选中高亮、导出成可编辑的网格。
   2. ~~通用节点图框架和材质节点图~~（2026-11-21 第一版：引擎 `content/formats/nodeGraph.ts` 是通用的格式和排序，`rendering/mesh/materialGraph.ts` 是材质的节点库（输入、噪声、Voronoi、砖块、棋盘格、渐变、圆、运算、色阶、颜色渐变、从高度算法线、UV 变换）和编译器；材质文件的 `graph` 编成 `materialGraph()`，当最后一层材质层接进网格着色器，在着色器里直接求值；没有切线的网格按导数现算切线框架；编辑器的节点图面板：拖节点、连线、断开、加删节点、节点上改参数，改了马上热重载；见 decisions.md）。还剩：每个节点的预览图、要烘焙的滤镜（模糊、扭曲）、三平面映射、多段的颜色渐变、把图烘成贴图页、材质库。
   3. ~~在模型上画贴图~~（2026-11-21 第一版：绘制层是一个材质层，遮罩是一张线性 png；`rendering/paint/MeshPainter.ts` 在 UV 空间里光栅化世界空间的球形笔刷（三角形的边再画一遍线补接缝），笔刷落点 CPU 上射线求交；编辑器材质的属性面板有图层栏（加绘制层、每层的颜色粗糙度金属度、画、笔刷的半径硬度强度擦除），视口里拖着画，一笔画完存 png；agent 用调试命令 `paint`（世界坐标的点列）；见 decisions.md）。还剩：节点图做画笔、按曲率和 AO 自动生成遮罩、智能材质（带遮罩规则的图层组）、投影绘制、没有独立 UV 的网格（白盒）先展一套 UV、撤销。
   4. ~~粒子编辑器~~（2026-11-21 第一版：编辑器底部的粒子面板，照 Niagara 的发射器模块栈——发射器页签（加、删）、发射器参数、形状和材质（换种类）、生成、初始化、更新三栏（加模块、上下挪、删）；模块的参数照引擎的模块库 `editor/particleModules.ts` 画，曲线参数是小曲线编辑器（拖点、双击加、右键删），颜色曲线是渐变编辑器；每次修改是场景文档的一步，能撤销、视口里的粒子马上重建；新发射器默认是柔和的圆点（颜色树加了 `computeSoftCircle`）；greybox 加了一个喷泉；见 decisions.md）。还剩：特效预设库、在面板里预览单个发射器（暂停、重播、慢放）、子粒子和导入的游戏模块按 JSON 改。~~序列帧烘焙~~（2026-11-21：粒子窗口的"烘成序列帧"、调试命令 `bake`，引擎 `offline/FlipbookBaker.ts`：另建一份粒子系统固定种子在 CPU 上模拟，正交相机把每一帧画进图集的一格，黑底白底各画一遍反推透明度，按最亮的分量缩进 8 位、放的时候组件颜色乘回去；旁边加一个用一个粒子放它的实体；greybox 的喷泉 16 帧 1024² 烘一次约 0.6 秒；见 decisions.md）。还剩：法线、自发光等别的图，体积流体（EmberGen 那样）。
   5. ~~SDF 建模~~（2026-11-21 第一版：`.sdf.json` 存形状——球、圆角方块、胶囊、圆角圆柱、圆环、椭球，按顺序平滑地并、差、交，`smoothness` 是融合带的宽度；编辑器后端用原生工具模块的 `st_sdf_mesh`（StrideNative 0.39，Manifold 的等值面）烘成同名的模型：光滑的法线（距离场的梯度）、每个三角形用离它最近的形状的材质槽，再按几何误差简化；属性面板、MCP 改了马上烘、视口热重载；greybox 加了一个蘑菇，精度 0.03 米烘一次约 0.3 秒、模型 12 KB；见 decisions.md）。还剩：视口里直接拖形状（操纵器摆每个形状、拖手柄改尺寸）、颜色按融合过渡（顶点色）、展 UV、更多形状（圆锥、多边形挤出、样条扫掠）。轻量多边形编辑是下一项。
   6. ~~轻量多边形编辑~~（2026-11-21 做完：`.poly.json` 存顶点和 n 边形的面，后端烘成同名的模型（三角化、按光滑角的法线、自动 UV、可选镜像，引擎 `modeling/polyMesh.ts`）；编辑操作——挤出、内插、倒角（三个面相交的角）、合并、切割、连接、移动、删面、翻面、换材质——是纯函数（`modeling/polyEdit.ts`），MCP 的 `edit_poly` 调它们；编辑器里模型组件上点"编辑多边形"进视口的编辑模式：点、边、面三种选择（1、2、3，Shift、Ctrl 加选），操纵器拖选中的顶点（移动、旋转、缩放），工具条上的操作按选中的东西可用，松开、做完一步存文件、后端烘（约 20–60 毫秒）、视口热重载，撤销、重做是网格的一步；见 decisions.md）。还没做：环选、刀切、UV 编辑、软选择、顶点吸附、镜像那一半的预览。
   7. ~~音效生成器~~（2026-11-21：声音资源的 `encoding: 'synth'` 存 sfxr 的参数（几十个字节），加载时合成，不要音频文件（引擎 `audio/soundSynth.ts`，噪声按种子、同样的参数出同样的波形）；属性面板上方的音效生成器——拾取、激光、爆炸、升级、受击、跳跃、点选、随机，"变一点"，试听，字段改了自动再放一遍；"新建 → 音效"；MCP 的 `generate_sound`；collect-dodge 的三个音效换成了合成的，删了 wav；见 decisions.md）。
   8. ~~材质库和特效库~~（2026-11-21：编辑器自带 17 种材质（金属、塑料和漆、玻璃、霓虹，混凝土、砖、石板、木头、大理石、布用材质节点图算，都不用贴图）和 7 种特效（篝火、烟柱、蒸汽、火花、魔法光球、浮尘、喷泉），`packages/editor/src/library/`；"库"窗口按类别列出带缩略图的卡片（缩略图用引擎画，`tools/dev/library-thumbnails.ts`），材质拖到视口里的物体上或者选中再点就用上，特效拖到视口里放在放下处的表面上；用的时候拷一份进工程；MCP 的 `list_library`、`use_library`；顺手修了粒子的柔和圆点不乘粒子颜色（颜色随时间不起作用），greybox 的序列帧重烘；见 decisions.md）。
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

- `.world.json`（`content/formats/worldFormat.ts`：格子、图层、索引，`checkWorldFile` 检查）和流式加载（`world/WorldStreaming.ts`，`game.world.load(路径)`、`StreamingSource` 组件、`stride call world`）。
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
- 引擎：`.terrain.json`（`checkTerrainFile`）、`Terrain` 组件、`TerrainAsset`、`game.terrain`（`world/TerrainSystem.ts`，四叉树和网格是纯函数 `world/terrainTiles.ts`），调试命令 `stride call terrain`（`height: [x, z]` 问地面高度）；`Mesh.dispose`、`ResourceTable.remove`。
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

- 格式和几何：`content/formats/splineFormat.ts`、`modeling/spline.ts`（采样、拉伸、立柱、导线）、`pipeline/src/bakers/splineModel.ts`；编辑器后端的烘焙表、新建资源（一段弯的 6 米宽的路）、字段描述（横截面是按 type 分的联合）、中文。单测：路径经过控制点、等距、right 水平、侧倾、首尾相连；道路的宽度、三角形朝着法线；围栏立柱数、导线中点下垂；烘出电杆、导线两个槽。
- open-world 的 Valley：广场上一条 S 形的路（7 米宽）、一圈圆角的围栏（每 3 米一根立柱、两根横杆）、一条架空线（每 40 米一根 10 米的电杆、三根导线下垂 1.2 米）；写进文件以后开发服务器的编辑器后端马上烘出模型（13、141、32 KB）。测试浏览器里看过：路、围栏、电杆和导线都在，帧时间 p50 8.33、p95 8.47 毫秒，绘制 36 次。字段检查（`check-fields.ts`）所有工程 0 个问题。

- 第二步地形贴着样条（同一天，native-dev 见 pnpm-workspace.yaml）：原生的折线地物（贴合、只削、只填，每个点的高度，线段的格子）加测试（路面上逐位是路的高度、过渡带、只削只填、2000 个点 20 公里的长路）；地形文件的 `splines`、加载时解析（`terrainPath`）、增量重算比较路径、资源引用、字段和中文。Valley：广场上的路压平（本来就在广场上），从广场东边下去一条 7 米宽的路翻过起伏（控制点的高度按路线上量的地面定，最低处路比地面高二十多米），过渡 25 米。测试浏览器里看：之前是广场边上自然的坡，之后路贴着地、下面填起一道路堤，边坡陡，按高山地形的材质规则成了岩石；控制点处地面正好比路面低 0.1 米（3.899、1.9）。编辑器里只改样条文件（末端挪 10 米）：地形跟着重新加载，重算 29 块（画着 300 多块），挪过去的末端下面地面 -1.1。
- 第三步视口里编辑控制点（同一天）：`editor/viewport/SplineEditTool.ts`（点路径、加点删点、拖的结果落到点上），多边形编辑拖顶点的 `transformVertices` 改成通用的 `transformPoints`（顶点、控制点共用），`modeling/spline.ts` 拆出 `splinePoint`、`splineCurve`（画路径、加点用）；`EditAgent.splineEdit`、视口的样条模式、编辑器的"编辑样条"按钮和工具条（几个点、删除点、完成），撤销重做、Delete 删点。测试浏览器里 Valley 的 EastRoad：点选第二个点、拖 Y 轴从 26 米抬到 73.7 米，文件存了、模型重新烘、路堤跟着隆起；Ctrl+Z 回到 26；双击第二、三点之间的路径加了 (258.262, 15.017, -62.203)，在路径上；Delete 删掉它回到原样。
- 第四步路口（同一天，native-dev 见 pnpm-workspace.yaml）：`.spline.json` 的 `branches`、道路横截面的 `cornerRadius`，`modeling/spline.ts` 的 `roadNetwork`（焊点、路口的截断、轮廓和路缘，拉伸去掉路口剩下的段）、`splineCenterlines`（地形贴的线），地形的 `terrainPaths` 改用它；原生的 `ApplyPaths`（连着的折线地物一起算）加测试（丁字路口：主路的路面上和没有岔路时差不到 1 毫米）；编辑器的样条模式认分支（扁平下标、焊着的一起拖和删、加点加在对的路径里），工具条"拉出分支"、点数算上分支。Valley 的 EastRoad 在 (320, 6, -75) 往南岔出一条（丁字路口）、在 (500, 4, -40) 穿过一条南北向的路（十字路口）。测试浏览器里看：第一版路口东边那条路埋在地下（岔路的过渡带把地面拉高了 0.55 米）→ 原生一起算以后路面下处处 0.1 米；路口里转角冒出草 → 地形加了端口 → 中心的辐条（一条路径一条折线，不然端头重叠又冒出来）和路缘（多压 0.2 米），之后近看、俯视都干净。路网烘一次 12.6 毫秒（6434 个三角形），中心线 2.5 毫秒；画面 120 Hz、p99 8.5 毫秒。编辑器里选中点、点"拉出分支"文件多一条分支、地形跟着重算，Ctrl+Z 回去。
- 第五步车道图（同一天）：`modeling/roadLanes.ts`（路段的车道按方向和下标偏移、路口的连接车道、焊点直连、首尾相连的路径接回起点）加测试；道路横截面的 `lanes`、`oneWay`（字段、中文）；`ContentManager.loadSpline`（地形贴样条也改用它，资源改了照常 evict）；页面命令 `lanes`（报车道、连接车道、总长、尽头，按时长画出来，带方向箭头）；编辑器的样条模式画车道（按样条对象缓存）。测试浏览器里 `stride call lanes {"spline":"Splines/EastRoad","entity":"EastRoad"}`：12 条车道、18 条连接车道（丁字路口 3 × 2、十字路口 4 × 3）、5 个尽头、总长 3132 米；俯视十字路口：两个方向的箭头靠右，每条驶入的车道右转、直行、左转各一条，没有掉头。算一次 1.9 毫秒（30 条、1744 个点）。
- 第六步列车（同一天）：`world/Train.ts`（`trainSchedule`、`trainStateAt`，`Train`、`TrainDoor` 脚本，在 Game 里登记）加测试（停站开门、梯形曲线、往返、短距离加不到限速、没车站时两头往返、绕圈）；样条成了脚本能引用的资源种类（`prop.asset('spline')`，SceneAssetKind、场景的预加载）；编辑器的中文字段名。Valley：一条 1 公里的铁路（`Splines/RailLine`，坡度 4% 左右，地形贴着它），西站（260 米）、东站（760 米）各一个站台（顺着轨道的坡）和 6 扇屏蔽门，一列三节的车（每节两扇门）。测试浏览器里看：停站时车门、屏蔽门一起滑开 1.3 米，25 秒后关上，车加速开走（50 秒时 19.9 米每秒、在 580 米处），120 Hz、每帧 update 0.17 → 0.25 毫秒；编辑器的属性面板画出 Train 的字段（车站的列表、最高速度……）。第一版生成场景时把脚本写在了实体上（应该在 `components.scripts` 里），加载时被悄悄忽略——`tools/editor-accept/check-fields.ts` 本来就会报这个，生成完先跑它。

## W4 程序化摆放和植被（2026-11-22）

- `content/formats/scatterFormat.ts`（ScatterFile、检查）、`world/Scatter.ts`（`Scatter` 组件、`ScatterAsset`、纯函数 `scatterCell`、`ScatterSystem`）加测试（密度、格子怎么切都一样、换种子不一样、坡度高度离路成片的筛选、顺着坡的旋转、文件检查）；`ContentManager.loadScatter`、场景的组件、资源引用（场景 → 摆放 → 模型）、`Game.scatter`（地形更新以后、变换更新以前）、调试命令 `scatter`；编辑器：新建"程序化摆放"、字段描述、中文（`cellSize` 的中文名改成通用的"格子大小"，体素也用它）。第一版的网格范围算错了（四个 32 米的格子拼不出一个 64 米的），测试抓到的。
- Valley：SDF 的松树（树干加四层针叶，0.2 米的网格，6 KB）和石头，`Scatter/Valley.scatter.json`：松树每公顷 120 棵、坡 32° 以内、170 米以下、成片盖住 45%，石头每公顷 12 块、坡 12°～60°、顺着坡、埋进去一点。测试浏览器里看：广场里、路上没有，松树一片一片的，石头在坡上；1700 个实例，静止 120 Hz（update 0.44 毫秒，其中原生的变换和剔除 0.63），每秒 50 米飞过去 120 Hz、update 的 p99 4 毫秒（撒格子的 2 毫秒预算加建实体）。编辑器里改密度（120 → 40）马上重撒：1704 → 704 个，改回来又是 1704 个。观察点没挪、格子都撒好时不重选格子（update 0.51 → 0.44 毫秒）。
- 工具：CI 上 csharp-intermediate 的失败查清了——不是卡住：过了的那些次作业也要 12～29 分钟（随运行器的快慢），最近两次是被每个样例 1500 秒的上限掐断的；作业的时限改成 45 分钟、每个样例 2400 秒（5d93890）。

- 第二步参数化的树（同一天）：`content/formats/treeFormat.ts`、`modeling/tree.ts`（生长、枝的圆管、叶片卡片，加测试：顶点数、同种子同一棵、换种子不同、绕向、针叶树的树干收到梢和侧枝越往上越短、文件检查），`modeling/meshBuilder.ts`（从 spline.ts 挪出来，样条和树共用），`pipeline/src/bakers/treeModel.ts`，编辑器后端的烘焙种类 `tree`、新建"参数化的树"、字段、中文、资源引用（树 → 材质）。Valley：`Trees/Oak.tree.json`（三层，叶簇的 SVG）、`Trees/Pine.tree.json`（针叶树，针叶的 SVG、枝条略下垂），摆放里的松树换成它、加一层橡树（每公顷 40 棵、成片）。测试浏览器里看：林子里橡树一团团的叶子、松树一层层的枝；针叶第一版太密（卡片像实心的方块），第二版太稀（远处像枯树：细线在 mip 里被挖没），第三版粗一点的针叶加更多卡片。3900 个实例、84 次实例化的绘制，120 Hz（GPU 上阴影 2.0、不透明 1.6 毫秒）。
- 第三步植被的风（同一天）：材质的 `wind`（资源格式、`Material.wind`、`setWind`、加载、字段描述和中文），`RenderSystem.wind`（Game 每帧从 game.wind 写：速度乘阵风），视图的 uniform 多一个 `wind`（VIEW_FLOATS 288 → 292），材质的 uniform 多一个（576 → 592 字节）、顶点阶段也看得见（第一次没开可见性，管线校验报错，页面里看出来的），网格着色器的 `windSway`（transformVertex 和上一帧的位置都过它）。Valley：树皮、橡树叶、针叶的材质 bend 0.45、叶子抖 0.08 和 0.03，加一个 7 米每秒、阵风 ±50% 的风区。测试浏览器里看：隔 0.7 秒的两张截图相减，树冠的边都在动、地面不动，叶子不离开枝；14 米的松树顶上摆 0.4～0.6 米；120 Hz。
- 第四步草（同一天）：摆放层的 `grass`、`material`、`cellSize`（格式、检查、字段、中文），`ScatterAsset` 带每层的材质，`ScatterSystem` 撒草的格子（`#buildGrass`：先建格子的实体，工作线程上的高度页好了再撒、合成网格挂上去，那时格子已经拿掉就不挂；拿掉格子时放掉网格），`gridGround`（高度页插出高度和法线）、`grassBlades`（草叶合成网格）加测试；材质的风加 `mode: 'grass'`（着色器的 windSway 多一个 UV 参数）；成片的阈值按点抖 ±0.08（斑块的边渐稀，树、石头也是）。Valley：`Textures/GrassBlade.svg`（根深梢浅的渐变）、`Materials/GrassBlades`（两面画、风的草模式），摆放加一层草：每平方米 40 片、50 米以内、坡 35° 以内、成片盖住 70%。测试浏览器里看：第一张在地下（相机比地面低），双面的草叶从下面看像飘在天上；第二张在广场上（压平的地物里不撒，对的）；第三张在橡树林边：一片草地、斑块的边是硬线 → 抖阈值以后渐稀。隔 0.6 秒的两帧相减，草梢和树都在动。120 Hz，不透明那一遍 1.8 → 2.1 毫秒。
- 第五步细节层次（同一天）：摆放层的 `lods`（格式、检查、字段、中文），`lodTier`（带回差）、`keepOf`，`ScatterAsset.models` 变成每层每个层次，格子记着层次、变了重撒，草的格子换层次时旧的留到新的好了；`scatterCell` 多一个 keep；树的每根枝自己的随机数（测试：少长一层，树干和第一层枝除了梢以外逐位相同）；草合网格挪进 update 的预算（`#ready` 队列，编辑器按需出帧时叫醒一帧）；`scatterCell`、`grassBlades` 去掉逐点建的对象（实例带上地面的法线，草叶不再取一次地面）：一个 16 米格子 4755 片草，摆 9 → 7 毫秒、合网格 14 → 3.5 毫秒。Valley：`Trees/OakFar.tree.json`、`PineFar.tree.json`，松树、橡树 120 米外换远处版，草 25、38 米外留 1/2、1/4，草的格子 8 米。测试浏览器里：同一个俯瞰的视角阴影 2.22 → 1.09 毫秒、不透明 2.14 → 1.97；飞过去第一版一帧卡到 92 毫秒（草在回调里合网格）→ 挪进预算 33 → 再去掉对象、格子 8 米以后 p99 8.5 毫秒；地面上看草往远处渐渐变稀。中途电脑死机重启：工作区的改动都在（文本文件没有截断、零字节），重跑类型检查、测试、字段检查都过，页面里重看一遍 120 Hz。
- 第六步细叶子保覆盖率（同一天）：网格着色器的 `baseColor` 里有 Alpha 裁剪时按 mip 级放大 alpha（`ALPHA_MIP_SCALE` 0.25，导数在材质参数决定的一致分支里求）。测试浏览器里同一个远看林子的视角 A/B：关掉时后排的树、远处的松树稀、透得见后面，开着时树冠是满的；帧时间不变（不透明 1.52、阴影 1.19 毫秒）。CI 上 261486c 的 physics-sample 冒烟"点中的箱子被推起来"第三次尝试没过（软件 WebGPU 的时序，和这几步无关），看下一次还出不出。
- 第七步只重撒改到的（同一天）：`ScatterSystem.#carryOver`（规则、模型、材质、种子、格子大小都没变的层留下格子；地形用 `changedRegions` 求改动范围，盖到的格子加上离路的距离标成 stale，下次选格子时重撒、新的好了再拿掉旧的；地形的底变了全部拿掉），调试命令 `scatter` 报上一次换版本时留下、重撒、拿掉了几个（`lastChange`）。测试浏览器的编辑器里：在相机附近的地形文件里加一笔，374 个格子标 6 个、重撒 6 个；加在撒的范围外：一个都不重撒；只改石头那层的密度：304 个留着、70 个重撒。
- 第八步局部风区也吹植被（同一天）：`RenderSystem.wind.locals`（Game 每帧取离相机最近的 4 个，强度乘它自己的阵风），视图的常量多 4 个中心加半径和一个强度（VIEW_FLOATS 292 → 312），着色器的 `windAt`、`VEGETATION_LOCAL_WINDS`；`WindField` 的说明写明坐标是渲染空间的（第一版把中心再减了一次渲染原点，测出来差 1024 米，查下来风场本来就在渲染空间里，和粒子一致，改的是植被这边）。Valley 加 `Downwash`（球形、20 米每秒、半径 30 米、阵风 ±30%）。测试浏览器里暂停后比较：风区开着和强度设成 0 的两张截图相减，只有风区里的橡树和草在变（地上亮的是它们的影子跟着动）；120 Hz，阴影 1.18、不透明 1.90 毫秒，和没有风区时一样。
- 第九步远处卡片（同一天，W4 做完）：`rendering/mesh/Impostors.ts`（`ImpostorBaker`，`renderSystem.impostors`）：模型临时挂在烘焙的渲染组（`RENDER_GROUP_BAKE` = 30，相机的视图按场景的掩码再去掉它，`RenderView` 默认的掩码也不含它）上，下一帧前向渲染器多 8 个正交视图（`RenderView.windless`：烘的时候不吹风），用新的阶段 `RenderStage.impostor` 画进一张 2048×256 的图集（网格着色器的 `fsImpostorBake`：材质层混过的漫反射色、Alpha 裁剪；第二张是视图框架里的法线加粗糙度），透明的像素按最近的不透明像素填色（往下的 mip 不混黑），再下一帧 `replaceLevel0` 拷进卡片材质的两张贴图、GPU 上出 mip。卡片的网格 `MeshData.impostor`：四个顶点都在中心、法线的 xy 是角的偏移，`vsImpostor` 按相机绕竖直轴转（正交的视图——阴影、天空遮挡——整个转向光），按方位角选格子，切线框架就是卡片的右和上，植被的风照常弯。摆放层的 `lods[].impostor`（格式、检查、字段、中文），`ScatterSystem.#modelOf`：第一次要时开始烘，烘好前用近一层的，烘好后各个摆放重选格子；编辑状态下按需出帧时烘焙期间一直出帧（`holdFrames`）。调试命令 `scatter` 报还在烘的个数。第一版循环引用（RenderSystem → Impostors → meshShader → RenderSystem）页面里报 `MAX_DIRECTIONAL_LIGHTS` 没初始化，格子数挪进 `Mesh.ts`。Valley：松树、橡树 220 米外换卡片、可见距离 350 → 700 米。测试浏览器里看：烘出来的图集 37% 不透明、颜色是叶子的绿；180 米高俯瞰时视野里的树全是卡片（把卡片的实例藏起来，树就全没了），和近处的真模型看不出分别；地面高度看远处山坡上的林子和近处的树接得上；5800 张卡片一共 1.2 万个三角形，换掉的是约 800 万个三角形的远处模型（PineFar 1640、OakFar 506 个三角形一棵）；120 Hz、GPU 3.7 毫秒（3840×1810）。编辑状态（`?stride-edit`）下也烘完、画上。CLI 的 `pick` 等不到结果是因为页面在后台不出帧（`visibilityState: hidden`），不是缺陷。
- 工具：编辑器后端打开工程时补烘开着时没看到的改动（开发服务器停着时 agent 写了树、白盒这些的源文件，模型还是旧的）：按内容的哈希比上次烘的（记在工程的 `node_modules/.cache/stride-editor/bakes.json`；不用文件的修改时间，新检出的工作树里靠不住），没记过的模型在就当是对的。实测：第一次启动什么都不烘，停着时改了橡树的种子再启动烘 1 个，改回来再烘 1 个。
## W5 程序化建筑和城市（2026-11-22 起）

- 第一步单栋建筑的文法：`content/formats/buildingFormat.ts`（BuildingFile、图案的解析 `parseFacadePattern`、检查）、`modeling/building.ts`（体块的底面和退台 `insetPolygon`、立面的框架（从外面看 u 从左到右）、一层的铺法 `layoutFloor`、构件的几何、屋顶），`pipeline/src/bakers/buildingModel.ts`，编辑器后端的烘焙种类 `building`、新建"程序化建筑"（三层的小楼）、字段（底面、屋顶、立面规则、构件按 JSON 改）、中文、资源引用（建筑 → 材质），MCP 的 `write_asset` 写文法出模型（加了测试），引擎的测试（图案、铺满、退台、高度、玻璃凹在墙里、三角形的绕向和法线一致、尖顶和圆的底面、检查）。第一版构件的窗框宽度和"窗框用哪个材质槽"都叫 `frame`，后端生成时报错才看出来，材质槽改成 `slots: { wall, glass, frame }`。Valley 的广场：`Buildings/Tower`（三层裙房、16 层玻璃幕墙退 4 米、两层冠顶的钢鳍片加玻璃穹顶）、`Rotunda`（28 边的圆楼、底层一圈门、上面退台、钢的穹顶）、`Apartment`（六层，窗和阳台交替、腰线、女儿墙）、三栋挨着的 `Shophouse`（店面、带小阳台的窗、尖顶）。测试浏览器里看：窗洞凹进去有阴影、阳台的栏板、腰线、穹顶的高光都对；尖顶从墙脚看不见（坡面在檐口后面），从高处看得见。全景 120 Hz，GPU 3.6 毫秒（不透明 1.8、阴影 0.8）。三角形：塔楼 2.3 万（窗框和幕墙骨架是 1.96 万），公寓 1.2 万。
- 第二步沿街摆楼（同一天）：`content/formats/cityFormat.ts`（CityFile、检查）、`modeling/city.ts`（纯函数 `cityLots`：沿每条路径两边按 1 米取样、按权重挑楼、矩形和路的线段（网格加速）、和摆下的楼（分离轴）碰了就往前挪 2 米），`world/City.ts`（`City` 组件、`CityAsset`、`CitySystem`：等地形加载好（`TerrainSystem.settled`）、按四个角往下打的地面取最低的放楼、楼是子实体，城市文件、路、模型换了整个重摆，调试命令 `city`），场景组件、加载、资源引用（场景 → 城市 → 路、楼）、字段和中文、编辑器新建"城市"。程序化摆放避开楼：城市系统给出楼的占地矩形和版本、每次改动的范围（`obstacles`、`changesSince`），`ScatterSystem` 换到地形本地坐标，撒的时候离楼 avoidPaths 米以内不撒，楼变了只把盖到的格子标成要重撒。整理先单独提交了：摆放和树里各一份的整数哈希挪进 `data/hash.ts`（这次是第三处要用），样条占地的宽度挪进 `splineCorridorWidth`。Valley：`Cities/EastTown`（沿东路网、东边 500 米见方的范围，联排、店铺、公寓、办公楼多，圆楼、塔楼少）加两种楼 `Buildings/Townhouse`、`Office`。测试浏览器（无头）里看：124 栋楼沿路两边排开、路口留空，平视的街景两边是公寓和联排、路边一条草、远处是塔楼，树和草都没有长进楼里；120 Hz，GPU 2.2 毫秒（不透明 0.57、阴影 1.37）。
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

## R2 的前两步：光追的 BVH 和光追场景（2026-11-22）

第一步原生（StrideNative 的 `sn_bvh_build_triangles`、`sn_bvh_build_boxes`，临时版 native-dev-7d98237448）：三个轴各 16 个桶的 SAH，二叉树、左右孩子挨着放，32 字节的节点（最小角、左孩子或第一个图元、最大角、个数）和 v0 加两条边的三角形，GPU 上直接用；异步任务在工作线程上建（bench 里 JS 建一百万个三角形要 7 秒是动机）。引擎的测试按 GPU 的布局在 CPU 上遍历，和挨个求交的最近交点一致（两个三角形同一点上被打中的平局按距离比）。

第二步 `rendering/raytracing/RayTracingScene.ts`（`renderSystem.rayTracing`）：每个网格一棵 BLAS（原生建，接进两个大缓冲），画出来的不透明实例按世界包围盒建 TLAS（实例或变换变了才重建，新的建好前接着用旧的），实例按叶子的顺序存世界矩阵的逆（射线变到网格的坐标，t 不变）、BLAS 的起点、材质的颜色和自发光；`rayTracingWgsl(group)` 给着色器 `rtTrace`（两层的栈遍历，先走近的孩子）、`rtNormal`、`rtAlbedo`、`rtEmissive`。调试命令 `raytrace` 从主相机光追一张（颜色乘太阳，打不到是天）读回成 PNG（`RayTracingDebug.ts`）。看过：站台的白模（19 个实例，BVH 54 毫秒）光追图和光栅化的截图几何一模一样（玻璃是透明的、按设计不进）；Valley（2702 个实例，BVH 225 毫秒，1280 × 720 一张 48 毫秒连编管线和读回）楼、树、双塔都在对的位置。还没进光追场景的：地形（高度页网格的高度在着色器里取，要从原生的地形求值另建）、远处卡片、贴图的颜色（树叶是白的）、蒙皮和形变——全局光照那一步补。

## R5 地铁站台的白模，编辑器跟上别处改的场景（2026-11-22）

新样例 `apps/photoreal`（端口 5234，`?scene=` 选场景，默认 `Subway`），`scripts/build-subway.ts` 只经编辑器的 MCP 服务照站台的照片搭白模：库里的拉丝钢、透明玻璃、混凝土加自己写的地砖、黑框、道床、红绿灯的自发光；白盒笔刷的站台和道床、两条线的钢轨、八跨屏蔽门（立柱、两扇滑动门、固定门，黑框加玻璃，门灯）、端门和带小窗的立柱、栏杆和黄黑挡杆、信号灯、顶棚（屋面、梁、檐口、立柱）、接触网（支柱、腕臂、承力索、接触线）、远处的地面和一排树；机位照照片（端门右后方约 2 米、1.55 米高，竖向视角 67°）。先写只有相机、太阳和天空的场景，再一块块写模型、马上放进场景（`STRIDE_BUILD_PAUSE` 每块之间停一下，用户要在看得见的浏览器里看着搭）。

用户在主 Chrome 里开着编辑器看搭的时候发现：**打开着的场景被 agent 经 MCP 改写了，编辑器不跟着变**（时间轴、属性面板里的资源会从磁盘重读，打开着的场景、预制体文档没有）。补上：引擎里加 `sceneEditBetween(from, to)`（`editor/SceneDocument.ts`）算两份场景文件之间的修改——没变的实体留着（同一个对象，视口里不重建），改了的按字段和一个个组件 set，删掉的、新加的、换了父实体或顺序的删了再加，场景设置一个个设；编辑器（`session.ts` 的 `#followOpenedElsewhere`）在打开着的文档在别处改了、自己没有没存的修改时把它当一次修改做进撤销栈（能撤销，文档仍是已保存的），有没存的修改时不动、提示保存会盖掉别处的修改。在主 Chrome 里看过：重搭时场景先清空，平台、轨道、屏蔽门、栏杆、信号灯、顶棚、接触网、远处的树一块块出现，场景树跟着长。

## R1 照片比对的工具（2026-11-22）

`stride shot <out.png> --photo <照片>`：截图（不加输出的抖动），照片的字节发给页面，页面用 `createImageBitmap` 解（JPEG、WebP、AVIF 都行，CLI 只会解 PNG），按截图的大小等比铺满、居中裁，回传 PNG（调试命令 `decode-image`，和截图共用编 PNG 的 `pngBase64`）；CLI 里 `packages/cli/src/photo.ts` 比"像不像"而不是逐像素：线性亮度的第 5、50、95 百分位差几档，log 亮度的标准差（反差），平均的 R/G、B/G（白平衡），饱和度，亮度梯度的平均（细节，渲染 / 照片），4 × 4 格子各自的曝光和细节，缩小 4 倍后的 SSIM，差得明显的写成一句句的结论；另写一张照片 | 渲染 | 各一半叠在一起的拼图对机位。单测用合成的图（一样的、暗一档的、平的对有纹理的、偏蓝的）。在测试浏览器里（960 × 1280，和竖拍的照片一样的比例）拿 Valley 对站台的照片跑通：内容完全不同所以数字只说明管线通，但已经看出我们的晴天天空比真实的灰、淡（B/G 0.67 对 1.27），记给 R3。微信发来的照片没有 EXIF，相机的视角按手机主摄约等效 26 毫米估（长边约 67°）。

## R 组的参考素材（2026-11-22）

用户给的素材整理进本机的 `reference/`（不提交：有人脸，未来城市是网上视频的截图），清单在 handover.md 的"参考素材"。看过的内容，按对 R 组的用处：
- **地铁站**（一张照片、两段视频）：高架站台、屏蔽门（不锈钢框、玻璃、贴的警示标志）、信号灯、接触网和支架、站台顶棚、地面的黄线和箭头、远处进站的列车和树；晴天的直射光。素材最全，R5 先做它。
- **长视频**（7 分钟走一圈）：高架下的人行道（砖铺、盲道、一长排电动车、行道树的斑驳树影），路口（红绿灯、电线、配电箱、远处的斜拉桥、骑车的人），商业街（花箱、护栏、招牌），老小区的巷子（补过的沥青、井盖、空调外机、墙上的污渍、晾的衣服）和楼道（掉漆的栏杆、补过的台阶、防盗门）。正是我们缺的 1 厘米到 1 米那一层细节：风化、裂缝、污渍、杂物、树影，R4、R6、R7 照它做。
- **商场**（中庭、美食广场）、**卧室**：R8。
- **未来城市**（三张截图）：穹顶塔楼和空中走廊、草地上的磁悬浮和雾、飞行器和森林，G8 的样片照它。

## W7 第一步：GPU 上的剔除（2026-11-22）

`rendering/mesh/GpuCulling.ts`：一帧一个计算通道（64 个线程一组，x 是实例、y 是视图），实例的本地包围盒按世界矩阵（世界矩阵缓冲这一帧的那一半）变成轴对齐盒和视图的平面比，可见的 `atomicAdd` 间接参数里的实例数、槽位写进实例列表；距离范围每个工作组在共享内存里归约（浮点数换成保序的整数做原子 min、max），结果拷进暂存缓冲异步读回。`MeshRenderFeature` 的 `cull` 只记视图（透明的批照旧给原生剔除），`prepare` 传实例（槽位、批号，和上一帧一样就不传）、批、视图和清零的间接参数，把计算通道录进这一帧的编码器（在所有画之前）；`draw` 对 GPU 剔除的批 `drawIndexedIndirect`。批级的世界包围盒（`#updateBatchBounds`，按 `changedSlots` 只重算动了的批）挡掉整批在视锥外的绘制。设备加请求 `indirect-first-instance`（`GraphicsDevice.indirectFirstInstance`），`RenderSystem.wireframe` 让画线框的帧走 CPU 剔除，调试命令 `culling` 切换。

量（测试浏览器，无头，1080p，Valley 俯瞰，游戏在走）：同一帧切换着截图，GPU 剔除和原生剔除逐像素一样（差的只有输出抖动的噪点）；画一帧的 CPU 平均 4.38 → 3.35 毫秒（原生剔除在调试版里 2.0 毫秒没了），计算通道 0.01 毫秒，绘制次数 414 → 416，GPU 总耗时不变（4.1 毫秒）。踩的坑：测量脚本里按游戏时间等（`seconds()`）在暂停的游戏里永远等不到，CLI 看起来像卡住；第一次对比时暂停得太早、摆放还没撒出来，差异是内容不同。

## W7 开头：先测（2026-11-22）

Valley 从高处看小镇和林子（测试浏览器，无头，1080p）：120 Hz，但画一帧的 CPU（`drawMs`）平均 5.3、p95 8.0 毫秒，GPU 4.1 毫秒（阴影 1.5）；约一万个实例，6 个视图（4 级阴影、平面反射、主画面）剔除后画 49610 个、414 次绘制。CPU 剖析（`stride cpu-profile`）里最大的几项和处理：

- 原生的视锥剔除 `CullBatches` 0.43 毫秒；`_emscripten_get_now` 0.82 毫秒是调试版原生模块在调试 CLI 连着时的计时自己（`forwardNativeDebug` 打开收集），发行版没有，测原生耗时时要记得扣掉。
- `writeBuffer` 0.55 毫秒：每帧把一万多个世界矩阵整段传上去。改成只传变了的：两半各记是第几次更新写的，从那以后变了的槽位（`TransformStore.changedSlots`，再早一次的自己留一份）合成连着的段传，隔了两次以上的更新（编辑状态按需出帧）、缓冲新建、变了的超过四分之一时整段传 → 0.19 毫秒。
- `pipelineFor`、`#pipelineKey` 0.39 毫秒：每次绘制都拼一个字符串当管线的键。每批记下各阶段上次用的管线和当时的输入（材质版本、网格效果、输出格式），没变就直接用 → 从剖析里消失。
- `catmullRom`、`samplePath` 0.15 毫秒：浮力每帧经 `waterAreas` 沿河的样条重新采样（W6 第四步留下的浪费）。中心线按实体缓存，世界矩阵变了才重采；涨水的高度另记在 `offset` 上 → 消失。

合起来 `drawMs` 平均 5.3 → 4.4 毫秒。动的东西（列车、浮着的箱子、物理样例）照常更新：两张隔一秒半的截图里列车往前走了，physics-sample、bepu-sample、platformer、first-person-shooter、open-world 的冒烟都过。剩下的大头是剔除本身和逐实例的 CPU 活：W7 的第一步做 GPU 上的剔除和间接绘制。

## 3D 动画长片的参考和路线图的 A 组（2026-11-22，用户给的参考）

用户要看《斗破苍穹》剧场版《双帝之战》（腾讯视频），分析引擎要做这种作品需要什么。第三方"VIP 解析"站（绕过付费）的视频、音频没有去取；改在官方页面：先看了免费的预告，用户登录会员账号以后看年番第 219、218 话（剧场版正片要另外买礼包，没买），按进度条每 10%～15% 截一帧（1080P、关了弹幕），共 28 张，放本地 `reference/doupo-movie/`（不进 git），`ANALYSIS.md` 按镜头类型（角色特写、怪物、大场面、特效、镜头语言、文字、声音）列了看到的和引擎要补的能力。路线图加了 A 组（A1 头发……A11 样片验收），排在清单最后、先后等用户定。顺手：handover.md 的定时任务提示词里有一行重复的残句，删了。

## R3 第一步：调色和镜头（2026-11-22）

- `ToneMap` 加了算子（`operator`：hejl2、agx、aces）、白平衡（`temperature`、`tint`，`whiteBalanceMatrix`）、`contrast`、`saturation`，镜头的 `vignette`、`grain`、`chromaticAberration`、`distortion`；场景文件 `postEffects.colorGrading`（`SceneColorGrading`），编辑器的字段和中文名，单测（6500 K 是单位矩阵；3200 K 的光源经相机设 3200 K 以后是中性灰）。
- 测试浏览器（无头，960×1280）站台和照片比：hejl2 把黑的门框压到 0（暗处差 10 档是这个），AgX 的暗处抬起来；AgX、5600 K、反差 0.9、饱和 1.15、暗角 0.15 以后照片比对不再报偏暖、反差、饱和度，剩曝光（暗处 2.6 档、亮处 1 档）和细节（0.29 倍）——留给自动曝光、材质和几何。畸变、色差、颗粒试过能用，站台不开（手机自己校正）。映射一遍 0.042 毫秒（全开），默认设置 0.027 毫秒。
- 第二步，按亮度直方图测光（`ToneMap.metering`、`histogramRange`、`histogramFilter`、`speedBrighten`、`speedDarken`；场景的 `postEffects.exposure`）：一个计算通道数 128 格的对数亮度直方图（工作组共享内存里原子加，隔一个像素数一个），一个线程求去掉两头的平均并适应，写进适应亮度。站台：自动 key 时和平均测光差不多（中位数和照片对上），固定 key 0.18 时整体亮 1 档但暗处仍差 1 档——差在动态范围（手机的局部色调映射），不在曝光；把太阳调亮 8 倍、速度调成 0.3 档/秒，左上角那格从 +0.05 到 −0.46 到 −0.5 档慢慢收敛。数的像素从全部换成隔一个以后结果一样、0.046 → 0.037 毫秒；写的时候 `target` 又是 WGSL 的保留字，新的单测当场报了。
- 第三步，局部曝光（`ToneMap.localHighlights`、`localShadows`、`localDetail`、`localBlur`，场景的 `postEffects.exposure` 的同名字段）：网格一个工作组一格（隔一个像素取一个，共享内存里按层原子加），三维高斯（一个线程一格一层）、各列加起来的大半径模糊各一个计算着色器；映射时按像素自己的亮度在网格里三线性取。站台（无头，960×1280）：只压暗处 0.5 时暗处差 2.79 → 0.79 档、0.4 时不再报，反差不再报；连亮处一起压（0.6～0.8）时亮处更暗、0.4/0.6 时反差反而比照片低（1.37 对 1.81 档）——我们的亮处本来就比照片暗，不该压。第一版的模糊一个线程一列、16 层和 17×17 的大模糊都在一个线程里，0.288 毫秒；拆成三维的一格一层加先存各列和以后 0.04 毫秒。
- 第四步，查找表（`ColorLut.ts`：`parseCubeLut`、按路径登记；`ContentManager.loadColorLut`，资源种类 `lut`（`.cube`），场景的 `colorGrading.lut`、`lutStrength`，编辑器后端导入 .cube（和 .ies 合成一个原样导入的函数）；单测：解析、报错带行号、场景的引用）。测试浏览器（无头，960×1280）站台：17³ 的恒等表和不带表比，平均差 0.76 个灰阶（两张都不带表、隔一秒的截图本来就差 0.64：光追的反射和探针在更新），棕褐色的表、强度 0.5 都看得出来；映射一遍 0.044 → 0.054 毫秒。
- 第五步，TAA 默认开（`ScenePostEffects.antialiasingMode`，ForwardRenderer.configure 按它开关 TAA，编辑器的字段和中文名，新建场景的模板，营地、collect-dodge、白盒、open-world 的两个场景、站台、短片改成 temporal）。测试浏览器（无头，1280×720）：站台、Valley 由场景打开了 TAA；放大看边缘干净，楼的窗格、栏杆比 FXAA 清楚（锐化）；TAA 0.074 毫秒（解析 0.052 加锐化 0.022），FXAA 0.046 毫秒。R3 做完。
- 回归：TAA 那次提交的验证里营地的显存超了预算（59.8 MB > 57.9 MB，基线 41.3 MB），多的 18 MB 正是 1280×720 的 TAA 两张历史（rgba16float 各 7.4 MB）加运动向量（3.7 MB），是有意的变化，重记了营地的基线；顺带给一直没有基线的 photoreal、open-world、greybox、short-film 记上（验证工作树里 `STRIDE_UPDATE_BUDGETS=1`，五个都过）。
- 整理（R3 做完以后，单独提交）：`ToneMap.ts` 长到 921 行，拆进 `rendering/postfx/tonemap/`——`ToneMap.ts`（映射和平均测光，532 行）、`HistogramMetering.ts`、`LocalExposure.ts`（建网格；映射时取网格留在 ToneMap 的着色器里）、`ColorLut.ts`（解析、按路径登记、每个设备的贴图）、`whiteBalance.ts`；站台的画面、照片比对、耗时和拆之前一样。
- 途中的坑：WGSL 里 `operator` 是保留字，整个画面黑了（色调映射的管线无效）。主动改进：假 GPU 的 `createShaderModule` 查 WGSL 的保留字（规范的表，146 个），新单测 `wgslSources.test.ts` 扫源码里 132 段 `/* wgsl */` 模板字符串，以后在单测里就报。

## 尾巴：贴花的图集分页（2026-11-22）

- `rendering/mesh/Decals.ts`：装箱改成可以分页（`packPages`，取代只能一页的 `packAtlas`）：先在一页里从 1024 长到 4096，再装不下就加页；图集数组里颜色的各页在前、法线的各页接在后面，用不到的不建（以前不管有没有法线贴图都建两层）；每个贴花数据里记颜色、法线在第几层（着色器按它取）。页数只受设备的数组层数上限限制，超了警告。调试命令 `decal` 加 `distinct`（每个测试贴花一张不同颜色的 512² 环），返回图集的边长和层数。单测：分页的装箱、层号的打包。
- 测试浏览器（无头，platformer，1280×720）：100 个贴花各一张贴图（一页 4096² 放 49 张）分成 3 页，全部画出来、颜色各不相同；加上法线贴图共 4 层（3 个颜色页加 1 个法线页），纹理显存 5.7 亿字节（按"每页两层"建是 7.5 亿，还没有法线）；GPU 一帧 0.626 毫秒（一页时 0.615）。

## 尾巴：agent 让开着的编辑器打开场景（2026-11-22）

MCP 的服务是单独的进程、有自己的后端，够不到用户开着的编辑器界面；走它已经在用的调试中枢：游戏页面（编辑器嵌着的那个）加调试命令 `editor-open`（`path`、`kind`），调 `EditAgent.onOpenRequested`——编辑器界面接上页面时把它设成 `session.openAsset`（打开着的改过就先保存）；没有界面时命令报清楚的错。MCP 的 `open_in_editor` 经中枢调它。测试浏览器（无头）开 bepu-sample 的编辑器，`stride call editor-open '{"path":"BepuSample/Scenes/Ropes"}'` 以后场景树和页签换成 Ropes。

## 尾巴：茶壶的反射、morph-targets 的参考图（2026-11-22）

- 茶壶背光面比 Stride 亮：用桌面版（`tools/stride-capture/csharp-beginner`，本机还在）重截 keyboard.png，`capture-ours.ps1` 再比：三张平均差 1.57、1.43、1.62（同 11-20），绿茶壶背光面 147.0 对 146.8，黄茶壶阴影面几处差都在 1.2/255 以内、有正有负——问题已经不在了（多半是后来改光照时修掉的），打钩。
- morph-targets：现在的 Stride 源码要 .NET 11 SDK（本机 10.0.400）和 VS 2026 的 C++ 工作负载编整个引擎再打包；11-19 已经比过（差都在有意的 UI 偏差上），往后放，等别处也要本机编 Stride 时一起做（我定的）。

## 尾巴：碰撞体跟着实体缩放；stride eval 多条语句返回最后的值（2026-11-22）

- 原生（fork 的 `PhysicsApi.cpp`，临时版 native-dev-54b1527）：`MakeShape`、`MakeBodyShape` 不再管缩放，建物体时整个形状套 `ScaledShape`（`MakeScaleValid`）。引擎：`Collider` 的 `absoluteSize`、`unscaledShape`，`Simulation` 建物体前换算，`debugShapes` 线框照原生的规则画；场景格式、编辑器的字段和中文名，Stride 导入器写 `absoluteSize`，迁移已有的内容（见 decisions.md）。
- 测试：Node 里的原生物理单测（放大 2 倍的 1 米方块、球：默认停在 1 米高，absoluteSize 停在 0.5 米），线框的单测按新旧两种规则，换算的单测。测试浏览器（bepu-sample 的 Colliders）：新建的放大方块比导入的方块高 0.500 米；导入的放大 2 倍的球、圆柱、方块的线框贴着模型。
- 主动改进：`stride eval` 多条语句（带顶层 await）的代码以前总是返回 null（当异步函数体跑、没有 return）；现在像浏览器控制台一样返回最后一条表达式的值：在顶层的 `;` 和换行处切开，从最长的尾巴试着包成 `return (…)`，编译得过就用（`withLastValue`，单测覆盖跨行的表达式、字符串和注释里的分号）。

## 整理：读回贴图都用 readTexture（2026-11-22）

序列帧烘焙（`FlipbookBaker.readFloats`，半精度换成 `Float16Array` 转，删了手写的 `halfToFloat`）、在模型上画的读回（`MeshPainter.read`）、光追的调试图（`RayTracingDebug`）都改用 `graphics/readTexture.ts`；离线渲染每帧复用常驻的读回缓冲，照旧。营地里试过：`stride call raytrace --out` 的图对、`bake` 烘出的火的序列帧对（试完删了）。

## 查立柱上的暗斑：是反射不是 GTAO；站台开 GTAO（2026-11-22）

- 调试工具：`stride call ao '{"dump":true}'` 把上一帧的遮蔽（半分辨率）读回成灰度 PNG；`stride call <命令> --out 文件.png` 把命令结果里的 png 存成文件（raytrace 也能用）；读回贴图的公共函数 `graphics/readTexture.ts`（另有四处各写了一遍，整理时换过去）。
- 导出的 AO 图里立柱的正面几乎全白，遮蔽是对的。同一时刻四张对比：GTAO 开反射开有暗斑，GTAO 开反射关没有，GTAO 关反射开还有——暗斑是屏幕空间反射（和光追补的反射）在拉丝不锈钢上反射出旁边的黑门框，噪点没收敛。照片比对：关 GTAO 暗处差 1.44 档、开 0.25 米 1.56 档（GTAO 只多 0.12 档），关掉反射这一条就不报了。所以站台开半径 0.25 米的 GTAO（只管缝隙和墙角，三步合起来 0.064 毫秒），地砖的脏污生效；立柱的反射记进路线图的地铁站台。

## R4 第三步：遮蔽遮罩的节点，改正第二步的验证（2026-11-22）

- 节点图的 `occlusionMask`（`from`、`to`：遮蔽多少开始、多少算满）：读这个像素屏幕空间的环境光遮蔽（GTAO）；材质流加了像素坐标 `streams.pixel`（片元阶段是 `in.position.xy`，顶点阶段、粒子里是 -1，当作没遮住）。站台的地砖接了一张节点图：扫描的贴图，乘世界坐标噪声的遮蔽遮罩往深灰的污渍混，脏的地方粗糙度高。
- **改正**：第二步说三平面投影"在 Chrome 里能编译、能画"是错的。节点图的贴图节点引用的是贴图资源（`.texture.json`），扫描材质的导入只写了图片，材质加载失败；而且是用编辑器接口改的材质，游戏页面不热重载（只有编辑器页面会），两张截图的差别只是帧间的噪声。现在扫描材质的导入给每张图写同名的贴图资源（站台的三张补上了），改了文件重开页面再试：每米 8 次的三平面投影把地砖铺成了一片细格子，确实生效。教训：试的时候每一步先看 `stride status` 有没有失败，改资源要么开编辑器页面、要么重开游戏页面。
- 测试浏览器（无头，960×1280）：开 GTAO（半径 1 米）以后门脚、栏杆脚、立柱脚下有了脏污，GPU 3.03 毫秒一帧；但 GTAO 在不锈钢立柱上画出一大块噪声暗斑（半径 0.5 也有），整体也暗了（照片比对的暗处差 1.6 档），所以站台先不开 GTAO（地砖的节点图留着，开了就生效），斑的问题记在路线图里接着查。

## 路线图的总表加"过程"一列，3D 动画长片挪到世界模拟之前（2026-11-22，用户定的）

总表多了第五列"过程"：每个小阶段的步骤打钩，正在做的"材质的细节"、"地铁站台"记了临时的笔记和还没做的步骤；大阶段的顺序改成 七 照片感 → 八 3D 动画长片 → 九 让世界活起来 → 十 大世界收尾；遗留里加了扫描材质的导入要并行压贴图。stages.md 里 R2 的状态改成 ✅（之前漏改）。

## 整理文档、重新规划：路线图改成一张总表（2026-11-22，用户要的）

用户要路线图"就一张大表格，做了的打钩，其他表格不放路线图，内容写得我能看懂"。`docs/roadmap.md` 从 685 行（150 KB，一节节的分析加十几张表）改成：要做成什么（一段话）、一张总表（14 个大阶段、70 来个小阶段，按做的先后，每行一句大白话的"做什么"和 ✅/▶/◐/☐）、正在做和下一步、等用户定的、等用户帮忙的。原来的内容原样挪走，没删：原则 → `docs/principles.md`，第一、二节（Stride 的全部内容、超出 Stride 的功能分析）→ `docs/scope.md`，第三到五节（阶段和验收、取舍 D1–D18、执行）和各阶段、各组的细节表 → `docs/stages.md`。CLAUDE.md、README、handover（连同定时任务的提示词）、architecture、research、代码注释里指向原各节的引用改到新地方。"等用户帮忙的"去掉了调试桥那一条（用户已经刷新到 0.4.3）；"等用户定的"写上 3D 动画长片排在哪里。

## R4 第二步：三平面投影、细节叠加、按距离淡出的节点（2026-11-22）

- `rendering/mesh/materialGraph.ts`：`triplanar`（贴图、每米几次、过渡的锐度：沿世界三个轴各采一次，按法线分量的次方混）、`overlay`（Photoshop 的叠加，amount 是叠多少）、`distanceFade`（离相机 near 米以内是 1、far 米以外是 0）；节点引用的贴图不只看 `texture` 节点，带 `texture` 参数的都算（加载、改名、移动时改写，`materialGraphTextures`、references.ts）。单测：三平面的六次采样、库函数只放一次、距离读 `view.eye`、贴图引用。
- 测试浏览器（无头，960×1280）：临时给站台的地砖加节点图（地砖贴图三平面投影，同一张按 8 倍缩小在 2～8 米内叠上去），能编译、能画，砖缝按世界坐标对齐，近处多了一层细的颗粒；不透明阶段 0.361 毫秒，加不加一样。试完还原（地面的白模本来就是按世界坐标投影的 UV，用不着三平面）。

## R4 第一步：扫描的材质的导入（2026-11-22）

- `packages/editor/src/materialSet.ts`（`classifyMap`、`materialSet`、`scannedMaterial`，界面和后端共用），`EditorBackend.importMaterialSet`（各张图写进 `<文件夹>/<名字>/`、导入设置是 UASTC、当场压好，金属度贴图取平均，写材质）、`POST /import-material`、MCP 的 `import_material`、资源浏览器拖进一组图片时认出来合成一个材质；材质文件的 `credit`（引擎的格式、字段描述、中文名）；单测（ambientCG、Poly Haven 的命名，成套的判断，写出的材质照字段描述检查）。TypeScript 的库升到 es2026（`Uint8Array.toBase64`）。
- 试：ambientCG 的 Tiles141（CC0）经后端导入站台，地面的白模换成它（`build-subway.ts` 同步）。头一回打开全是错：photoreal 没加载 `texture` 侧模块，KTX2 转不了码——新建工程的模板也没有，编辑器一压缩就坏；模板和 photoreal 加上 `texture`。测试浏览器（无头，960×1280）：地面有了真实的砖缝和污渍，照片比对的细节比 0.29 → 0.45，整体亮 0.36 档、偏暖（地砖比照片的暖、白），GPU 3.09 毫秒一帧（不变）。2K 的三张压 UASTC 用了 6 分钟、1K 的 78 秒：原生的 Basis 编码是单线程的，以后要快可以并行编几张（记一笔）。

## R2 第九步：成片的路径追踪的间接光，R2 做完（2026-11-22）

- `PathTracedLighting`（`renderSystem.pathTracing`）：深度预通道以后，半分辨率（取 2×2 的左上角）按深度还原位置、按邻居求法线，余弦分布发 `paths` 条路径、最多 `bounces` 次反弹（第三次起俄罗斯轮盘赌）：打到的表面加 反照率 ×（直射光，带阴影射线）+ 自发光，没打到的加天空盒（镜面贴图的第一级）；相机不动时逐帧平均（离线渲染每个输出帧的第一个子帧从头来），两遍 à-trous 按深度、法线挡边，样本越多糊得越少。交给网格着色器当屏幕空间的间接光，视图的辐照度体那一位设 2，漫反射的环境光（辐照度体、天空盒光、环境光）整个由它代替，镜面反射照旧。光追场景和管线都好了才在写视图常量之前定下来用（不然那一帧网格着色读的是白图）。
- 入口：离线渲染的 `pathTracing`（调试命令 `render`、MCP 的 `render`），调试命令 `pathtrace`（开关、`paths`、`bounces`、`reset`，报累积了几帧）。
- 测试浏览器（无头，960×1280）站台：3.6 毫秒一帧（一条路径、三次反弹）；累积几千帧以后和辐照度体的结果相近，顶棚底面暗一些、带地面反上来的暖色，和辐照度体互相印证。离线渲染 480×640、16 个子帧的 PNG 序列能出，16 个子帧还有颗粒，成片给 32 个以上。
- 途中的坑：类型位置又写了 `typeof this.#私有字段`（开发服务器编不出来，这回 `stride open` 直接报了位置）；新模块的着色器字符串在模块顶层拼、用到了互相引用的 RenderSystem 的 `MAX_DIRECTIONAL_LIGHTS`（浏览器里 ReferenceError，Vitest 的模块运行器查不出来——它给的是没填完的模块对象），改成用到时才拼，光追的反射的也改了；累积的着色器没用深度，自动布局把那个绑定去掉了、绑定组对不上（整帧黑）；画面边上求法线时夹回来的邻居就是自己（零向量、NaN，边上一条白），改成出界的那边用另一边。

## 修回归：光追的东西不同步编管线、不提前占缓冲（2026-11-22）

R2 第八步的回归里 bepu-sample（开着屏幕空间反射：光追的反射跟着开了）同步编的管线 10 > 预算 8——烘表面颜色、追踪的管线在帧里现编；material-shader 没用光追也多了几个常驻的缓冲（54 > 54）。改：辐照度体的三条计算管线、表面颜色的烘焙（先 `MeshRenderFeature.warm` 再 pending）和求平均的管线、光追的反射的追踪管线和降噪的两条全屏管线都在后台编，编好以前那一遍不做；它们的缓冲（参数、统计、光照、表面颜色）第一次用到时才建。站台照常：同步编的管线 1 条。顺手：上一个提交带着一个失败的单测推了出去（命令里把测试的输出 grep 短了、提交没跟在测试的退出码后面），马上补了提交；假 GPU 的着色器模块的编译信息改成 Promise。

## R2 第八步：光追的反射降噪（2026-11-22）

`RayTracedReflections` 交给屏幕空间反射之前在半分辨率上降噪（SVGF 的简化版）：时间上按表面的世界位置和上一帧的视图投影重投影，历史夹在这一帧 3×3 的均值 ± 1.5 倍标准差里（方差夹），九成留历史，写进自己的两张轮换的历史贴图；空间上两遍 à-trous（步长 1、2 的 3×3），法线（16 次方）和到平面的距离挡边，步长乘粗糙度（粗糙度 0.05 以下不糊）。测试浏览器（无头，960×1280）站台：不锈钢立柱的反射从斑驳变成平滑的渐变（上半截映天、下半截映地），时间累积 0.016、模糊 0.049 毫秒（追踪 0.65）；相机一下子挪了 1 米以后立柱下半截先有些颗粒、几帧后收敛，没有拖影。

## R2 第七步：光追的反射（2026-11-22）

- 整理：光追打到的表面怎么受光（方向光、点光聚光都带阴影射线，天空盒光的球谐、环境光）从探针的追踪着色器里抽成共用的 `raytracing/RayTracedLighting.ts`（`rayTracedLightingWgsl`，光照放一个 uniform：`RayTracingScene.lighting`，前向渲染器在用到光追的帧写一次）；探针的参数只剩体、帧、射线的旋转。屏幕空间反射的公共着色器代码（参数结构、随机数、GGX 可见法线取样，加上新抽出来的 `reflectionDirection`）挪进 `screenspace/reflectionWgsl.ts`。`RayTracingScene.update` 一帧只做一次（辐照度体、光追的反射都会调）；它的绑定组布局对片元着色器也可见。
- `RayTracedReflections`：屏幕空间反射开着、画质开着全局光照时，半分辨率（每帧在 2×2 里换一个像素）按屏幕空间追踪的同一个随机数取同一条反射光线，屏幕上命中的把握不足的才追：打到的表面同探针的射线着色（烘好的材质平均色 ×（直射光 + 辐照度体的间接光）+ 自发光），没打到的取天空盒的镜面贴图。结果 rgb 是反射、a 是 1 − 屏幕上的把握，空间解析按比例混进去（双线性地取半分辨率的图），再照旧时间累积、合成。
- 站台开了屏幕空间反射，地砖的粗糙度 0.55 → 0.35（只做粗糙度 0.45 以下的；照片里的地砖有光泽）。测试浏览器（无头，960×1280）：光追的反射 0.65 毫秒（辐照度体 1.41、整帧 GPU 3.3）。比较：不锈钢的立柱以前反射的是天空盒（屏幕外的都退回没遮挡的天空），现在是背后的顶棚、阴影里的站台，侧面映出树的绿色。粗糙的金属上有斑驳的噪声（一个像素一条光线，阴影里和太阳下的地面亮度差得多），下一步降噪。

## R2 第六步：探针的 GPU 时间预算；开发服务器的错误进日志（2026-11-22）

- 辐照度体的 `budget`（毫秒，默认 1.5）：这一遍自己写时间戳（`timestamp-query`，开发时剖析器要的那帧让给它），读回以后下一帧的射线数按 预算 / 量到的 时间 调，每次最多变 30%，上下限 8192 和两百万条。站台：默认预算量到 1.23～1.37 毫秒（按整层更新，落在预算下面一点），改成 0.5 量到 0.51。射线缓冲按上限开，调大不用换。属性面板、场景文件都有 `budget`。
- 主动改进（调试体验）：这一步写的时间戳类型用了 `typeof this.#timing`，tsc 过了、Vite 的 oxc 解析不了，开发服务器上这个模块编不出来，页面停在"starting..."，CLI 只报"60 秒没有页面连上"。改：
  - 调试中枢的 Vite 插件接管 Vite 日志的 `error`：开发服务器的错误进中枢的日志（来源 `server`、页号 0，`stride logs --source server`）；`stride open` 等页面时见到浏览器开起来以后的服务器错误就直接报（5.7 秒，带编译错误的位置），不再干等 60 秒。
  - `tools/dev/cdp-eval.ts`：页面没连上中枢时直接经 DevTools 协议在 stride 的 Chrome 里求值、重新加载并收集异常和控制台的错误。
  - 单测 `test/core/modules.test.ts`：引擎的每个源文件经 Vite 的转换加载一遍（以前只有被别的测试引到的模块才会，故意写坏一个没人引的模块能查出来）。

## R2 第五步：地形进光追场景，用不上的探针少更新（2026-11-22）

- 地形块（高度页的网格）以前不进光追场景：射线穿过地面看到天空，地面附近的探针被天光从下面照亮。现在每块按自己那页高度建一棵 BLAS（几何的键是"页:版本"，`HeightPages.versionOf`，`MeshRenderFeature.heightPageOf`；隔一个高度取一个，32 格的块取成 16 格、512 个三角形），表面颜色每块烘一格（`vsSurfaceBakeHeightfield`，按格坐标铺；同一个地形材质按坡度、高度混出来的颜色每块不一样）。流式加载换掉的块的 BLAS 在大缓冲里成了空洞：不用的比用着的多（而且超过一百万个 u32）时整理紧，偏移变了，顶层重建好以前不给绑定组。
- 遍历的步数上限分开：BLAS 4096、顶层 16384（大世界里贴着地面横穿整张图的射线能过几千个实例的盒子，Valley 里一开始有一次被截断）。
- 用不上的探针隔 8 轮才更新：悬在空中的（附近没有几何，距离图的 a 记着）、埋在东西里的（打到背面的太多）。Valley 里跟着相机走的体上半截悬空、下半截在地下。
- 测试浏览器（无头，1280×720）里 Valley 地面上、小镇边上的机位加一个跟着相机走的 64×24×64 米、间距 2 米的体：14157 个探针、2912 个实例，被截断的遍历 0、最多 307 步；探针那一遍 GPU 4.1 → 3.75（地形之前测的是高空）→ 2.95 毫秒（跳过埋着的）。开关比较：背阴的楼面暖了一点（地面反上来的光），草地没有异样。

## R2 第四步：光追表面的颜色、点光聚光、跟着相机走的体（2026-11-22）

- 表面颜色（`raytracing/SurfaceColors.ts`）：每个批按纹理坐标用网格着色器自己的材质代码（`vsSurfaceBake`、`fsSurfaceBake`）画进图集的一格，计算着色器求平均；`MeshRenderFeature.bakeSurfaces` 直接按槽位画（firstInstance），`Mesh.uvBounds` 写进 MeshParams 的末尾。站台的光追调试图（`stride call raytrace`）里树是绿的、道砟是棕的、站台是灰的（以前都是材质的颜色，贴图和节点图的材质发白）；不锈钢的立柱是黑的（金属没有漫反射，间接光里也该这样）。只在批或材质变了的帧烘，平时不花时间；探针的那一遍照旧 1.4 毫秒。
- 点光、聚光照探针打到的表面（带阴影射线）：站台顶棚下临时放一盏橙色点光，开着全局光照时顶棚底面有地面反上来的橙光，关掉就没有。
- `followCamera`：站台的体改成跟着相机走，相机往站台外挪了 10 米，挪完当时和 3 秒后的画面一样，没有黑块，遍历没有被截断的。
- 修 CI：W7 的 GPU 剔除以后 platformer 的冒烟在 CI 的软件 WebGPU 上一直挂在"场景画出来了"（剔除剩几个是异步读回的，软件 WebGPU 开头几帧太慢，检查的时候还没读回来）：冒烟等到有数再比（最多 10 秒）。
- 用户装好了 Windows 的图形工具（D3D12 调试层），`stride open --gpu-debug` 现在连 D3D12 的校验一起开。

## R2 第三步：DDGI 的辐照度体（2026-11-22）

`IrradianceVolume` 组件（场景文件的 `irradianceVolume`：`size`、`spacing`、`rays`、`hysteresis`、`intensity`，属性面板、MCP 都有）和 `renderSystem.irradianceVolumes`（`rendering/raytracing/IrradianceVolume.ts`）：前向渲染器在写视图常量之前 `begin`（找体、分配图集、更新光追场景），阴影之后一个计算通道 `IrradianceVolume`（追射线、更新探针、拷回图集）。网格着色器的视图多三个 vec4（`giMin`、`giSpacing`、`giCounts`，视图常量一块从 1280 字节涨到 1536），第 27 个绑定是图集（和第 26 个一样，设备放得下 16 张以上的贴图时才有），`volumeIrradiance` 盖住的地方漫反射的环境光用探针的，盖不住的部分才用环境光和天空盒的。光追场景加了 `rtBackFace`（单面材质的背面，实例的标志位存双面）、`version`、`check`/`readBack`。画质的 `globalIllumination` 关着时不做。调试命令 `gi`（开关、探针数、每帧更新的探针和射线、遍历的统计）、`raytrace-check`。

站台（`apps/photoreal`，以机位为中心 40×6×16 米、间距 1 米，41×7×17 = 4879 个探针、每个 128 条射线，每帧 26 万条）：测试浏览器（无头，960×1280）里 GPU 1.4 毫秒、120 Hz；开关比较，顶棚下的地面从天空的蓝色变成中性的灰、顶棚的底面被地面反上来的光照亮。照片比对：暗处从差 2.2 档变成差 2.8 档——天空不再无遮挡地照进顶棚下面了，照片里的暗处亮是因为真的地砖亮、太阳照到地面上、手机的局部色调映射把暗处提起来，归 R3（曝光、色调）和 R5（场景、太阳的方向）。

途中把用户的主 Chrome 卡死了一次（DXGI_ERROR_DEVICE_HUNG）：先是 WGSL 的保留字 `active` 让更新的管线无效、整帧的命令缓冲无效（黑屏），改了以后光追在场景还没加载出实例的那一两帧死循环。原因和查法见 decisions.md 的同名一条。以后新写的计算着色器先在 `stride open --headless` 或 `--gpu-debug` 的浏览器里试。

## W6 第九步：下雨涨水（2026-11-22），W6 做完

天气状态（`world/Weather.ts`）多一个 `flood`（0..1）：照积水的写法，下雨就按雨的大小慢慢涨（`FLOOD_TIME` 1800 秒涨满），最多涨到雨的大小，雨停或变小了按 `FLOOD_DRAIN_TIME` 3600 秒退；一开始就在下的雨（编辑状态、第一帧）直接是雨的大小。写给 `renderSystem.surfaceWeather.flood`。水体文件多一个 `rise`（大雨下久了涨多少米，默认湖 0.5、河 0.6、海 0，`waterRise`）；渲染器的水面高度加 `rise·flood`（水下的判断、平面反射认不认这片水都跟着），`waterAreas` 加一个 `flood` 参数：浮力传现在的，程序化摆放不传（不随天气重撒）。渲染器的 `draw` 改收整个 `surfaceWeather`（雨和涨水），不再一个个传。测试浏览器（无头，1080p）里湖北岸看：`stride call weather {"on": true, "preset": "rain", "instant": true}` 以后岸线往草坡上爬了一截；湖里浮着的箱子从 −65.14 升到 −64.81（0.5 米 × 0.6）。W6 做完，留下的小尾巴记在路线图的行里。

## W6 第八步：焦散（2026-11-22）

物理上的做法：竖直照下来的阳光在起伏的水面折射，横着偏 d·(1 − 1/η)·∇h（η = 1.33），水底一小块的面积变成 det(I + d·(1 − 1/η)·∇∇h) 倍，亮度是它的倒数（浪尖、细浪像透镜，把光聚成线）。只要水面高度的二阶导数，Gerstner 和海浪谱同一套，不用另外的焦散贴图（HDRP 是把折射的网格画进一张焦散图，我们这个是它的解析近似，没有阴影）。`world/WaterRenderer.ts` 的 `causticsFactor` 用在两处：水面上看下去的那份拷贝的水底（湖、海；河不画）、相机在水下时全屏的雾之前。第一版用斜率的中心差分（每个像素四次求 6 组浪加 3 组细浪），看下去的那一遍从 0.14 涨到 0.39 毫秒；改成 Gerstner 每组波解析地加二阶导数（−a·k²·d·dᵀ·sin θ）、海浪谱前向差分，回到 0.14 毫秒。先前只算大浪时看不出焦散（大浪曲率小），细浪 `windRipples` 抽成函数，着色和焦散共用。海浪谱的最细一级在 15 米深处混叠成白噪点：加"模糊宽度" 0.08 + 0.008·深度 + 0.002·距离（米），按它挑每级的 mip、当差分的步长，海湾浅滩上变成顺着风拉长的光斑。测试浏览器（无头，1080p）里看：Valley 湖北岸 3 米深的浅滩从岸上看下去有光网，湖里 −70 米往湖底看是典型的焦散网，海湾浅滩是拉长的光斑；120 Hz，透明那一遍 0.12～0.15 毫秒。文件格式多一个 `caustics`（强度，0 是不要），属性面板有它。

## 整理整个仓库的目录（2026-11-22，用户要的）

做完 W6 以后又过了一遍：引擎的 78 个测试照源码的模块分进 11 个子目录（`fields.test.ts` 按 `import.meta.dirname` 找 apps 的 `..` 手改），README 和 architecture.md 里的路径跟着改；样例里照 C# 命名空间排的单文件目录不动（见 decisions.md）。第一遍（W6 第七步以后）两次提交：引擎（37 个文件搬家，`world/Water.ts` 拆出 `WaterRenderer.ts`），pipeline、editor、tools（20 个）。搬家的脚本：映射表 → 先按新位置改写全仓库的相对 import（含 `new URL`、`path.resolve` 里的相对路径），再 `git mv`，最后把文档、导出表、配置里写全的路径换掉；按 `import.meta.dirname` 拼的 `..` 和 PowerShell 里的路径手改（`smoke.ts` 找 CLI 和 `budgets.json`、`affected.ts`、`library-thumbnails.ts`、`build-jolt-wasm.ps1`、`regress.ps1`）。顺带：`tools/lib/affected.ts` 加了 `world/`、`modeling/` → open-world、greybox、particles-sample 的规则，`tools/dev/` 不触发冒烟；删了没人用的 `vendor/`（vue-tsx-pro 早改成从 GitHub 预发行版装）。类型检查、四个包的测试、字段检查都过；全部样例的回归在验证工作树里跑。

## W6 水体（2026-11-22 起）

- 第一步湖和海的水面：参考 WickedEngine 的 ocean（`wiOcean.cpp`、`oceanSurfacePS.hlsl`：FFT 的位移和梯度图、屏幕空间网格、平面反射、按水深吸收、岸边泡沫），先做不要计算着色器的那一半：`content/formats/waterFormat.ts`（WaterFile、检查）、`world/Water.ts`（`Water` 组件、`WaterAsset`、`WaterRenderer`：相机为中心的极坐标网格（160 圈 × 192 段，近处 0.4 米、往外按几何级数铺到 extent），顶点里 6 组 Gerstner 波（按世界坐标加渲染原点取模的部分，远处几十个波长外压平），片元重算法线、近处叠 3 组短的波纹；天空的镜面立方体贴图反射、GGX 的太阳高光、菲涅耳混；水下是主画面不透明的拷贝（`Refraction`，现在也拷一份深度：主深度缓冲加 COPY_SRC），按水深偏开、按光在水里的路程吸收；岸边按竖直的水深起泡沫，和地面相交处按水深淡出），合成器在折射拷贝之后、别的透明物体之前画，有水时也要拷（`renderSystem.water.active`）。程序化摆放不往水下撒（`waterAreas`、`underWater`：水体变了整片重撒）。场景组件、加载、引用、字段和中文、编辑器新建"水体"。第一版的着色器里变量叫 `distance`，挡住了内建函数，页面里水的管线建不出来（Chrome 的日志里看出来）。Valley：`Waters/WestLake`（西边洼地，水面 −65 米，六边形的岸线），测试浏览器（无头，1080p）里看：浪、天空的反射、近岸变浅、岸边一圈泡沫、对岸的林子；第一次看湖里长着树，加了摆放避开水。120 Hz，水那一遍 0.087 毫秒。

- 第二步河（同一天）：样条的横截面 `river`（`width`；`splineMeshes` 不出几何，`bakeSplineModel` 返回 undefined，后端不写模型；占地按水面宽加 4 米），水体文件的 `river`（`spline`、`level`、`speed`），`WaterAsset.river`、`riverRibbon`（每 2 米一节、两边按样条的宽展开、比样条低 level，顶点带弧长、流向、横向、半宽），渲染器多一条管线 `vsRiver`（顶点缓冲按实体的位置和转角放到世界里），片元里河用 `riverNormal`：4 组短波纹顺着流向平移，两个相位错开半个周期、交替淡入淡出（Valve 的 flow map，Alex Vlachos 2010），越快越碎，带子两边淡出；`waterAreas` 的河按中心线和半宽算，摆放不往河里撒。测试：带子的宽、高、流向，河的水下判断，河道样条不出几何，不烘模型。Valley：`Splines/WestRiver`（从广场西边 −1.5 米一路下到湖边 −64.8 米，宽 10 米），地形贴它 carve（低 2.2 米、宽 13 米），`Waters/WestRiver`（流速 2.5 米每秒、浑一点）。测试浏览器（无头，1080p）里看：河从坡上流下来进湖，两边挖出来的坡是石头的颜色，波纹顺着河走；120 Hz，水那一遍（湖加河）0.02 毫秒。

- 第三步倒影（同一天）：`PlanarReflections.plane`（这一帧画的平面），水体多绑一张平面反射图：平面朝上、高度和水面差不到半米时按屏幕坐标（u 翻回来）取、按法线偏开，浪越陡越退回天空（反射方向和平面的反射方向的点积，同 WickedEngine 的 planar_factor）。第一次看倒影里林子对、天空那片却是灰褐色：镜像视图的投影是斜裁剪的（近平面换成反射平面），天空的着色器按远平面（深度 0）反投影定方向，落到了相机后面、方向翻到地下。改成按近平面（深度 1）反投影：近平面就在反射平面上、总在相机前面，普通相机两种取法一样——网格的平面反射（湿地面、地板）里的天空原来也是错的，一起好了。Valley 的湖挂上 `PlanarReflection`（1100 × 4 × 900 米的盒子、半分辨率）。测试浏览器（无头，1080p）里看：对岸的林子、草坡倒映在水里，浪把倒影打碎一点，天空的反射是蓝的；120 Hz，平面反射那一遍 0.66 毫秒（预通道 0.31、不透明 0.36）。

- 第四步浮力（同一天）：原生（fork 的 StrideNative）加 `sn_physics_body_apply_buoyancy`（调 Jolt 的 `BodyInterface::ApplyBuoyancyImpulse`：按形状算水下的体积和浮心，加浮力、线性和角阻力、水流；运动学物体忽略，写回有没有在水下），JS 的 `PhysicsWorld.applyBuoyancy`（查询缓冲里放水面的点、法线、流速、结果）；`build-wasm.ps1 -SkipTests` 在 Git Bash 起的 pwsh 里找不到 pnpm，用 PowerShell 工具重跑；fork 提交 7fc9c991，`node tools/native.ts dev` 发了 `native-dev-7fc9c9913e`。TS：`BodyControl.applyBuoyancy`，`world/Buoyancy.ts`（`Buoyancy` 组件：浮力系数、平移和转动阻力；`waterSurfaceAt`：湖、海是水位，河是离中心线半宽以内那一点的水面和顺着河的流速；`BuoyancySystem` 挂在仿真的 `onStep` 上，水体一帧取一次，离水面 50 米以内的调原生），场景组件、字段和中文；`WaterArea` 的河带上流速。测试：`waterSurfaceAt` 的湖、河、水外。Valley：湖里 5 个 1 米的箱子（浮力系数 1.6）、河里 3 根 3 米的木头（1.8）。测试浏览器（无头）里看：箱子浮在湖面上、露出三成，水下那截透过水看得见；木头几秒里顺着河往下游漂了几十米；120 Hz，物理步 0.06 毫秒。字段检查第一次报 40 处：场景里的 Body 要写全所有字段（layer、kinematic……），补上。

- 第五步水下（同一天）：`world/Water.ts` 多一条全屏的管线（`vsFull`、`fsUnderwater`：读那份拷贝的颜色和深度，按到场景的距离、清澈度盖上水的颜色，天空的像素算无穷远），渲染器在相机低于这片湖、海的水面、在岸线里（按实体的转角换到本地判断）时先画它；水面的片元在相机低于这一点时走 `underside`：法线朝下，水的折射率 1.33 算出射角，超过临界角全反射成水的颜色、否则透过去取上面的画面，再按距离加雾；水里的光照抽成 `lightInWater`（水面、水下雾、水下看水面共用）。测试浏览器（无头，1080p）里在湖里 −68、−70 米看：远处被水的颜色盖住、近处的箱子看得见，水面从侧下方看大多是全反射、浪尖透出亮斑，往正上方看是透过水面的天空和全反射的暗块；120 Hz，透明那一遍（雾加水面）0.16 毫秒。

- 第六步下雨（同一天）：水洼的涟漪函数（`cellHash`、`rippleGradient`，Lagarde 2013 的程序化版本）从网格着色器挪进 `rendering/wgsl.ts` 的 `RAIN_RIPPLES`，网格着色器和水体共用；水体的常量多一个雨多大（合成器传 `renderSystem.surfaceWeather.rain`），60 米以内叠到水面的法线上。测试浏览器（无头）里 `stride call weather {"on": true, "preset": "rain", "instant": true}` 以后在湖边看：雨丝、湿了的树和草坡，水面上近处一圈圈的涟漪叠在浪上；120 Hz。

- 第七步 FFT 的海浪（同一天）：照 Tessendorf 2001（WickedEngine 的 ocean、HDRP 的水同一套思路）。`world/OceanFFT.ts`：三级级联（patch、patch/6、patch/36，各 256²，每级只留自己那段波数，下一级从它的第 6 个谐波接手），初始频谱是带风向的 Phillips 谱加种子的高斯随机数，在 CPU 上算一次、按方差归一到有效波高（不写浪高时按风速估 0.21·V²/g）；每帧一个计算通道：频谱按深水色散推进（角频率量化成 600 秒的整周期，时间取模后相位仍精确）、八个实数信号（高度、水平位移、斜率、位移的导数）两两拼成复数放两张 rgba32float 数组、逆 FFT 一行一个工作组在共享内存里做蝶形、收尾翻符号乘尖度写位移图和导数图（rgba16float，再出 mip）。水面的顶点按网格间距挑 mip 取位移，片元用 `textureSampleGrad`（导数在裁岸线前取）取斜率算法线、按位移的雅可比起浪尖白沫。踩的坑：WGSL 的保留字 `patch`、`target` 当了变量名，管线编不过，整帧的命令缓冲失效、画面全黑（`uncapturederror` 里看到）。演示：Valley 的地形在南边 (0, 3200) 加一笔压低 220 米，`Waters/SouthBay`（风 9 米每秒、尖 0.6）水面 −120 米。测试浏览器（无头，1080p）里贴着水面看：涌浪、尖的浪峰、一块块的白沫；120 Hz，FFT 那一遍 0.077 毫秒，透明那一遍 0.14 毫秒。浮力还按平的水面算（FFT 的位移在 GPU 上，要读回才能让东西随浪起伏，以后做）。

## CI 提速和 csharp-intermediate 的导航（2026-11-22）

- CI 上 0c68a3f 的 csharp-intermediate 冒烟失败在"导航：角色走到目标"：角色走了 2 米就到了等待的上限。物理每帧最多补 0.25 秒（`maximumTimeToProcess`），CI 的软件 WebGPU 上一帧要零点几秒到一秒，物理只有游戏时间的几分之一，按 15 秒游戏时间等不够（按运行器的快慢时过时不过）。等待放宽到 60 秒游戏时间，快的机器上走到就返回。
- CI 的耗时：一次全量 70 分钟左右，最慢的是 csharp-intermediate（30 分钟）、内容导入（改了 `packages/pipeline` 时缓存整个失效，16 分钟）、csharp-beginner（14 分钟），别的样例 2～5 分钟；后面的推送排在它后面、被新的推送取消，实际只有最新的提交跑完。两个 C# 样例的冒烟只按 CSS 坐标点击、不看像素，CI 上改成半分辨率画（`STRIDE_DPR=0.5`，`regress.ps1` 传给 `stride open --dpr`；CSS 的大小、点击坐标、UI 的布局不变，片元少四倍）。本机按 0.5 跑这两个样例都过。CI 上（8a50ec6 那次）：csharp-intermediate 30 → 4.3 分钟、csharp-beginner 13.6 → 5.1 分钟，都过了；全量的冒烟现在最慢的是 5 分钟左右，一次 CI 主要花在内容导入（改了导入器时 15 分钟）上。
- 以后：内容缓存按样例分（改了导入器只重导受影响的）。

## CI 的软件 WebGPU 提速：调研（2026-11-21，没做完）

- CI 用 Chrome 带的 SwiftShader。它在 x86-64 上用 Subzero 编着色器（`src/Reactor/reactor.gni`：二进制小、只用 SSE4.1，不用 AVX），线程数默认 min(核数, 16)，`SwiftShader.ini` 的 `[Processor] ThreadCount` 能改。
- 想换成 Mesa 的 lavapipe（llvmpipe 的 Vulkan，LLVM 编着色器、用 AVX2，"256 bits"）：WSL 的 Debian 13 装着 Chrome 158 和 mesa-vulkan-drivers 25.0.7。Chrome 在 Linux 上默认只在合成器（Skia）走 Vulkan 时才让 Dawn 用 Vulkan，适配器还要能导入外部贴图（`webgpu_decoder_impl.cc` 的 `CanUseAdapter`）。试了 `--use-vulkan=native --use-angle=vulkan` 加 lavapipe 的 ICD：GPU 进程反复重启、WebGPU 没有适配器，还要再查（看 GPU 进程的崩溃日志、只开 Skia 的 Vulkan）。
- 小测试页（`--headless=new`，限 4 个核同 CI 的运行器）：SwiftShader 1280×720 画 2000 个立方体每帧 91 毫秒、100 万次的计算着色器 136 毫秒。lavapipe 跑通以后用同一页比。

## 七、超市和街边小店（2026-11-22 起）

用户 11-22 给了第二批照片（104 张：超市的货架、冷柜、散装、熟食，夜里的街巷、小店；6 段视频：高架站台、美食广场、商场中庭、服装店、街上、卧室；3 张未来城市的截图），照片拷在本地 `reference/shop/`。功能核对见 stages.md 的"第二批照片的功能核对"，挑货架这条线先做。

1. **共用资源的仓库**：用户提出照 vue-tsx-pro 的字体包单独放仓库。建了 `kenconnet666/stride-ts-assets`（公开；内容是 OFL、CC0），本身是编辑器工程；`tools/assets.ts build` 照 `sources.json` 用编辑器后端的 `importFile`、`importMaterialSet` 导入（重导前删掉旧的输出：导入器遇到同名会另起名字"…2"，第一次试就多出了一份 23 MB 的字体），`dev` 发 `dev-<提交>` 的预发行版、改 override、`pnpm install`。编辑器后端、命令行、构建前同步包里的 `content/Shared` 到工程的 `Shared/`。字体站酷庆科黄油体导成 91 个字形块共 23 MB——正是不该进主仓库的东西；站台的扫描地砖挪过去，`stride-editor assets apps/photoreal` 查 0 个缺失的引用。
2. **商品包装生成器**：`.product.json` 六种外形（盒、瓶、罐、广口瓶、桶、袋），生成模型、SVG 标签、材质；11 个单测（尺寸、法线、UV、外壁法线朝外、种子和变体、SVG、材质）。`apps/photoreal/scripts/build-shop.ts` 经 MCP 写了 12 种商品和一张台子（`?scene=Shop`），无头 Chrome 里看：形状对，中文的品牌名和品类清楚、贴着弧面弯，字色按底色取黑白。顺手：`seededRandom` 从音效合成挪到 `data/hash.ts` 共用（树的生长留着自己那份，写法差一点，换了已有的树会长得不一样）；3D 文字和包装读字体共用 `pipeline/src/bakers/textFont.ts`。
3. **白盒的视口编辑（四的尾巴）**：编辑器里在展示台的台子上试：属性面板点编辑白盒，工具条（几个笔刷、加减交、删除、完成）和状态栏的提示出来；点台面选中（橙色，六个面的手柄按轴着色）；拖顶面的手柄，台子从 0.8 米变成 0.968 米，文件存了、模型重烘；Ctrl+Z 回去；双击正面加了一个同样大小的方块；Delete 删掉；撤销三次后文件和提交的一样。同一处连点是按射线上的先后轮着选（0→1→2→0）；双击的第一下也算一次单击，会先把选中换到下一个，第二下加方块并选中新的。
4. **货架生成器加摆货**：`.shelf.json`（`modeling/shelf.ts`、`pipeline/src/bakers/shelfModel.ts`），6 个单测（每层只摆放得下的、在架子里、双面背面转半圈、种子、空位、UV 在图集里、材质）。包装的生成拆出 `productLabelShapes`（标签的图形嵌进图集）、`productFootprint`、旋转体的分段参数。`build-shop.ts` 加了 8 类没写配色的商品和 5 个货架、带灯管的厅（`?scene=Supermarket`）。无头 Chrome 竖屏 960×1280：过道两边摆满货、价签条和黄白的价签，近看瓶罐的条纹、中文牌子、红色价格都清楚；6 个货架约 8000 件商品、180 万个三角形，主画面 1.67 毫秒、7 次绘制，GPU 6.6 毫秒（光追反射 4 毫秒）。生成的文件不进 git，删掉后用 `tools/dev/open-project.ts` 打开工程 4.6 秒补烘完（修了补烘只看哈希、不看文件在不在）。离线的统计 `tools/dev/shelf-stats.ts`（每个货架几件、几个顶点和三角形、生成多久）。
5. **原生模块默认 16 个工作线程**（用户 11-22 定，原来最多 8 个）：fork 里 JS 的 `MAX_DEFAULT_WORKER_THREADS` 和 C 侧 `cMaxDefaultWorkerThreads` 一起改，临时版 native-dev-58346d2da4；Node 里 `defaultWorkerThreads()` 是 16，无头 Chrome 的页面里 `stride native` 报 `workerThreads: 16`。
6. **物理堆放**：`.pile.json`（`modeling/pile.ts`、`pipeline/src/bakers/pileModel.ts`），货架里合并商品、拼图集的那段抽成 `modeling/productBatch.ts` 两边共用。包装加了五种果蔬的外形。单测 4 个（容器、倒之前的位置、合成、标签很大时的装箱）。`build-shop.ts` 加了散装区（`?scene=Produce`）：蒜 220、红洋葱 90、核桃 420、番茄 110、土豆 70，烘焙时物理分别 0.8、0.5、3.6、0.6、0.4 秒；无头 Chrome 里看堆得自然（有的搭在筐沿上），GPU 一帧 0.74 毫秒。核桃那筐碰上原生物理世界的物体对上限，烘焙时容量开大；土豆那筐撞出图集装箱的稀疏数组 bug，修了。
7. **冷柜、冰柜、灯箱招牌**：货架加 `type`（fridge、freezer）、`header`；`ProductBatch` 加发光的格子和玻璃的网格；招牌 `.sign.json`（`modeling/sign.ts`、`pipeline/src/bakers/signModel.ts`）；单测 3 个（冷柜冰柜、招牌两个）。超市过道尽头加了一台冰柜、两节冷柜（"冷藏饮料"），过道上方两块双面灯箱（"饮料 零食"、"冷冻食品"）；无头 Chrome 里看：灯箱带泛光、冷柜的玻璃门后面摆满货和价签、冰柜槽里躺着冰淇淋和水饺。GPU 一帧 7.4 毫秒（光追反射 4.5、主画面 1.85）。字体里没有"·"，显示成空格。
8. **主动改进：原生模块在 Node 里的监听警告**：MCP 搭场景时一直有 `MaxListenersExceededWarning: 18 error listeners added to [Socket]`。查下来是线程数改成 16 带出来的：Node 的每个工作线程把自己的 stdout、stderr 接到主进程的输出流上，每接一次加一个 error 监听，超过 10 个就报。fork 的加载器在 Node 里按线程数调高这两个流的上限（一个进程里导入工具和运行时各一个实例，按实例累加）。
9. **散装柜**：堆放的容器加 `cells`、`lids`，东西加 `cell`，细粒的堆 `heaps`（`modeling/pile.ts` 的 `pileCell`、隔板、按格子倒、`heapMesh`、`grainShapes`；合并批加 `glassQuad`、`mesh`）。单测 2 个。散装区后排加一张台子、一个 4×2 格的散装柜：花生、干香菇跑物理，米、红豆、绿豆、黑豆、瓜子、玉米粒画成堆；无头 Chrome 里看得出是一格格的散装，GPU 一帧 0.76 毫秒。插曲：冷柜那次提交是在后台跑完检查、最后 `git add`，中间我已经开始改散装柜的格式，改了一半的格式被带进去、字段描述没跟上，主分支的类型检查挂了；补了一个修补提交（`a4dad3f`），记了一条记忆：后台提交链在跑时不改仓库里的文件。
10. **电子价签**：货架加 `priceTags`（paper、electronic）；电子的价签是一个凸出价签条的外壳（纯色，盒子）加贴在正面的墨水屏（图集里一格：浅灰底、黑色的价格、7×7 的二维码样子的方块，三个里一个底下有红色的促销条）。单测 1 个。超市的饮料、粮油两节和靠墙那排换成电子价签；无头 Chrome 近看外壳、墨水屏、价格、二维码、促销条都对，GPU 一帧 7.33 毫秒（和纸价签时一样）。
11. **挂钩架、堆头、端架**：货架加 `type: pegboard`（`planShelf` 多返回 `hooks`，东西挂在钩下 1.5 厘米，空间到下一排挂钩为止）、`type: stack`（`planStack`：一块一种商品，往上一层四周收进去半件）；单测 2 个。超市两排货架朝入口的那头放了端架和挂钩架，过道口一个低的堆头；无头 Chrome 里挂钩上挂着袋装零食、钩尖有价签，堆头是码起来往上收的纸巾箱。
12. **地面和天花板**（用户 11-22 加进计划的：超市的地板、天花板、收银台）：地面是节点图材质（`build-shop.ts` 里的 Floor：60 厘米浅色瓷砖、浅灰缝、每块深浅和光滑度不同、磨痕）；天花板 `.ceiling.json`（`modeling/ceiling.ts`、`pipeline/src/bakers/ceilingModel.ts`，合并批加 `tube`），单测 2 个（第一次测出桥架吊得比灯管低、会挡光，抬到灯管以上）。超市和散装区的厅去掉了原来的平顶和灯具盒子，换成开放式的黑顶，面光源照 `ceilingLights` 的位置放。
13. **光追的抽灯**：开放式黑顶 36 盏面光源时 GPU 一帧 17.7 毫秒，光追反射 12.1。`RayTracedLighting` 的 `rtDirectLight` 改成照得到的点光聚光多于 4 盏时按贡献抽一盏（随机数按位置和帧号，`counts.z` 是帧号）。同一个画面 6.97 毫秒、光追反射 1.53，截图看不出噪点。主画面 36 盏面光源 4.3 毫秒，记进路线图的性能欠账。
14. **店里的器具** `.fixture.json`（`modeling/fixture.ts`、`pipeline/src/bakers/fixtureModel.ts`）：收银台、购物车、篮子、寄存柜、闸机；单测 6 个。超市入口那片放了两个收银台（"收银 1""收银 2"）、一排寄存柜、几辆购物车、一摞篮子、两道闸机。搭场景时撞上一处实体编号重复（36 盏灯用到 0x63，器具从 0x60 起），改到 0x80 起。
15. **白盒导出成多边形网格**：`modeling/trianglesToPolygons.ts`（焊点、同平面同组的三角形按共用边连成块、只有一圈边界的块合成 n 边形、去掉共线点；有洞的留成三角形），pipeline 的 `brushToPoly`，后端 `POST /brush/to-poly`，MCP 的 `brush_to_poly`，白盒工具条"转成多边形网格"。单测 4 个；Chrome 里 greybox 的 Room 转成 RoomPoly、接着进多边形编辑。
16. **编辑器工程整理**（用户 11-22 要的，照 vue-tsx-pro）：四步各一个提交，每步验证槽跑改动相关的冒烟和 platformer、greybox 的编辑器验收都过。① 视口工具：引擎 `editor/viewport/tools/`（`ViewportTool`、`ViewportFrame`、`Clicks`、`FileEditTool`，五个工具类），EditorViewport 996 → 426 行、EditAgent 652 → 521 行；界面 `session/ViewportTools.ts`、`session/FileEditing.ts`（`createHistory`），会话 1515 → 1007 行。主 Chrome 里试的时候撤销按钮是灰的：撤销历史放在普通字段里，主工具条读不到它的变化，改成 `shallowRef`。② 前端分目录，工具条拆出 `ToolToolbar`；挪完库窗口的缩略图没了（`import.meta.glob` 的相对路径），新的 `tools/move.ts`（照 vue-tsx-pro 的 `pnpm move`）也改写 glob。③ 后端、MCP 分目录，`backend/bakers.ts`、`backend/http.ts`、`backend/files.ts`，MCP 434 → 25 行加 `mcp/tools/` 六个文件；MCP 客户端按 `import.meta.dirname` 找 cli.ts 的路径断了（单测抓到），`tools/move.ts` 挪完列出这类文件；样例脚本、工具改经包名导入编辑器。④ oxlint 1.94（类型感知），`pnpm lint` 管编辑器范围、零警告，CI 加一步；`FileEditing` 单测 2 个。
17. **全仓库整理**（用户 11-22 要的，照编辑器那次）：第一步 lint 清零（约 270 条，`pnpm lint` 管全仓库）、跨包导入走包名；第二步开发工具包 `@stride-ts/devkit`；第三步之一资源种类可登记和工程的编辑器扩展（greybox 的"柱子"示范）。中途：项目改名 World Engine（GitHub 仓库改名、README 重写，旧 README 挪成 `docs/design-notes.md`）；用户的 20 个自己的仓库改成 Apache-2.0（第三方声明保留，zerodep-vue 的 LICENSE 末尾附第三方组件的 MIT 文本）；"工具链换 Rust"的结论记进决定；`stride open --headless` 默认窗口改成 1920×1080（原来是又小又竖的默认值，编辑器的面板挤得点不中，用户指出）。第三步之二到之四：引擎子系统做成可登记的 `GameSystem`，调试命令按领域拆进 `debug/commands/`（回归按改动挑样例时，改了帧循环或调试命令也挑 open-world、photoreal：GameSystem 那次漏了它们，补跑过了）。第四步：网格着色器的 WGSL 分六段进 `rendering/mesh/wgsl/`（拆前拆后各导出一份着色器字符串逐字节比过，所以不用量帧时间），网格特性的 GPU 资源挪进 `MeshGpu.ts`（原样挪），资源的字段表按领域分进 `editor/fields/assets/`；`ForwardRenderer`、`ContentManager` 没拆（见决定）。第五步：`docs/extending.md` 和引擎、管线、开发工具包的 README。每步都在验证槽跑了按改动挑的回归（字段表那次带编辑器验收），全过。顺手：`Game.ts` 里挪子系统时落在 `addSystem` 上面的一段注释归回 `#updateRenderWind`，货架合并网格的单测超时放宽到 30 秒（验证槽并行时超过默认的 5 秒）。
18. **编辑器的样式和原生标签换成 vue-tsx-pro 的组件**（用户 11-22 要的：库里有同类的直接用或扩展 API，不够再建新组件、API 做全，带 demo）：横栏换成 Toolbar（库加停靠档位 docked、surface、留出焦点环的内边距），属性面板一节一个组件换成紧凑可折叠的 FormSection（库加 density），材质库、特效库换成 Listbox 的网格排列（库加 layout="grid"、ToggleGroup 加 wrap，修了单独用的 Listbox 点了拿不到焦点），粒子编辑器换成 Card、Grid、FormSection，场景树、资源浏览器、图层栏、音效生成器换成 Text、Strong、Empty、ControlGroup；新组件三个：DiagramPortNode 加 portNodeLayout（节点图）、ImageRegions（图上的区域，精灵表）、TrackTimeline（轨道时间轴），各带单测、浏览器测试（三种浏览器）、文档页。顺带修了：Workbench 浮动窗口左右下三边都能改大小、挪窗口不让一边空着、换窗口时标题栏菜单不复用（前两条用户指出）；属性面板的节按组件名加 key（折叠状态原来会串到别的实体上）；精灵表拖着挪框时框会被拉宽（'move' 里有字母 e，被当成拖右边）；主工具条的名字改成 World Engine，加了主题切换和全屏（用户要的）。vue-tsx-pro 的测试版改成推 master 时 CI 第一个任务发（滚动的 dev 预发行版、文件名带提交号，不再按提交打标签，用户定的流程），正式版是 v* 标签发 npm。每批都在 Chrome 里点过，编辑器的回归在验证槽里跑过（含编辑器验收）。
19. **白盒转多边形网格：带洞的面切成几块**（路线图创作工具的尾巴）：modeling/trianglesToPolygons.ts 的 diskPieces 把有洞的一块平面分成几块不带洞的简单多边形（规则见决定）；单测加了单洞、双洞（面积对得上、每块没有重复顶点、没有零碎三角形）。Chrome 里把 greybox 的房间转成多边形网格：160 个面里只剩 2 个三角形（原来地板上立着东西的地方是一圈三角形）。同一轮收尾了编辑器组件替换的第三批（在 Chrome 里点过时间轴、精灵表、节点图，验证槽回归含编辑器验收全过），删掉了 vue-tsx-pro 的 6 个旧 dev-<提交> 发行版和标签（只留跟着 master 走的 dev）。
20. **材质节点图每个节点的预览**（路线图创作工具的尾巴；用户 11-23 选了平面 UV 方块）：引擎 rendering/mesh/materialGraphPreview.ts（预览着色器的生成、MaterialGraphPreviewer），materialGraph.ts 拆出共用的 emitMaterialGraphNodes，nodeGraph.ts 的 sortGraph 加 all；编辑器节点图面板每个节点在端口行下面画预览、图一改就重画，找图片地址挪进会话（EditorSession.imageUrl，精灵表一起用）。单测查着色器的生成；Chrome 里 campsite 的石头材质：七个节点都有预览，改噪声的缩放后噪声和下游的颜色渐变、法线跟着变；同一张图重画 2 毫秒、改参数 115～150 毫秒（重编管线）。踩到一个坑：管线用 'auto' 布局时，没有贴图节点的图里采样器没被用到、被布局丢掉，绑定组对不上，改成按贴图数写明布局。同一轮：vue-tsx-pro 的 CI 修了两处（节点里有控件时 Diagram 的节点框改成 group，axe 的 nested-interactive；新组件让体积长了一点，重写预算），问了用户两件事（原生测试版暂时照旧本地发；节点预览画平面）。
21. **材质节点图的多段颜色渐变、自动排布**：颜色渐变节点加色标 `colorStops`（位置加颜色）和插值 `interpolation`（线性、平滑、阶跃），着色器里按位置排序后一段段 mix；单测在 JS 里求着色器的表达式，查三种插值和乱序的色标。编辑器：带列表参数的节点宽 280、高按项数算；节点没写位置时按连线分层排（vue-tsx-pro 的 graphLayout），工具条加"整理"（重排后视口适应内容）；库、campsite 和 photoreal 的搭建脚本、样例里的 10 份材质去掉节点位置（节点加了预览以后原来手写的坐标压在一起，photoreal 的全叠在原点）。Chrome 里 campsite 的石头：加一个色标、填 0.5 和红色，节点预览和视口里的石头跟着变红，换成阶跃是硬的红白斑；去掉位置的图自动摆开、不重叠。踩到：参数名起先叫 `stops`、`at`，属性面板全局的字段名翻译表把它们翻成了列车的"车站""停在"，改名。
22. **材质节点图的滤镜（烘焙、模糊、扭曲）**：引擎 `rendering/mesh/materialGraphBake.ts`（烘焙着色器、每个设备一个 `MaterialGraphBaker`、`bakedMaterialGraphTexture`），贴图数据加 `generate`（`GpuResources.texture` 第一次用到时调），加载材质时给滤镜节点建烘焙的贴图；节点图的预览和烘焙共用 UV 平面的声明。单测查烘焙着色器只算上游、材质里不再算滤镜的上游、模糊大半径换小一级、预览的显示。Chrome 里 campsite 的石头：斑块接扭曲（量是细噪声）、高度接模糊，节点预览和视口跟着变，没有 WebGPU 报错；`stride eval` 量烘焙：512² 约 4～6 毫秒，2048² 半径 0.01 约 25 毫秒。顺手：vue-tsx-pro 的输入框窄的时候单位（deg）把数值挤成 0 宽，改成输入框至少留 4 个字、单位先缩。
23. **材质节点图导出成贴图**：引擎 `offline/MaterialGraphExport.ts`（调试命令 `material-export`），`MaterialGraphBaker.exportOutputs` 把各个输出画进 8 位贴图读回，烘焙和导出共用 `uvPlaneShader`，sRGB 编码函数和预览共用；ContentManager 加 `loadMaterialGraphTextures`（加载材质也改用它）、`loadMaterialFile`。编辑器节点图工具条"导出贴图"（带上界面里没存的图），MCP 的 `export_material_textures`。单测查各种输出的编码。Chrome 里 campsite 的石头点"导出贴图"：存了 Rock_baseColor、Rock_normal（1024²，1.05 秒），法线图、颜色图看过；CLI 量 512² 0.34 秒、2048² 3.2 秒。顺手：会话里 `baking` 的注释原来放错了位置（在 tools 上面）。
24. **曲率遮罩和智能材质**：GTAO 的主着色器顺带算屏幕空间的曲率（世界尺寸 3 厘米外的四个点，κ = −2·n·q/|q|²），结果改成 rg8（g 是曲率，不模糊）；没开 AO 时绑的默认图换成"没遮住、平的"`openOcclusion`；网格着色器的 `screenCurvature`，节点图的 `curvatureMask`（edges、cavities 两个输出），平面上的替身是平的；`stride call ao '{"dump":"curvature"}'` 导出曲率图。库加两个智能材质（掉漆的金属、长青苔的石头），缩略图工具给智能材质换斜放的方块、开 AO；分类的翻译类型改用库的类型（原来在翻译表里重复列了一遍）。Chrome（无头）里 greybox：曲率图凸边白、凹缝黑；房间地面换上掉漆金属，平台上沿出现斑驳的掉漆边、墙脚积灰；GTAO 0.076 → 0.081 毫秒。
25. **绘制层的填充是节点图**：材质层加 `graph`；`compileMaterialGraph` 加后缀（一个材质几张图），ContentManager 的材质层编译重写（材质的图挪到最底下一层、各层的图当填充、没接的输出用树，抽出 `graphLayerFunctions`、`graphShaderLayer`），`MaterialShaderTrees.graphs` 是要调的函数列表；引用改写也看各层的图。编辑器：图层栏每层加"填充"菜单（纯色、库里带节点图的材质）和"节点图"，会话的 `graphPath` 让节点图面板编辑某一层的图（标题带"图层 n"），导出贴图导出面板上的那张。单测查编出来的层函数。Chrome 里 campsite 的石头材质：加绘制层、填充选掉漆的金属、在石头上画，画到的地方是青色的漆面；点这层的"节点图"打开的是这层的图。
26. **投影绘制**：MeshPainter 的笔刷加 `projection`（画面上的圆心、半径、宽高比、渲染原点），着色器拼进 `DEPTH_SURFACE_WGSL`，按主视图上一帧的深度判断看不看得见；PaintTool 的笔刷加 `projection`，落点换算成画面上的圆，每帧 `viewDepth.use()`；`paint` 命令加 `projection`（先出几帧留深度）；图层栏笔刷加"投影"开关。无头 Chrome 里 greybox 的球：投影画一笔，正面一个圆、背面干净；同一笔用球形笔刷对照。踩到：greybox 的箱子各面 UV 重叠，画一面全变，换成球来验。
27. **粒子编辑器的预览、序列帧的法线图**：引擎 `editor/ParticlePreview.ts`（编辑代理的 `particles`，视口每帧 `apply`，调试命令 `particle-preview`）；`FlipbookBaker` 加 `flipbookNormals`、`bake` 命令的 `normals`、`normalStrength`。编辑器粒子面板工具条加播放/暂停、从头放、速度、只看这个（切发射器页签时跟着换），烘焙弹窗加"也烘法线图"。单测查法线的方向和不跨格。Chrome 里 campsite 的篝火：面板工具条看过；无头 Chrome 里用命令验：播放时一直出帧、暂停后停下、只看第二个发射器时火苗那个关掉、0.1 倍速从头放 2 秒多只长出 78 个火苗（正常是 131 个满员）；烘 4×2 的序列帧带法线图 0.22 秒，法线方向对。踩到：主 Chrome 的窗口被挡住时标签不出帧（截图时才画一帧），这类验证改用无头 Chrome。
28. **SDF：视口里拖形状、更多形状**：fork 的 StrideNative 加 `ST_SDF_CONE`、`ST_SDF_ROUND_CONE`、`ST_SDF_HEX_PRISM`（GeometryApi.cpp、Tools.h、JS 绑定），编了发临时预发行版；格式、烘焙、字段描述加这三种。引擎 `sdfShapes.ts`（包围盒、按操纵器的平移旋转缩放改形状、加删形状）、`SdfEditTool.ts`、`EditAgent.editSdf`，白盒的盒子求交抽成 `boxHits`。编辑器：会话的 `sdfEditing`、工具条、属性面板模型组件上的"编辑 SDF"。单测：pipeline 烘三种新形状、报错；引擎查包围盒、缩放、平移旋转换进本地、加删。Chrome 里 greybox 的蘑菇：点选菌盖、拖 X 轴挪开（后端重烘、视口跟着变），加圆台、六棱柱、球、圆环都烘出来了。
29. **多边形的环选和软选择**：引擎 `modeling/polyLoops.ts`（`edgeLoop`、`faceLoop`、`softWeights`），`transformPoints` 加权重（软选择时周围的点按权重动），PolyEditTool 双击选环、软选择的着色和拖动，`sameEdge` 导出；编辑器工具条加软选择开关和半径，MCP 加 `poly_loop`。单测：4×4 网格上整行的边环、面环，立方体的边环只有自己、四个侧面绕一圈的面环，软选择的权重。Chrome 里 greybox 的箱子：双击侧面选中下半圈，软选择拖上去，上面的点按 0.84 的权重跟着动。
30. **多边形的环切**：`modeling/polyEdit.ts` 加 `loopCut`（面环加切边加连线拼出来）、`PolyOperation` 的 `loopCut`；编辑器工具条加"环切"（选一条边时能点），MCP `edit_poly` 的说明跟上。单测：4×4 网格切一整列（多 5 个点 4 个面、新点都在同一个 t 上），立方体绕侧面切一圈。Chrome 里 greybox 的箱子：边模式选下半截的竖边点"环切"，下半截正中多了一圈边（顶点 12 → 16、面 10 → 14）。
31. **多边形的 UV 编辑**：格式 `PolyFaceFile.uvs`（每个角的 UV，可选），烘焙（`polyMeshSlots`）个数对得上就用、对不上回到自动投影，翻面、镜像时跟着倒；纯函数 `modeling/polyUv.ts`（`faceUvs`、`projectFacesUv`、`transformFacesUv`、`resetFacesUv`），`PolyOperation` 加 `uvProject`、`uvTransform`、`uvReset`，MCP `edit_poly` 的说明和参数跟上。编辑器底部的 UV 工具窗口（`ui/editors/UvPanel.tsx`，编辑多边形时出现）：面模式里选中的面的 UV 画在棋盘格上，工具条平面投影、顺时针转 90°、左右翻、放大缩小、回到自动，拖着平移、滚轮缩放（松开才改文件，一步撤销）。单测：正对轴的面平面投影等于自动投影、斜面展开后边长不变，绕中心转放大再平移，烘焙用存的 UV、个数对不上回到自动、翻面倒序。无头 Chrome 里 greybox 的箱子：转、拖（160 像素 ≈ 0.99 个周期）、滚轮、放大都写进文件，前面放大三次后视口里网格贴图明显变密。顺手：① 查到旧的 MCP 服务（前一天起的，代码旧）也在监视 greybox、把新烘的模型用旧代码盖掉，改成两个后端共用烘焙的哈希表（见决定），新起的 MCP 开着时编辑器改 UV，模型只写一次；② 调试 CLI 的负数选项值（`--dy -300`）带着内部的前缀变成 NaN，`page scroll` 往上滚报 Invalid parameters，修了。
32. **高斯泼溅：反射里画、和透明物体遮挡**：`SplatRenderer` 改成按视图（`collect` 收各视图，`sort`、`draw`、`active` 带视图），前向渲染器给主画面、反射探针的面、平面反射、渲染目标贴图的相机都排、都画；泼溅挪进不透明的那一遍（表面目标写掩码 0），颜色画完再画一遍写深度（`vsDepth`、`fsDepth`，不透明度过 0.5 的那一圈）。测试：PlayCanvas 示例的酒店大堂（102 万个）经 MCP 导入营地的临时目录，页面里搭场景（`setRootScene`）：雕塑前的绿玻璃盖在雕塑上；挪到雕塑后面，被雕塑的轮廓挡住、铁丝缝里透出一点；挪到电梯墙后面完全看不见。镜面地板挂 `PlanarReflection`：倒影里有雕塑、投影仪、门；镜面球挂每帧拍的反射探针：球里是大堂。耗时（无头 Chrome、1080p、只有泼溅）：不透明那一遍 3.71 毫秒，写深度第一版多 0.94，四边形缩到只盖要写的那一圈后多 0.30。临时资源测完删了。
33. **高斯泼溅的细节层次**：引擎 `content/splatFile.ts` 版本 3（节点表 `SplatNode`）；pipeline 新的 `splatLod.ts`（`buildSplatLod`：八叉树、按格子矩匹配合并、格子按比例自适应，`symmetricEigen` 分解协方差），导入时调；引擎新的 `rendering/splats/splatLod.ts`（`selectSplatNodes`：按误差的堆、预算、视锥），`SplatRenderer` 每个视图选一刀、排序按选中的段二分；调试命令 `splats`（预算、像素误差，报画了几个）。单测：特征分解还原、两个高斯的矩匹配、5 万个的树（叶子加起来是原来的个数、粗的在前、编解码往返）、选节点的远近、预算、视锥。酒店大堂重新导入（2.0 秒建树，多 12.7%）后在无头 Chrome 里看：近处画面和之前一样（只画视锥里的 67 万个）；30 米外 1 像素误差画 85 万个、和全细节几乎没差；预算 20 万时平滑变粗。用过的 MCP 服务是旧代码，停掉让它重连后再导入。
34. **高斯泼溅按需加载节点**：`content/splatFile.ts` 拆出 `readSplatLayout`、`readSplatNodes`；`SplatCloud` 挪进自己的文件（`rendering/splats/SplatCloud.ts`：`fromBytes`、`stream`、`request`、`arrived`、`ready`，合并相邻节点、最多 4 个同时读、失败重试 3 次）；`ContentManager` 加 `readRange`（默认 fetch 带 Range、no-store）；`selectSplatNodes` 加 `ready`、`wanted`；渲染器每帧把到了的数据写进 GPU 再标就绪。单测：缺节点时画父节点、按范围读的请求个数和合并、读到的字和整个文件一致、失败重试和放弃、服务器回整个文件。无头 Chrome 里营地的临时目录放酒店大堂：头和节点表 14 毫秒，0.11 秒画出 4.6 万个，0.52 秒到齐 67 万个、只下了 2/3；第一版偶尔 Failed to fetch 让几个节点卡在粗的一级——加了重试，再压测找到是 HTTP 缓存和并发范围请求的问题，改 no-store 后不再失败。最终画面和整个读进来的一样。临时资源测完删了。
35. **多盏面光源的开销**：`mesh/wgsl/fragment.ts` 的 `areaShading`（每像素一次）、`areaLight` 加跳过和远处近似；`lighting/LocalLights.ts` 加 `ltcQuad`、`ltcHorizon`，`ltcPolygon`、`ltcLine` 改成接现成的坐标系。量法：photoreal 的 `?scene=Supermarket`，`stride perf` 看 ForwardRenderer opaque（6.42 → 3.20），临时不算面光源得出它占 5.5；画面和旧代码比（`git stash` 后重载各截一张，旧代码两次重载之间差超过 32 的约 300 个像素当噪声基准）：差别集中在层板朝下的一条线上，逐项关掉查出是地平线剔除，看像素值确认是旧的漏光；面光源测试场景（矩形、圆盘、管状）新旧最大差 1。
36. **商品进光追场景用简化的形状**：fork 的 `sn_bvh_build_triangles` 加 `max_triangles` 和小块按格子换成包围盒（`BoxSmallParts`：并查集分连通块、按中心分格合盒子），结果 [1] 是用了几个三角形，JS 的 `buildTriangleBvh` 加 `{ maxTriangles }`、`triangleCount`，原生的 JS 测试加 2000 件小物件加地板（fork 826ec18b、a1765f3d、61ba7879，临时预发行版 native-dev-61ba7879f3）；引擎 `RayTracingScene` 传 65536、记下每个 BLAS 的原来和用了的三角形数，调试命令 `raytrace-stats`。量法：页面里按连通块统计最大的货架模型（17679 块、对角线多在 1–4%），看出“一块一个盒子”不够；最终超市 190 万 → 41 万个三角形，光追反射 1.66 → 1.29 毫秒，主画面和简化前比差在噪声以内。
37. **熟食的碗和菜**：格式 `ProductShape` 加 `bowl`、`plate`，`ProductSurface` 加 `ceramic`，`ProductPattern` 加 `floral`，`ProductFile.food`（`ProductFood`：主料、配料、汤汁的颜色，level、mound、pieces）；新的 `modeling/ware.ts`（轮廓线、方盘的超椭圆、菜面的网格、青花和菜的 SVG），旋转体挪进 `modeling/lathe.ts`；字段描述和中文跟上（顺手补了果蔬的外形）。单测：碗、盘的尺寸和 UV，盛了菜的碗多一块菜面（中心鼓到口沿以上、边上低于口沿）、贴图有钴蓝和菜色。看了用户拍的熟食柜照片（青花碗成排、方盘、木托盘、保温灯）；经 MCP 在 photoreal 的临时目录写六份（红烧肉、土豆丝、蛋羹、空碗、花生、豆角），无头 Chrome 里摆在白台面上看：第一版菜面像一张饼、盘里的菜铺满到边，加大起伏、盘里的菜改成堆在中间后像了。临时资源测完删了。
38. **熟食柜**：格式 `ShelfFile.type` 加 `deli`，`modeling/shelf.ts` 的 `deliTray`、`deliLamps`、`deliBody`（加四种纯色：黑柜体、白石英、黄铜、暖光），`ProductBatch.tube` 加另一头的半径（圆台）；字段描述和中文跟上。单测：碗一排排摆在托盘里、灯的个数和位置、有发光。经 MCP 在 photoreal 的临时目录写五份菜（红烧肉、土豆丝、炸鸡块、炒青菜、豆腐）和一个 2.6 米的熟食柜，无头 Chrome 里搭场景（后墙、地面、灯位上的暖色聚光灯、头顶一块面光）：两排青花碗、黑托盘、白台面和金边都对，第一版灯罩是直筒，改成钟形；整个场景不透明那一遍 0.78 毫秒。临时资源测完删了。
39. **地贴导视**：格式 `SignFile` 加 `style: floor`、`shape`、`wear`、`seed`；`modeling/sign.ts` 的 `floorStickerSvg`；pipeline 的 `bakeSign` 地贴只写 `<路径>.svg`；字段描述和中文跟上。单测：三种外形、磨损的遮罩、同种子一样、尺寸报错。经 MCP 在 photoreal 的临时目录写三个地贴（"出口"箭头、"请在此排队"圆标、"一米线"），无头 Chrome 里用四个贴花投到地面上（一个箭头转 90°）：形状、字、描边、磨损都对；箭头上"出"看着像倒的，把 SVG 单独栅格化核对，是这款字体的写法。场景不透明那一遍 0.37 毫秒。临时资源测完删了。
40. **轨道射灯**：格式 `FixtureFile.type` 加 `track` 和 `length`、`heads`、`tilt`；`modeling/fixture.ts` 的 `trackSpots`、`track`（加暖白发光的纯色）；字段描述和中文跟上。单测：灯头等距、方向是单位向量且往下往前、模型有发光。经 MCP 在 photoreal 的临时目录写一根 2.4 米、4 个灯头的轨道，无头 Chrome 里吊在黑顶下、按 `trackSpots` 放四盏带阴影的暖色聚光灯，照地上三筐果蔬：第一次地上没有光斑——灯放在灯口正中被灯头挡住，改成灯口外 2 厘米后照亮了；抬头看轨道和灯头也对。不透明那一遍 0.40 毫秒。临时资源测完删了。
41. **包柱、墙砖、吊旗、地堆价牌**：材质库加 `wallTiles`（编辑器的 `library/index.ts`、名字、缩略图 `tools/dev/library-thumbnails.ts --only wallTiles`）；格式 `SignFile.style` 加 `banner`、`stand` 和 `hang`、`standHeight`，`modeling/sign.ts` 画横杆、吊绳、底座、立杆；字段描述和中文跟上。单测：吊旗的上下沿和吊绳、价牌立在地上、卡片顶在 standHeight。经 MCP 在 photoreal 用白瓷砖做一根方柱和一面墙（白盒）、写一面"天天低价"吊旗和"特价 9.9"价牌，无头 Chrome 里摆在一个堆头旁边看：吊旗和价牌对了；瓷砖第一版缝太宽太亮，调细后像了。不透明那一遍 0.33 毫秒。临时资源测完删了。
42. **照片比对：油货架**：新的 `apps/photoreal/scripts/build-oil.ts`（五种油、一排 3.2 米的靠墙货架、上面的深色木格子、过道上方三块面光、`OilShelf` 场景）；货架格式加 `boardColor`（字段描述、中文、单测）。无头 Chrome（960 × 1280）里 `stride shot --photo` 比了九遍：第一遍 SSIM 0.09、阴影亮 2.2 档、对比度 1.33 对 2.42 档；最后中间调差 0.8 档以内、阴影 +1、高光 −0.5、白平衡差 3% 以内、SSIM 0.13、细节 0.46 倍（过程见决定）。顺手弄清了 `localShadows` 的意思（暗处的反差系数，越小提得越多），场景不透明那一遍 0.63 毫秒。
43. **半透明的油桶**：材质格式的 `glossinessTexture.transmissionChannel`（ContentManager、Material、MeshGpu 的标志位 6..8、片元着色器乘到透射上）；透射的材质在透明阶段写深度（管线的键带上）。商品格式加 `transmission`（`productTransmission`、`productSurface`、`productSurfaceSvg`：表面贴图的 R，印的图形套滤镜涂成不透）；单独烘的透光商品多出 `.surface.svg`、材质带透射；`ProductBatch` 把前排透光的商品放进 `clear` 网格，`mergedClearMaterial`、烘焙写 `<path>.clear` 材质（模型的材质槽按有没有玻璃、透光的排）。字段描述、中文、单测（材质、表面贴图的颜色和滤镜、货架分出透光的网格）。油货架的五种油加 `transmission: 0.9`，无头 Chrome 里比：先是整排都透，瓶身发暗发绿；只让前排透后像了，再把油色调浅。影调和上一轮一样（中间调 −0.86 档、阴影 +1.1、SSIM 0.13），透明阶段 0.28 毫秒，一帧 GPU 2.5 毫秒。
44. **细致的包装图案**：商品格式加 `motif`、`badge`、`detail`、`colors.trim`（字段描述、中文）；`modeling/product.ts` 的 `labelDetails`（徽标、配料小图、细字、角标）、`bandFinish`（色带的镶边和明暗）、`motifShapes`（七种小图），设计加 `detail`、`motif`、`badge`，`productText` 给货架、堆放、单个商品的烘焙取字体子集（原来三处各拼一遍）。单测查细节的图形、关掉后没有、原来挑的不变。油货架的五种油写上 `motif`、`badge`，应用内置的浏览器里逐个看了标签的 SVG（第一版小图和徽标太小、芝麻是白的看不见，放大、改深色），无头 Chrome 里比照片：细节 0.45 倍。
45. **带提手的方桶**：包装加外形 `jug`（`modeling/product.ts` 的 `jugMesh`：旋转体加超椭圆的变形、偏前的瓶口、贝塞尔弯管的提手；`capLengthOf` 顺手把算盖子长的两处合成一个；字段描述、中文）。单测按尺寸查出第一版的肩前面鼓出桶身，改成按半径过渡。油货架的三种 5 升油换成方桶，无头 Chrome 里正面、侧面看过（侧面看得见提手），比照片：中间调差 0.83 → 0.61 档，细节 0.46 倍；GPU 一帧 2.4 毫秒。用户 11-23 改了顺序：做完这一步先做材质的细节，再做扫描场景的编辑，然后回到超市剩下的，路线图跟着改。
46. **边角的磨损**：`apps/photoreal/scripts/build-subway.ts` 的挡杆（HazardYellow：斜条纹、棱边掉漆、缝里攒灰）和屏蔽门（新的 DoorSteel：离地蹭花、棱边磨亮）换成节点图；编辑器库的节点图简写导出成 `nodeGraph`（`@stride-ts/editor/library`）。重搭站台（场景文件没变），无头 Chrome 里主机位比照片、相机挪到挡杆前看了条纹和掉漆、立柱下面的蹭花；GPU 一帧 3.4 毫秒。
47. **地上的碎石杂物**：格式 `content/formats/debrisFormat.ts`、`EXTENSIONS.debris`、引用、字段描述和中文、编辑器的新建模板和烘焙表（商品改了连带重烘）、多语言；`modeling/debris.ts`（`debrisSpawn`、`debrisBoards`、`debrisModel`，`randomRotation` 从 pile.ts 导出共用）；包装加 `leaf`（`leafMesh`、贴图）；`pipeline/src/bakers/settle.ts`（`readProducts`、`productFontTexts`、`loadFonts`、`settleProducts`），货架、堆放改用它，新的 `bakers/debrisModel.ts`。单测：范围、靠边的比例和疏密、同种子一样、合成时丢掉出界的、报错；落叶的尺寸。站台脚本加四种杂物和两块地面，`.gitignore` 忽略生成的文件；无头 Chrome 里贴近门脚看了石子、落叶、烟头躺在地上、靠门密，主机位比照片。
48. **杂物超了显存预算的修正，和两处环境的修正**：验证工作树的冒烟查出站台超预算（缓冲 21 MB、贴图 212 MB）；`ProductBatch` 的图集按内容定边长（`maxDensity`，杂物给 2）、小东西少分段（`TINY_SEGMENTS`、`produceProfile` 的 `detail`）、Model 组件加 `visibleInRayTracing`（组件、场景格式、SceneBuilder、`addModel`、批的键、光追场景、字段描述和中文、单测），站台的杂物关掉。无头 Chrome 里量：杂物的贴图 22 → 5.6 MB、缓冲 8 → 3.2 MB、光追场景 12.6 → 0.8 MB，贴近看杂物照旧。【主动改进】烘焙记录的哈希带上生成代码的版本（`packages/editor/src/server/backend/generatorVersion.ts`：改了生成的代码，旧生成物打开工程时重烘，这次一下补烘了 274 个文件）；MCP 模式下 console 打到 stderr（补烘的提示走了 stdout，`build-subway.ts` 读 JSON 时崩了）。重记站台的预算（验证工作树里 `STRIDE_UPDATE_BUDGETS=1`），顺手把 `MipmapGenerator` 的两种常用格式的管线改成后台预热（原来第一次出 mipmap 时当场编）。
49. **扫描材质的贴图并行压**：`importer.ts` 的 `importMaterialSet` 先写文件、再一起编码；`EditorBackend.#recordBake` 排队写共用的哈希表。量：单张 1K（Tiles141 的颜色图）29 秒（质量 100 时 5.6 秒、力度 0 时 18 秒）；经 MCP 的 `import_material` 导入一套三张，78 → 37 秒（在 greybox 里导入、量完删掉）。烘焙哈希带上生成代码的版本以后，验证工作树里 open-world 的两棵树（进 git 的生成模型）被重烘、和提交的不一样：提交的是按旧的长树代码烘的。主检出里每个工程开一次编辑器后端补烘（只有这两棵变了，两边烘出来逐字节相同），提交新的。
50. **高度贴图接上视差**：材质格式 `NormalMapSlot.parallax`（Material、ContentManager、MeshGpu 的材质缓冲加一个 vec4、640 字节，`fragment.ts` 的 `parallaxUv`）；图片导入设置的 `alpha`（`EditorBackend.#packAlpha`，引用登记、字段描述、中文）；导入扫描材质时并高度贴图（`importer.ts`、`scannedMaterial` 的 `parallax`、MCP `import_material` 和 HTTP 的 `parallaxDepth`）；`tools/assets.ts` 的哈希带上选项、传 `parallaxDepth`。资源仓库：Tiles141 加 ambientCG 包里的 Displacement（CC0），重新构建、发 dev 预发行版装上。站台的地砖材质开视差（4 毫米）；无头 Chrome 里低角度比开关、调到 5 厘米确认方向；不透明那一遍 0.57 → 0.61 毫秒。单测：扫描材质开视差、认出高度贴图。
51. **扫描场景的编辑（第一步：资源和烘焙）**：格式 `content/formats/splatEditFormat.ts`、`EXTENSIONS.splatEdit`、引用、字段描述（新的 `fields/assets/scans.ts`）和中文、新建模板、烘焙表（源泼溅重新导入时连带重烘）；`content/splatEdit.ts`（`decodeSplatSource`、`applySplatEdit`、`insideBox`，引擎的导出 `@stride-ts/engine/splat-edit`）；`pipeline/src/bakers/splatEditModel.ts`（`bakeSplatEdit`，导出 `buildSplatLod`）。单测：读回原样、裁剪和刷掉、转了的盒子、删飞点、烘焙和报错。真实数据：PlayCanvas 的 hotel-culpture 经 MCP 导入 photoreal 的临时目录（3 秒），写一个只删飞点的编辑（烘 4.6 秒），无头 Chrome 里原样、编辑过的同一个角度比（115 → 110 万个，天花板上的糊淡了），GPU 一帧 1.7 毫秒；量完删掉。【主动改进】烘焙记录改成版本加内容的哈希、生成物在不在按生成器的输出查（见决定）。
52. **扫描场景的编辑（第二步：编辑器里框选、刷选）**：引擎的 `editor/viewport/tools/SplatEditTool.ts`、`splatBoxes.ts`（框、操纵器的改动、加删框、主体的范围 `splatExtent`、一笔里放球 `extendStroke`），`EditAgent.editSplats`；`content/splatEdit.ts` 的 `splatEditMask`；`SplatRenderer` 加遮罩（顶点阶段的 `masked`、`setEditMask`）和点选的一遍（`fsPick`、`drawPicking`，ScenePicker 调它）；编辑器的 `ViewportTools.startSplatEdit` 等、属性面板的按钮、工具条、多语言。单测：加框、操纵器、主体的范围、刷、GPU 遮罩和 CPU 判断一致。无头 Chrome 里经编辑器界面（`stride page`）走了一遍：导入 PlayCanvas 的酒店扫描、点"编辑扫描"自动建编辑、加删除框（第一版太大，改了）、刷选在雕像上刷掉一道（第一版一笔 143 个球，改了以后 31 个）、松开存盘重新生成、完成后看生成的；顺手修了后端改名重试太短（EPERM）。临时文件测完删了。
53. **对齐、合并几段扫描**：格式 `SplatEditPart`、`merge`（字段描述、中文、引用）；`content/splatAlign.ts`（`transformSplats` 连球谐一起转、`shRotation`、`concatSplats`、`alignSplats` 的 ICP 和 k-d 树、`similarity`），从 `@stride-ts/engine/splat-edit` 出去；烘焙先合并；后端 `alignSplatPart`、HTTP `/splat-align`、客户端、MCP `align_splats`；视口工具的合并段（蓝框、操纵器绕框的中心）、工具条"合并一段""自动对齐"。单测：球谐转前转后的颜色一致、变换、点对的相似变换、ICP 在带柱子桌子的房间上对回来（全是平面时比例、平移会互相抵，第一版的测试场景太平）、合并段的框和操纵器。真实数据：酒店扫描两块经 MCP 和编辑器界面各对齐一次（37 → 3.7 秒）。
54. **扫描的调色**：格式 `color`（字段描述、中文）；`content/splatEdit.ts` 的 `splatColorMatrix`、`applySplatColor`（烘焙最后一步）、`splatColorPreview`；遮罩加调色的三行（`splatEditMask` 的头从 4 个数变成 16 个，渲染器 `masked` 的框从第 4 项起、`project` 乘矩阵）；视口工具记着存过的调色（`saved`），会话里存文件集中到 `#commitSplat`；工具条"调色"弹出四个数和"还原"。单测：恒等、曝光、饱和度 0 的亮度、色温方向、烘焙的颜色和球谐、预览的矩阵、遮罩。无头 Chrome 里经编辑器界面在酒店扫描上调曝光、色温、饱和度，预览和重烘的画面比过。
55. **代理网格**：格式 `proxy`（字段描述、中文）；`content/splatProxy.ts`（体素化、闭运算、去碎块、Surface Nets），从 `@stride-ts/engine/splat-edit` 出去；烘焙的第二个输出 `.proxy` 模型（`SPLAT_PROXY_SUFFIX`，简化、光滑法线）；Model 的 `visibleInCamera`（组件、场景格式、SceneBuilder、`addModel`、MeshRenderFeature 的批键和按阶段过滤、字段描述）；会话的 `setSplatProxy`（等烘好再挂组件）、工具条"代理网格"。单测：封闭朝外、体积和大小、薄墙的扁泼溅、去噪点和透明的、格子自动放大、烘焙出两个文件。在用户的主 Chrome 里和用户一起看：编辑器界面点"代理网格"、临时打开"画进画面"看网格、试玩里扔五个球。顺手修了：MCP 的 `write_asset` 写 SDF 时形状缺 `position` 报的是"undefined is not iterable"——后端存生成类的资源烘不出来时，先照字段描述查（`checkFields`），有问题就报缺了哪个字段（单测：白盒的笔刷缺位置）。
56. **价签的透明挡条**：货架格式 `tagHolder`、`tagAccent`（字段描述、中文）；`modeling/shelf.ts` 的 `tagRail`（玻璃的挡条加不透明的折边）、`railTag`（放大、仰着插在后面）、`accentTagCell`（白底深灰字、右边色块）；`build-oil.ts` 换上（挡条、照片里量的蓝 #28a9d7）。单测：挡条进玻璃网格、顶点数、价签的法线和位置、色块。无头 Chrome 量了近景和耗时，再在用户的主 Chrome 里打开近景给用户看。
57. **照片比对：调料过道、饮料冷柜**：`apps/photoreal/scripts/build-sauce.ts`（六种酱、16 米九层的木层板货架、黑顶天花板，`SauceAisle`）、`build-drinks.ts`（三种新饮料、五台单门品牌冷柜，`DrinkFridges`）；货架格式加 `stock.levels`、`boardThickness`、`doorColor`（字段描述、中文、引用），冷柜加门把手和门下的前脸。单测：按层摆、层板厚影响净空、品牌冷柜的颜色和把手。无头 Chrome（960 × 1280）`stride shot --photo` 各比了五六遍，量了帧时间。用户 11-23 指了照片的原始目录（微信的临时目录），和 reference/shop 一样，记进备忘。
58. **自助收银机**：器具格式加 `selfCheckout`（字段描述、中文），`modeling/fixture.ts` 的 `selfCheckout`、`selfCheckoutCells`、`fixtureText`（烘焙器照它取字形）；超市左墙前三台（build-shop.ts）。单测：站在地上、发光、图集里有界面、挂臂往顾客那边伸。用户要一起看，在用户的主 Chrome 里打开、凑近看，发现屏上没字（烘焙器只给收银台取字形）、袋子像实心的白箱子，改了重烘。顺手修了闸机错挂的注释。
59. **多盏面光的开销**（用户说帧率到不了 120）：`stride perf` 分出面光占不透明那一遍的 5.2 毫秒、镜面占 3.2；`fragment.ts` 的 `areaLight` 镜面按 max(α, φ) 走小光源，`LocalLights.ts` 的 `rectCorners`、`ltcRect` 换掉 `ltcQuad`。4K 下不透明那一遍 5.96 → 4.18 毫秒、GPU 合计 10.83 → 8.97，改前改后截图比过。按用户的要求查了前沿的做法（MegaLights、Stochastic Tile-Based Lighting、ReSTIR、CWBVH、混合反射），记进 research.md，两项排进路线图；克隆了 tinybvh 到 C:/code/refs。环境上：用户的游戏标签切到后台时 `stride perf` 等不到帧——测量改在同样大小（`--size 1920x961 --dpr 2`）的无头 Chrome 里做；Bash 的 heredoc 里写反斜杠会少一层（路线图的路径被转义坏），记了备忘。
60. **性能：找长帧、阴影射线**（用户说帧率还是不稳，接下来做性能）：`GpuProfiler` 记最近 600 帧逐帧的通道耗时（`frames()`），`stride perf` 多报 GPU 每帧合计和跨度的分布、最慢的三帧前五个通道、CPU 一侧最慢的五帧（调试 CLI 的改进）；4K 无头 Chrome（`--size 1920x961 --dpr 2`，和用户的屏一样）量出不稳是 GPU 15 毫秒、跳两三次刷新，逐个关效果分出面光、光追反射、SSR 各占多少；光追加 `rtOccluded`（任意交点，阴影射线用），过道机位的光追反射 3.8 → 3.3 毫秒。987b8c5 的验证里 platformer 失败了一项，单独重跑通过（偶发，那次的输出被截掉了，再出现时抓日志）。
61. **面光的四种做法都试过**（用户：可以直接改渲染器结构）：像素按簇抽灯、延迟的面光（计算着色器按块）、漫反射 2×2 分摊（工作组屏障版和子组 quad 版）、按块抽灯（并行挑灯）。每样都在 4K 无头 Chrome 里量、和前向逐像素比过，数字和不留的原因见 decisions.md"面光的几种做法都试过了"；补丁存草稿目录。实验都写成脚本文件、`trap` 保证结束时还原源文件（不在工作区留半截改动）。顺手：`shadeLight` 的注释挪回原处，`tools/regress.ps1` 最后列出失败样例的 FAIL 行。
62. **SSR 半分辨率追踪、光追直射光一遍走完**：`reflectionWgsl.ts` 加 `rayPixel`（半分辨率光线出发的像素，SSR 和光追反射共用）；`ScreenSpaceReflections.ts` 的追踪贴图半分辨率、空间解析在半分辨率里找光线（自己那格也查同一表面）、合成的调试视图按半分辨率读；`RayTracedReflections.ts` 读追踪结果用同一格、尺寸跟着追踪贴图；`RayTracedLighting.ts` 的 `rtDirectLight` 一遍里记前几盏加蓄水池抽样。4K 无头 Chrome 量：GPU 合计 14.3 → 13.5 毫秒，和改前截图比过。
63. **光追的 BVH 换成 4 叉**：fork 的 `BvhApi.cpp` 加 `WideNode`、`Widen`，`sn_bvh_build_triangles`、`sn_bvh_build_boxes` 输出 4 叉节点（原生测试查包含关系、每个三角形都在叶子里、每个节点都走得到、节点数）；`RayTracingScene.ts` 的 `rtWideBoxes`、`rtTraceBlas`、`rtTraverse` 换成宽节点的遍历，栈 24，检查用的遍历器跟着改。第一版反的空盒子被当成测中、显卡超时，改成显式比较。4K 无头 Chrome 量：光追反射 3.02 → 2.42 毫秒、GPU 合计 13.5 → 12.8，和改前截图比过。
64. **运动向量只画动过的网格**：`MeshRenderFeature.ts` 的 `#updateBatchBounds` 改成 `#trackBatchChanges`（一直跟踪、记 `movedAt`，GPU 剔除时才算包围盒），`draw` 在运动向量的阶段跳过 `#moves` 为假的批；`TemporalAntialiasing.ts`、`MotionBlur.ts` 的深度重投影用不带抖动的视图投影的逆。4K 无头 Chrome 量：运动向量那一遍 0.34 → 0 毫秒，GPU 合计 12.83 → 12.61；`stride eval` 每帧挪冷柜看 `stride draws`，那一遍照样画它。宽 BVH 那次的单测（`raytracing.test.ts` 的 CPU 遍历）也换成了 4 叉布局：第一次跑时它还按旧布局走、死循环 5 分钟才失败。
65. **熟食：落下去堆起来的菜**：格式 `ProductFood` 加 `dropped`、`pieceSize`；`modeling/ware.ts` 加 `foodPieces`（块、丝、粒的形状和色块）、`foodSpawn`（分批的落点，丝一把把平躺并排）、合网格的 `settledPieces`（菜面底下的不要），菜面贴图四角画色块，`foodEdge` 把菜面边上的高度抽出来共用；`productMesh`、`ProductSources.food` 带上落定的位姿；`randomRotation` 挪进 `data/hash.ts`。pipeline 的 `settle.ts` 抽出共用的 `settle`（分批放、抬高、步数从最后一批算、`using` 释放），加 `settleFood`（按商品内容缓存），货架、堆放、杂物、单个商品的烘焙器接上。原生（fork 33318456，`native-dev-333184568d`）加连续碰撞检测，引擎 `Body.continuous`、场景格式、导入器、字段描述和中文跟上。新的搭建脚本 `apps/photoreal/scripts/build-deli.ts`（`?scene=Deli`，六样菜的熟食柜）。单测：块的形状、落点、丝并排分批、合网格、色块；pipeline 的 `settle.test.ts`（块、粒落在碗里、可复现）；原生测试连续碰撞。无头 Chrome 里看了四遍：第一遍丝立成柱子、改成一把把平躺着落，块和豆子一次就对。
66. **冷柜门上的广告贴、LED 灯带、玻璃的反光**：格式 `ShelfFile.doorSticker`（`ShelfDoorSticker`），`modeling/shelf.ts` 加 `stickerCells`、`doorSticker`（横幅和下面那条是图集的格、两边边框是纯色 `STICKER`），冷柜的灯带换成 `LED` 纯色（自发光 120、2 厘米宽）；pipeline 的货架烘焙把贴纸的字放进字体子集；字段描述和中文。`build-drinks.ts` 给白冷柜贴上紫色的"冰冻专区"，过道里加一个按盒子投影的反射探针；`build-deli.ts` 的实体编号前缀改成 0004（原来和饮料冷柜的撞了）。单测：两扇门多两条横幅、两条边框，图集里有贴纸色。无头 Chrome 里和照片并排比了四遍。
67. **玻璃罐里透出来的酱**：`modeling/product.ts` 的 `labelPrint` 对不透光的玻璃罐先画 `contentsShapes`（红油一层、辣椒碎、芝麻、渣）；`ware.ts` 的 `shade` 挪进 `svg.ts` 成为共用的 `shadeColor`。`build-sauce.ts` 给三种酱写上红、黄、绿的色带，加反射探针。单测：玻璃罐的标签多出几十个颗粒、有芝麻色，塑料罐、玻璃瓶不画。无头 Chrome 里近看了两遍（第一版颗粒太小看不出来）。
68. **按种子的随机变化（第一轮）**：格式 `ShelfStock.messiness`、`ProductFile.wear`；`modeling/shelf.ts` 的 `planShelf` 摆货时转、推、错开（`ROUND_SHAPES`），`woodCell` 木纹格，层板有 `boardColor` 时用 `ProductBatch.texturedBox`（`addBox` 加了按面算 UV 的回调）；`modeling/product.ts` 的 `labelWear`。字段描述、中文。单测：乱度 0 整齐、默认时转过而不重叠，木纹层板的 UV 散开、图集有木纹线，旧了的标签有灰、wear 0 和果蔬没有、表面贴图不变。重搭了油货架、调料过道和照片比。记忆里记下用户定的方向（`seeded-variation-realism`）。
69. **带注释的 `.jsonc` 内容文件**：引擎 `data/jsonc.ts`（`parseJsonc`、`stripJsonc`，content-format 导出），`assetFormat.ts` 的 `jsonContentFile`；编辑器 `AssetDatabase`（扩展名表加 `.jsonc`、`mainFile`、主文件用 `parseJsonc`）、`EditorBackend`（`#jsonFile` 按数据库的主文件、`#readJson`、给烘焙器读文件时找 `.jsonc`）、`rewrite.ts`、`assetTypes.ts`；pipeline 的 `settle.ts`、`textFont.ts`；`vite.ts` 加 `strideJsonc`（开发服务器发去掉注释的、构建时换成 `.json`），devkit 的 `strideApp` 接上；`check-fields.ts` 认 `.jsonc`。字段描述的检查拆出 `fieldValues.ts`（加 `withDefaults`）。单测：解析（注释、尾逗号、字符串里的 //、行列不变、报错位置）、数据库认 `.jsonc`、后端读出来去掉注释、存回原来的 `.jsonc` 不另建 `.json`、构建换文件。无头 Chrome 里打开过带注释的场景。
70. **有类型的内容文件（模式、货架试点、IDE 的 JSON Schema、新建默认 `.jsonc`）**：`content/schema/schema.ts`（`Schema`、`s.*`、`Infer`、`InputOf`、`parse`、`safeParse`、`~standard`、`$type`、`nullableList`、`schemaFields`），`builders.ts`、`fieldValues.ts` 一起挪进 `content/schema/`（单独的整理提交）；`shelfFormat.ts` 换成模式 `SHELF`，`retail.ts` 的 `SHELF_FIELDS = schemaFields(SHELF)`，`modeling/shelf.ts` 入口解析、删掉默认值；`editor/fields/jsonSchema.ts` 加 `contentFileSchemas`；`tools/json-schemas.ts` 导出 `schemas/` 和 IDE 关联（`.vscode/settings.json`），单测 `fieldSchema.test.ts` 跑 `--check`；`EditorBackend.#jsonFile` 新建的是 `.jsonc`，编辑器的测试跟着改。单测：模式的类型推导（`expectTypeOf`）、补默认值（嵌套、列表、几种形状之一）、报错带路径、字段描述、Standard Schema。bepu-sample 的实体数预算在机器很忙时超过一点（373 对 366），单独重跑通过：子弹按游戏时间攒，冒烟收尾时多几个，记着，再出现时把那条检查改成按固定的游戏时间量。
71. **堆放换成模式**：`pileFormat.ts` 换成 `PILE`（`PILE_ITEM`、`PILE_HEAP`），`PILE_FIELDS = schemaFields(PILE)`；`modeling/pile.ts` 的入口（`pileContainer`、`pileCell`、`checkPile`、`pileSpawn`、`pileModel`）收文件的样子、解析一次，内部的 `containerOf`、`cellOf`、`checkParsed` 收解析后的，删了 8 种 `?? 默认值` 和 `DEFAULT_WALL`；两条说明去掉"没写时……"（默认值由模式给出、面板和 JSON Schema 里显示），中文跟着改，重新导出 `schemas/`。
72. **超市和地铁场景的资源换成 `.jsonc`**（用户 2026-11-23 说两个场景都改成这种模式）：新的 `tools/to-jsonc.ts`（只改进了 git 的人写的内容文件，`git mv`，`--dry` 先看），`apps/photoreal/public/content` 的 133 个文件（场景、商品、货架、堆放、招牌、天花板、器具、杂物、白盒、手写的材质）改成 `.jsonc`；`.gitignore` 里只放行源文件的那几条（生成的大文件和源文件同目录的）改成 `*.<种类>.json*`。烘焙的生成物照旧 `.json`、不进 git。无头 Chrome 里打开 `?scene=Supermarket`、`?scene=Subway` 都在跑、没有报错，编辑器后端打开时按 `.jsonc` 的源补烘了 383 个文件。导出的 JSON Schema 声明 draft 2020-12：用户问是不是最好的——是现在最新发布的版本，和 MCP、OpenAPI 3.1 一致，两种 IDE 都支持；我们只用了各版本通用的那些关键字，换版本只改生成器的一行。
73. **招牌、天花板、器具、杂物换成模式，安装后自动导出 schema**：`SIGN`、`CEILING`、`FIXTURE`、`DEBRIS`（`DEBRIS_ITEM`）四份模式，字段描述 `schemaFields`，`modeling/sign.ts`、`ceiling.ts`、`fixture.ts`、`debris.ts` 入口解析一次、删了重复的默认值（按种类、样式不同的配色留在代码里）；模式过了以后走不到的两处检查（器具的种类、杂物的边）删了，测试认模式的报错。模式的 `default` 改成照文件的样子写（对象的默认值可以只写一部分），解析时默认值里面没写的也按各自的默认值补——原来不补，`lights: {}` 这种会缺字段。根 `package.json` 加 `postinstall`（`tools/json-schemas.ts`，失败只提示）和 `pnpm schemas`。在 CLion 里实测 `.jsonc`：注释不报错，schema 的越界、多余字段照报（警告），尾逗号标红（我们的解析器认），记进 CLAUDE.md：`.jsonc` 里别写尾逗号。photoreal 里这六种资源（38 个文件）都过了新模式。
74. **不用 GitHub 的 CI**（用户 2026-11-23 定）：删 `.github/workflows/ci.yml`、`tools/content-key.ts`；`tools/verify.ps1` 先跑类型检查、单测、lint 再跑回归，失败的一起报（`-NoChecks` 跳过）；CLAUDE.md 的测试规矩、`tools/README.md`（删了 CI 一节）、`docs/handover.md`（定时任务的提示词、工具表）跟着改；记忆里"提交前要测试通过""不等 CI"改成提交直接推、测试槽后置；会话里的定时任务按新提示词重建。
75. **商品格式换成模式**：`productFormat.ts` 换成 `PRODUCT`（`PRODUCT_FOOD`、`PRODUCT_COLORS`；外形、材料、底纹、配料小图改成 `as const` 的数组、类型从它推出来），`PRODUCT_FIELDS = schemaFields(PRODUCT)`（`hexColor` 挪进格式成了 `seededColor`）；`modeling/product.ts`、`ware.ts` 的导出函数收文件的样子、解析一次，内部都收 `Product`，删了种子、旧了多少、透光、印得细、菜的高度、鼓起、样子、块数这些固定的默认值（按种子、外形挑的配色、底纹、品牌名、材料留在 `productDesign`）；透光不用再夹在 0..1（模式查范围），测试改成越界报错。仓库里 55 个商品文件都过了新模式。
76. **白盒换成模式**：`assetFormat.ts` 的 `BrushFile` 换成 `BRUSH`（笔刷是 `BRUSH_SHAPE`：`s.union` 的四种形状加共用的运算、位置、旋转、材质槽；多边形的点照旧是原样的 JSON、用 `$type` 给出类型，属性面板不变），`BRUSH_FIELDS = schemaFields(BRUSH)`；烘焙器 `bakeBrushModel`、`brushToPoly` 入口解析，删了 `DEFAULT_SEGMENTS` 和几处默认值（原生的 `Brush` 类型导入时改名 `NativeBrush`，免得和解析后的白盒重名）。格式文件要在运行时用模式，`builders.ts` 原来为 `textureRef`（贴图的字段描述）在运行时引了 `assetFormat.ts`，绕成了环（`TEXTURE_EXTENSIONS` 还没初始化）：`textureRef` 是具体资源的字段描述，挪进 `editor/fields/assets/shared.ts`，`builders.ts` 只剩通用的构造函数、运行时不依赖任何格式。仓库里 15 个白盒文件都过了新模式。
77. **货架顶上的格子柜**：货架加 `cubbies`（`SHELF` 模式里：高、深、几排、每个立柱间距几格、木头颜色、`hex` 个六边形格、瓶子、有瓶子的格子的比例）。`modeling/shelf.ts` 的 `planCubbies` 先按种子挑六边形格的位置（不挨两头、互相隔开，占 1.3 格宽、上下贯通所有排、左右在半高处是尖角——照片里就是这样），六边形格把每排切成几段，每段每排各分各的格子（格宽 0.8～1.2 倍，上下两排的竖板错开）；瓶子瓶口朝外、离前沿 2～5 厘米横躺成一排，之间留半个瓶身，绕瓶身各转一点。`cubbyBody` 画底、顶、背板、侧板、横板、竖板（木纹格，种子和层板的不同），六边形格两边的竖板和四块斜板（`ProductBatch.plank`：XY 平面里任意方向的板）。油货架换上（高 0.55 米、两排、每间距三格、一个六边形格，三种深色玻璃的酒：红、黄、绿盖），原来白盒拼的空柜子（`Cubbies.brush`、`DarkWood` 材质）删了。照片里格子柜两排一共大约半米：0.8 米时格子太空、酒瓶显得小，改成 0.55。
78. **同一列前后一样、价签按商品定价**（用户看了油货架说的）：① 透光的商品原来只有前排透射，后排不透明地画标签图的底色（浅黄的油色），露出来的瓶肩像另一种货。先试了后排另用一格标签图、瓶身压暗成透着油看到的颜色（`seenThroughOil`，在截图上量着前后排瓶身侧面的颜色调到差 5% 以内），用户还是看得出不一样：朝上的瓶肩不透明时被顶灯直接照亮、透射时照样暗，底色对不齐两种材质。最后改成透光的商品每一排都进透射的网格（`ProductBatch.finish` 的 `clear` 不再看 `fine`），压暗那一格的代码删了；透过去看到的是货架暗的背板、发暗发绿（当初只让前排透的原因），油的底色换成更饱和的琥珀色、透光 0.9 → 0.75。1080×1920 下油货架透明阶段 0.91 毫秒、GPU 一帧 2.7 毫秒，饮料冷柜 6.0 毫秒、画面没变。② 商品加 `price`（元）：价签第 0 款印它，别的款（别的牌子）按款式和货架的种子在 0.9～1.12 倍，取整到元配尾数（.90、.80、.50，二十块以下还有 .00、.99）；没写的照旧从 8 个随机价格里挑，挑的那次随机数照旧取，摆货不变。价签不再固定 8 格，每个不同的价格一格（`ShelfTag.price` 是印的字）。photoreal 的 41 种商品写了零售价（5 升花生油 129.9、调和油 69.9、矿泉水 1.5……）。③ 顺带发现：开发服务器开着时改了生成器，MCP 服务用新代码烘了货架，开发服务器看见商品文件变了，按 `REBAKE_WITH` 用它加载的旧代码把用着商品的货架又烘了一遍、盖掉了新的。`generatorVersion.ts` 加 `generatorCodeIsStale`（磁盘上的源文件的哈希和进程加载时的比，一秒内不重算，一次 80 毫秒），`#bake` 开头查：旧了就不烘，保存时报错叫重开后端，被动重烘时留警告。
79. **标签的细字**：照片里油桶的标签上有好几行看得出是字的小字（卖点、净含量），我们只有几行灰的短横。商品加 `claims`（卖点；没写时按种子从 12 句通用的里挑两句，挑在原来那些之后，原来挑的品牌、配色不变），设计带上 `claims`，`productText` 把卖点和"净含量"放进字体子集。`labelDetails` 的细字：卖点印在强调色的圆角色条上（白字），有角标时下一行"净含量 5L"（墨色），再往下才是短横；没有字体时照旧都是短横。油货架的五种油写了卖点（非转基因、物理压榨、一级、小磨香油……）。4K 无头 Chrome 里看了标签特写：色条和净含量清楚，短横不再和字挤在一起；油货架 4K 下 GPU 一帧 8.1 毫秒（图集大小没变）。
80. **冷柜玻璃上的手印和雾**（随机变化那一项）：货架加 `doorHaze`（默认 0.5，0 是干净的）。`fridgeFront` 每扇门在玻璃外 1.5 毫米贴两片（`ProductBatch.hazeQuad`）：把手周围（左右各 17 厘米、上下多 10 厘米）和底下 42 厘米高的一条，UV 落在一张横排的贴图里这扇门那一格；贴图 `doorHazeShapes` 按种子画指头大的手印（径向渐变的椭圆）、一两个掌印、灰点，底下上沿起伏的水雾（线性渐变）和水珠。`MergedProducts` 加 `haze`、`hazeSvg`、`hazePixels`，烘焙写 `<path>.haze.svg` 和 `mergedHazeMaterial`（白、混合、粗糙度 0.55）。第一版整扇门都贴、整片发白：着色器是预乘输出，颜色没乘贴图的 alpha——改了着色器（透明阶段不透射的材质颜色乘 `base.a`，见 decisions），再改成只贴两片（透明阶段 +1.15 → +0.15 毫秒，1080×1920 下饮料冷柜 GPU 一帧 6.4 毫秒）。单测查每扇两片、UV 在自己那格、每扇的贴图不同、0 时和别的货架没有。
81. **地面、墙的脏污和划痕**（随机变化那一项，只改 `apps/photoreal/scripts/build-shop.ts` 的节点图，不动引擎）：地面在原来的瓷砖、深浅、细磨痕上加 `dirt`（世界 UV 0.35 的低频噪声取 0.45～0.68 一段当灰印，加 `occlusionMask` 让货架脚下、墙角更脏）混向灰褐色，`scratch`（世界 UV 拉长 40 倍、转 8° 的噪声取 0.67～0.69 很窄的一段，顺着过道的细线）稍亮；粗糙度在脏处 +0.18、划痕 +0.15。墙从纯色换成节点图（白盒的自动 UV）：大片淡水渍、墙根 12 厘米往上渐隐的脏（`heightMask` 乘噪声）、0.15～0.9 米高横着的黑色擦痕（拉长的噪声，`heightMask` 限高度）。调参时把脏、划痕临时染成红、蓝看分布（噪声很少到 0.8 以上，第一版几乎看不见；划痕第一版方向横着），在无头 Chrome 里用 `stride eval` 把相机挪到右墙前看墙根。1080×1920 下超市 GPU 一帧 5.30 → 5.27 毫秒（噪声以内）。
82. **`stride eval` 认 TS 的写法**（改进调试工具）：`--file` 读的多半是 TS（非空断言、类型注解、`as`），原来原样发给页面、报 SyntaxError；现在发之前用 Node 的 `module.stripTypeScriptTypes` 去掉类型（实验性的接口，调用时临时不打它的提示）。`--check` 照旧按引擎的类型查。
83. **器具、招牌的磨损**（随机变化的最后一项）：新的 `modeling/wear.ts` 放用旧了的两种画法——`printWear`（印刷面上的褪色、手印、擦痕，原来是商品的 `labelWear`，挪过来共用）和 `wornPaintCell`（一张 512² 的旧漆格：深浅不匀的几大块、贴着四条边的掉漆（漆面露出灰的金属，不锈钢是暗的划伤）、细划痕、靠底一截发脏和几道黑印；`texturedBox` 每个面铺满整格，格子的上沿正好是竖直面的底）。`ProductBatch.textureSolid(solid, cell)`：之后 `box` 里用这个纯色的都换成贴这一格，生成函数不用改。器具加 `wear`（默认 0.4）、`seed`，主色换成旧漆格；招牌的 `wear` 从只给地贴扩到所有样式、默认 0.3，外框换成旧的不锈钢格，字面的格子在字上叠 `printWear`（灯箱的也画进发光层，脏处透光少）。单测查器具、招牌用旧和不用旧的区别、种子不同图不同。无头 Chrome 里挪相机看了自助收银机：柜体边角掉漆、底部黑印。
84. **用上浏览器的新特性：第一步**（用户 11-23 定两批都做、以开了实验特性的最新版 Chrome 为主）：`GraphicsDevice` 按适配器请求 `OPTIONAL_FEATURES`（默认上限模式只要 `BASIC_FEATURES`），构造里的 depth-clip-control 这些从设备读，加 `has(feature)`、`hasWgsl(feature)`；调试命令 `gpu`（适配器、拿到的特性、适配器有但没要的、WGSL 语言特性、几个上限）。CLI 的 `launch` 默认加 `EXPERIMENTAL_ARGS`（`--enable-unsafe-webgpu`、`--enable-experimental-web-platform-features`；`--stable`、`STRIDE_STABLE=1` 不加），回归、冒烟的 `run-page.ts` 走同一个启动。用户的主 Chrome 在 chrome://flags 开了三个开关，`stride call gpu` 在用户的页面里核对：23 个特性（含三个实验的），WGSL 多了 `fragment_depth`。带实验开关的无头 Chrome 里油货架没有错误，GPU 一帧 2.67 → 2.46 毫秒（光请求特性不变慢）。
85. **用上新特性：先量、再试子组**（用户 11-23：浏览器的特性、实验特性和别的能提速的都优先用上，现在做）：4K 超市一帧 GPU 14.1 毫秒，不透明那一遍 6.8（36 盏面光源逐像素）、光追反射 2.9、屏幕空间反射几个通道约 1.6、TAA 0.6；CPU 提交 1.6。第一个试的是灯光循环的子组标量化：用户的主 Chrome 和无头 Chrome 的 GPU 进程一起崩了（用户的页面跟着热更新）。在单独的无头 Chrome 里二分：只写 `enable` 不崩，调任何子组函数都崩，`--gpu-debug`（不优化）不崩，小着色器里不崩——记进 decisions，网格像素着色器先不用子组。期间又碰上 Bash 的 heredoc 吃掉反斜杠（已知的坑，改用 Edit）。为它把每盏灯抽成 `localLightLit` 的重构耗时不变（14.1 毫秒），按用户说的"优化无效就不进代码"撤回。
86. **试过：光追的宽 BVH 节点压缩**（新特性那一行里"实验特性以外能提速的"）：原生的 `Quantize` 把宽节点压成 64 字节，着色器按原点加格数乘缩放解盒子，JS 和引擎的单测按新布局读（查叶子的盒子盖住三角形；子节点的盒子允许探出父节点两格）。原生的 JS 测试全过、发了临时版 0.44.0、`raytrace-check` 没问题，4K 超市量：光追反射 2.88 → 3.15 毫秒，换成每面一次乘加加 `unpack4xU8` 后 3.01，还是慢——整个撤掉（fork 提交了还原，stride-ts 的依赖指回原来的版本），结论见 decisions。
87. **按设备自动选 BVH 节点布局：试了、撤了**（用户 11-23：别处可能有用的也留下，按设备自动开关）：原生加了单独的 `sn_bvh_quantize`（建树照旧出原来的布局，压缩另算，每个节点单独压、子节点的下标不变），着色器两种解码由管线常量 `RT_COMPRESSED` 选（先试了 uniform 的分支：不压缩那条路慢 3%，2.88 → 2.97；换管线常量回到 2.89），三处用光追的特性按场景的布局编管线、变了重编，`BvhBenchmark.ts` 在场景稳定后打一批射线现场量。问题是合成的测速和实际对不上：随机起点、随机方向测出压缩快 5%，改成从表面出发的两段射线测出快 1%，实际的反射通道压缩慢 4%（3.01 对 2.90，交替量了两遍）。用户定只留不压缩的一种：stride-ts 全部还原，fork 还原了 `sn_bvh_quantize`（另一个提交只把 BVH 注释里的"孩子"改成"子节点"），原生依赖回到 0.43.0。灯光循环的 `localLightLit` 按用户说的留下。
88. **浏览器新特性那一行收尾**（用户 11-23：先思考，不必逐项测；预计无效或效果不大的不测、不加）：按 4K 超市的瓶颈逐个对照（research.md"浏览器的新特性和实验特性"的最后一段）：这台机器上 GPU 卡在着色和光追的运算量，CPU 不是瓶颈，所以省 CPU 的（一次画一串、无绑定、立即数）、省重复着色的（可见性缓冲）、只省带宽的（rg11b10）都不加；子组、半精度最该用的地方不稳妥。已经请求的特性留着，开放世界 CPU 成瓶颈、泼溅多的时候再用。降运算量要靠算法：灯光按块随机抽样加降噪、反射按块分类。
89. **撤掉实验特性**（用户 11-23："chromium-experimental-* 特性撤销，不使用实验特性"）：`GraphicsDevice` 的可选特性去掉三个 `chromium-experimental-`（一次画一串、无绑定贴图、通道内时间戳；引擎还没有哪处用它们），只剩正式发布的 18 个；CLI 的 `launch` 不再加 `--enable-unsafe-webgpu`、`--enable-experimental-web-platform-features`，`--stable` 和 `STRIDE_STABLE` 删掉；`tools/dev/bench.cjs` 也不开不安全的 WebGPU。查 GPU 问题的 `--gpu-debug`（Dawn 的校验、导出着色器）照旧。CLAUDE.md 的约定、decisions、research、路线图那一行跟着改。
90. **灯光抽样加降噪：做完、撤了**（用户 11-23："现在做算法优化"；量完后用户定撤）：试了四种挑法，只有建簇时挑的快；只靠 TAA 噪点太大，加了按 6 个法线方向的比例和专门的降噪器（时间累积加 à-trous，镜面一起去噪），4K 超市一帧 14.15 → 12.60 毫秒、静止时平均差 0.9/255。用户问剩下的优化能省多少，按不测直接估：反射按块分类 1.2～1.6、半分辨率降噪 0.7～0.8、屏幕空间反射合并和锐化 0.5～0.6，合计 2.3～3.0；用户觉得不值，又让按"对画质影响大、收益不大的撤"把做过的优化过一遍：只撤灯光抽样（动起来的画质代价大、只省 11%），面光的小光源近似、光追的阴影射线抽样、遍历栈、BVH 简化、运动向量、各种半分辨率的效果都留；接着用户定 SSR 的半分辨率追踪也撤（只省 0.6 毫秒，动的时候倒影的风险），那次提交里 SSR 的三个文件反向应用（光追打到的表面的直射光一遍走完结果不变，留着）。代码全部还原，结论记在 decisions。期间讨论了硬件光追的几条路（自编 Chromium、Node 或桌面端、Firefox），记在路线图"等用户定的"。
91. **反射按块分类：做完、撤了**（用户 11-23："Yes, do it"）：光追反射改成分类加间接派发的计算着色器，在 4K 无头 Chrome 里跑通、量过：合计 2.87 毫秒，和原来的 2.88 一样；SSR 的把握调试图显示几乎没有满把握的像素，能跳过的块几乎没有。代码还原，结论记在 decisions。撤 SSR 半分辨率那次提交的验证全部通过。
92. **整个超市的布局、码垛**（用户 11-23 在截图上画的布局，后来改成左入口、右结账出口）：货架生成器加 `pallet`（`planPallet`、`palletBody`，格式说明、中文、schema、单测）；`build-shop.ts` 加十几种商品、七种靠墙货架、两种中间货架、四个码垛、三块招牌、12 米宽的天花板 `Market`，超市场景按新布局摆（左墙四节、右墙四节、后墙冷柜加两节、中间三排加端架挂钩架冰柜、入口和结账、四个托盘），机位在入口往里看。第一版托盘比货垛大一圈（整箱铺不满），改成托盘跟着货垛；码垛降到 1.2 米、往里挪。主 Chrome 里看过、量过：GPU 13.2 毫秒。调料罐的竖亮光先停着（用户插进来这一项）。
93. **超市加细节**（用户 11-23："问题不大，继续加更多细节"）：`build-shop.ts` 加墙上的分类灯箱七块、入口出口的挂牌、四面吊旗、四个地堆价牌、三种地贴（入口、出口箭头，排队圆标）、过道里一辆购物车和一个篮子（`detailEntities`）。地贴第一版报 KTX2 读错（贴花的贴图引用要写 `encoding: 'svg'`）、改了以后颜色很淡（盒子中心离地，地面落在渐隐区），都修了；在主 Chrome 里把相机临时转过去（`stride set Camera Transform.position/rotation`）看了地贴。验证（布局那次提交）全部通过。
94. **调料罐的竖亮光：查了、撤了**：反射调试图和开关 SSR 的差图确认罐子有反射但只有 3～4 级；对面摆货架、换冷柜、罐子改圆肩，三样在无头 Chrome 里对比都看不出变化，全部还原，原因记在 decisions。路线图上这一项标成放下，接着做地铁站台的照片比对。
95. **只烘改了的、photoreal 能转视角**（用户 11-23："我们有没有做好热重载，只改应该改的"、"我的浏览器又调节不了角度"）：后端 `saveAsset` 内容没变且烘过时不写不烘（单测：同样的内容不改源文件和模型的修改时间，改了照常烘），超市的搭建脚本 97 → 3 秒；`EditorCameraController` 只在有输入时写回；photoreal 的主相机挂自由相机。改生成代码那次（购物车）开发服务器自己标成过期、不再烘，页面热重载后断开，重启开发服务器恢复。
96. **超市：饮料挪到收银旁、入口和收银之间的围栏、购物车**（用户 11-23）：右墙靠收银那节换成饮料（灯箱跟着换）；不锈钢围栏用样条的 fence（`Shop/Splines/CheckoutFence`；第一版顺着 -Z 拦在收银台左边，用户在截图上画了以后改成沿门口横着、从入口闸机右边拦到收银台那头，进店只能走闸机）；购物车改成后宽前窄的车筐（侧面的横杆斜着收、底盘和前轮收窄），三辆顺着车身套成一串（原来斜着错开，轮子落在别的车的底盘中间）。主 Chrome 里看过。
97. **超市的入口**（用户 11-23："储物柜放在入口外面"、"围栏和入口连起来，而且色调要一致"）：围栏挪到闸机那条线上，左墙到第一道闸机一段（`EntranceFence`）、第二道闸机到收银台那头一段（`CheckoutFence`），材质同闸机的灰色漆面金属（原来是亮的不锈钢，映着门外的黑、发暗）；门外加 3.5 米的门厅（`Shop/Models/Vestibule`：地面、两边的墙、顶，两盏灯），储物柜贴着门厅左墙；购物车、篮子挪进闸机里面。主 Chrome 里从门厅往里看过。
98. **收银台镜像、购物车靠墙**（用户 11-23："购物车和篮子靠墙，收银机靠墙对着中间这一边"）：器具加 `mirror`（收银台按 Z 镜像：收银员、收银机的屏在 -Z、顾客在 +Z；只转 180° 会让传送带往店里送），格式说明、中文、schema；超市的两个收银台镜像、往墙边挪（x = 2.6、4.7），顾客从中间那边过、两条通道，排队圆标跟着挪到两条通道口，围栏收到 x = 1.7，自助收银机往后排紧；购物车、篮子挪到左墙边（闸机里面、靠墙货架前头）。改了生成代码要重启开发服务器（它把自己标成过期、不再烘）。
99. **地铁站台：端门结构、机位**（路线图七"地铁站台"）：照片里端门横在站台尽头、和屏蔽门成直角，拐角是带小窗的不锈钢立柱；白模原来把端门排在屏蔽门那条线上。按照片的透视估了机位（立柱在正前方约 3.1 米，屏蔽门的消失点在左边约 22°，往下俯约 7°，1.55 米高）；端门转成沿 Z（门和固定玻璃），立柱 0.6 宽、窗打通加玻璃，门和端门的下部加拉丝的踢脚板，黄黑挡杆横在端门后面、旁边一块水泥墩，信号灯挪到立柱正后方的轨道一侧、圆顶的灯罩。查了不锈钢发黑：是光追补的反射在粗糙度 0.35 的拉丝钢上降噪没压住（只关光追反射就干净很多），留到接着做站台时处理。剩下：机位还离屏蔽门太近、天空偏暗、树是白模、警示贴和接触网。用户插进来"标签按矢量画"，站台先停在这里。
100. **标签按矢量画**（用户 11-23："4K 屏上很多文字和物体都不清楚""标签直接按矢量画"）：查到是货架的标签图集栅格化成 2048 的位图、每毫米 2 个像素左右；试了烘焙时栅格化到 4096 压 KTX2（加了 resvg）就停下撤掉了。做了矢量贴图：`svgShapes`（SVG 子集拆成填充形状，单测：方块圆、描边成圈、相对命令三次曲线弧、evenodd 的洞、嵌套 svg 拉伸裁剪、rotate、渐变平均、真货架图集整张能拆）、`buildVectorAtlas`（带和格子，单测：按带数的绕数和全部曲线一致、格子从前往后）、着色器、材质的 `vector`、网格的绑定、内容管理器加载、`mergedFiles` 多写 `.vector`、调试命令 `vector`、字段和中文、schema。无头 Chrome 4K 近景开关对比：位图糊，矢量的字和小字边都清楚；最坏情况不透明多约 1.8 毫秒。期间 CLI 连到了用户主 Chrome 的页面（HMR 以后它最后连上），改相机、开关矢量都落在了用户的页面上——以后同一个开发服务器上有用户的页面时 CLI 一律带 `--page`。
101. **CLI 默认不碰用户的页面**（主动改进，起因见上一条）：开发服务器的中枢没指定 `--page` 时，原来操作最后连上的页面；用户主 Chrome 里的页面热重载以后常常最后连上，结果挪了用户的相机。改成默认选最后连上的、不经调试桥的页面（agent 用 `stride open` 开的），只有调试桥的页面时才用它；帮助说明、CLAUDE.md 跟着改。
102. **建矢量贴图提速**（上面验证时发现）：每个货架、堆放的矢量贴图每烘一次要 1.4 秒，photoreal 重启后初次补烘太久、开发服务器没及时监听，验证超时。原因是每个带里重复算每条曲线的包围范围和水平、竖直；改成每条曲线预先算好一次，循环里直接 push，降到 0.13 秒，数据不变，单测过。验证（类型检查、单测、回归）全过。
103. **地铁站台机位**：按和照片的边缘图相关度（`edgescore.py`，960×1280 的无头页面）网格搜索相机位置，注视点不变：3.45/1.55/0.86 → 4.6/2.0/2.1，得分 0.378 → 0.577（高度 2.0 米比 1.85 略好、再往外退得分平台）。并排看立柱和门的位置和照片接近，剩下的差别在照片里更宽的镜头、左边的栏杆、天空偏蓝偏暗、树还是白模。注意：搜索时页面尺寸要和之前一样（无头默认 1920×1080，得分不可比，要 `--size 960x1280`）。
104. **站台不锈钢上的黑斑**（光追补的反射）：近看立柱和门下半块板上一块块黑斑、竖黑条，关掉光追的反射就干净。两帧相差 0.9 级（总差 11 级）：稳定的图案，不是时间上的噪声。逐个排除：时间累积 0.9 → 0.96（没变）、射线起点偏移 1 毫米 → 2 厘米（图案略变，黑还在）、金属的烘焙色是 `albedo × (1 - 金属度)`（金属烘成黑，改成烘基色：平均亮度 87.5 → 87.65，几乎没变，撤了）、销毁辐照度体（黑斑照旧）。真因是一条光线一个像素、粗糙度 0.35 的波瓣有时扫到黑门框，两遍 à-trous 的半径不够：半径系数 2 → 3，斑驳变成柔和的渐变（取的是同一个窗口里的区域，平均亮度 87.5 → 88.3）。顺手把光追反射的结果改成预乘占比存（rgb × 占比，合成时除回来）：降噪和双线性取样会把没追光线的邻居（全 0）平均进来，颜色被拉暗；这次画面上没有可见差别，但对的写法。黑框边上几条黑边是门框本身的反射，属合理。
105. **站台的天空**：照片的天空 RGB 152,196,239，我们 97,131,161（又暗又灰）。SkyAtmosphere 的强度调到 2.2 只变 +17（直方图测光把亮度抵消了），不是办法；问题在色调映射：AgX 压天空。试了 aces（地面掉到 45，太暗）、hejl2、AgX 提对比提饱和：hejl2（白平衡 6200 K、对比度 1.1、饱和度 1.3）加局部曝光 `localHighlights: 1.4`，天空 98,164,201、低处 211,226,227（照片 190,221,247），地面 61（照片 75，偏暗、照片地砖是暖色的，我们的扫描地砖是中性灰，那是材质的事）。页面不热更新合成器设置，改了调色要重载页面。
106. **材质库扩充**（用户 11-23 要的"尽量补完整"，先上网看了 Poly Haven 的材质分类、Material Maker 的节点分类、OpenPBR 和 glTF 的材质扩展）：
  - **着色功能**两项（按 OpenPBR、glTF 里我们缺的）：薄膜干涉 `iridescence`（factor、ior、thickness；Belcour 和 Barla 2017，写法同 glTF Sample Viewer：先算干涉的菲涅耳，再按 Schlick 反推 F0 换进镜面项），漫透射 `diffuseTransmission`（factor、color：背面的方向光和环境光透出来，正面的漫反射让出一部分；点光、聚光没做）。材质 uniform 640 → 672 字节；字段描述、翻译、JSON Schema、`stride call material` 都跟上。地砖上试薄膜干涉：近处偏绿、远处偏粉，随视角变，没有着色器错误。
  - **节点**：`spots`（圆点）、`scratches`（划痕）、`hexTiles`（六边形砖）、`weave`（平纹、斜纹、篮纹）、`woodGrain`（年轮加纤维）、`cracks`（裂缝）、`wave`（波），`adjustHsv`、`blend`（8 种混合模式）、`function`（11 种小运算）；Voronoi 加格子边距输出 `edge`，噪声加脊状 `ridged`，渐变加径向、角向。
  - **预设** 22 → 146 种，14 类（金属 19、塑料橡胶 13、玻璃水冰 14、发光 9、石头 13、砖瓦 6、混凝土沥青 10、陶瓷瓷砖 8、木头 11、织物皮革 12、纸和卡 6、有机 9、地面 9、智能材质 7），每类一个文件在 `packages/editor/src/library/materials/`，`define.ts` 放类型和节点图简写；缩略图都用引擎渲染（123 张新的，球；智能材质是方块）。
  - 渲出来看了一遍总览，改了：马赛克（缝宽按 UV 算，28 格时 0.06 比一格还宽，全成了缝）、水磨石的石屑、花岗岩的底色、树皮和骨头的纹理方向、碎石的颜色。库的测试放宽成"节点图至少有一个输出"（冰、压花玻璃只写粗糙度和法线）。
  - **已知的**：噪声不是无缝的，球上和平铺的地面上有接缝（以前的预设一样）；编织的平纹看着有点像斜纹的锯齿。
  - 之前查的一件事：这一轮开头站台的光追反射黑斑是降噪半径不够（见 104）。
107. **站台远处的树**：白模的球换成参数化的树（`Subway/Trees/Autumn4、9、12`：同一个树形、三个种子和大小，树皮用材质库的 `bark`，叶子是 SVG 叶簇贴图的交叉卡片，借开放世界样例的 `LeafCluster.svg`，加风），一排 20 棵、离站台 28 到 35 米。试了三轮才和照片的林带密度、高度接近：第一轮树 16 米高、离得近，铺满右半边天；第二轮缩小推远又只剩树尖；第三轮 1.0～1.3 倍、叶子每枝 26 片、大小 2.3 倍。叶色的 baseColor 调到 [0.62, 0.5, 0.16] 还是偏艳绿（叶簇贴图自带的绿太强，下一步换贴图的色调），照片是橄榄黄绿。
108. **库窗口实时渲染缩略图：试了，用户定回 WebP**（11-23）：做了原型——编辑器界面服务器上的小页面（隐形 iframe，里面是第二个引擎实例，只有天空、太阳和一个球，材质和模型用 `ContentOptions.read` 的虚拟文件提供，不碰工程）、界面这边的队列加 IndexedDB 缓存（按材质内容的哈希）、空闲 30 秒拆掉 iframe、库窗口只给挂载的卡片要图。能跑：画面和烘好的一致，工作室冷启动约 5 秒，不带节点图的材质一张约 0.24 秒；但带节点图的材质每个拼出一份新的大 WGSL，浏览器重编一遍，一张约 2 秒，整库没缓存时约 0.45 张每秒，首屏要等几十秒。想过的补救：节点图先在 UV 平面上烘成三张小图（`MaterialGraphBaker.exportOutputs`，每个输出一个很小的着色器）、用同一个标准材质画，写了但没来得及量就被用户叫停。结论：缩略图继续用引擎烘好的 WebP（`tools/dev/library-thumbnails.ts`，库变了重跑），工程自己的材质以后要预览再单独做（可以走烘贴图的路）。
109. **噪声做成无缝的**（材质库扩充留下的已知问题）：球上、平铺的地面上噪声在 UV 的 0 和 1 接不上，有一条硬接缝。噪声、Voronoi、圆点、划痕、木纹、裂缝加参数 `tileable`：格点的编号按周期取模（`graphWrap`，周期是取整的 scale 格；分形噪声每高一层周期翻倍），默认关（旧内容不变），库里的预设都打开。UV 节点的缩放是整数时一个 UV 单位正好循环整数次，没有接缝（库里的 `[1, 12]`、`[5, 1]` 这些都是）；木纹的扭曲在可平铺时用 3 × 1 的周期。球上生锈的铁、镀锌钢、鹅卵石的缩略图重渲：接缝没了。整库 146 张缩略图重渲。
110. **节点图的数值参数放 uniform**（用户 11-23 要的，"顺带发现的改进点"）：原来节点的数值参数（缩放、颜色、阈值……）写成字面量拼进 WGSL，每个图（连拖一次滑块）都是一份新的网格着色器，浏览器要编一两秒。现在编材质时给一张 `GraphParams` 表（`rendering/mesh/materialGraph.ts`）：节点的数值参数（经 `f`、`v2`、`rgb` 格式化的）登记进表、代码里读材质 uniform 的 `material.graph[i].x`（材质 uniform 的 `graph: array<vec4f, 64>`，672 → 1696 字节）；结构相同、只有数不同的图编出一样的代码，共用着色器模块和管线。做算术、选分支用的数（取整的 octaves、可平铺的周期的值……）照旧是字面量，结构的一部分；预览、烘焙没有材质的 uniform，不给表、照旧字面量。参数值放 `MaterialShaderTrees.graphParams`，不进模块的缓存键，MeshGpu 写 uniform 时带上（缓冲共用，先清零）。量（greybox，无头 Chrome）：第一个图材质 4028 毫秒（冷启动，含第一次编译），**同结构不同数值的第二个 25 毫秒**，结构不同的第三个 3966 毫秒，回到第一个 25 毫秒。画面和以前一致（五个预设前后对比）。测试：同结构不同数的图代码相同、数在表里，没给表是字面量，槽位满了退回字面量。
111. **加载与缓存的盘点**（用户 11-23 问："快速渲染、烘焙、缓存、流式加载做好了吗"）：有的——世界格子流式、地形块、程序化摆放按格子、泼溅细节层次加按范围读、meshopt 和 KTX2、内容按资源缓存、加载场景时预热管线、GPU 剔除、远处卡片、编辑器烘焙按内容哈希缓存、启动计时和 `measure.ps1` 的预算。没有或只做了一半的——渐进显示和加载优先级（现在等模型和管线都好了才出第一帧）、运行时烘的东西的持久缓存（每次打开重算）、贴图 mip 流式（路线图十的"超大的阴影和贴图按需加载"还是 ☐）、分层细节层次和遮挡剔除、着色器编译卡顿（上一条解决大半，异步建管线还没做）。路线图的"十、大世界收尾"开头加了"加载与缓存"一行，按"先量、再按收益排"。
112. **加载与缓存第 0、2 步的第一块：度量和"管线没好先不画"**（11-23）：
  - **度量**：`tools/dev/streaming-bench.ts`（借开放世界的开发服务器和自己的无头 Chrome，不限帧率）在 Valley 里按固定路线飞 20 秒，输出启动各阶段（原生、内容、第一帧）、帧间隔（中位数、p95、p99、最长、超 50、100 毫秒的帧数）、页面请求数和传输字节、飞行中同步建的管线数（`PipelineCounts`）和后台预热数；`--sync` 对照老做法，`--check` 比 `tools/streaming-budgets.json`。基线（开发服务器）：第一帧约 4.2 秒（原生 1.0、内容 3.8），中位帧 16 毫秒。
  - **发现**：飞行中同步建的管线（地形块的阴影、深度预通道、不透明、运动向量，水）会堵住一帧，最长帧 271.6 毫秒；只有加载根场景时预热管线，流式进来的新材质、新网格第一次被画时当场编。
  - **做法**：`MeshBatch.ready`：新批创建时（`MeshRenderFeature.#prepareBatch`）按当前合成器的阶段检查它要的管线（`neededPipelines`，预热和检查共用）都编好了没有，好了直接画；没好的后台编（`warm`），期间所有阶段都不画这一批（一起不画，免得深度预通道画了、颜色阶段没画出洞），编好置 ready 并请求出帧。离线渲染（`takeOverFrames`）关掉（`deferPipelines`），烘焙用的渲染组（远处卡片自己预热自己的阶段）和单元测试里没加入渲染系统的特性不延迟。
  - **量**（空闲机器，同一路线）：当场编译（`--sync`）最长帧 271.6 毫秒、同步建 11 条；先不画 43.1 毫秒、同步 0 条、后台预热 10 条；中位帧都是 16 毫秒。画面（地形、楼、树）没有空洞。
  - **顺带修的 bug**：网格释放（流式加载的地形块卸载）时它的批被移除、后面的批下标挪了，但槽位到批的表（`#batchOfSlot`）没标失效，下一帧按旧下标取到 undefined，报 `Cannot read properties of undefined (reading 'bounds')`。移除批时置失效。
113. **加载与缓存第 1 步的第一块：页面外壳的加载骨架**（用户 11-23 问"先把 loading 的骨架摆出来对流式加载有用"）：以前游戏页面是一块黑画布加一行 "starting..."，到第一帧之前什么都没有。现在 devkit 的 `strideLoading` 插件（`packages/devkit/src/loadingScreen.ts`，进了 `strideApp`）在构建和开发服务器上把一小段 HTML 和 CSS 注入每个应用的页面：深色底、标题（取页面的 title）、进度条、一行阶段说明，纯 CSS，脚本和原生模块还在下载时就显示（引擎没报告前进度条是来回扫的光条）。引擎（`engine/loadingScreen.ts` 的 `reportLoading`）在 `Game.run` 的阶段更新：native 15%、content 45%、scene 90%，第一帧画出来时 `finishLoading` 淡出并摘掉，启动出错时 `failLoading` 停下写原因。嵌在 iframe 里（编辑器的视口，编辑器自己有骨架屏）直接摘掉，60 秒兜底淡出；页面没有这个元素时全是空操作。`tools/dev/loading-timeline.ts` 用 CDP 记时间线并每个阶段截图。量（开放世界、开发服务器冷启动）：骨架 47 毫秒出现，native 阶段 1148 毫秒，content 1523 毫秒，scene 7593 毫秒，第一帧 8002 毫秒，摘掉 8416 毫秒——以前这 8 秒是黑屏。devkit 加了测试（注入位置、不重复注入、内联脚本）。
114. **加载与缓存第 1 步的另一块：格子状态和占位**（11-23）：`WorldStreaming` 每帧记下要的格子（流式源加载半径里有内容的）和它们的状态——排队（同时最多读 `MAX_LOADING` 个，其余等着）、在读、好了——`game.world.cellStates`（近的在前）、`stats`（要的、好了、在读、排队的个数和占位个数），`stride call world --cells` 列出。`WorldLayer` 加可选的 `placeholder: { y?, color? }`：声明了的图层（地面一类铺满的），没读到的格子在地面上先画一块和格子一样大的平板（`world/WorldPlaceholders.ts`：共用一个平板网格，按格子大小缩放，不投影、不进光追），格子读到的那一帧去掉；不写就不画（不知道高度的内容不乱画）。开放世界的 Test 世界地面层开了。量：本机格子读得太快看不到占位，页面里把 fetch 延迟 1.5 秒再把相机瞬移到 1500 米外：要的 57 个格子、0 个就绪、2 个在读、55 排队、49 个占位，截图是灰色的地面代替了空洞；几秒后 10 个就绪、占位降到 44。测试：世界文件的 `placeholder` 检查。
115. **启动里到底慢在哪、占位的一个坑**（11-23，加载与缓存的度量）：
  - **度量**：`Game.startup` 加 `warmStart`、`warmEnd`、`warmedPipelines`；`PipelineCounts.warmTimes` 记后台编的每条管线从请求到编好的毫秒数；新调试命令 `stride call pipelines`（同步建的、后台编的条数、最近当场建的标签、最慢的 N 条）。发布版（preview 构建，`measure.ps1`）：原生 438 毫秒、内容 3167 毫秒、第一帧 3201 毫秒、下载 0.89 MB（brotli）、稳态帧 1.3 毫秒——下载不是启动的大头，内容阶段才是；内容阶段里预热管线占大头：最慢的是网格着色器不透明阶段的两条（冷启动各约 4 秒，别的管线多在 300 毫秒以内，大气多重散射 1.6 秒、运动模糊 0.9 秒）。
  - **浏览器的着色器缓存管用**：同一个页面重载，不透明阶段的管线 31 到 40 毫秒（冷的 4 秒），预热总共 0.8 秒（冷的 16.8 秒累计）。缓存按着色器源码，改了着色器代码这一次又是冷的；用户第一次访问付约 4 秒，之后几乎没有，不用我们另做。
  - **试过没用的**：启动时（内容还在加载）先提前预热最常见的管线（默认材质配没量化、量化过的两种顶点布局）：全新浏览器用户目录（`streaming-bench --cold`）冷启动对照，有无提前预热第一帧都约 4.0 到 4.1 秒，还多编 10 条，撤了。
  - **占位的坑**：占位平板最初是两面画的材质，两面画是另一条管线、要多编一遍，启动时和格子里真内容的管线抢编译：不透明阶段的编译从约 1.8 秒涨到约 4 秒，开放世界冒烟的"相机附近的格子都在"、统计量预算在槽位验证里失败。改成单面、不带变体的材质，和普通不透明材质共用管线：冒烟过了，格子 0.75 秒就有 18 个就绪（之前 2.3 秒时还是 0）。教训：给引擎加"小东西"也要看它引入了几条新管线。
116. **格子提前读和内容哈希长期缓存**（11-23，加载与缓存第 3、4 步的第一块）：
  - **提前读**（`WorldStreaming`，`MAX_PREFETCH` 8）：格子同时建实体最多 `MAX_LOADING`（2）个（读和建实体都在主线程上），网络有延迟时每个来回只出一两个格子。现在轮不到建实体的近处格子先 `content.preloadScene`（只下载、解码文件和引用的资源，不建实体；资源按路径缓存，之后建实体时已在内存里）。量（页面里 fetch 延迟 300 毫秒，相机瞬移到 1500 米外，57 个格子全部就绪）：不提前读 8186 毫秒，提前读 8 个 2282 毫秒（`game.world.maxPrefetch` 可调，0 是对照）。
  - **内容哈希**：devkit 的 `strideContentHash`（`contentHash.ts`，进了 `strideApp`，在预压缩之前）构建后给 `dist/content` 里每个文件按内容哈希改名（`Valley.scene.json` → `Valley.scene.3fa9c2d1b0e4.json`，12 位十六进制），清单（原路径 → 带哈希的路径）嵌进每个页面（`<script type="application/json" id="stride-content-manifest">`，不多一个请求），写 `_headers`（Netlify、Cloudflare Pages：assets 和 content 永不过期，页面每次验证）。引擎 `ContentManager.resolveUrl` 读文件时按清单换地址（默认读器；流式音频、视频贴图的地址也过它；自己给了 `read` 的不换），换了的 fetch 带 `cache: 'force-cache'`，浏览器直接用缓存不向服务器验证。开发服务器没有清单、照旧读原路径。量（开放世界发布版 + preview，无头 Chrome）：714 个内容文件都改了名，页面 2 KB → 65 KB（嵌清单，brotli 后小得多）；首次加载 78 个内容请求全是带哈希的、传输 78 个，**再次加载 78 个全走缓存、传输 0 个**（以前每个都要向服务器验证）。测试：清单解析、读文件带不带 force-cache、哈希命名、嵌页面。
  - **冒烟的时序**：开放世界冒烟原来"等 2 游戏秒就检查格子全到了"，槽位里两个验证同时跑、机器忙时格子读得慢就失败（格子没到时占位还在，也是实体，预算里的实体数超了）。改成 `settle()`：等要的格子全就绪（没有排队、在读、占位）再检查，最多 60 个游戏秒。
  - **教训**：`pwsh tools/stop-dev.ps1` 会停掉所有开发服务器和无头 Chrome，包括槽位里在跑的验证——槽位验证跑着的时候只停自己开的（按端口杀、`stride close`）。
117. **读格子按视线方向排优先级**（11-24，加载与缓存第 3 步的第一块）：`WorldStreaming` 的流式源里相机多了水平朝向（逆视图矩阵第三列取负，几乎朝天朝地时不给），要读的格子按 `loadPriority(distance, cosine)` 排：距离乘 `1.5 - 0.75 × cos`（正前方 0.75 倍、侧面 1.5、身后 2.25，源就在格子里时按纯距离），几个源要同一个格子取最高的；半径和卸载仍按纯距离，`cellStates` 的 `distance` 照旧是到最近源的距离、排序是先读的在前。单测 `test/world/streamingPriority.test.ts`（含相机朝向约定）。度量：Valley 飞行最长帧 42.7 毫秒、超 50 毫秒 0 帧、飞行中同步建管线 0（和另一个验证同时跑时最长帧 268 毫秒、同步 1 条，是抢显卡，独占重跑正常）。顺带：`packages/engine/vitest.config.ts` 把测试超时放到 30 秒（槽位里几个验证并行时合成音效、扫描代理网格的测试超过默认 5 秒，单独跑 2 秒）；photoreal 预算按站台加的 20 棵树重记（实体 26 → 66、实例 110 → 282，有意的增长）；内容清单测试的 mock 类型修了。未做：取消过期的请求（`loadScene` 没有中止，读好了发现不要了就卸，成本是白读的那几个）、自适应并发。
118. **运行时烘焙的持久缓存：量了，不做**（11-24，加载与缓存第 4 步）：临时在 `ImpostorBaker` 里记了每张远处卡片的耗时（Valley，无头 Chrome）：`warm`（等管线编好）1.56 秒、总共 1.64～1.69 秒，也就是排队到画好交出去只要 80～130 毫秒；`warm` 是着色器的第一次编译，浏览器自己把编好的存进磁盘缓存，再次打开几乎为 0（见第 112 条的启动分析）。把烘好的图集存进 IndexedDB 再读回来省不下这 100 毫秒，还得管失效（模型、材质、生成代码的版本），所以不做（只做有效的优化）。节点图烘的贴图和地形高度页同理：前者一次 GPU 通道、后者在原生的工作线程里算，没有量出能省的大头，以后量到再做。顺手：`tools/debug-bridge/service-worker.js` 的 `detachLater` 里 `setTimeout(async …)` 被带类型的 oxlint 报 `no-misused-promises`（槽位验证的 lint 失败），改成 `void …then(…)`。
119. **格子卸载后有没有泄漏：量了，没有**（11-24，加载与缓存第 6 步的显存预算那一块的前提）：`streaming-bench` 在飞行前后各读一次实体数、`gpu.buffers.bytes`、`gpu.textures.bytes`、`native.allocated.bytes`（`metrics.snapshot()`），`--check` 把增长（`gpuBufferGrowthMB`、`gpuTextureGrowthMB`、`nativeGrowthMB`）也比预算（`tools/streaming-budgets.json`）。Town 世界（`--world Worlds/Town --seconds 40 --speed 100`）飞过去加载 172 个格子、卸载 214 个：原生内存 69.9 → 69.9 MB，GPU 贴图 57 → 57 MB，缓冲 0.8 → 0.9 MB，最长帧 13.6～18.6 毫秒、超 50 毫秒 0 帧、飞行中同步建管线 0。Valley 没有格子（地形和摆放是常驻的），飞行的帧时间照旧达标（40 秒最长 45.4 毫秒）。**教训**：①度量脚本里 `cdp.send` 的等回复超时是第三个参数，之前写进了命令参数，飞行超过 60 秒就断；②槽位里的回归冒烟会关掉共用的无头 Chrome，度量要在验证没在跑的时候量；③开放世界的开发服务器端口固定 5232，`STRIDE_PORT_OFFSET` 对它没作用（冒烟走自己的路），槽位里量度量用默认端口、先确认 5232 上是哪个检出的服务器。
120. **一次性的测量，只记结论**（11-24，用户当天说：临时、性能这类测试记下结论、别留在回归里，定期清理；已记进工作约定 `temporary-tests-record-then-delete`）：本轮量过就删的脚本和结论——
  - **Basis 编码**（脚本 `packages/pipeline/experiments/basis-bench.ts`，已删）：2048² 的 UASTC（effort 2，带 mip）单张 76.3 秒，四张并发 77.2 秒（张与张之间已经完美并行，慢在单张只用一个核；原生是 wasm 的、没有 SIMD 路径，`BASISU_SUPPORT_SSE=0`）。改成编码器自带的线程池（`ST_BASIS_FLAG_THREADED`，`encodeBasis` 的 `threaded` 默认开）：1024² 19.6 → 3.9 秒，512² 5.0 → 1.2 秒，24 张 512² 并发 9.4 → 6.6 秒（输出字节数一样）。
  - **10 万实例**（页面里 `stride eval` 临时脚本）：Valley 里 10 万个共用一个盒子模型的静态实体，生成 1.5 秒，55 fps（无头、不限帧率），update 5.2 毫秒（其中变换更新 4.6 毫秒：当时每帧对全部槽位单线程重算，已改成按深度层分块并行，`TransformApi.cpp`），绘制 CPU 12.4 毫秒、GPU 5.4 毫秒；原生内存 394 MB。**发现的上限**：变换存储容量默认 65536（`Game.maxTransforms`），超了 `sn_transforms_alloc` 报错；放大到 100 万要多占约 300 MB 原生内存（列都是一次分配、填满），而 `Transform` 组件的列直接缓存存储的视图（`engine/transform.ts` 的 `state.data`），让存储随用随长要改这层，还没做。
  - **资源热重载的引擎侧延迟**（脚本已删）：忘掉加载结果再读一遍，材质 4.2 毫秒、模型 4.0 毫秒、树的模型（大）约 62～170 毫秒（中位 72.5）；所以热重载的延迟大头不在引擎重读，在后端烘焙和文件监听，要优化先量那一段。
121. **整仓清点一次性的测试和脚本**（11-24，用户要求："临时测试、性能测试这类记结论、别留在回归里，定期清理，整个仓库检查"）：
  - **删了**（结论都在文档里，git 历史找得回）：`apps/bench`（早期数据布局、GC、内存、位移微图的性能页）连同 `tools/dev/bench.cjs`、`gc-trace.cjs`；`packages/pipeline/experiments/` 的两个几何实验（`displacement-storage.ts`、`sweep-generator.ts`，结论在 vector-assets.md 的 E1、E4）；`tools/dev/shelf-stats.ts`（一次性的货架统计）；多余的旧工作树 `.claude/worktrees/brave-mccarthy-c70cb4`（和它的分支，已合并）。
  - **量了、留着**：`packages/engine/test/core/stress.check.ts`（2553 行的类型压力文件，看推导会不会出 TS2589）：引擎类型检查有它 5 秒、没有它也 5 秒，没有可见的开销，是个低成本的类型回归门槛，留着。单测总共约 30 秒（110 个文件，最慢的是 `core/modules.test.ts` 从入口加载全部模块 11 秒），不是瓶颈。回归冒烟最慢的是 csharp-intermediate 168 秒、photoreal 121 秒、csharp-beginner 118 秒，都是真覆盖，按 `-Changed` 只在相关改动时跑。
  - **留着的工具**（有人用）：`streaming-bench`（有预算门槛）、`loading-timeline`、`terrain-hillshade`、`hdr-ratio`、`library-thumbnails`、`open-project`、`cdp-eval`。
  - **约定**：一次性测量放 `packages/*/experiments/` 或 `tools/dev/`，不进 `regress.ps1`；量完把结论和数字写进本文件、脚本删掉；每轮"主动改进"顺手清扫这两处。
122. **变换存储按需增长，不再有 65536 的上限**（11-24，用户 11-19 定的"不给规模设上限"；第 120 条里发现的）：原生 `TransformStore` 的容量改成初始值（`Game` 的选项 `maxTransforms` 改名 `initialTransforms`，默认 16384），分配不够时翻倍增长（上限 2^31 - 2），增长以后各列换了新内存，`sn_transforms_generation` 报增长次数、JS 的 `TransformStore.generation` 对应，`Transform` 组件的列（`transform.ts` 的 `state.data`）按它重取；原生构造时不再给每个槽位写默认值（分配时本来就初始化），所以大初始容量不白占内存。同一轮把变换更新按深度层分块并行（一层 8192 个槽位以上）。**量**（Valley 里建共用一个盒子模型的静态实体，无头 Chrome）：10 万实体 `transforms.update` 4.58 → 1.48 毫秒、update 5.2 → 2.0 毫秒；100 万实体（原来第 65536 个就报错）建到 1,006,998 个、容量涨了 6 次到 1,048,576、`transforms.update` 33 毫秒、update 37.5 毫秒、draw CPU 67.7 毫秒、GPU 9 毫秒、原生内存 420 MB（帧 106 毫秒，不是目标，是"不再崩"的验证）。100 万时每槽位 33 纳秒、10 万时 15 纳秒：大了以后受内存带宽限制，下一步要让没变的槽位不算（要在 JS 写列时标脏，或者按输入快照比较），还没做。测试：原生 Node 测试 46 项（含大层并行、增长），引擎 `transforms.test.ts`（增长后位姿和层级不变）。
123. **更正第 121 条：压力、性能测试留着，只是不进常规回归**（11-24，用户说"压力测试组可以留着，只是不适合作为长期回归每次都跑"）：第 121 条删掉的 `apps/bench`、`dev/bench.cjs`、`dev/gc-trace.cjs`、`packages/pipeline/experiments/` 的两个几何实验、`dev/shelf-stats.ts` 全部恢复；Basis 度量脚本也放回 `experiments/`（第 120 条）；新加 `dev/instance-stress.eval.ts`。这些都本来就不在 `regress.ps1`、`verify.ps1` 里，现在在 tools/README.md 加了一节"按需运行的压力和性能测试"列清单和跑法，CLAUDE.md 的约定改成"留着、不进回归、结论写进 progress-log"。真删掉的只有多余的旧工作树和一次性的热重载度量脚本（它还有 bug：贴图用错了编码）。

124. **加载与缓存做完**（11-24）：①物理的物体上限：Jolt 按上限预留碰撞对和接触，原来每个物体 8 个，堆（Node 里量）4096 上限 64 MB、6.5 万 317 MB、100 万 4.9 GB；预留封顶 65536 后 6.5 万 111 MB、100 万 577 MB，单步耗时不变（5 万个静态盒子 2～4 毫秒），`Game` 默认上限改 65536。②验证槽里引擎、pipeline 的测试卡死（worker 报"NaN cannot be converted to a BigInt"）：Basis 线程编码每次按核数开 36 个线程、全在 Emscripten 的线程池外，并发编码时出事（主检出偶尔也崩，24 张并发的脚本复现过）；改成线程数等于任务系统的、同一时间一张用线程池，单张 512² 2.7 秒、24 张并发 23 秒（全单线程 21 秒；排队等线程池 65 秒，不用），两次跑都没崩。③格子还在读就走远了的中止（`loadScene` 的 `signal`，`game.world.cancels`）：Town 每秒 100 米、加 300 毫秒延迟时 0 个（提前读让文件早到了），每秒 400 米时 1 个，最长帧 20 毫秒。④`streaming-bench` 加 `--latency`（DevTools 的网络模拟），浏览器目录跟着 `STRIDE_STATE_DIR`、自己开的开发服务器按 `--port`；`regress.ps1` 选中开放世界时冒烟后单独跑 Valley、Town 的预算。⑤异步建管线本来就全了；贴图 mip 流式量过不做（开放世界没有位图贴图）；渐进加载算占位平板，HLOD 留给"大世界的渲染（二）"。⑥顺手：fork 的 `build-wasm.ps1` 在 emsdk_env 之后接回原来的 PATH（以前找不到 node、pnpm，要手动补 JS 的构建）；tools 的类型检查不再查 `*.eval.ts`（页面里跑的片段，用 `stride eval --check`）。⑦用户 11-24 要求：加载与缓存做完先做世界模拟的底座（核心模块、材质扩充、第三方扩展），路线图加了"八、世界模拟的底座"，盘点和步骤在 stages.md。

125. **世界模拟的底座开头：材质节点能从工程登记；验证槽的几处失败**（11-24）：①引擎 `registerMaterialNodes`（`MaterialNode`、`graphParam` 公开，节点库变成内置的加登记的 `materialNodeSpecs()`，和内置重名报错、同名再登记替换），编辑器扩展加 `materialNodes`（`installEditorExtension` 登记），节点图面板按 `graphNodeLabel` 取名（节点自己的 `label`）；greybox 加"警示条纹"节点（`src/materialNodes.ts`，入口和扩展都登记）、`Hazard` 材质盖在箱子上：Chrome 里游戏画出黄黑斜条纹、没有报错，编辑器里节点图显示"警示条纹"、带预览、菜单里有。顺手：扩展在 Node 里加载，引擎被它引用的文件要写 `.ts` 扩展名（`materialGraph.ts` 引 nodeGraph）。②槽 1 验证第 124 条：单测全过（Basis 卡死修好了）；lint 报压力脚本最后的表达式没用（是 `stride eval` 的结果，就地关掉那条规则）；Valley 的流式预算飞行中当场建了 1 条管线（槽里机器忙、预热排到了飞行中）：度量加 `syncLabelsDuringFlight` 报名字，远处卡片的 dilate 管线改成烘之前后台编好、mip 生成预热加 `rgba16float`，主检出复测 0 条；物理样例的原生内存超预算 24 MB（默认 65536 个物体）：接触预留封顶改 32768、默认 16384（只多 3 MB），开放世界传 65536（原生 `native-dev-586c8b9333`）。

126. **世界时钟和日历**（11-24，世界模拟的底座第 2 步的第一件）：`world/WorldClock.ts`，`game.clock`（世界时间、倍速、日历的 day、timeOfDay、dayOfYear、year、weekday，`set`、`state`、`restore`，`at`、`after` 的定时返回 Disposable），Game 每帧在脚本之前按游戏时间走它（编辑状态不走）；`DayNightCycle` 改成跟着时钟（第一帧按字段设、别处改字段就拨钟）；调试命令 `clock`；单测：日历、定时（一帧走三天只调一次、拨钟后重排）、日夜循环跟钟、游戏代码先设钟。Chrome（短片样例）：时钟按场景设成第 172 天 18 点；时间轴放的时候它改 `timeOfDay`、时钟跟着它；放完以后 1800 倍速 2.008 秒游戏时间走了 1.004 小时，组件字段同步，19:12 是黄昏、13:00 是正午，没有报错。

127. **全局的命名事件**（11-24，世界模拟的底座第 2 步的第二件）：`engine/GameEvents.ts`，`game.events`（`key`、`emit`、`emitUnchecked`、`recent`、`listeners`；事件名和值的类型 `GameEvents` 声明合并），时间轴的事件点同时发 `timeline`（放它的实体、事件名），调试命令 `events`（看最近的、`emit` 发一个）；单测。Chrome（短片）：放完时 `end` 事件点出现在 `recent` 里，CLI 发的 `test.hello` 也在，没有报错。

128. **输入映射**（11-24，世界模拟的底座第 2 步的第三件）：格式 `content/formats/inputFormat.ts`（`INPUT_MAP` 模式：动作 button、axis、axis2，绑定 control、axis、dpad，scale、deadZone），资源种类 `input`（`.input.json`，`loadInputMap`，脚本属性 `prop.asset('input')`，场景预加载，编辑器的字段、新建模板、名字，`schemas/input.schema.json`），运行时 `input/InputActions.ts`（`game.input.actions`：`add` 按优先级叠、`down`、`pressed`、`released`、`value`、`vector`，`rebind`、`overrides`、`listen`），手柄的按键和状态挪到 `input/gamePad.ts`（InputManager、InputActions 互相引用时不会读到没初始化的值）；单测三条。collect-dodge 的 PlayerController 改成按 `Input/Player.input.jsonc` 的 move、jump 读，冒烟在 Chrome 里按 W 走、吃金币、被撞回出生点、过门到终点走完一局，没有错误日志，统计量在预算内（41 秒）。

129. **数据表；验证槽报的输入映射漏翻译**（11-24，世界模拟的底座第 2 步的第四件）：格式 `content/formats/tableFormat.ts`（`TABLE` 模式、`checkTable`），运行时 `content/DataTable.ts`（`get`、`require`、`as`），资源种类 `table`（`loadTable`、脚本属性、场景预加载、资源列的引用、编辑器的字段、新建模板、名字、`schemas/table.schema.json`）；单测三条。开放世界加示例表 `Data/Shops.table.jsonc`（店的营业时间、类别、人数，给以后行人的日程用）：Chrome 里页面加载它（`.jsonc` 换成 `.json`、补默认值），编辑器里资源浏览器认得"table"、属性面板能改列（列、行的字段名显示成"列数""行数"，和别处的计数字段同名，等表格面板一起改）。槽 1 验证第 128 条报两处：字段描述的种类清单、中文字段表没加输入映射的字段，补上。顺手：`verify.ps1` 成功时最后打一行 `PASSED`（原来只有带颜色码的表，后台等它的脚本匹配不上，第 128 条的验证因此没接着跑）。

130. **数据表的表格编辑面板**（11-24）：编辑器的 `ui/editors/TablePanel.tsx`（属性面板里开着数据表时底部的"数据表"窗口）：vue-tsx-pro 的 DataTable，id 列加每个表列，数字列是数字框、枚举和开关是下拉、颜色和向量写 JSON，改的值按 `tableValueProblem`（引擎里加载时的同一套检查，从 tableFormat 导出）查、不对的标红不写，加行、删勾选的行、拖把手排序，经 `session.editInspected` 存。属性面板里表的两个字段用自己的标签（"列""行"，原来和计数字段同名显示成"列数""行数"）。Chrome（开放世界的编辑器）：四行按列显示、没写的列显示默认值；把五金店的人数改成 4，文件里只多写了这一格；把开门时间改成 30 时格子下面显示"is 30, above the maximum 24"、文件没变，Esc 放弃。槽 1 验证第 128、129 条：PASSED。

131. **存档和世界状态的持久化，玩法的基础模块做完**（11-24，世界模拟的底座第 2 步的最后一件）：`world/Persistence.ts`（`Persistent` 组件，场景文件的 `persistent`，编辑器的字段和名字"持久（存档）"；`game.persistence`：`sceneLoaded`、`sceneUnloading` 由 Game 调，`capture`、`save`、`load`、`section`、`forget`），值按字段描述换成 JSON（`data/schema.ts` 导出 `objectFields`、`variantFields`），调试命令 `save`；单测两条（格子卸掉读回来：位置、字段、销毁的都还原，不持久的回到文件的样子，别的路径不受影响；存档读档：实体、世界时钟、游戏的段，格式不对的不读）。开放世界的冒烟加一项：`props/0_0` 里挂了 Persistent 的方块抬高 20 米，相机飞到 1.2 公里外（格子卸掉）再飞回来，方块还在抬高的地方、存档的记录里有它；流式的预算照常过。槽 1 验证第 130 条：PASSED。

132. **轮式车**（11-24，世界模拟的底座第 3 步的第一件）：fork（`c0a0014d`、导出表 `6e295e4d`，`native-dev-6e295e4d37`）加 `sn_physics_add_vehicle`、`remove_vehicle`、`vehicle_input`、`vehicle_state`（`Physics.h` 的 `sn_vehicle`、`sn_vehicle_wheel`），车身移除时车一起移除，JS 的 `addVehicle`、`vehicleInput`、`vehicleState`，Node 测试（四轮着地、油门往 -Z 开、打方向转弯、轮子数不对报错、车身移除后车没了），原生全部 47 条 Node 测试过；引擎 `physics/Vehicle.ts` 的 `Vehicle` 脚本（引擎登记，场景、编辑器能挂）和 `simulation.addVehicle`。Chrome（greybox 里 eval 搭的试车场）：落地后四轮着地，全油门 3 秒开 23.4 米、16.5 米/秒（1 挡打滑在 6000 转）、半油门右打方向 2 秒横移 14.2 米，轮子模型跟着悬挂摆，物理每次更新 0.1 毫秒；Node 里小油门转速和车速对得上（不打滑，到 4000 转才升挡）。槽 1 验证第 131 条：冒烟全过，单测只有多语言漏了持久组件的字段（`8ba476da` 补上）。

133. **碰撞体随世界格子流式加载；验证槽的生成文件**（11-24）：格子是普通场景，里面的 `static`、`body` 组件跟着格子建物体、卸掉时移除，原来就成立，只是没有格子带碰撞体、没人查过。`generate-test-world.ts` 给 Test 世界的方块加静态碰撞体（跟着实体缩放），0_0 的第一个方块写进生成器里持久（原来是手改的格子文件，重新生成会丢），地面图层的占位也写进生成器（原来也是手改的）；开放世界的冒烟加一项：开始、飞到 1.2 公里外、飞回来时的物理物体数，回来时和开始时一样（不越积越多），冒烟全过。顺手：`verify.ps1` 发现 `pnpm install` 的 postinstall 重新生成的 `schemas/` 和提交的不一样时记成失败并还原（这次就是持久组件的提交忘了重跑 json-schemas：槽里的单测 `--check` 被 postinstall 先生成掩盖，工作树带着改动，下一次验证拒绝用它）。

134. **布娃娃**（11-24，世界模拟的底座第 3 步）：fork 加 `sn_physics_add_ragdoll`、`remove_ragdoll`、`ragdoll_root`、`ragdoll_pose`、`ragdoll_impulse`（`sn_ragdoll_part`：关节、父部分、骨头的另一头、半径、质量、摆动和扭转角），世界销毁时一起移除；JS 的 `addRagdoll`、`ragdollPose`（直接写动画实例的原生内存）等，`AnimationBatch.posed`；Node 测试（倒在地上、姿势写回、没进的关节跟着父关节、posed 不被静止姿势盖掉），原生 48 条全过；全身的冲量改成按质量分（`native-dev-3d7f5ddd20`）。引擎：`animation.skeletonOf`、`setPoseSource`，`simulation.addRagdoll`，`physics/Ragdoll.ts` 的 `Ragdoll` 脚本（引擎登记）；`Matrix.compose` 也能写 Float64Array。Chrome（platformer 的人体模型，92 个关节）：根先错选成脚底的场景根节点，人吊着往下掉、穿过地面一直落（y 到 -9380），改成第一根够长的骨头后正常；全身冲量第一次按 Jolt 的每个物体一整份，人飞出 12 米，按质量分以后在原地附近倒下、约 1 秒停稳，截图里躺在地上、蒙皮正常；建布娃娃 6～11 毫秒（一次），物理每步 0.03 毫秒、蒙皮 0.04 毫秒。槽 1 验证第 132、133 条：PASSED。

135. **绳子**（11-24，世界模拟的底座第 3 步）：`physics/Rope.ts` 的 `Rope` 脚本（引擎登记；`end`、`length`、`segments`、`radius`、`massPerMeter`、`material`、`layer`，`pieces` 是各段的实体）和 `ropePoints`；`ContentManager.createProceduralModel`（`loadModel` 的解码拆成共用的 `#modelFromData`）。单测：折线每段一样长、V 形的垂度；单摆：吊着 5 公斤的重物荡下来，第一次没有长程拉住时离锚到 3.72 米（绳长 3.2），加上以后不超过绳长，去掉脚本时段和锚一起没了。Chrome（greybox，eval 搭）：4.2 米高挂 2.5 米、12 段的绳子吊一个箱子，从旁边放开荡起来，离锚 2.41 米，截图里白色的段连成一条，物理每步 0.19 毫秒（连同房间里别的物体）。槽 1 验证第 134 条（布娃娃）见下一条。

136. **可破坏的物体**（11-24，世界模拟的底座第 3 步）：fork 加 `st_mesh_fracture`（Manifold 合并顶点、不封闭时取凸包，按种子撒点做 Voronoi，每块切下来、标出断面的三角形；`native-dev-5d87425a0c`）；接触事件加 `speed`（开始接触时碰撞求解之前沿法线的接近速度，复合形状取最快的一对；`native-dev-7e99a3cccd`）、物体的破碎速度 `sn_physics_body_set_break_speed`（够快时这一对不做碰撞响应；`native-dev-0239b94fa2`），Node 测试：箱子落进触发器、落地时的速度等于 √(2gh)（差 0.4 以内），设了破碎速度的箱子被石头撞时这一步不挡、石头照原速度穿进去。引擎：模型网格的解码抽成 `content/modelFile.ts` 的 `decodeModelMeshes`、`meshPositions`、`meshFloatVertices`（运行时加载和烘焙共用；烘焙用 settle 那个运行时原生模块的 meshopt 解码，`runtimeNative()`）；新资源种类 `fracture`（`.fracture.json`：`model`、`count`、`seed`、`interiorMaterial`、`uvScale`，typed schema，引用、字段、新建模板、中文名都加了），`modeling/fracture.ts` 按块、按材质分网格并补 UV 和法线，pipeline 的 `bakeFracture`，编辑器后端的烘焙表（`REBAKE_WITH` 加 model → fracture：原模型重烘时碎块跟着重切）；`physics/Breakable.ts` 的 `Breakable` 脚本（`pieces`、`breakSpeed`、`density`、`scatter`、`lifetime`，`break()`，引擎登记），`StartedContact.speed`、`ContactHandler.breakSpeed`。单测：1 米的方块切 6 块，体积和 1 立方米、外表面法线沿轴、材质槽对、同一个种子字节一样；静态箱子被 50 公斤的球从 5 米砸碎、从 0.3 米不碎，碎块质量 300 公斤（半块乘 600），到时消失。Chrome（greybox，箱子挂 `CratePieces.fracture.jsonc` 烘出的 9 块，eval 加 Static 和 Breakable，4 米上掉 40 公斤的球）：第一次碎了但碎块紧挨着不动、球停在上面（碰撞在碎之前那一步已经挡住了），加了原生的放行以后球砸进去、碎块往两边分开，警示条纹在碎块之间连续，断面是地砖的材质；物理每步 0.03 毫秒。坑：碎块文件和原模型同名会盖掉原模型（生成的模型和源文件同名），示例叫 `CratePieces`；开发服务器换了原生包要重开（vite 的预构建缓存着旧的）。

137. **布料**（11-24，世界模拟的底座第 3 步）：fork 加 `sn_physics_add_soft_body`（Jolt 的 SoftBody：顶点、逆质量、三角形，柔度、弯曲（距离或二面角）、长程拉住、压力、摩擦、阻尼、重力、顶点半径、双面、不睡）、`sn_physics_soft_body_vertices`（顶点相对质心加面积加权的法线，按步长写进交错的顶点）、`sn_physics_soft_body_pin`（固定点按目标设速度）、`sn_physics_soft_body_wind`（按面的二次阻力，隐式地积）；JS 的 `addSoftBody` 等和 Node 测试（1 米的布钉两角荡到垂下约 1 米、不伸长、法线是单位向量、钉子跟着目标挪、风把布吹向 +z）（`native-dev-f4508d510b`）。坑：钉子的速度一直保持，只设一次的角会一直飞；显式的风在布被猛拽时 NaN，改隐式；二面角的弯曲约束被球一撞就拉爆，默认改距离型。引擎：`MeshData.dynamic`、`Mesh.updateVertices`、`vertexVersion`（`MeshGpu` 按版本重新上传，`MeshRenderFeature` 的批按版本重算包围盒）；`Simulation.addSoftBody`（`SoftBodyHandle`：vertices、pin、wind、remove）；`physics/Cloth.ts` 的 `Cloth` 脚本和 `clothGrid`（引擎登记）。单测：格子的点数、三角形、四种钉法；窗帘垂下近 1 米、实体挪 2 米时上边跟过去、去掉脚本时画布的实体没了。Chrome（greybox，eval 搭）：1.6×2.2 米的窗帘（警示条纹的材质）和 1.2×0.8 米的旗子、5 米/秒带湍流的风、6 公斤的球以 7 米/秒砸窗帘——第一次布被拉成一大团（二面角的弯曲约束），换距离型以后撞开、在风里起伏，褶子和明暗正常；无头 Chrome（1920×905）120 帧/秒，物理平均每帧 1.21 毫秒（两块布 1910 个点，每两帧一步），布料脚本抄顶点、上传 0.26 毫秒；Node 里 1485 个点的布一步 1.0～1.3 毫秒、读顶点 0.06～0.09 毫秒。顺手：上一条的验证挂在一条单测上（网格解码缺 meshoptDecoder 的报错措辞改了），改回原措辞、单独提交。

138. **车身损伤（撞了会瘪）**（11-24，世界模拟的底座第 3 步）：fork 的开始接触事件带上接触点（几个接触点的平均，双精度的世界位置）和法线（从 body_a 指向 body_b，换位置时取反），事件 64 字节，构造统一走 `Event`、`Started`（`native-dev-127fdf4be1`，原生 51 条 Node 测试过）；引擎 `StartedContact.point`、`normal`（从自己指向对方）。`physics/Deformable.ts` 的 `Deformable` 脚本（`threshold`、`softness`、`radius`、`maxDent`、`subdivide`，`dent()`、`dents`、`deepest`，引擎登记）、`deformableCopy`、`subdivideMesh`；`content/modelFile.ts` 加 `meshTangents`；`Mesh.updateVertices(bounds?)` 可以直接给包围盒。单测：细分后每条边不超过给定长度、面积不变、共用边的中点只建一个；20 公斤的箱子从 3 米落地底面中间被推上去、四个角几乎不动、网格是自己的，2 厘米落下不瘪。坑：细分在只有位置的顶点（步长 3）上把法线归一写到了下一个点；第一次的断言看包围盒最低点不对（角在影响半径边上）。Chrome（greybox，eval 搭）：铁皮桶（圆柱，细分到 6 厘米，60750 个顶点）被 30 公斤的球以 12 米/秒砸，条纹往里凹，瘪 10.6 厘米；斜着从 4 米落地的箱子瘪 5.3 厘米。一次凹陷第一版 35 毫秒（扫全部顶点和三角形），改成格子分桶加邻接表、去掉内层的数组分配和 Set 以后 4～5 毫秒（第一次 17 毫秒含 JIT）。槽 1 验证第 136、137 条（可破坏、布料，含措辞的修复）：PASSED。

139. **远处物理的降级**（11-24，世界模拟的底座第 3 步）：fork 加 `sn_physics_lod`（醒着的动态物体、软体离关注点太远的冻结、回到近处叫醒，只遍历 Jolt 的活动列表和冻结着的；被撞醒的不再算冻结；冻结的软体不被钉子、风叫醒），JS 的 `lod` 和 Node 测试（近的接着落、远的停住，关注点挪过去叫醒、接着落，回差参数不对报错），原生 52 条全过（`native-dev-8a899bc578`）。引擎：`simulation.lod`（sleepDistance 250、wakeDistance 200、interval 0.25）、`focus`（Game 每帧给主相机上一帧的位置）、`lodStats`；`SoftBodyHandle.awake()`，`Cloth` 睡着时只抄一次顶点；调试命令 `physics-lod`。单测：600 米外的落体停在半空、近的落下 15 米以上，关注点挪过去以后接着落，关掉以后不再冻。无头 Chrome（greybox，1920×905）：沿 x 每 50 米一面受风的旗子共 40 面，相机在原点时冻结 34 面，每次更新平均 1.36 毫秒（物理 0.81、布料脚本 0.31）；关掉降级（距离设 10 万米）4.33 毫秒（物理 2.04、脚本 2.04），帧间隔从 8.3 毫秒掉到 16.7 毫秒；相机挪到 x = 1000 时 850～1150 米的 7 面醒着、其余 33 面冻结。槽 1 验证第 138 条（撞了会瘪）：PASSED。

140. **按模型建的软体**（11-24，世界模拟的底座第 3 步，物理这一行做完）：`physics/SoftBody.ts` 的 `SoftBody` 脚本（`model`、`mass`、`pressure`、`stretch`、`bend`、`iterations`、`friction`、`windDrag`、`layer`，引擎登记）和 `weldModel`（所有网格的顶点按位置焊成质点，`welded[网格][顶点]` 是对应的质点，焊完退化的三角形去掉）。单测：球的接缝焊掉、没有退化三角形；直径 1 米的球充气（500）落地高度还有 0.75 米以上、不充气的瘪下去 0.2 米以上，画的网格是动态的，去掉脚本时一起没了。Chrome（greybox，eval 搭）：三个压力不同的球（200、800、3000）落下，高压的弹得很高、弹进地上的洞掉出了房间（Node 里网格地面、方块地面都复现：2.5 米落下弹回 2.3 米，不是穿模）；改成 100、300、600 以后在房间里弹、滚、被 40 公斤的石头压。无头 Chrome：三个球（每个画用 1225 个顶点、焊后约 600 个质点）物理平均每帧 1.24 毫秒、脚本 0.34 毫秒（没有它们时 0.05、0.002）。物理这一行标成做完：贴骨骼的衣服、披风归到九的布料，车门、保险杠撞掉以后和载具的玩法一起做。槽 1 验证第 139 条（远处物理的降级）见下一条。
