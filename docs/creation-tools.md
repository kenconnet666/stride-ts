# 资源创作工具调研（2026-11-21）

用户 2026-11-21：做一站式创作工作台，"适当搜索一些资源的创作工具什么样，有哪些功能，完善路线图"。这里按创作的元素列出业界的工具、它们的要点功能、我们拿什么、不做什么。结论落在 [roadmap.md](roadmap.md) 第二节的"一站式创作工作台还缺什么"和第三节的创作线 S1–S5。资料是 2026 年的公开页面（厂商文档、发布说明、评测），厂商自述的能力没有逐项验证。

共同的取舍原则：

- **编辑器里能做完一件作品要的全部，但每类工具只做到"够做 3A 风格的游戏和短片"**：精细的专业工作（高模雕刻、电影级的流体、专业混音）靠导入外部工具的结果或接 AI 生成，不在编辑器里重造一个 ZBrush、Houdini、Resolve。
- **能程序化的就程序化**：节点图、参数、规则生成的资源小、能改、能被 agent 调参数，和"资源尽量矢量化"（vector-assets.md）一个方向。
- **一套节点图框架**：材质、贴图、特效、程序化摆放、地形、可视化逻辑共用一个节点图编辑器和求值器（虚幻是材质、Niagara、PCG、Blueprint 各一套，我们合成一套）。
- **人和 agent 一条路**：每个工具的操作都落成资源文件的修改或场景文档的修改，带撤销；参数有字段描述，agent 能直接调。
- **工具的结果马上在视口里看到**（热重载）；改了参数不用"导出、重新导入"。

## 材质和贴图

| 工具 | 要点功能 |
|---|---|
| Substance 3D Designer 16 | 节点图做程序化材质（生成器、滤镜、混合）；SDF 形状、3D 形状散布（Shape Splatter）；OpenPBR；输出成套贴图 |
| Substance 3D Painter 12 | 在模型上直接画：图层栈（填充层、绘制层、遮罩、生成器、滤镜）、智能材质（带磨损、污垢规则的预设）、投影绘制、按模型的曲率和 AO 烘焙生成遮罩、实际尺寸的置换；和 ZBrush 一步联通 |
| ArmorPaint 1.0（开源，zlib） | 实时视口里在模型上画；节点式的材质编辑器（生成器、滤镜、映射）；画笔本身也是节点图；节点预览、折叠、改名 |
| Material Maker（开源，MIT，基于 Godot） | 程序化材质节点图加 3D 绘制；画笔用同一套节点；社区库共享材质、画笔、节点 |

我们要的：

1. 材质的属性面板（基础色、金属度、粗糙度、自发光、贴图槽）——C1 在做。
2. 材质节点图：和导入的颜色树同一种数据，节点有生成器（噪声、图案、SDF 形状、渐变）、滤镜（模糊、扭曲、色阶、法线从高度）、混合、映射（三平面、UV 变换）；每个节点有预览；输出直接是材质的各个槽，不烘焙也能用（在着色器里求值），需要时烘成贴图页（vector-assets.md 的"按页求值"）。
3. 在模型上直接画：图层栈（填充、绘制、遮罩），画笔是节点图，按曲率、AO、朝向自动生成遮罩，"智能材质"就是带遮罩规则的图层组预设；投影绘制。
4. 材质库：带缩略图的预设（金属、木头、石头、布……），拖到实体上就用上（2026-11-21 做了，和特效库一起，见 decisions.md 的"材质库和特效库"）。

不做：Substance 级别的大量烘焙器、扫描材质的处理（Sampler）；需要时导入。

## 模型

| 工具 | 要点功能 |
|---|---|
| 虚幻的 Modeling Mode | 在编辑器里建模：CubeGrid（按网格搭方块做白盒）、Extrude Polygon / Extrude Path、Boolean（加减）、PolyCut（用挤出的多边形切）、拓扑编辑、AutoUV（自动展开和打包）、多材质、碰撞体编辑、贴图烘焙；工具先预览，确认（Accept）或取消才落到网格上 |
| Unity ProBuilder | 关卡白盒：点线面选择、挤出、倒角、合并、UV 编辑 |
| Womp、Spline、Vectary（浏览器里的） | Womp：基本形状加"液态"混合（SDF 的平滑并、差）做出圆润的造型；Spline：交互式 3D 场景；Vectary：建模加渲染加 AR |
| Nomad Sculpt、SculptGL | 雕刻：笔刷（拉、推、平滑、褶皱）、遮罩、对称、动态细分 |

我们要的：

1. 关卡白盒（S2 的第一件）：网格上搭方块、挤出多边形、布尔、切割、自动 UV，工具先预览、确认才写进模型；结果是 JSON 写的模型加编辑历史（能回到参数改）。
2. SDF 建模（Womp 式）：基本形状的平滑并、差、交，参数化，生成网格；圆润的道具、角色的粗形很快。
3. 轻量的多边形编辑：点线面选择、挤出、倒角、合并、切割、对称。
4. 雕刻放最后（D20）；精细模型导入（glTF、FBX）或 AI 生成。

## 地形

| 工具 | 要点功能 |
|---|---|
| Gaea | 节点图做地形；水力侵蚀分成沉积、冲沟、碎石三部分单独控制；Directed Erosion（雕刻和程序结合，指定哪里侵蚀）；生物群落的分区图导出（一张总图或每个分区一张遮罩）；32 位高度图 |
| World Creator 2025 | GPU 上实时生成；侵蚀和沉积是滤镜；生物群落分布导出 2D 图；导入高度图盖印到地形上 |
| 虚幻 5 的地形 | 雕刻、刷图层、样条改地形 |

我们要的（P6，编辑器的工具和运行时一起做）：地形的节点图（噪声、侵蚀、热侵蚀、平台化、遮罩），GPU 上求值，改参数马上在视口里看到；侵蚀分项控制；生物群落的分区图驱动材质层和植被；雕刻和刷层；导入高度图。

## 植被和程序化摆放

| 工具 | 要点功能 |
|---|---|
| SpeedTree | 程序化生成树（按"带引导的随机值"，一棵树随机出很多变种）加手工修；风（顶点着色器，多层的风）；LOD 一直降到一张公告牌；离线工具，游戏里不实时生成 |
| 虚幻 5 的 PCG 框架 | 节点图做程序化内容（采样点、过滤、按规则摆放）；GPU 上执行；形状语法（Shape Grammar）做建筑；程序化植被编辑器（Nanite 的植被） |
| Houdini（HDA 进虚幻的 PCG 图） | 节点网络做工具，生成几何、曲线、地形、骨骼网格 |

我们要的：树和植物的程序化生成器（枝干的分支规则、叶子、季节，随机种子出变种，带风的顶点数据和到公告牌的 LOD）；程序化摆放的节点图（P6：按地形的坡度、高度、生物群落、密度图撒点，规则在编辑器里画）；形状语法做建筑立面和街区（P6、P8）。

## 角色

| 工具 | 要点功能 |
|---|---|
| MetaHuman Creator | 选底子、混合几个脸、细调五官、加衣服和头发；全套的面部绑定；主要为虚幻用 |
| Character Creator 4（Reallusion） | 体型和脸的形变滑条；SkinGen 皮肤；头发库、自动贴合；AccuRIG 自动绑骨；和 iClone 做动画；能把头导进 MetaHuman |
| VRoid Studio | 动漫风格的人：滑条调脸和体型，头发用笔画出来（发束），服装模板 |
| Mixamo、AccuRIG | 上传模型自动绑骨和蒙皮权重；配动作库 |

我们要的（S4）：参数化角色（体型、脸用形变滑条，骨骼按比例缩放，皮肤、眼睛、牙齿的材质参数）；发型（先发片的模板库，VRoid 式用笔画发束；发丝在 P9）；服装模板（跟着体型的形变走，换装）；自动绑骨和权重（照 AccuRIG、Mixamo 的流程：标关键点，算骨骼和权重）；表情集（ARKit 52 个形变命名，和面部捕捉、口型对上）。写实的扫描级人脸不做，导入。

## 动画

| 工具 | 要点功能 |
|---|---|
| Cascadeur 2026 | AutoPosing（拖几个关键点，AI 补全整个姿势）；AI 中间帧（关键姿势之间自动生成动作，可以拿已有动画当风格参考）；AutoPhysics（把关键帧动画修成物理合理的）；动画层（叠加）；缓动曲线；BVH、FBX、USD |
| 虚幻的 Sequencer、控制绑定 | 时间轴上关键帧、曲线编辑器、IK 控制器在视口里拖 |
| NVIDIA Audio2Face（2025 开源模型和 SDK） | 从语音生成口型和面部动画（回归模型、扩散模型），Audio2Emotion 从语音推断情绪 |
| Rhubarb Lip Sync（开源） | 从语音分析出口型（几种标准口型）的时间表 |

我们要的：时间轴上的关键帧和曲线编辑器（S1）；视口里摆姿势（IK 控制器、对称）；动画层；动作库和重定向；AI 补间、自动姿势、视频动捕、语音驱动口型都走"AI 辅助"的接口（D21），开源模型能在浏览器里跑的（WebGPU 推理）优先本地跑；不能的走服务。

## 特效

| 工具 | 要点功能 |
|---|---|
| 虚幻的 Niagara | 模块化的粒子图（发射器、生成、更新、渲染的模块，参数可以接曲线和其他参数）；流体（Niagara Fluids）；Flipbook Baker：把任何特效烘成一张序列帧图集 |
| EmberGen（JangaFX） | 实时的体积流体模拟（火、烟、爆炸）；几秒生成游戏能用的序列帧图集，导出 VDB、图像序列、Alembic 粒子 |

我们要的：粒子图编辑器（现在的粒子模块按 JSON 改 → 模块的增删、参数接曲线和颜色渐变、实时预览）；特效预设库；序列帧烘焙（把任何特效或体积模拟烘成图集，GPU 粒子用）；小规模的体积流体模拟（GPU 上的烟火，烘成序列帧或体积贴图）放在后面。

## 镜头、分镜、剪辑、后期

| 工具 | 要点功能 |
|---|---|
| Storyboarder（开源） | 几种简单的画笔快速画分镜；可以打印分镜纸、手绘后拍照导回；导出动态分镜（animatic） |
| DaVinci Resolve | 精确到帧的剪辑、调色（节点式）、Fairlight 混音、字幕 |
| CapCut | 手机和网页上的快速剪辑：拖、剪、配乐、自动字幕、模板，面向短视频平台 |

我们要的（S1、S3）：分镜（视口截图或矢量画笔画的格子，排在时间轴上就是动态分镜，后面逐个换成真的镜头）；剪辑（多镜头、转场、按镜头调色、LUT）；自动字幕（语音转文字走 AI 接口）；短视频模板（9:16、片头片尾、配乐卡点）。专业调色和混音不做，导出图像序列和分轨音频交给外部。

## 声音

| 工具 | 要点功能 |
|---|---|
| Wwise | 事件、RTPC（游戏参数驱动音量音高效果）、状态和开关、混音总线；Meter 插件把音量回传给游戏（能驱动简单的口型） |
| sfxr、jsfxr、bfxr | 程序化生成复古音效：按类别（拾取、爆炸、跳跃、受击）随机参数，波形、包络、扫频 |
| AI 音乐和语音（Suno、Eleven Music、各家 TTS） | 文字生成配乐、对白语音；循环长度、商用许可证各家不同 |

我们要的：音效生成器（sfxr 式，参数化、几个字节存下、编辑器里点一下试听；2026-11-21 做了，见 decisions.md 的"音效生成器"）；P7 的事件、参数、状态的数据模型（Wwise 式）；时间轴的音轨和混音（S1）；配乐、对白走 AI 接口，记来源和许可证。

## AI 生成

| 工具 | 要点功能 |
|---|---|
| Tripo、Meshy、Rodin、Meta 3D Gen | 文字、图片生成模型，AI 贴图、自动绑骨、动作；结果的拓扑和质量不稳定，要人修；商用许可看套餐 |

我们要的：D21 的接口（工程里配服务或本地模型），结果当普通资源导入后能继续在编辑器里编辑（重新拓扑、换材质、绑骨），记来源、提示词、许可证。

## 资料

- Adobe Substance 3D（2026-05 的新功能，2026-07 的 SIGGRAPH 更新：Designer 16、Painter 12、OpenPBR）：https://blog.adobe.com/en/publish/2026/05/20/faster-workflows-precise-creative-control-more-connected-3d-pipeline-whats-new-substance-3d ，https://blog.adobe.com/en/publish/2026/07/21/adobe-substance-3d-unveils-new-innovations-deliver-faster-workflows-openpbr-everywhere-digital-twins-scale
- ArmorPaint 1.0：https://www.cgchannel.com/2026/09/armorpaint-1-0-is-out-after-eight-years-in-early-access/ ；Material Maker：https://www.linuxlinks.com/material-maker-procedural-texture-authoring-3d-painting-tool/
- 虚幻的建模工具：https://dev.epicgames.com/documentation/en-us/unreal-engine/modeling-tools-in-unreal-engine ；ProBuilder：https://docs.unity3d.com/Packages/com.unity.probuilder@6.0/manual/workflow-edit-tasks.html
- 浏览器里的建模工具：https://www.creativebloq.com/3d/3d-software/the-best-web-browser-3d-modelling-apps-3d-sketch-online-and-more-for-free ，https://www.hackdesign.org/toolkit/womp/
- Gaea：https://quadspinner.com/Gaea/Features ；World Creator：https://www.world-creator.com/features.html
- SpeedTree：https://unity.com/products/speedtree ，https://docs.unity3d.com/speedtree-runtime-sdk/manual/level-of-detail.html ；虚幻 PCG：https://dev.epicgames.com/documentation/en-us/unreal-engine/procedural-content-generation-framework-in-unreal-engine ；Houdini 进 PCG：https://www.sidefx.com/docs/houdini/unreal/pcg/overview.html
- Character Creator 和 MetaHuman：https://www.reallusion.com/character-creator/metahuman
- Cascadeur 2026：https://cascadeur.com/blog/view/cascadeur-2026-2-animation-layers-easing-new-languages ，https://digitalproduction.com/2026/04/09/cascadeur-2026-1-adds-unreal-live-link-filament-rendering-and-ai-root-motion/
- Audio2Face 开源：https://developer.nvidia.com/blog/nvidia-open-sources-audio2face-animation-model
- Niagara 的序列帧烘焙：https://dev.epicgames.com/documentation/en-us/unreal-engine/niagara-flipbook-baker-quick-start-guide-in-unreal-engine ；EmberGen：https://jangafx.com/software/embergen
- Storyboarder：https://wonderunit.com/storyboarder/ ；CapCut 和 Resolve 的对比：https://www.selecthub.com/video-editing-software/capcut-vs-davinci-resolve/
- AI 音乐、语音：https://accelerator.xsolla.com/blog/voice-and-music-generation-ai-tools ；AI 生成模型：https://medium.com/ideas-with-wings/best-ai-3d-model-generators-in-2026-tripo-ai-vs-meshy-rodin-kaedim-and-more-7eea7b05eb11
- 虚幻的成片渲染：https://dev.epicgames.com/documentation/en-us/unreal-engine/movie-render-pipeline-in-unreal-engine ；WebCodecs：https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API
