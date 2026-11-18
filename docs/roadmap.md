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
| Games、Engine 的 Game、GameSystem、SceneSystem | 游戏循环、时间、场景实例、子场景 | ✅ 循环和时间；▶ 子场景和场景切换（P1） |
| Entity、EntityComponent、Processor | 实体、组件、处理器 | ✅ 数据组件加系统（我们的写法，见 architecture.md 的"组件 API"） |
| ScriptComponent（Sync、Async、Startup）、EventKey、MicroThreading | 脚本和事件 | ✅ |
| Prefab、InstancingComponent | 预制体、GPU 实例化 | ▶ 预制体实例化和嵌套（P1）；✅ 实例化绘制 |
| TransformComponent、ModelNodeLink、TransformLink | 层级、挂到骨骼节点 | ✅ 层级；▶ 挂到骨骼节点（P1，FPS、TopDownRPG 用） |
| Animations（剪辑、混合、AnimationComponent） | 骨骼动画、混合、曲线 | ✅ ozz 采样加混合、GPU 蒙皮；▶ 曲线、根运动 |
| Updater（UpdateEngine） | 按属性路径给任意字段做动画 | ▶ 随动画剪辑里的非骨骼曲线一起做（P1） |
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
| 点光、聚光（clustered），点光阴影（立方体、抛物面），聚光阴影 | ▶（P1，TopDownRPG、教程场景用） |
| 光探针（球谐、四面体插值）、光照烘焙 | ▶（P3） |
| 材质特性：漫反射、镜面、法线、自发光、透明（混合、cutoff）、遮蔽、clear coat、次表面散射、头发、卡通、位移 | ✅ 前四项；▶ 透明和遮蔽（P1）；▶ clear coat、卡通（P2）；⏸ 次表面散射、头发 |
| 材质层（MaterialBlendLayers）、颜色树（ComputeColor） | ▶ 由着色器系统生成（P2，见 D3） |
| 曲面细分（Tessellation） | ✂ WebGPU 没有曲面细分阶段；位移改用顶点位移 |
| 精灵（SpriteComponent、精灵表）、字体（SpriteFont：静态、动态、SDF） | ▶ P1 做精灵，SVG 精灵按矢量画；P2 做字体：屏幕上的字按字形轮廓直接画，世界空间的字用 MSDF，Stride 的位图字体照样能导入 |
| 后处理：FXAA、Bloom、光芒、镜头光晕、色调映射、颜色变换 | ✅ |
| 后处理：TAA、SSAO、景深、雾、轮廓、光束（LightShafts）、局部反射（SSR）、抖动 | ▶（P3，按样例需要逐个做） |
| MSAA | ▶（P2） |
| 自定义效果（.sdsl / .sdfx，CustomEffect、MaterialShader 样例） | ▶ 着色器系统（P2，见 D3） |
| 图形合成器（GraphicsCompositor，.sdgfxcomp）：多相机、渲染到纹理、分屏 | ▶ 合成器数据化，读 .sdgfxcomp（P1 最小，P2 完整） |
| 线框、调试渲染（DebugRenderer、物理形状） | ▶（P1，编辑器和调试都要） |
| 体素全局光照（Voxels） | ✂ 实验性功能，Stride 默认关 |
| 延迟渲染 | ✂ Stride 也只用 GBuffer 做 SSR，主路径是前向 |

### 插件

| Stride 插件 | 处理 |
|---|---|
| BepuPhysics（刚体、角色、触发器、约束、射线和扫掠、碰撞层、凸包、网格碰撞） | ✅ 静态体、角色、动态刚体、触发器、接触事件、约束（Bepu 的约束组件映射到 Jolt，刚性）、射线、扫掠、凸包、网格碰撞（含动态网格）；▶ 重叠测试、接触的软度 |
| BepuPhysics.Navigation（Recast 导航网格组件） | ▶ Recast 已在原生侧（P1，TopDownRPG） |
| BepuPhysics._2D、Soft | ▶ 2D 用 Jolt 锁定轴（P1，Platformer2D）；⏸ 软体（Jolt 有，样例不用） |
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
| .sdscene、.sdprefab、.sdm3d（模型）、.sdmat、.sdtex、.sdsky、.sdgamesettings | ✅ 导入；▶ 预制体（P1） |
| .sdskel、.sdanim | 🔨（P1） |
| .sdsheet（精灵表）、.sdfnt（字体）、.sdpcfnt | ▶（P1、P2） |
| .sduipage、.sduilib | ▶（P2） |
| .sdsnd（声音） | ▶ 转成 Opus/WebM 或保留 mp3、ogg（P2，见 D9） |
| .sdpart、粒子组件 | ▶（P2） |
| .sdpromodel（程序模型：立方体、球、平面、圆柱、胶囊、圆环、茶壶） | ▶（P1，教程和物理样例大量使用） |
| .sdprefabmodel、.sdhull（凸包分解） | ▶（P2，VHACD 已在 stride-tools） |
| .sdnavmesh | ▶（P1） |
| .sdgfxcomp | ▶（P1、P2） |
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
| **P2 界面、声音、效果** | 矢量渲染的底座、UI 系统和 .sduipage、影子 DOM（选中复制、无障碍、输入法）、字体（字形轮廓和 MSDF）、音频、粒子、着色器系统（自定义效果、材质层、颜色树）、MSAA、渲染到纹理、Morph、触摸 | SpriteFonts、GameMenu、UIElementLink、UIParticles、SimpleAudio、ParticlesSample、JumpyJet、SpaceEscape、MaterialShader、CustomEffect、MorphTargets、FPS（含粒子）、教程 CSharpBeginner、CSharpIntermediate |
| **P3 编辑器** | 见第一节的编辑器表，矢量优先（SVG 图标、解析线的 Gizmo 和网格、SVG 资源导入） | 用编辑器打开 P1、P2 的每个游戏，改场景和属性后能保存、播放；用编辑器从零搭一个小游戏 |
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
   - P2 补：场景选择和说明的 UI、调试文字的渲染（现在用 `stride call scene`、`stride call debug-text`）。P4 补：环境光遮蔽、屏幕空间反射（样例的合成器开着）。遗留：接触的软度不映射（见 decisions.md）；重叠测试（BepuSimulation.Overlap）还没有；点光和聚光的阴影、分簇。
6. 接着做 **Platformer2D**，然后按第三节的 P1 游戏顺序：TopDownRPG → FirstPersonShooter。

