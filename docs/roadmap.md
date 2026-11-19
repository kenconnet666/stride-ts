# 路线图（2026-11-19 定稿，无人值守执行中）

目的：一次把范围定下来，之后无人值守地持续执行，用复刻开源游戏来验证。本文件列出 Stride 的全部内容、超出 Stride 要加的功能、每项做不做、按什么顺序做、怎样算完成；取舍见第四节，2026-11-19 全部按推荐定下，执行中的决定记在 docs/decisions.md。

盘点依据：
- Stride：`C:\Users\Administrator\IdeaProjects\stride` 的 `sources/`（engine、plugins、editor、assets、shaders、tools）和 `samples/`。
- 别的引擎：虚幻 5.7、Unity 6、Godot 4.6 的公开文档。
- Web 上的现成做法：`C:\code\refs` 里 three.js（2026-11-18 的版本）、Babylon.js、Filament 的 WebGPU 实现，以及 WebGPU 规范的提案状态。

## 原则（用户 2026-11-19 定）

- **有意义的功能都尽量做**：判断意义不大的可以不做（写明理由）；Stride 没有的功能可以加，参考虚幻、Unity、Godot；WebGPU 没有的硬件功能用计算着色器模拟（比如软件光追）。
- **矢量优先，清晰优先**：
  - 能用矢量表达的东西，默认按矢量在原生分辨率下渲染，任何缩放、任何 dpr 都清晰，其他格式照样支持：
    - 界面和文字：界面的形状、文字的字形轮廓直接在 GPU 上算覆盖率，3D 场景里的文字用 MSDF；
    - 2D 精灵：SVG 精灵按矢量画；
    - 贴图上的图案：SVG 贴图按屏幕上需要的分辨率栅格化，见下面的"矢量贴图"；
    - 编辑器：图标、Gizmo、网格线都用解析的抗锯齿线，粗细恒为整数像素。
  - 资源管线和编辑器优先接受 SVG（导入成贴图、精灵、界面图片），位图照样支持。
  - 画面默认不糊：
    - 按原生分辨率渲染（已定：不封顶分辨率）；
    - 界面在后处理之后、按原生分辨率画，不经过 FXAA 和 TAA；
    - 时间性抗锯齿要配锐化，并保留 MSAA 选项。
- **画在 canvas 里的东西也要有 Web 原生的能力**（用户 2026-11-19 提出）：界面和文字画在 WebGPU 的 canvas 里，浏览器看不到；要同步一层透明的影子 DOM，做法参考 Flutter Web 的 semantics 树、Google Docs 的 canvas 渲染、CodeMirror 和 Monaco 的隐藏输入框：
  - **选中和复制**：每段界面文字在影子 DOM 里有一个位置、大小、字号和画面一致的透明文本元素，浏览器原生的选中、复制、Ctrl+F 查找和翻译插件都能用；选区的高亮由我们自己的渲染器画（读 `Selection` 和 `Range`），和画面一致。
  - **无障碍**：界面控件对应 ARIA 角色（按钮、复选框、滑块、列表、对话框），读出名字、状态、值；焦点顺序和 Tab 键导航和界面的焦点系统同步；屏幕阅读器能读、能操作。
  - **输入**：文本框获得焦点时，把一个隐藏的 `<textarea>` 放到光标位置，拿到输入法（中文、日文）组合输入、手机软键盘、粘贴、撤销；组合中的文字由我们的渲染器画。
  - **系统设置**：跟随浏览器缩放（矢量渲染按新的 dpr 重画）、`prefers-reduced-motion`、`prefers-contrast`、深浅色。
  - 影子 DOM 由 UI 系统按需维护（只在界面变化时更新，布局计算复用），游戏可以关掉；3D 世界里的文字和世界空间的界面默认不进影子 DOM，可以按元素打开。
  - 编辑器本身的界面就是 DOM，天然具备这些能力；视口里的叠加层同上。
- **和 Stride 对齐是底线，不是上限**：Stride 有的功能画面要能逐像素对上（有意的偏差除外）；超出的功能用"质量档"开关，对齐模式下关掉。

## 一、Stride 的全部内容和我们的处理

图例：✅ 已有　🔨 进行中　▶ 要做（括号里是阶段）　⏸ 推迟（有需要再做）　✂ 不做（理由）

### 运行时核心

| Stride 模块 | 内容 | 处理 |
|---|---|---|
| Games、Engine 的 Game、GameSystem、SceneSystem | 游戏循环、时间、场景实例、子场景 | ✅ 循环和时间、子场景和场景切换、流式加载（P1） |
| Entity、EntityComponent、Processor | 实体、组件、处理器 | ✅ 数据组件加系统（我们的写法，见 architecture.md 的"组件 API"） |
| ScriptComponent（Sync、Async、Startup）、EventKey、MicroThreading | 脚本和事件 | ✅ |
| Prefab、InstancingComponent | 预制体、GPU 实例化 | ✅ 预制体实例化（Stride 存的是展开后的实体，嵌套随之支持）、实例化绘制 |
| TransformComponent、ModelNodeLink、TransformLink | 层级、挂到骨骼节点 | ✅ 层级、挂到骨骼节点（ModelNodeLink） |
| Animations（剪辑、混合、AnimationComponent） | 骨骼动画、混合、曲线 | ✅ ozz 采样加混合、GPU 蒙皮；▶ 曲线、根运动 |
| Updater（UpdateEngine） | 按属性路径给任意字段做动画 | ▶ 随动画剪辑里的非骨骼曲线一起做（P1 的游戏都没用到，挪到 P2：有样例用到时做） |
| Morph targets | 变形动画 | ▶（P2） |
| Input（键鼠、手柄、触摸、手势、传感器） | | ✅ 键鼠手柄；▶ 触摸和手势（P2）；▶ 重力、加速度计（P3，浏览器的 DeviceMotion） |
| Audio（声音、空间化、流式） | | ▶ Web Audio：音效、音乐流、AudioEmitter/Listener 空间化（P2） |
| Video | 视频贴图 | ▶ 用浏览器的 video 元素加 `importExternalTexture`（P3，量小） |
| Streaming（贴图流式加载） | | ⏸ 内容规模上来再做 |
| Profiling、Debugger、Network（远程调试） | | ✅ 由调试 CLI 取代 |
| Localization | 编辑器和游戏的多语言 | ⏸ |
| VirtualReality（OpenXR） | | ⏸（D7）：WebXR 以后再做 |

### 渲染

| 内容 | 处理 |
|---|---|
| 前向渲染、HDR、PBR、方向光阴影、天空盒、背景、深度预通道 | ✅ |
| 点光、聚光（clustered），点光阴影（立方体、抛物面），聚光阴影 | ✅ 点光、聚光（P1，逐像素遍历，最多 256 个）；▶ 阴影和分簇挪到 P2（P1 的游戏都没开，教程场景用到时做） |
| 光探针（球谐、四面体插值）、光照烘焙 | ▶（P3） |
| 材质特性：漫反射、镜面、法线、自发光、透明（混合、cutoff）、遮蔽、clear coat、次表面散射、头发、卡通、位移 | ✅ 前四项、透明（混合）和遮蔽（P1）；▶ cutoff、clear coat、卡通（P2）；⏸ 次表面散射、头发 |
| 材质层（MaterialBlendLayers）、颜色树（ComputeColor） | ▶ 由着色器系统生成（P2，见 D3） |
| 曲面细分（Tessellation） | ✂ WebGPU 没有曲面细分阶段；位移改用顶点位移 |
| 精灵（SpriteComponent、精灵表）、字体（SpriteFont：静态、动态、SDF） | ✅ 精灵和精灵表（P1，SVG 先栅格化）；▶ SVG 精灵按矢量画挪到 P2 的矢量渲染底座；P2 做字体：屏幕上的字按字形轮廓直接画，世界空间的字用 MSDF，Stride 的位图字体照样能导入 |
| 后处理：FXAA、Bloom、光芒、镜头光晕、色调映射、颜色变换 | ✅ |
| 后处理：TAA、SSAO、景深、雾、轮廓、光束（LightShafts）、局部反射（SSR）、抖动 | ▶（P3，按样例需要逐个做） |
| MSAA | ▶（P2） |
| 自定义效果（.sdsl / .sdfx，CustomEffect、MaterialShader 样例） | ▶ 着色器系统（P2，见 D3） |
| 图形合成器（GraphicsCompositor，.sdgfxcomp）：多相机、渲染到纹理、分屏 | ✅ 读 .sdgfxcomp 的最小数据化（P1：相机槽位、渲染到纹理、后处理开关）；▶ 完整的合成器（P2） |
| 线框、调试渲染（DebugRenderer、物理形状） | ▶ 挪到 P3：和编辑器的解析线 Gizmo、网格一起做（P1 的游戏和调试没用到，现在用调试 CLI 的射线、查看代替） |
| 体素全局光照（Voxels） | ✂ 实验性功能，Stride 默认关 |
| 延迟渲染 | ✂ Stride 也只用 GBuffer 做 SSR，主路径是前向 |

### 插件

| Stride 插件 | 处理 |
|---|---|
| BepuPhysics（刚体、角色、触发器、约束、射线和扫掠、碰撞层、凸包、网格碰撞） | ✅ 静态体、角色、动态刚体、触发器、接触事件、约束（Bepu 的约束组件映射到 Jolt，刚性）、射线、扫掠、凸包、网格碰撞（含动态网格）；▶ 重叠测试、接触的软度 |
| BepuPhysics.Navigation（Recast 导航网格组件） | ✅ 运行时建导航网格、寻路（P1，TopDownRPG）；▶ 排队寻路、直接移动 |
| BepuPhysics._2D、Soft | ✂ 2D 模式：Platformer2D 不用它（平台和角色都在 Z=0 上，3D 物理照常），有样例用到时再用 Jolt 锁定轴；⏸ 软体（Jolt 有，样例不用） |
| Heightfield（地形） | ▶ Jolt 高度场加地形渲染（P3） |
| BulletPhysics（旧物理、旧导航） | ✂ 被 Bepu 取代，我们用 Jolt |
| Particles（发射器、初始化器、更新器、形状、材质、动画） | ▶（P2，大块：CPU 模拟放在 C++，GPU 实例化绘制） |
| UI（布局系统、控件、UI 页面、UI 库、UIElementLink、世界空间 UI） | ▶（P2，见 D4） |
| Audio | 见上 |
| SpriteStudio | ✂ 第三方专有格式，只有一个样例用 |
| Video | 见上 |
| Voxels | ✂ 见上 |

### 资源管线（Stride 的资源类型 → 我们的处理）

| 资源 | 处理 |
|---|---|
| .sdscene、.sdprefab、.sdm3d（模型）、.sdmat、.sdtex、.sdsky、.sdgamesettings | ✅ 导入，含预制体 |
| .sdskel、.sdanim | ✅（P1） |
| .sdsheet（精灵表）、.sdfnt（字体）、.sdpcfnt | ✅ 精灵表（P1）；▶ 字体（P2） |
| .sduipage、.sduilib | ▶（P2） |
| .sdsnd（声音） | ▶ 转成 Opus/WebM 或保留 mp3、ogg（P2，见 D9） |
| .sdpart、粒子组件 | ▶（P2） |
| .sdpromodel（程序模型：立方体、球、平面、圆柱、胶囊、圆环、茶壶） | ✅（P1） |
| .sdprefabmodel、.sdhull（凸包分解） | ▶（P2，VHACD 已在 stride-tools） |
| .sdnavmesh | ▶ 预先烘焙的导航网格（P1 的 TopDownRPG 运行时建，有样例用烘焙的再做） |
| .sdgfxcomp | ✅ 最小（P1）；▶ 完整（P2） |
| .sdsl、.sdfx | ▶ 着色器系统（P2） |
| .sdrendertex | ▶（P2） |
| .sdvid | ▶（P3） |
| .sdhf、.sdhmap | ▶（P3） |
| .sdvs（可视化脚本） | ✂ Stride 已经停止维护 |
| .sdss4a/.sdss4s（SpriteStudio） | ✂ |

### 编辑器（Game Studio）

| 功能 | 处理 |
|---|---|
| 工程、资源浏览器、资源导入、缩略图 | ▶ |
| 场景编辑器：场景树、视口、Gizmo（移动、旋转、缩放）、选择、相机导航、网格和吸附 | ▶ |
| 属性面板（Quantum：任意对象的属性编辑、集合、引用、撤销重做、多选） | ▶ 由 `prop` 的 schema 驱动 |
| 预制体编辑和继承（archetype、覆盖、嵌套） | ▶ |
| 播放（在编辑器里运行游戏）、热重载 | ▶（运行时已有热重载） |
| 脚本编辑 | ✂（D5）：用外部 IDE（WebStorm/VS Code）加热重载，编辑器只负责跳转 |
| 材质编辑（属性面板加预览） | ▶ |
| 精灵表编辑器、UI 编辑器、粒子编辑器、曲线编辑器 | ▶（随对应的运行时功能，P3） |
| 图形合成器的节点图编辑器 | ⏸ 用属性面板编辑，不做节点图 |
| 着色器预览、效果编译服务器 | ✂ 着色器在 Node 端预编译 |
| 构建和发布（各平台打包） | ▶ 只有 Web：`vite build` 加内容打包；⏸ 桌面壳（Electron/Tauri） |
| 模板、新建工程 | ▶（P3） |
| 多语言 | ⏸ |

## 二、超出 Stride 的功能

### WebGPU 现在能做什么、缺什么（2026-11）

- **有**：
  - 计算着色器、间接绘制（`drawIndirect`、`dispatchWorkgroupsIndirect`）、存储缓冲和存储纹理、时间戳；
  - 子组运算（subgroups，已进规范）、`shader-f16`；
  - 压缩贴图（BC、ASTC、ETC2）；
  - 32 位原子操作：把深度和编号塞进同一个 32 位值，靠它可以做软件光栅。
- **没有，要绕开**：
  - 硬件光追：用计算着色器遍历 BVH；
  - bindless：贴图图集、贴图数组，或按材质分批；
  - 64 位原子操作（正在标准化，Nanite 的软件光栅靠它）：用 32 位打包，three.js 的可见性缓冲就是这么做的；
  - multi-draw-indirect（Chrome 有实验版）：顶点拉取（vertex pulling）加每种材质一次间接绘制；
  - 曲面细分、几何着色器：用计算着色器生成；
  - 稀疏纹理：页表加图集模拟虚拟贴图。
- **说明 Web 上已经做得到的参考（都是 MIT 或 Apache，可以读、可以照着做）**：
  - three.js 2026-11 的 WebGPU 版有：
    - 渲染管线：簇（meshlet）绘制管线、可见性缓冲管线（大三角形走硬件光栅，小三角形走软件光栅）；
    - 光照和全局光照：体素锥追踪全局光照（VXGI）、光探针网格烘焙、BVH 光追的辐射度光照贴图烘焙、路径追踪渲染器（three-gpu-pathtracer）；
    - 屏幕空间效果：SSGI、随机 SSR、TRAA、接触阴影；
    - 场景内容：体积云、海洋、焦散、Gaussian splatting。
  - Babylon.js 9：上千盏灯的分簇光照、节点粒子编辑器、IBL 阴影。
  - EA 的 Gigi 示例：把 tinybvh 的遍历移植到 WGSL，做"软件光追"。
  - meshoptimizer 1.0 的 `clusterlod.h`：类 Nanite 的簇层级 LOD 构建，meshoptimizer 已经在我们的 stride-tools 里。
  - Vello：MIT/Apache，用 WGSL 计算着色器画任意矢量路径。

### 加什么（价值和可行性是我的判断）

| 方向 | 功能（参考） | 价值 | WebGPU 上的做法 | 阶段 |
|---|---|---|---|---|
| **矢量渲染** | 任意路径、描边、渐变的 GPU 渲染（Vello） | 高：原则里的默认 | 计算着色器分块算覆盖率；简单形状（圆角矩形、边框、阴影）用解析 SDF | P2 起（界面和字体先用） |
| | 矢量贴图：SVG 贴在 3D 表面上，近看也清晰 | 中高 | 按屏幕上的需要（贴图坐标的导数）分块栅格化进贴图缓存（类似虚拟贴图），远处用 mip | P4 |
| **抗锯齿和上采样** | TAA 加锐化；时间性上采样（AMD FSR 2/3 的思路，MIT）；可选的动态分辨率 | 高 | 计算着色器；默认按原生分辨率只做抗锯齿，上采样和动态分辨率是用户可选项 | P4 |
| **屏幕空间效果** | GTAO、随机 SSR、SSGI、接触阴影、屏幕空间次表面散射、运动模糊 | 高、成本低 | 全屏计算着色器，参考 three.js | P4 |
| **阴影** | PCSS 软阴影、缓存的级联阴影、点光和聚光阴影图集 | 中高 | 标准做法 | P4 |
| **大气和天气** | 物理天空和大气散射（Hillaire 2020）、日夜循环、体积云、体积雾和体积光（froxel）、高度雾、雨雪 | 高：最出效果 | 查找表加光线步进，GPU 粒子 | P4 |
| **材质** | glTF 的扩展材质（清漆、光泽、各向异性、透射、虹彩、体积）、视差遮蔽、三平面、贴花（分簇）、顶点动画贴图、节点式材质编辑器（Shader Graph） | 高 | 着色器系统生成 WGSL；节点编辑器进编辑器阶段 | P4 |
| **粒子和特效** | GPU 粒子（深度缓冲碰撞、条带、网格粒子、序列帧）、节点式特效编辑器（VFX Graph、Niagara） | 高 | 计算着色器模拟加间接绘制；Stride 的 CPU 粒子导入后跑在 GPU 上 | P4 |
| **软件光追** | BVH：tinybvh（MIT，单头文件）编进 stride-native，SAH 构建、动态物体只做 refit、两级（TLAS、BLAS）；WGSL 里遍历 | 高：下面几项的基础 | 计算着色器，光线按半分辨率加时间复用 | P5 |
| | 光追阴影（面光源软阴影）、光追反射（和 SSR 混合）、光追 AO | 中高 | 同上，加时空降噪（SVGF、A-Trous） | P5 |
| | 参考路径追踪器：编辑器里的"真值"模式，也给后面的近似算法当验收基准 | 高 | 渐进累加 | P5 |
| **全局光照** | 烘焙：光照贴图（xatlas 展 UV，已在 stride-tools）和光探针网格，用上面的 BVH 在 GPU 上烘焙；对应 Unity 的 APV 和 Stride 的光探针 | 高：Web 上最省 | 编辑器里渐进烘焙 | P5 |
| | 实时：DDGI（探针网格每帧用软件光追更新辐照度和可见性），加 SSGI 补细节 | 高 | 计算着色器 | P5 |
| | 很多动态光源：ReSTIR 直接光（MegaLights 的思路） | 中 | 计算着色器加降噪 | P5 后段 |
| | Lumen 式（网格距离场、表面缓存）、VXGI | 中，复杂度很高 | ⏸ DDGI 加 SSGI 已经覆盖大部分效果；以后需要再做 | ⏸ |
| **大规模场景** | GPU 驱动渲染（计算剔除、Hi-Z 遮挡剔除、实例数据全放在 GPU 上，对应 Unity 的 GPU Resident Drawer） | 高 | 计算着色器加间接绘制 | P6 |
| | 虚拟几何：簇 LOD（`clusterlod.h`），可见性缓冲，小三角形走软件光栅（对应 Nanite） | 中高：画面细节的上限 | 32 位打包原子；材质按屏幕分块解析 | P6 |
| | 地形（高度场、分块 LOD、贴图混合）、植被（GPU 实例化、风）、大世界分块流式加载 | 高（开放世界类） | Jolt 高度场加 GPU 实例化 | P6 |
| | Gaussian splatting（扫描场景） | 中：展示效果好 | 计算着色器排序加实例化绘制 | P6 |
| **动画** | 状态机和混合树（对应 Mecanim）、根运动、IK（ozz 自带双骨骼 IK 和朝向 IK）、动画重定向、布娃娃（Jolt）、大量角色的 GPU 蒙皮 | 高 | ozz 加 Jolt | P1（基础）、P7 |
| **物理** | 载具（Jolt 的轮式、履带、摩托车）、布料和软体、破碎（离线 Voronoi 切分）、浮力、CharacterVirtual | 中高 | Jolt 现成，原生侧接出来 | P7 |
| **音频** | HRTF 空间化、混响区（卷积）、射线遮挡、混音总线和快照、AudioWorklet 程序化音频 | 中高 | Web Audio | P7 |
| **玩法框架** | 输入动作映射（对应 Unity 的 Input System）、过场时间轴（Sequencer、Timeline）、存档、行为树、多人联网（WebSocket/WebRTC，状态同步） | 中高（联网对 Web 游戏价值大） | TS | P7 |
| **画质档位** | 低、中、高、极高四档，像虚幻的 Scalability：每档开哪些效果、多少光线和探针 | 高：同一个游戏在笔记本和台式机上都能跑 | 配置 | P4 起 |
| **VR、AR** | WebXR | 低（现在） | ⏸ | ⏸ |

## 三、阶段和验收

每个阶段都以"复刻一批游戏"收尾。验收全部由 agent 用调试 CLI 自动完成，不靠人看：

- **画面**：同一场景、同一相机位置，和桌面 Stride 的截图逐像素比较（`tools/stride-capture` 推广到每个样例）。阈值：每通道平均差 ≤ 1/255，差超过 10 的像素 ≤ 0.5%，有意的偏差写进文档。
- **玩法**：每个游戏一个脚本化的通关或冒烟流程（`stride key`、`mouse`、`step`，加上 `inspect`、`eval` 的断言），放进仓库，回归时重跑。
- **性能**：同一台机器、同一时段，帧时间不比桌面 Stride 慢（用相对值，不受笔记本电源模式影响），另记绝对值和电源模式。
- **工程质量**：类型检查、单元测试、原生测试全过；每个游戏的导入、构建、启动时间和下载体积记入文档。
- **超出 Stride 的画面功能**（没有桌面 Stride 可比）：
  - 光照的近似算法（DDGI、SSGI、光追阴影和反射、AO）：和我们自己的参考路径追踪器收敛后的结果比较，记误差；
  - 每个功能各有一个固定机位的截图回归；
  - 各画质档位有帧时间预算，同时记录电源模式；
  - 矢量渲染：放大 1×、2×、4× 截图检查边缘清晰（边缘过渡宽度不超过 1 个像素），并和 Vello/浏览器自己画的 SVG 比覆盖率。
  - 影子 DOM：用 CDP 的 Accessibility 域读无障碍树，检查角色、名字和画面一致；脚本化地选中、复制文字，用输入法事件输入中文，检查结果。

| 阶段 | 内容 | 用来验收的游戏和场景 |
|---|---|---|
| **P1 运行时补齐 3D 游戏的基础** | 场景脚本导入、骨骼动画和混合、挂到骨骼节点、预制体、程序模型、动态刚体、触发器、接触事件、约束、导航、点光和聚光（含阴影，分簇）、透明材质、精灵和精灵表（SVG 精灵按矢量画）、2D 物理、调试渲染、合成器的最小数据化 | ThirdPersonPlatformer（完整，含动画）、AnimatedModel、PhysicsSample、BepuSample、Platformer2D、TopDownRPG、FirstPersonShooter（不含粒子） |
| **P2 界面、声音、效果** | 矢量渲染的底座（含 SVG 精灵按矢量画）、UI 系统和 .sduipage、影子 DOM（选中复制、无障碍、输入法）、字体（字形轮廓和 MSDF）、音频、粒子、着色器系统（自定义效果、材质层、颜色树）、MSAA、渲染到纹理、Morph、触摸，从 P1 挪来的点光和聚光的阴影、分簇，动画剪辑的非骨骼曲线（Updater） | SpriteFonts、GameMenu、UIElementLink、UIParticles、SimpleAudio、ParticlesSample、JumpyJet、SpaceEscape、MaterialShader、CustomEffect、MorphTargets、FPS（含粒子）、教程 CSharpBeginner、CSharpIntermediate |
| **P3 编辑器** | 见第一节的编辑器表，矢量优先（SVG 图标、解析线的 Gizmo 和网格、SVG 资源导入）；调试渲染（线框、物理形状，从 P1 挪来） | 用编辑器打开 P1、P2 的每个游戏，改场景和属性后能保存、播放；用编辑器从零搭一个小游戏 |
| **P4 现代画面** | 画质档位、TAA 加锐化和可选的时间性上采样、GTAO、随机 SSR、SSGI、接触阴影、PCSS、物理天空和日夜循环、体积云、体积雾和体积光、扩展材质、贴花、GPU 粒子和特效、矢量贴图；Stride 剩下的效果（景深、轮廓、光束、光探针等） | Starbreach（本机）、Sponza、Bistro 这类公开的测试场景，加上用 P4 功能重新打光的 TPP、TopDownRPG |
| **P5 软件光追和全局光照** | tinybvh 进 stride-native、WGSL 遍历、参考路径追踪器、光照贴图和光探针的 GPU 烘焙、DDGI、光追阴影、反射、AO、时空降噪、ReSTIR 直接光 | 同上，加日夜循环下的室内外场景；误差和参考路径追踪器比较 |
| **P6 大规模场景** | GPU 驱动渲染和遮挡剔除、簇 LOD 加可见性缓冲、地形、植被、分块流式加载、Gaussian splatting | 大场景基准（几百万到上亿三角形、上万实例）、一个开放世界的小游戏 |
| **P7 玩法系统扩展** | 动画状态机、IK、重定向、布娃娃、载具、布料、破碎、空间音频和混响、输入映射、时间轴、存档、行为树、多人联网 | 别的引擎的开源游戏（见 D8）、一个联网小游戏 |

P1 和 P2 内部不分先后，按"下一个游戏缺什么就做什么"推进，游戏顺序就是上表的顺序。P4 到 P7 的顺序可以按需要调整，但 P5 依赖 P4 的降噪和时间复用基础，P6 的可见性缓冲要等着色器系统稳定。

## 四、取舍（2026-11-19 用户决定：全部按推荐）

- ~~**D1 范围**~~：已定（用户 2026-11-19），见上面的"原则"。
- **D2 编辑器的时机**：放在 P3（运行时先跟着游戏走），还是从 P1 就和运行时并行？推荐 P3。理由是游戏复刻走 Stride 工程导入器，不依赖编辑器；运行时的组件和资源格式稳定后再做编辑器，返工最少。代价是编辑器晚几个阶段才有。
- **D3 着色器系统**：自定义着色器（.sdsl）怎么办？
  - (a) 我们自己的 WGSL 组合系统（Node 端预编译），样例里的 SDSL 由 agent 手工移植成 WGSL。推荐这个。
  - (b) 在资源管线里跑 Stride 自己的着色器编译器（这个仓库里有新的 SPIR-V 编译器，可以出 WGSL），能直接导入 SDSL，但管线要依赖 .NET。
- **D4 UI 系统**：
  - (a) 照 Stride UI 自己做：布局规则照 Stride，能导入 .sduipage，用矢量渲染器在 WebGPU 上画，屏幕和世界空间都清晰。推荐这个。
  - (b) 用 HTML/CSS 覆盖层，省事，浏览器本身也是矢量渲染，但做不了世界空间 UI 和逐像素比对。
- **D5 脚本**：游戏脚本只用 TypeScript；C# 脚本由 agent 逐个翻译（不做 C# 到 TS 的自动转译器）；编辑器不内置代码编辑器。推荐都选"是"。
- **D6 C# 网页移植版**：停止，只当参考实现。推荐停止。
- **D7 VR**：推迟（WebXR 以后再说），VRSandbox 不在验收清单里。推荐推迟。
- **D8 验证用的游戏来源**：
  - Stride 自带的样例：MIT，能和桌面 Stride 逐像素比，覆盖面全，必做。
  - Starbreach：Stride 官方的大型演示；代码 MIT，美术是 CC BY-NC 4.0，只能本机导入、不能提交进公开仓库。
  - 社区的开源 Stride 游戏，比如 StrideAsteroids。
  - 别的引擎的开源游戏（比如 Godot 的演示项目），要先有编辑器、要手工搬场景，验证的是"用我们的引擎做游戏"而不是"对齐 Stride"。

  - 公开的图形测试场景：Sponza、Amazon Lumberyard Bistro（CC BY）、Khronos 的 glTF 样例。用来验证 P4 到 P6 的画面和性能。

  推荐：P1、P2 只用 Stride 样例；P4 到 P6 加 Starbreach、测试场景和一两个社区游戏；其他引擎的游戏放到编辑器之后（P7）。
- **D9 音频格式**：管线把 .sdsnd 的源文件转成 Opus（WebM 或 Ogg 容器）要用 ffmpeg。
  - (a) 要求本机装 ffmpeg；
  - (b) 用 ffmpeg 的 wasm 版，慢但零安装；
  - (c) 浏览器能解的格式（mp3、ogg、wav）原样复制。
  
  推荐 (c) 起步，(a) 作为可选的压缩。
- **D10 无人值守的边界**：哪些事可以自己定、哪些要停下来等你？推荐：
  - **自己定**：表里已定的事；同一阶段内的实现方式；和 Stride 不同但更好的做法（照记忆里的规矩：想清楚后果、在代码里标"和 Stride 不同"）；原生包发版；提交和推送。决定记进 `docs/decisions.md`，写明理由。
  - **停下来问**：改动这份路线图的范围；公共 API 的大改（比如组件写法）；引入新的重型依赖；要花钱或要账号的事；连续两次修不好的阻塞。
- **D11 编辑器和现代画面谁先**：推荐编辑器在前（P3 再 P4）。烘焙、打光、调大气和特效都要在编辑器里看着调；而且编辑器做出来以后，P4 起的效果都能直接接进编辑器的预览。另一个选择是先做画面，展示效果来得快，但没有编辑器，灯光和特效只能写在代码里调。
- **D12 渲染器的主路径**：GPU 驱动加可见性缓冲（P6）做成以后，是否取代现在的前向渲染做主路径？推荐分档：
  - 对齐 Stride 的模式和低档继续用前向（简单，和 Stride 逐像素对得上，弱显卡也快）；
  - 高档和极高档用可见性缓冲（几何量大时才划算）；
  - 两条路径共用材质和光照代码，由着色器系统生成。
- **D13 全局光照的默认方案**：推荐：
  - 默认用烘焙（光照贴图加光探针），在 Web 上最省，画面也最稳；
  - 高档开 DDGI，配合日夜循环、可破坏场景这类动态光照；
  - SSGI 作为各档都能叠加的细节；
  - Lumen 式和 VXGI 暂不做。
- **D14 上采样和动态分辨率**：照你之前的意思，默认按原生分辨率只做抗锯齿；时间性上采样和动态分辨率做成玩家可开的选项（画质菜单里），不默认打开。
- **D15 多人联网**：Stride 没有。推荐放进 P7：权威服务器用 Node，客户端预测加插值，WebSocket 起步，WebRTC 数据通道可选。另一个选择是不做，交给游戏自己。
- **D16 矢量渲染怎么实现**：推荐两步：
  - P2 先做 UI 和文字需要的部分：圆角矩形、边框、阴影、渐变用解析 SDF；文字按字形轮廓（二次贝塞尔）在片元着色器里算覆盖率，世界空间的字用 MSDF；
  - SVG 精灵和矢量贴图要用到任意路径时，再做 Vello 式的计算着色器路径渲染器（WGSL，参考 Vello 的算法自己写，不引入 Rust 依赖）。

## 五、无人值守怎么执行（草案）

- **任务队列**：`docs/roadmap.md` 的阶段表是唯一的计划，进度写在本节下面的"进度"里。每个游戏一节：缺的功能、做了什么、验收结果（截图差、性能、通关脚本）、遗留问题。
- **每个游戏的流程**：
  1. 导入，列出不认识的组件和资源（导入器会计数）；
  2. 按缺口补运行时，每补一项写单测；
  3. 翻译脚本；
  4. 用桌面 Stride 截参考图；
  5. 写通关脚本；
  6. 比对，修到达标；
  7. 记录、提交、推送。
- **长任务**：构建、测试在后台跑；等的时候读源码、写下一步。
- **自检**：每完成一个游戏，所有已完成游戏的通关脚本和截图比对全部重跑一遍（回归），不过就先修。
- **性能数字**：一律记相对桌面 Stride 的倍数，附带绝对值和电源模式。
- **代码质量**（用户 2026-11-19 强调）：注释用中文，只写不直观的"为什么"；每完成一个游戏或一个阶段就整理一次：文件放进职责明确的文件夹，函数和类的分工理顺，合并重复，删掉没人用的代码。整理和功能改动分开提交。

## 进度

定时续跑：会话里有一个每 15 分钟触发的定时任务（CronCreate，2026-11-19 建，7 天后过期，到期前由 agent 重建），提示词让 agent 读这一节接着做。

### P1 运行时补齐 3D 游戏的基础

下一步按顺序：
1. ~~场景脚本导入~~（2026-11-19 完成）：导入器把 Stride 的脚本组件写进场景（属性名改成小写开头，实体和资源的引用写成 `$entity`、`$asset`）；运行时按类名在登记表里找翻译过来的 TS 脚本（`loadScene` 的 `scripts` 选项可以显式对应），找不到的脚本和属性警告后跳过；新的属性种类 `prop.asset(kind)`；`InputManager` 也认 Stride 的键名。TPP 改成由场景挂脚本。顺手修了热重载在有私有成员的脚本上崩溃的问题。
2. ~~骨骼动画~~（2026-11-19 完成，ModelNodeLink 留到 FPS、TopDownRPG 用到时做）：ufbx 导出骨架、蒙皮、动画剪辑；ozz 采样和混合；蒙皮顶点格式、GPU 蒙皮；AnimationComponent 和 TPP 的 AnimationController。TPP 的角色动起来了。见 architecture.md 的"骨骼动画和 GPU 蒙皮"。
3. ~~AnimatedModel~~（2026-11-19 P1 部分完成，`apps/animated-model`，端口 5186；见 decisions.md 的"AnimatedModel 分两次验收"）：
   - 做了：导入和运行（角色跑步、Idle/Run 淡入淡出、拖动转身）；2D 背景（Background 的 Is2D）；一个视图最多 4 个方向光；相机槽位（Camera.slot）；合成器的最小数据化（主画面的清屏色、后处理开关、透明阶段开关，相机画进渲染目标贴图 RenderTextureSceneRenderer）；渲染目标贴图（Texture.renderTarget）；精灵（Sprite 组件、SpriteRenderFeature，普通和 billboard，透明阶段，从远到近）；指针事件（`input.pointerEvents`）；关掉后处理时原样拷贝。
   - 验收：和桌面 Stride 4.4.2 比（动画停在第 0 帧，去掉 UI 按钮的区域）平均每通道差 0.148/255，差超过 10 的像素 0.31%（`tools/stride-capture/animated-model`）；冒烟脚本 `pnpm --filter @stride-ts/animated-model smoke` 通过。
   - P2 补：UI 页面的 Idle、Run 按钮（现在用 `stride call idle`、`run` 代替）。遗留：画进渲染目标贴图的相机不用阴影、不做后处理；精灵没有 Swizzle、sprite sheet、billboard 的 Z 旋转。
4. ~~PhysicsSample~~（2026-11-19 P1 部分完成，Bepu 版，`apps/physics-sample`，端口 5188；三个场景，`?scene=PhysicsSample/VolumeTrigger` 这样选，NextSceneScript 在场景之间换）：
   - 做了：Body 组件和 `simulation.body(entity)`（运动学、唤醒、瞬移、速度、冲量、重力、睡眠阈值；物体移除后只记设置），凸包碰撞体，程序模型（照 Stride 4.4.2 生成），`screenToWorldRaySegment`；触发器和接触事件（`TriggerHandler`、`setContactHandler`），实体销毁时移除物体和连着的约束；约束（球窝、铰链、齿轮马达、点在线上、线性限位、摆动和扭转限位、焊接，语义照 Bepu，映射到 Jolt；刚性，和 Bepu 的软约束不同）；换根场景（`game.setRootScene`，`prop.asset('scene')`），运行中改重力；材质的透明混合、环境光遮蔽、镜面颜色工作流、贴图乘颜色的自发光，贴图引用记 sRGB；正交相机（`Camera.projection`、`orthographicSize`）。原生到 0.14.0。
   - 验收：和桌面 Stride（master 的样例配 4.4.2 的包）比，去掉 UI 后平均每通道差 0.13 到 1.32/255，差超过 10 的像素 0.56% 到 2.40%，都在箱子的发光标志（材质层，P2）上（`tools/stride-capture/physics-sample`）；冒烟脚本 `pnpm --filter @stride-ts/physics-sample smoke` 走完三个场景的玩法和换场景。
   - P2 补：各场景的 UI 文字和按钮（现在用调试命令 `next`、`previous`、`next-scene`、`previous-scene` 代替），材质层（LogoD）。遗留：透明物体不投阴影、同一批的透明实例不排序。
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

### P2 界面、声音、效果

下一步按顺序（阶段表的游戏顺序）：
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
12. **FPS 的粒子和材质层**：FirstPersonShooter 在 P1 时跳过的部分。
   - 粒子：VFXPackage 的枪口火焰、弹孔用 SpawnerBurst（一次喷一批），受击拖尾用 SpawnerFromDistance（按移动距离生成），导入时现在警告后去掉。
   - 材质层：SamplesAssetPackage 的 LogoA、LogoD（BepuSample、FPS 里的箱子）有 Layers（子材质按 BlendMap 的遮罩混进来），现在只画底层。

   分步：
   1. ~~生成器~~（2026-11-19）：SpawnerBurst（每次活跃喷一批，Stride 的 NotifyStateSwitch 做成 `onStateSwitch`）、SpawnerFromDistance（按粒子系统移动的距离，生成器经 `SpawnTarget.systemTranslation` 拿位置），单测；FPS 冒烟加一项（三个特效的粒子都生出来）。顺手修掉：没有关键帧的曲线分量数按第一个关键帧取，颜色曲线成了 1 个分量、另外三个通道 NaN，受击拖尾画成大黑块；现在按采样器的类型定（Stride 的空曲线是 0）。
   2. ~~材质层~~（2026-11-19）：导入器把 Layers 导出成 `MaterialFile.layers`（遮罩和子材质的漫反射、镜面、金属度、光泽度、法线、自发光，都是颜色树；没写 BlendMap 是 Stride 的默认 ComputeTextureScalar，整层盖上），运行时编成 `layer{i}...` 函数，片元着色器里 `materialLayers`、`layerNormal`、`layerEmissive` 按遮罩逐层线性混合（Stride 的 MaterialStreamLinearBlend），没有层的材质这几个函数原样返回。在主 Chrome 里看过：FPS 的 BoxE（LogoD）红框里的青色面板发光。还没做：层的遮蔽、透明、UVScale 覆盖、层里再套层（记警告）。
   3. FPS 和 BepuSample 重新比对（开枪那帧的粒子、带层的箱子），更新冒烟。
