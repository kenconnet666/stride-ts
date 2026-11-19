# 路线图（2026-11-19 定稿，无人值守执行中）

目的：做一个比 Stride 更好的引擎（用户 2026-11-19 把目标从"对齐 Stride"改成"比 Stride 做得更好"），范围一次定下来，之后无人值守地持续执行，用复刻开源游戏来验证。本文件列出 Stride 的全部内容、超出 Stride 要加的功能、每项做不做、按什么顺序做、怎样算完成；取舍见第四节，2026-11-19 全部按推荐定下，执行中的决定记在 docs/decisions.md。

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
- **目标是比 Stride 做得更好，对齐只是底线**（用户 2026-11-19）：
  - Stride 有的功能，画面要能逐像素对上（有意的偏差除外）；截图比对是用来找我们的错的，不是要把 Stride 的毛病也复刻出来。
  - 每做一项都问两个问题：Stride 在这里哪里做得不好（bug、怪癖、帧率相关、单位不一致、API 难用、慢），我们就改好；我们哪里比 Stride 差（"只支持某种情况"这类限制），就补到不差。留着"比 Stride 差"的限制不算完成。
  - 改之前把受影响的情况想全；有意的偏差在代码里注明"和 Stride 不同：……"，在 docs/decisions.md 记一条。
  - 超出 Stride 的功能用"质量档"开关，对齐模式下关掉。
- **边做边整理**（用户 2026-11-19）：文档和代码的整理是持续执行的一部分，不留到最后。文档只留结论（被取代的决定改写原条目，不留互相矛盾的两条；"进度"每项写结论，细节放 docs/architecture.md、docs/decisions.md 和各工具的 README）；代码按第五节的"代码质量"整理。

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

- **任务队列**：`docs/roadmap.md` 的阶段表是唯一的计划，进度写在本节下面的"进度"里。正在做的那一项写分步的计划；做完后在"已完成"的表里留一行结论（验收结果、没做完的），过程挪到 docs/progress-log.md。
- **每个游戏的流程**：
  1. 导入，列出不认识的组件和资源（导入器会计数）；
  2. 按缺口补运行时，每补一项写单测；
  3. 翻译脚本；
  4. 用桌面 Stride 截参考图；
  5. 写通关脚本；
  6. 比对，修到达标；
  7. 回头看一遍：比 Stride 差的限制补掉，Stride 的毛病不跟（见"原则"）；
  8. 记录、提交、推送。
- **长任务**：构建、测试在后台跑；等的时候读源码、写下一步。
- **自检**：每完成一个游戏，所有已完成游戏的通关脚本和截图比对全部重跑一遍（回归），不过就先修。
- **性能数字**：一律记相对桌面 Stride 的倍数，附带绝对值和电源模式。
- **代码质量**（用户 2026-11-19 强调）：注释用中文，只写不直观的"为什么"；每完成一个游戏或一个阶段就整理一次：文件放进职责明确的文件夹，函数和类的分工理顺，合并重复，删掉没人用的代码。整理和功能改动分开提交。

## 进度

定时续跑：会话里有一个每 15 分钟触发的定时任务（CronCreate，2026-11-19 建，7 天后过期，到期前由 agent 重建），提示词让 agent 读这一节接着做。

这一节只留结论和没做完的事；已完成各项的过程（每一步做了什么、比对时修掉了什么）在 [progress-log.md](progress-log.md)。

### 已完成

每个样例都有 `import:stride`（从 Stride 仓库导入）和 `smoke`（冒烟脚本），`pwsh tools/regress.ps1` 全部跑一遍。截图差是和桌面 Stride 比的平均每通道差（/255），做法和逐张的结果在 `tools/stride-capture/<样例>/README.md`。P1 那张表里的数当时是按"每个像素取差最大的通道"算的（偏大），而且是修正泛光权重（2026-11-19）之前截的，重截时更新。

**P1 运行时补齐 3D 游戏的基础**（2026-11-19 完成）：场景脚本导入、骨骼动画，加七个样例。导入、构建、下载量、启动和帧时间的验收数字（帧时间是桌面 Stride 的 0.47 到 0.97 倍）在 progress-log.md 的"P1 收尾"。

| 样例 | 应用（端口） | 截图差 | 没做完的 |
|---|---|---|---|
| ThirdPersonPlatformer | `apps/platformer`（5184） | ≤ 1 | |
| AnimatedModel | `apps/animated-model`（5186） | 0.083 | UI 的 Idle、Run 按钮（现在用调试命令）；画进渲染目标贴图的相机不用阴影、不做后处理 |
| PhysicsSample | `apps/physics-sample`（5188） | 0.13 到 1.32 | 各场景的 UI 文字和按钮（现在用调试命令）；透明物体不投阴影、同一批的透明实例不排序 |
| BepuSample | `apps/bepu-sample`（5190） | 0.37 到 1.11 | |
| Platformer2D | `apps/platformer2d`（5192） | 2.17（Stride 把精灵表压成 BC） | 拿金币的音效；九宫格的精灵边框 |
| TopDownRPG | `apps/topdown-rpg`（5194） | 2.45（BC 压缩） | 粒子特效、音乐和音效；RecastNavigationComponent 的排队寻路和直接移动；场景的父子层级 |
| FirstPersonShooter | `apps/first-person-shooter`（5196） | 2.70 | |

**P2 界面、声音、效果**（进行中）：

| 样例 | 应用（端口） | 做了什么 | 截图差 | 没做完的 |
|---|---|---|---|---|
| SpriteFonts | `apps/sprite-fonts`（5198） | 矢量文字（Slug）、SpriteBatch、字体导入 | 0.21 到 0.97（六屏），对齐 2.65、抗锯齿 4.80（hinting） | UI 文字的换行和富文本、世界空间的文字（MSDF）、点存成 f16 |
| GameMenu | `apps/game-menu`（5200） | UI 系统：导入、布局、渲染、输入 | 3.5 到 4.6（BC 压缩、hinting） | 输入框以外的无障碍树、按键的路由事件、没用到的控件（ToggleButton 等） |
| UIElementLink | `apps/ui-element-link`（5202） | 放在 3D 里的 UI、实体跟着 UI 元素走 | 4.46 到 6.81（Stride 的 UI 被色调映射，见 decisions.md） | 场景里烟的粒子（现在有粒子系统了，重新导入、比对） |
| UIParticles | `apps/ui-particles`（5204） | 粒子系统（CPU 模拟）、粒子画在 UI 上面 | 4.65、4.68 | |
| SimpleAudio | `apps/simple-audio`（5206） | 声音（Web Audio） | 1.53 | |
| ParticlesSample | `apps/particles-sample`（5208） | 曲线、飘带和拖尾、子粒子、自定义模块和材质 | 0.70 到 2.09（七个场景） | |
| JumpyJet | `apps/jumpy-jet`（5210） | 游戏自己的渲染器、形状重叠查询 | 2.53、3.54（BC 压缩） | |
| SpaceEscape | `apps/space-escape`（5212） | 网格效果（自定义着色器）、场景模板 | 2.04、3.45 | |
| MaterialShader | `apps/material-shader`（5214） | 材质的法线树和位移树、游戏的着色器类 | 0.24 | |
| CustomEffect | `apps/custom-effect`（5216） | SpriteBatch 的自定义效果 | 0.43 | |
| MorphTargets | `apps/morph-targets`（5218） | 形变目标（原生 0.27.0）、Slider、Border | 3.88（UI 的色调映射） | |
| FPS 的粒子和材质层 | `apps/first-person-shooter` | SpawnerBurst、SpawnerFromDistance、材质层 | 2.70 | |

### 正在做和下一步

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
      - 桌面比对还没做：截图工程搭了一半（`tools/stride-capture/csharp-intermediate`，还没提交）。样例要 Stride.BepuPhysics.Navigation，只有本机编的 4.5.3-dev4 有这个包，而那一版的资源编译器编天空盒时要 `STRIDE_WEBGPU_NATIVE_LIBRARY`（见 stride-webprobe3 的 build/wgpu/README.md），设好再编。
