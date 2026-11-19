# 决定记录

无人值守执行路线图（docs/roadmap.md）时自己做的决定，按时间倒序。每条写：决定了什么、为什么、考虑过的别的做法、影响到哪里。路线图的范围和 D10 里"停下来问"的事不在这里定，要问用户。

## 2026-11-19 SimpleAudio：声音

- **用 Web Audio，源文件原样用**：浏览器自己解 mp3、ogg、wav（D9 的 (c)），不转码、不带解码器。不流式的声音整个解码成 AudioBuffer（音效：开始得快，能同时放很多个）；流式的（StreamFromDisk，音乐）每个实例一个 `<audio>` 元素边下边放，经过 MediaElementAudioSourceNode 接到同一个主音量。没选 AudioWorklet 加 wasm 解码：浏览器已经会解这些格式。
- **浏览器要用户先操作才出声**：Chrome、Safari 的自动播放策略让 AudioContext 在用户点击、按键之前挂起。和 Stride 不同（桌面一启动就有声音）：之前开始放的声音状态是 Playing，恢复出声后从头接着放（AudioContext 挂起时时间不走）。Game 在窗口上监听第一次点击、按键，恢复出声。
- **SoundInstance 的语义照 Stride**：Play 在放时什么也不做、Pause 只在放时有效、Stop 回到开头、没循环的放完 PlayState 自己变回 Stopped；Pitch 是播放速度，音高跟着变（`<audio>` 关掉 preservesPitch）。空间化的声音没有 AudioEmitter 时按 2D 放（同 Stride）；AudioEmitter、AudioListener 等用到的样例再做。

## 2026-11-19 UIParticles：粒子系统

- **粒子在 CPU 上模拟，照 Stride 的算法**：Stride 的粒子系统是 CPU 上的（每个发射器一个粒子池，生成器、初始化器、更新器），样例的粒子数在几百到几千，用 JS 的类型化数组按字段分列存足够快，以后数量大的效果再考虑放进原生侧或 GPU 计算。随机数、每帧的顺序、生成器的状态机都照 Stride，固定种子（RandomSeedMethod: Fixed）时结果和桌面一样（RandomSeed 和 .NET 算的逐位对上）；默认的按时间取种子两边本来就对不上。
- **场景按 Stride 的对象树原样导入**：粒子系统由几十种模块组成，导入成 `ParticleModuleFile`（类型名、属性名首字母小写，没写的属性运行时取 Stride 的默认值），运行时按 `$type` 建模块；导入器只留下运行时认识的类型，其余警告后去掉。加新模块只要在两边各加一项。
- **力场的衰减改掉 Stride 的毛病**：Stride 的 FieldFalloff 在 FalloffStart 到 FalloffEnd 之间除以 FalloffEnd / FalloffStart（应该是两者的差），过渡区里力几乎不变、到 FalloffEnd 时突然跳到 StrengthOutside。我们线性过渡。影响：UIParticles 的彩纸在力场的边缘附近受力和 Stride 不一样（Stride 的更强）。
- **组件的 Control 不导入运行时**：ParticleSystemComponent 的 Control（ResetSeconds、Play/Pause/Stop）在 Stride 里只在编辑器和预览里起作用（ParticleSystemSimulationProcessor 的 applyEditorControl），游戏运行时粒子系统一直在播。我们照运行时的行为。
- **统一缩放取世界矩阵 X 轴的长度**：Stride 把实体和所有父实体本地缩放的 X 乘起来（父实体转了角度时和世界矩阵不一样）；统一缩放时两者相同，我们直接从世界矩阵取。

## 2026-11-19 UIElementLink：放在 3D 里的 UI；跟着 UI 元素走

- **放在 3D 里的 UI 也画在后处理之后**（和桌面比对时量到的代价见 `tools/stride-capture/ui-element-link`：这个样例的场景很暗，Stride 的自动曝光把 UI 提亮很多，量平均亮度时也算上了 UI；我们的 UI 是原色，场景的曝光只看场景）：Stride 在透明阶段里画，会被色调映射、泛光、FXAA 处理；我们和全屏 UI 一样画在后处理之后（UI 的颜色照原样），另外和场景的深度缓冲比较，被更近的物体挡住。为此前向渲染器在场景里有 UI 时把主画面的深度缓冲留下来（`depthStoreOp: 'store'`，平时 `discard`，分块渲染的 GPU 上省带宽）。代价：斜着的 UI 的边没有 FXAA。没选在透明阶段里画：那样 UI 的颜色被色调映射改掉，和全屏 UI 不一致。
- **放在 3D 里的 UI 不把文字对齐到像素，布局按虚拟像素**：Stride 按投影估计 真实 / 虚拟 的比例（RealVirtualResolutionRatio），相机一动比例就变，文字每帧重新排版；只有面向相机且固定大小时才对齐像素。我们的字是矢量的，排版不随比例变，所以比例当 1、从不对齐（对齐在透视下也没有意义）；投影估计的比例只给文字的抗锯齿边留宽度（`SpriteBatch.pixelRatio`）。
- **UIElementLink 先布局再算**：Stride 的 UI 在画的时候才布局，UIElementTransformLink 用的是上一帧的元素位置，跟着走的实体晚一帧（按钮移动时骑士落后一点）。我们在 UIElementLink 系统里（变换更新之前）先布局这一帧的 UI（`game.ui.layout`，画的时候不再重复），跟着走的实体这一帧就对齐。没有 UIElementLink 的游戏仍在画之前布局，不受影响。面向相机的 UI 的朝向用上一帧画的时候的相机（相机的世界矩阵这时还没更新）。
- **面向相机的 UI 按实际画它的相机算朝向**：Stride 的 UIElementLinkComponent 要另外设 Camera，没设或设的不是画 UI 的相机时，跟着走的实体和 UI 的朝向对不上；我们用画 UI 的主相机，组件上的 Camera 导入但不用。
- **画布的大小在帧开头跟上窗口**：以前在画之前才调，启动的第一帧里脚本读到的是画布的默认大小 300x150（SplashScript 按它摆角上的按钮）；现在启动时和每帧开头调，这一帧的脚本和绘制看到的一样大（Stride 的后备缓冲在游戏开始前就建好了）。

## 2026-11-19 GameMenu：UI 只做两维的布局、画在最后；贴图按预乘 alpha 用

- **布局只做两维**：Stride 的 UI 布局是三维的（每个元素有 Depth、MinimumDepth、MaximumDepth、DepthAlignment，Margin 有 Front、Back，Grid 有层 LayerDefinitions），为了把 UI 放进 3D 场景时有厚度。实际用法里深度一直是默认值：GameMenu、UIElementLink、UIParticles 的页面没有一个元素设了深度（WelcomePopup 的 DepthAlignment: Stretch 在两维里没有意义）。3D 里的 UI 由 UIComponent 的世界矩阵和 Size 摆放，不靠深度布局。只做两维，每个元素的布局计算和存储少三分之一，代码更好读。导入时深度方向的属性和 Grid 的层直接不导入（不警告：它们在两维里没有对应）。代价：真要做有厚度的 3D UI（层叠的面板）时要补，目前没有样例用到。
- **UI 资源平铺成元素数组**（`UIFile`，`.ui.json`）：元素按 Hierarchy.Parts 的顺序放进数组，Children、Content 的 `ref!!` 引用换成下标；属性名首字母小写，值换成 JSON（颜色是 0 到 1 的 sRGB，Thickness 是四元数组，NaN 是 null，枚举是首字母小写的名字）。UI 库的实例（带 Base 的元素）在 Stride 的文件里已经是完整的属性，导入时不去合并 UI 库。页面和库同一种文件，库多一个 `templates`（名字 → 元素）。
- **贴图按预乘 alpha 用**：Stride 编译颜色贴图（包括精灵表）时预乘 alpha（ColorTextureType.PremultiplyAlpha 默认开；DirectXTex 对 sRGB 格式在线性空间乘，等于采样后的 rgb 乘 a），画精灵、UI、SpriteBatch 都按预乘混合。我们的贴图存直通 alpha，以前直接按预乘混合，半透明的边会发亮（Platformer2D 的精灵边、UI 的圆角框）。现在精灵、SpriteBatch（UI 用它画）的着色器采样后乘 alpha，结果和 Stride 一样（差 8 位量化；Stride 的 mip 在预乘之后生成，我们在之前，只影响有 mip 的半透明贴图）。设成 PremultiplyAlpha: false 的贴图画成精灵、UI 时也按预乘画（不支持）；网格的贴图不受影响。别的做法：导入时预乘——KTX2 可以在编码前乘，但原样复制的 PNG 只能在运行时让浏览器乘，两条路径；着色器里乘一次最简单。
- **UI 画在整个画面之后**：Stride 的 UI 在前向渲染器的透明阶段里画（会被泛光、色调映射处理，也会被 3D 物体的深度挡住），我们画在后处理之后、调试文字之前。全屏 UI 本来就清了深度，区别只在后处理：UI 的颜色照原样显示，这是想要的。（放在 3D 里的 UI 见上面 UIElementLink 一节。）
- **UI 的裁剪用剪裁矩形**：Stride 的 ClipToBounds 用模板缓冲，按元素本身的形状（可以转角度）裁；我们用元素在屏幕上的包围盒做剪裁矩形，不用模板缓冲、不打断合批。转了角度的元素裁到包围盒；样例里裁剪的都是 ScrollViewer，不转。
- **EditText 的文字区域按内边距放**：Stride 把文字区域（元素减去内边距）放在元素中心，左右或上下内边距不一样时文字偏了（GameMenu 的名字输入框上 30、下 40，文字高了 5 像素）；我们放在内边距里面。
- **UI 输入照 Stride master 的占用**：Stride 4.4.2 没有输入的占用（UI 和脚本都看到同样的输入），master 上加了（InputManager.MaskCapturedInput、InputCaptureMonitor 样例），我们照 master 做：GameMenu 的脚本本来就是 master 版的。按键的屏蔽照 ButtonCaptureTracker，脚本不会看到没有按下的松开、没有松开的按下。
- **EditText 用浏览器的输入框编辑**：Stride 桌面版自己解释按键（方向键、Home、End、退格），没有复制粘贴和撤销，输入法靠系统的 TextInput。我们在激活的 EditText 后面放一个看不见的 `<input>`（多行时 `<textarea>`），键盘、输入法、选中、复制粘贴、撤销都是浏览器的，行为和网页上的输入框一样；输入框摆在 EditText 的位置，输入法的候选窗在字旁边，读屏软件读得到。Enter、Esc 结束编辑同 Stride（多行时 Shift+Enter 换行，多做的）；编辑时点画布的别处不结束编辑（同 Stride 桌面版，挡掉画布的 mousedown 默认行为）。
- **滚轮滚动 ScrollViewer**（多做的）：Stride 桌面版的 UI 不处理鼠标滚轮，ScrollViewer 只能拖。鼠标在 ScrollViewer（或它里面的元素）上时滚轮滚动它，一格 50 个虚拟像素；鼠标被 UI 占着，脚本看不到这次滚轮。
- **OutsideClick 按弹窗的矩形判断**：Stride 拿相对弹窗中心的位置和 [0, 大小] 比，点在弹窗的左半边、上半边也算外面；我们按矩形判断。
- **每帧只提交一次命令**：场景（ForwardRenderer）、UI、调试文字以前各建一个命令编码器、各提交一次；现在都录进 `GraphicsDevice.frameEncoder`，Game 在帧末提交一次（GPU 计时的查询也在这里解析），后备缓冲的视图每帧只建一次。GameMenu 的启动页 0.57 → 0.43 ms（桌面 Stride 0.52 ms）。约束：`queue.writeBuffer` 在提交之前就写好，同一个缓冲一帧只能写一份，所以每个 UI 有自己的 SpriteBatch。游戏自己的根渲染器（SpriteFonts 的 FontRenderer）照旧可以自己提交。
- **调试文字按左上角摆**：Stride 的 FastTextRenderer 每个字以给的位置为中心，整段字向左上偏半个字（4、8 像素）；我们按给的位置当左上角。字体用 Stride 自带的 8x16 位图（嵌在引擎里，5.8 KB），颜色同 Stride（LightGreen 当线性颜色用）。
- **键名的缩写整个小写**：脚本属性和 UI 属性的键名以前只把第一个字母改小写，`UILibrary` 变成 `uILibrary`；现在开头的缩写整个小写（`uiLibrary`、`imeSelectionColor`），后面的单词不变。已有的样例里只有 GameMenu 有这样的键。

## 2026-11-19 SpriteFonts：文字按轮廓画（Slug）；排版改掉 Stride 的两处毛病；合成器的游戏渲染器

- **算法用 Slug**（Eric Lengyel，JCGT 2017）：每个像素对字形轮廓（二次贝塞尔）做横竖两条射线，按交点算覆盖率，带分块限制每个像素要看的曲线数。选它是因为数值上最稳（根的取舍按控制点的符号查表，没有浮点误差导致的漏点），2026-03-17 专利已捐给公有领域，参考着色器 MIT/Apache（要署名，见 README 的"许可证"）。考虑过 Dobbie 的网格法（精度问题多）、Loop-Blinn（要三角化轮廓）、MSDF（缩放到很大时角会圆，D16 定它只给世界空间的字）。字形在 CPU 上按真实像素外扩一个像素（SpriteBatch 只有平移、旋转、缩放，用不着参考顶点着色器那套按投影矩阵的动态外扩）。
- **运行时字体导入全部字形、按码位块下载**：Stride 的运行时字体带着整个字体文件，用到哪个字栅格化哪个；我们导入时把所有字形转成轮廓，按码位块（码位 >> 8）分文件，运行时用到哪块下载哪块。日文字体总共 118 MB，一屏文字只用到十几块。以后可以把点存成 f16 再减半。
- **系统字体**：照 Stride 在系统字体目录里按家族名（名字表的 1 号或 16 号）和粗斜体找，找不到依次试度量兼容的替代并警告。字形轮廓会进游戏的内容（同 Stride 把栅格化的字形放进内容），字体的授权由用游戏的人负责。
- **排版照 Stride 的度量，但改掉两处毛病**（用户 2026-11-19：Stride 有问题时不跟随，做得更好）：
  - 字距：Stride 的两种字体都没有填 KerningMap，字距不生效；就算填了，GlyphEnumerator 也只挪这一个字、不推后面的字。我们按 kern 表做（同 FreeType 取整到像素），推后面所有的字。
  - drawString 的原点：Stride 把它当字体像素用，而调用方（比如 SpriteFonts 的动画）给的是 measureString 量出来的虚拟坐标，窗口和虚拟分辨率不一样大时旋转中心就偏了。我们的原点就是虚拟坐标。
  - 留着照 Stride 的：度量公式（行距、基线、LineGapFactor；编译期字体的度量不随字号变，OfflineRasterizedSpriteFont 重写了那几个方法）、前进宽度按栅格化的 ppem 取整、字体要求时 ppem 取整（head 表 flags 第 3 位，Arial 有；FreeType 开 hinting 时照做，字号 33.33 的字按 33 排、按 33 画）、位置和字的原点取整到真实像素、颜色当 sRGB、预乘混合。
  - 更正：起初以为 Stride 的编译期字体"字形不随字号变、行距却缩放"是第三处毛病，和桌面截图比对时发现是我们第一版漏看了 OfflineRasterizedSpriteFont 的重写，Stride 本身是一致的。
  - 后果：和桌面 Stride 的截图在用到字距、动画的旋转原点的地方有差，比对时记成有意的偏差。
- **排版加缓存**：Stride 每次 MeasureString、DrawString 都重新排；SpriteFonts 每帧把同样的几段字量好几遍再画，CPU 占了一帧的大半。`layoutText` 按字体、字号、对齐、文字缓存（每个字体最近 256 条，字体下载完新块或开关字距时作废），SpriteBatch 每个字直接写缓冲。对齐那屏 2.1 ms 降到 0.39 ms。
- **合成器的游戏渲染器**：Stride 的合成器的根（Game）可以是游戏程序集里的渲染器（SpriteFonts 的 FontRenderer 没有场景）。导入游戏设置（`--asset <包>/GameSettings`）时写出它的类型名和属性（同场景脚本的属性规则，引用的字体、贴图一起导入），运行时 `Game.loadGameSettings(path, { renderers })` 按类型名用游戏给的工厂建它、换掉 `rootRenderer`。用显式的工厂表而不是登记表：现在只有这一个，等第三次出现再考虑和脚本的登记表合并。脚本和渲染器属性引用的贴图另写一个 `.texture.json`（编码、尺寸、sRGB），`content.loadTextureAsset` 读。

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
