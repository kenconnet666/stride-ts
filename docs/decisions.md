# 决定记录

无人值守执行路线图（docs/roadmap.md）时自己做的决定，按时间倒序。每条写：决定了什么、为什么、考虑过的别的做法、影响到哪里。路线图的范围和 D10 里"停下来问"的事不在这里定，要问用户。

## 2026-11-19 导入的派生数据缓存

贴图编成 KTX2 是导入里最慢的一步，同一张贴图每次导入、每个用到它的样例都重编一遍（CSharpIntermediate 一次三分钟，全部样例重导十几分钟）。加了 `DerivedDataCache`（`packages/pipeline/src/cache.ts`）：键是"做法的名字和版本、像素、尺寸、选项"的 SHA-256，值存在 `~/.stride-ts/cache/pipeline`，各样例、各工作树共用；命令行默认打开，`--no-cache` 关掉；库里默认不缓存（测试不往用户目录写）。

- 按内容寻址：不会用到过期的结果，目录只增不减，随时可以整个删掉。换编码器或参数的含义时改做法的版本号（`BASIS_RECIPE`）。
- 现在只缓存贴图编码。别的步骤都在秒以内；团队共享的缓存（路线图 P10）到时在这个接口后面加一层远端。

## 2026-11-19 资源尽量矢量化（用户决定方向，格式还在讨论）

用户：我们和别的引擎不同，各种资源尽量做成矢量的，现成格式不够用可以自己设计，别的常见格式支持但不是默认。讨论后定下：

- "矢量"按广义：存生成方法（曲线、节点图、规则加种子），运行时按需要的精度现算并缓存。
- 照片级写实要同等可达：采样数据在每种格式里都是图的叶子节点，不是兼容用的后门。
- 几何先做实验再定默认的表示（路线图"进度"第 16 项）。

具体的格式方案写在 docs/vector-assets.md，是讨论稿：2D 矢量图（SVG 创作，运行时是 COLRv1 式的画法树加 Slug 条带，形状可以带材质通道）、材质（节点词汇照 MaterialX，加样本合成、矢量图、状态、频带信息、求值方式）、几何（基础网格加位移为首选的候选）、地形和摆放。里面标了四个要用户定的问题，定之前不动现有的格式。

## 2026-11-19 路线图：要有做 3A 开放世界的潜力；性能靠算法不靠降分辨率（用户决定）

用户要求修订路线图：引擎要有做 GTA 6、荒野大镖客 2、赛博朋克 2077 这一类游戏的潜力，并强调要做得更好，尤其是性能优化（不是降分辨率那种）。改动都在 docs/roadmap.md：

- **原则**加了两条：规模不设上限（世界大小、实体数量、内容体量、团队规模），性能靠少做、做得快、不卡顿，上采样和动态分辨率不计入达标。
- **第二节**加了"做 3A 开放世界还缺什么"：按十五个方面列出这类引擎的做法、我们已有的、要补的和阶段，另列 Web 上的硬限制和对策。参考只用公开资料（虚幻 5 的文档、GDC 和 SIGGRAPH 的报告）；RAGE 没有公开文档，GTA 6 的技术只有第三方对预告片的分析，文中都注明了。
- **阶段**：P4 开头加底座（渲染图、预算和统计、管线预热），P5 加辐射缓存和 ReSTIR 全局光照，P6 加世界分区、HLOD、全类型的流式加载、虚拟阴影贴图、水体、程序化工具，P7 加 motion matching、物理动画、事件式音频；新增 P8 世界模拟（人群和交通）、P9 角色和过场、P10 生产规模的工具和交付。原来推迟的贴图流式加载、次表面散射、头发、游戏内容的本地化、桌面壳改成要做。
- **我按推荐定的两条取舍**（用户可以改）：D17 原生宿主（同一套代码跑在自带 Dawn 的壳里，不另写渲染后端）；D18 大世界用双精度位置加相对相机渲染（P6 开头做，是数据模型的改动，动手前把方案和开销报给用户）。
- **验收**不是做出一个 3A 游戏，是技术演示级的切片：8 公里见方的野外、一万个行人和车辆的城市街区、一段近景对话的过场，帧时间预算按原生分辨率算。
- 对眼前工作的影响：P2 收尾照常做；导入器的派生数据缓存提前到 P2 收尾（这次比对里一张法线贴图每次导入都要编两分钟）。

## 2026-11-19 CSharpIntermediate：声音的发射器和听者；只改朝向；相机教程里 Stride 的毛病

- **发射器和听者做成引擎自带的脚本组件**（`AudioEmitterComponent`、`AudioListenerComponent`），场景里的同名组件导入成它们的属性。空间化用 Web Audio 的 PannerNode：距离模型 inverse、参考距离 1，和 Stride 在 Windows 上用的 X3DAudio 默认曲线一样（1 米以内不衰减，以外 1/距离）。听者的朝向是实体的 -Z：Stride 传给 X3DAudio 的是 +Z，X3DAudio 是左手系，左右算出来和我们一致。和 Stride 不同的地方：
  - 没标 Spatialized 的声音也能挂在发射器上放（不做空间化）；Stride 直接不让。
  - `directionalFactor` 起作用（正面是实体的 +Z，背面的音量 1 - 这个值，中间按角度过渡，用 PannerNode 的锥形近似心形）。Stride 的 XAudio2 后端把指向类型写死成全向，这个值没有效果；别的后端不看它。
  - `environment` 的混响是合成的（指数衰减的白噪声做冲激响应，混响时间小、中、大各 0.4、0.8、1.6 秒，自己定的），所有浏览器都有；Stride 用 Windows 的 HRTF 自带的房间模型，只在 Windows 上、只在 UseHRTF 时有。我们也只在 `useHRTF` 时加混响，免得同一个场景默认的 `Small` 让所有发射器都带上混响。
  - 不做多普勒和按距离的低通。X3DAudio 默认两样都算，但 Stride 传的速度是每帧的位移（不是每秒），多普勒几乎听不出；低通是 X3DAudio 的默认曲线（1 米以外截到采样率的 1/8），Stride 没有调它的接口，更像是没关掉而不是要这个效果。Web Audio 也已经去掉了多普勒。
- **`body.setOrientation`**（原生 0.29.0 的 `sn_physics_body_set_rotation`）：只改物体的朝向，位置和它的插值不动。第一人称、第三人称相机每帧把鼠标的偏航写给角色（Stride 的 `character.SetTargetPose(Quaternion)`）；用 teleport 的话每帧都让插值从头开始，开着插值的角色走起来一顿一顿。
- **鼠标锁定**：Stride 的脚本一启动就锁、Esc 来回切换。浏览器里锁鼠标要先有用户操作，锁着时按 Esc 由浏览器解锁（页面收不到这次按键）。所以两个相机教程改成：点左键锁定，锁着时才转视角，没锁时屏幕上提示一句；Esc 解锁。
- **第三人称相机的避障射线只跳过角色自己**：Stride 的脚本用 `CollisionMask.Everything & ~character.CollisionLayer.ToMask()` 跳过角色所在的整个层，而教程场景里的墙和箱子都和角色同在 Layer0，射线只打得到地面，相机退到墙边时穿到墙后面。我们用穿透的射线取第一个不是角色自己的命中，墙能挡住相机。
- **`entity.findChild(name)`**（Stride 的 `Entity.FindChild`）：找整棵子树（教程里激光挂在武器模型下面，不是脚本所在实体的直接子实体）。和 Stride 不同：不会找到自己（Stride 从自己找起），同名的先找到靠前的子实体（Stride 用栈遍历，先找到靠后的）。

## 2026-11-19 材质：着色模型、停用的特性、化不成固定槽的属性（CSharpIntermediate 的桌面比对查出来的）

第一次和桌面版比，四张图平均每通道差 26 到 67/255：木地板在我们这边是映着天空的镜面，激光是白的、长度不对。原因都在材质的导入，以前的样例没碰到：

- **镜面的颜色和着色模型是两个特性**：Stride 的 `Specular`（金属度或镜面颜色）只给出镜面色，`SpecularModel`（微表面模型）才画镜面反射，材质里没写就是没有。SamplesAssetPackage 的木地板（board1B）只有前者，在 Stride 里是纯漫反射；我们以前只要有 `Specular` 就画反射。现在没有模型的材质导出 `specularShading: false`：不画镜面反射，但金属度、镜面颜色照常折进漫反射（金属没有漫反射、能量守恒时乘 1 - 镜面），同 Stride。
  - 样例里只有 board1B 这一个材质是这样，别的 104 个带 `Specular` 的都有模型，不受影响。
  - 模型不是微表面的（玻璃 `MaterialSpecularThinGlassModelFeature`）先当微表面画并警告，见下面。
- **停用的特性（`Enabled: false`）当没有**：Stride 生成着色器时跳过停用的特性。教程的 Red 材质留着一个停用的自发光（一张按钮贴图乘 5），我们照样导入了，激光成了发白光的。
- **化不成固定槽的属性整棵树导出**：材质文件里漫反射、金属度、镜面、光泽度是固定的形状（一个常量，或常量和一张贴图），运行时不用按材质编着色器。board1B 的光泽度是"贴图 × 0.3"、镜面带贴图，以前退成后备值（光泽度成了 0，反相后粗糙度 0）。现在这样的属性放进一个遮罩是常量 1 的材质层（`MaterialFile.layers` 的第一层），运行时和材质层走同一条路径，不用新加概念；法线贴图不是单独一张贴图时走已有的 `normalTree`。漫反射的树（两张贴图合成等）还没这样做，仍然警告。
  - 考虑过的别的做法：给基础材质的每个属性各加一个"树"的字段和对应的着色器分支。和材质层的那套完全重复，不值。
- **颜色树里的法线贴图翻转绿色通道**（`TextureRef.invertY`）：Stride 在编译贴图时按 `InvertY` 翻，我们的贴图照源文件，固定槽的法线贴图在着色器里翻；颜色树（材质层的法线、`normalTree`）以前没翻，带法线贴图的材质层的凹凸在 Y 方向是反的。
- **没给材质的程序模型也有一个材质槽**：Stride 的程序模型总有一个 `MaterialInstance`，里面的材质可以是空的，实体的 `Materials` 按槽覆盖。我们以前在模型没给材质时不建槽，覆盖就用不上（教程的激光是这样的圆柱，红色由实体给）。程序模型也能被脚本的属性引用了（以前报不支持）。
- **玻璃**（`MaterialSpecularThinGlassModelFeature`，教程里绿色的箱子）：照 Stride 分两遍画在透明阶段，先把透过去的比例乘到背景上（混合是 目标 × 源），再把反射加上去；两个比例按折射率、视角和玻璃的颜色算（`MaterialTransmittanceReflectanceStream`），镜面的菲涅耳项和环境光的镜面系数都换成反射的比例。材质文件里是 `glass: { refractiveIndex }`。
  - 和 Stride 不同：两面都画时我们先画背面再画正面（远的面的反射被近的面挡掉一部分）。Stride 的注释也是这么写的，代码却是先正面后背面。
  - 顺带补上的两条 Stride 规则：背面的法线翻过来朝着相机（所有两面画的材质，以前背面是按背对着光算的）；漫反射的颜色和着色模型缺一个就不算漫反射光照（`diffuseShading: false`：玻璃、只有自发光的激光）。
- **清漆**（`MaterialClearCoatFeature`，车漆，教程里蓝色的箱子）：照 Stride 画两遍。第一遍在不透明阶段，是金属碎片和底漆：漫反射色和光泽度按到相机的距离从碎片过渡到底漆（过渡量 = saturate(距离 × LODDistance)），法线用碎片的法线贴图，金属度是碎片的；第二遍在透明阶段、直接加到画面上（One/One）：材质自己的漫反射色配清漆的金属度、光泽度和橘皮法线。各个输入整棵树导出（`MaterialFile.clearCoat`），运行时编译；渲染那边把"一个材质画几遍"收成一张表（`MaterialPass`），玻璃和清漆共用。
  - 和 Stride 不同：`UseRandomTextureCoordinates`（碎片的贴图按格子随机翻转、旋转、平移）采样时用打乱之前的坐标的导数。打乱以后的坐标在格子边上是断的，照它自己的导数选 mip 会在每个格子的边上取到最小的一级，画出一圈模糊的线；受影响的只有这种贴图的格子边缘。
  - 还没做：清漆加透明（Stride 第一遍沿用材质的透明混合）报警告，第一遍按不透明画；没有切线的网格上碎片和橘皮的法线贴图不起作用（和别的法线贴图一样）。
- 还没做的材质特性（次表面散射、曲面细分）导入时报警告，不悄悄忽略。

## 2026-11-20 渲染组和渲染掩码（模型、UI、相机）

Stride 的 RenderGroup（组件属于 32 个组里的一个）和 RenderGroupMask（相机渲染器的 RenderMask：这台相机画哪些组）。样例的合成器掩码都是 All，所以以前忽略、导入时报警告；编辑器要靠它把辅助图形和游戏的东西分开（P3），先把通路做出来：

- `Model.renderGroup`（0 到 31）进批次的键：同网格、同材质但组不同的实例分成不同的批，画的时候整批按视图的掩码跳过（`RenderView.cullingMask`、`inRenderMask`）。没有改原生的剔除：按批跳过不用逐个实例判断；被掩掉的批照样剔除了一遍，白做的这点功等掩码真的用起来再看。
- 合成器里相机渲染器的 `RenderMask` 导入成 `renderMask`（主画面和画进渲染目标贴图的相机各有各的），全部时不写。
- `UIComponent.renderGroup`：主画面的掩码里没有这一组时这个 UI 不画（全屏的和放在场景里的都是）。Stride 还能用 RenderStageSelector 把某个组的 UI 分到别的渲染阶段（AnimatedModel 把 Group1 的 UI 放到后处理之后画），我们的 UI 本来就都在后处理之后画，这一层不用做。
- 还没做：精灵、粒子、背景的渲染组（组件上有这个属性，样例里只有 UIParticles 的粒子用了 Group1，已经由"粒子画在 UI 上面"处理）；阴影视图用的是全部的组。

## 2026-11-20 字形块的文件：点是字体网格上的 16 位整数、存差分，带存成 16 位

P2 记下的遗留项"点存成 f16"。量了一下 SpriteFonts 导入出来的字形块：531 个文件 128.6 MB，点（f32）占一半、带的索引（u32）占 47%、字形记录 3%。改了文件格式（`GLYPHS_VERSION` 2）：原始大小 128.6 → 66.2 MB（GameMenu 的 115.4 → 59.2 MB），brotli 以后抽样的 40 块 0.90 → 0.69 MB（小 23%）。下载的是压缩以后的，所以按压缩后的大小选的编码：

- **第一版是"每个字形一个包围框，框里量化成 16 位"**：原始大小也减半，但 brotli 以后反而大了 12%。f32 的坐标是"整数个字体单位除以 em"，不同的字里相同的坐标是相同的字节，压缩器吃得到；换成各自框里的相对值，这层重复就没了。
- **现在是字体网格上的整数**：步长取字体网格的四分之一（1 / (4 · unitsPerEm)），TrueType 的点（整数单位）和隐含的中点（半个单位）正好在网格上，没有损失；三次曲线转出来的点对齐到网格，差不到 1/8 个字体单位。坐标大到 16 位放不下的字体，整个字体换粗一倍的网格（编码时放不下会报错，不悄悄截断）。
- **存差分，x 和 y 分开放**：每个点存和同一个字形里前一个点的差（轮廓上相邻的点离得近，差都是小数），抽样比不差分小 20%。差按 16 位回绕着存。
- **带的字存成 16 位**：带头和曲线表里的数都相对这个字形，不会超过 65535。
- **只改了文件，运行时不变**：读进来还原成 f32 的点和 u32 的带，着色器和显存里的格式照旧。
- **分带之前先对齐**：管线把曲线对齐到网格再分带（`snapGlyphPoints`）。对齐以后才变成水平或竖直的线，要按水平、竖直的处理（不进和它平行的带），否则着色器里和平行的射线求交会除以 0。
- **还能再小的**：压缩以后带占 43%（点 49%）。带可以不存、加载时从点重建（分带是确定的算法），下载量能再少四成；代价是每块加载时多十几毫秒的计算，要放进 wasm 或者分帧做才不卡。没做，等字体的下载量成问题（大段中日文）再定。
- 文件格式变了，旧的内容读不了（报版本不对），所有样例重新导入过。

## 2026-11-20 导入警告清查：材质层的遮蔽；渲染器属性里的渲染阶段

把所有样例重新导入、收集警告（路线图 15.5），真有内容用到的两处补上：

- **材质层的环境光遮蔽**（层的 Occlusion 特性）：层文件多一项 `occlusion`（AmbientOcclusionMap 的标量树、DirectLightingFactor），着色器里和别的属性一样 `mix(下面的, 这层的, 遮罩)`——Stride 的层就是把每个流按遮罩线性混。底下没有遮蔽时从"遮蔽 1、直射光不受影响"往上混。层的 cavity 没做：没有贴图、后备值是 1 的 cavity 本来不起作用（样例里都是这样），不报警告；别的情况照旧报。PhysicsSample 重新导入后和桌面比是 1.02、0.38、0.96，和以前持平：这几个材质的遮蔽只影响环境光（DirectLightingFactor 是 0），量很小。
- **游戏自己的渲染器引用渲染阶段**（JumpyJetRenderer 的 OpaqueRenderStage、TransparentRenderStage）：这些属性引用的是合成器的 RenderStages，不是实体。现在导出成阶段的名字（`'Opaque'`、`'Transparent'`），TS 的渲染器要用时按名字找。没有做成专门的引用类型：我们的阶段本来就按名字取，多一种引用类型只多一层解析。

没补的：UI 的渲染组等渲染掩码（P3）；没有样例触发的警告留着（清单在路线图 15.5），等有内容用到再做——凭空实现没法和桌面版对。

## 2026-11-20 法线用世界矩阵的逆转置变换

以前顶点着色器里法线直接乘世界矩阵（注释里写着"非均匀缩放要用逆转置，等材质系统一起做"，一直没做）。缩放不等比的物体上，斜着的法线会歪向缩放大的那个轴，光照就错了；样例里第一个碰到的是 CSharpIntermediate 的 SceneB（拱的缩放是 1.68、1、1.99），拱顶两肩比桌面亮 12/255，查了两轮才想到是它。

- 现在用余子式矩阵（世界矩阵左上 3×3 的三列两两叉乘）：它等于逆转置乘行列式，长度在片元着色器里本来就要归一，所以不用真的求逆；每个顶点多三次叉乘。行列式是负的（镜像）时方向反回来。
- 切线照旧乘世界矩阵（切线是表面上的方向，本来就该这样变换），副切线仍由法线叉切线得出。
- 蒙皮矩阵那一步还是直接乘（骨骼带不等比缩放的情况样例里没有，Stride 那边也是直接乘）。
- 教训：比对时某块差"只在斜面上有、轴向的面上没有"，先看物体的缩放。

## 2026-11-20 影子 DOM：全屏 UI 的文字和控件在页面上有透明的节点

路线图"画在 canvas 里的东西也要有 Web 原生的能力"的那一层（`ui/semantics.ts` 算语义树，`ui/SemanticsLayer.ts` 同步到 DOM，`game.ui.semantics`）。输入框早就有自己的影子输入框（`TextInputBridge`），这次补的是其余的：

- **节点**：每段文字一个节点（一行一个 span），按钮是真的 `<button>`，开关按钮是 `role=checkbox`（不确定是 `aria-checked=mixed`），滑条 `role=slider`（方向键、Home、End 调值），输入框 `role=textbox`（走到它上面就开始编辑，真的输入框接手），ModalElement `role=dialog`，滚动的文字 `role=marquee`（内容是整段，不是这一帧露出来的几个字）。名字取 `accessibleLabel`（新加的属性），没设时按钮用它里面的文字、别的用 `name`。
- **平的一列，不嵌套**：节点按树的顺序排（也就是阅读和 Tab 的顺序），各自按世界矩阵用 CSS 的 `matrix()` 摆。按钮里的文字节点 `aria-hidden`（按钮的名字里已经有了，不读两遍），查找和复制仍然找得到。嵌套的话每个节点要换算到父节点的坐标里，换来的只是"名字从内容里算"，不值。
- **模态的弹窗**：最上面那个模态弹窗以外的节点设 `inert`——读不到、Tab 走不到、不能操作，和指针点不到它们一样。不这样的话键盘能绕过弹窗去按后面的按钮。
- **Tab 的顺序**：就是节点在 DOM 里的顺序。正在编辑的输入框是 `TextInputBridge` 的 `<textarea>`，不在这一层里，浏览器自己的顺序接不上（实测会跳出界面、再按又回到输入框，永远到不了后面的按钮），所以输入框里按 Tab 由我们结束编辑、把焦点交给下一个节点（`SemanticsLayer.focusNext`）。
- **透明而不是 opacity 0**：颜色、背景透明，这样 Tab 走到控件上时浏览器画的焦点框看得见，位置就是画面上控件的位置。
- **默认不接指针**（`pointer-events: none`）：鼠标照常落到画布上，游戏和 UI 的输入不受影响。读屏软件的"点击"、键盘的 Enter 和空格是 DOM 的 click 事件，转成 `ButtonBase.performClick()`；这些键不再传给游戏（空格常是跳）。
- **选中文字**：全选、查找、读屏对所有文字都有效；用鼠标拖着选要给 TextBlock 开 `isSelectable`（开了以后鼠标落在这段文字上归浏览器，不再是游戏的输入，所以默认关，同 Flutter 的 SelectableText）。选区的底色由我们的渲染器照自己的排版画（`SemanticsLayer.selectionOf` 读页面的 Selection），浏览器自己的选区底色关掉——页面上没有游戏的字体，浏览器排出来的字和画面对不齐。
- **文字的宽度**：照 PDF.js 的文字层，每行按我们量出来的宽度横向拉伸（`scaleX`），行的起止和画面一致；行内每个字的位置只是近似。
- **没变就不动**：最多每 0.1 秒同步一次（`updateInterval`），每次把语义树和上一次的逐个比（`semanticsKey`），变了的节点才写 DOM。没有逐帧做是因为要把整棵 UI 走一遍——元素的属性大多是普通字段，没有"变了"的信号；等 UI 的分层缓存做了，改成只在脏的时候同步。
- **在 Chrome 里验过的**（GameMenu）：无障碍树里有全部文字、按钮（名字取自里面的文字）、输入框、对话框；弹窗开着时后面的按钮是 inert，关掉后恢复；只用键盘 Tab、Tab、Tab、Enter 能从输入框走到按钮并关掉弹窗，焦点框画在按钮的位置上；开了 `isSelectable` 的两行文字用鼠标拖选，页面的选区文字和我们画的高亮一致。
- **还没做的**：放在 3D 场景里的 UI 不进影子 DOM（路线图说默认不进、可以按元素打开，打开的那部分还没做，要把投影换成 CSS 的 `matrix3d`）；图片没有节点（`role=img`，要有 `accessibleLabel` 才有意义）；ScrollViewer 没有对应的滚动区域，读屏软件把焦点移到滚出去的控件上时不会自动滚过来。
- **用户的偏好**（`game.userPreferences`）：`reducedMotion`、`highContrast`、`colorScheme`，读的是媒体查询的当前值。引擎自己还没有哪里照着它们改行为，留给游戏用。浏览器的缩放本来就跟着（后备缓冲每帧按 `devicePixelRatio` 调，文字是矢量的）。

## 2026-11-20 文字的描边按到轮廓的距离画；键盘事件发给有焦点的元素

**描边**（TextBlock 的 `outlineColor`、`outlineThickness`，ScrollingText 也有）。Stride 把整段文字往八个方向各偏移 thickness 再画一遍，垫在字下面：九倍的字形、描边比笔画粗时八个影子分开露出来、角是方的。我们的字本来就是按轮廓逐像素算的（Slug），所以描边在同一个着色器里算"这个像素到字形轮廓的距离"，不到半径的涂上描边色，边上按距离过渡一个像素：

- 一个字多画一项（字形的矩形向外扩半径），粗细不限，角是圆的，放大缩小、放进 3D 里都一样清楚。
- 距离怎么找：字形的曲线本来按横带、竖带分好了（数穿越用的），找距离时看采样点上下 radius 以内的横带；横带里没有横的直线（和带平行的不参与数穿越），再到竖带里找它们。每条曲线上最近的点用牛顿法（从投到弦上的位置起步，四次）：闭式解要解三次方程，在接近直线的曲线上单精度不够用。
- 整段文字的描边先画完再画字，相邻的字的描边不会盖住前一个字。
- 没解决的：半透明的描边在相邻两个字的描边重叠的地方会深一些（各画各的、叠了两层）。Stride 的八遍叠得更厉害。要完全均匀得先把整段描边画到一层上再合成，等 UI 的分层缓存做了再说。
- 只有 `SpriteBatch.drawText`（UI 用的）有描边；`drawString`（照 Stride 的 SpriteBatch.DrawString）没加，Stride 那边也没有。

**键盘事件**（`UIElement.keyPressedEvent`、`keyDownEvent`、`keyReleasedEvent`、`textInputEvent`，冒泡）：照 Stride 发给 `game.ui.focusedElement`。焦点可以给任何元素（用方向键选菜单项这类），它占着键盘，脚本读不到按键，UI 读的是不管占用的原始状态（`input.rawKeys`、`input.rawTextInput`）。

- 和 Stride 不同：这一帧有文字输入时 Stride 不发 KeyPressed、KeyReleased（松开的事件会丢），我们照发。
- 和 Stride 不同：TextInput 只有键盘直接打出来的字（keydown 的 `key`），没有输入法拼字的过程。浏览器里要输入法就得有一个拿着焦点的 DOM 输入框，手机上它一拿焦点就弹出软键盘——给菜单项焦点不该弹键盘。要输入法的地方用 EditText（它后面有输入框）。
- 键名是 `KeyboardEvent.code`（同 InputManager），`args.isKeyDown('LeftShift')` 也认 Stride 的键名。

## 2026-11-20 UI 控件补齐：开关按钮、图片按钮、滚动文字

Stride 能写进 .sduipage 的元素类型我们都有了（`UIElementType` 和运行时的类型表是同一份清单，少一个就编不过）：这次补上 ToggleButton、ImageButton、ScrollingText、ContentPresenter，页面里单独放的 ScrollBar 也认。样例的页面没有用到它们，在 GameMenu 的页面上用代码加了一组、在 Chrome 里点过看过。

- **ToggleButton** 照 Stride：三个状态各一张图（可另给悬停时的图），点一下换状态并发 Checked、Indeterminate、Unchecked。状态的名字照 Stride 的枚举写成 `'checked' | 'unChecked' | 'indeterminate'`（导入器把枚举值的首字母改小写，页面文件里就是这三个）。
- **ImageButton**、**ContentPresenter** 在 Stride 里已经标了过时（分别建议用 Button 的三张图、ContentDecorator），为了老页面能照常导入才有；新写的不用。
- **ScrollingText** 和 Stride 不同的两处：
  - 滚出左边的字从要画的那串里去掉。Stride 去字的循环条件写反了，从不去字，重复滚动时那串字一直变长（每帧量一遍越来越长的字符串）、偏移一直变负。
  - 不重复的文字全滚出去以后，`appendText` 接上的字从右边进来。Stride 把它们接在早已滚出去的那串后面，要等新接的字比空出来的那段还长才看得见。
  - 没改的：文字改了会让布局失效一次（大小其实只看 `desiredCharacterNumber`）；滚动是每帧在 CPU 上挪偏移、重画这一个元素，UI 的缓存做了以后（路线图"没变就不做"）它应该只让自己那一层重画。

## 2026-11-20 透明实例逐个从远到近画

以前透明阶段按批排（看每批第一个实例到相机的距离），同一批里的实例不排、不同批的实例不能交错；重叠的半透明物体混合的先后会错。Stride 把透明的渲染节点逐个排。

- 实例按批存在实例缓冲里，所以分两步（`rendering/transparentOrder.ts`）：剔除之后、上传之前，透明的批在每个视图里把自己可见的实例按距离排好；画的时候把各批的实例按距离归并成一段一段，同一批里连着的几个一次画完（`firstInstance` 指到那一段），不同批的交错着画。
- 只有透明的批（和要在透明阶段叠清漆的批）做这件事；阴影视图不画透明的东西，跳过。排序在 CPU 上、每帧做，透明的实例通常很少；多了以后（成千上万）要换成按深度分桶，到时候再量。
- 距离取物体原点到相机的距离（Stride 取包围盒中心在视图空间的深度）。两种在大物体互相穿插时都会错，要彻底对得上只有顺序无关的透明（P4）。

## 2026-11-20 手势识别（Input.Gestures）

Stride 的 `Input.Gestures`、`Input.GestureEvents`：SpaceEscape 用拖动手势换道，我们移植时在脚本里用指针事件自己判。

- **照 Stride.Input 的 Gestures 移植**（`input/gestures.ts`）：点（可以多指、多次）、长按、拖动、轻扫、双指的组合（平移、旋转、缩放）五种，状态机、默认值、阈值都照各个 `GestureRecognizer`；位置归一化，量距离时按屏幕宽高比把短边换到长边的尺度。`game.input.gestures.add(Gestures.drag(…))` 加配置，每帧读 `game.input.gestureEvents`。
- 和 Stride 不同：配置是不可变的普通对象（`Gestures.tap({ requiredNumberOfTaps: 2 })`），不是 new 出来改属性、加进集合后冻结；事件是按 `type` 区分的联合类型，不用强转；时间用秒。
- 和 Stride 不同：被 UI 占用的指针不参与手势（Stride 的手势看所有指针事件，点按钮的同时也会触发游戏里的点手势）。
- SpaceEscape 的 CharacterScript 换回手势的写法；冒烟加了"往右划换道"。TouchInputs 样例（专门演示手势）还没移植，记在路线图里。

## 2026-11-20 用代码建的动画剪辑（属性曲线）

Stride 的 `AnimationClip.AddCurve` 可以给任意属性加曲线；ParticlesSample 的 RotationScript 用它让环转起来，我们以前只有骨骼动画，移植时改成了按时间算角度。

- **写法**：`AnimationClip.fromCurves(name, 秒, [propertyCurve(Transform, 'rotation', [[时刻, 值], …], 'linear')], repeatMode)`，由 `AnimationComponent` 照常播放、淡入淡出、混合。
  - 和 Stride 不同：目标写组件类型加属性名（编译期检查属性存在、值的形状对），不是 `"[TransformComponent.Key].Rotation"` 这样运行时才解析的字符串路径。
  - 和 Stride 不同：四元数的三次插值 Stride 没实现（抛 `NotImplementedException`），我们按分量做同样的 Catmull-Rom 再归一化。
- **插值**照 Stride：常量取前一个关键帧，线性（四元数走球面最短的弧），三次是过四个点的 Catmull-Rom（两头用端点补）。
- **混合**：属性曲线是混合栈的第三部分（骨架的姿势在原生侧，形变权重、属性曲线在 TS 侧），同样的压栈、混合、叠加；只有一边有的属性取那一边，没有曲线的属性不动。
- **谁能播**：没有模型的实体（灯、相机、空实体）也能播——播带曲线的剪辑时实体被打上 `PropertyAnimated` 的记号，动画系统按它找。带骨架的模型也能叠播没有骨架轨道的剪辑（以前报错）：它不往原生的栈里压姿势，合并时只有一边有姿势就留那一边。
- 现在只能驱动数据组件的数、向量、四元数、颜色属性；脚本的属性、材质参数以后有需要再加（Stride 的字符串路径能指到任何可序列化的成员）。

## 2026-11-20 点光、聚光的阴影

CSharpIntermediate 的 SceneB 有一盏投阴影的点光，以前导入时报警告、不投阴影。

- **照 Stride 的做法**：点光是立方体的六个面各一个透视视图（`LightPointShadowMapRendererCubeMap`：视场角比 90° 大 8 像素的边，近平面 0.1，远平面是半径的两倍，按近、远平面裁剪），着色时按到光源的方向里最长的轴选面、深度按沿这个轴的距离算；聚光是一个透视视图（`LightSpotShadowMapRenderer`：按光源的世界矩阵摆，视场角是外锥的全角，近平面 0.01，远平面是射程的两倍）。每块的大小按光源在画面上盖住多大定。和方向光的级联共用一张图集、同一套滤波。
- **图集按矩形分配**（`GuillotinePacker`，照 Stride 的同名类）：以前只会把级联排成格子。每帧清空重排。
- **不给盏数、视图数设上限**：每盏光的阴影数据放存储缓冲（按需变长），每个视图的常量缓冲按需变长（以前最多 8 个视图，一盏点光就要 6 个）。上限只有图集的面积。
- 和 Stride 不同：Stride 的点光还可以选抛物面的画法（`LightPointShadowMapType.DualParaboloid`，两张图），我们都按立方体画——抛物面只是省图集面积的近似，边上有变形，没有样例用。
- 和 Stride 一样、以后要改的：图集放不下的光这一帧没有阴影（Stride 也是；光多的场景要按重要程度缩小或者轮流更新，P4 做阴影缓存时一起）。
- 验证：SceneB 停住仿真和桌面比，平均每通道差 1.23；阴影的形状、两个球投在拱顶和柱子上的影子都对得上。剩下的差在拱顶内侧的两边（我们亮 12/255 左右），关掉这盏灯的阴影两边再比还在，是这个模型上点光的光照本身的差，和阴影无关；原因没查清（不是法线，见路线图第 15.5 项）。

## 2026-11-19 CSharpIntermediate：预制体的实例照文件里的值；穿透的射线；投影

- **预制体的实例照场景文件里的值，不和预制体合并**：场景文件里存着实例每个成员的值，改过的成员键名后面带 `*`。CSharpIntermediate 的场景里有一批实例的 `Model: null`，而且一半实例对应的预制体部件已经不存在了（预制体改过以后场景没重新保存）。试过照 Game Studio 的做法合并（没标覆盖的成员取预制体现在的值），撤掉了：
  - Stride 的资源编译器（`dotnet build`，我们截参考图用的）不合并，照文件里的值编；合并是 Game Studio 打开工程时做的（`PackageBuilderApp.ReconcileBases` 的注释写明了）。
  - 样例的场景文件里覆盖标记不可靠：TPP 的柱子各有各的碰撞体高度（1、2、3、4 米），都没带标记，一合并全变成预制体的 5 米。
  - 所以照编译器：没有模型的 ModelComponent 不画（以前导入器直接报错），实体上别的组件照常。这些实体的碰撞体还在（看不见的墙），同桌面 Stride。
  - 标题里这一项对应的代码没有留下。
- **穿透的射线**（原生 0.28.0 的 `sn_physics_ray_cast_all`，`simulation.rayCastPenetrating`）：每个物体一个命中（进入它的那一处），从近到远；复合碰撞体的子形状只算一次。
- **`worldToScreen`**（Stride 的 Vector3.Project）：返回按画面归一化的位置和深度；点在相机后面时返回 undefined（Stride 照样除以 w，得到镜像过去的位置，教程里的字会出现在背后物体的对面）。`debugText.fromScreen` 把归一化的位置换成 print 用的位置。
- **`--textures source` 时改过像素的贴图写成 PNG**：这个策略的意思是运行时不用带 KTX2 的解码器；以前缩放过的贴图在这个策略下也编成 KTX2，颜色键和 1 位 alpha 加进来以后 FPS、PhysicsSample、TopDownRPG 的遮罩贴图成了 KTX2、加载失败（回归发现的）。
- **教程里的笔误不跟**：AsyncWebApi 的提示写的是按 A，判断的却是 G；提示改成 G。

## 2026-11-19 贴图的颜色键和 1 位 alpha；泛光的权重；比对时关掉亮度适应

查 CSharpBeginner 里箱子的发光标志为什么比 Stride 多一圈蓝光（带材质层的箱子第一次近距离比）：

- **颜色键**（贴图资源的 `ColorKeyEnabled`、`ColorKeyColor`，精灵表也有）：以前没导入。等于键的像素变成全透明的黑，在缩放之后做（同 Stride 的 TextureHelper）。箱子的遮罩图里 22% 的像素是不透明的纯黑，是用颜色键去掉的。
- **`Alpha: Mask` 照 1 位 alpha 做**：这种贴图在桌面上压成 BC1，alpha 不到一半的像素是全透明的黑，其余不透明（预乘时颜色先乘 alpha）。这是 BC1 格式的限制，不是我们非跟不可的；但材质是按硬边的遮罩做的（标志的自发光是遮罩乘 50），留着平滑的 alpha 时半透明的边缘会亮出一圈。所以导入时照做。
- **1 位 alpha 的贴图不做 alpha 渗色**：渗色（`bleedTransparentColors`）把透明像素的颜色换成最近的不透明颜色，是为了线性过滤和 UASTC 的块误差。但渗进去的白色会被压缩误差漏出来的一点 alpha 带出来，自发光乘 50 以后在黑底上成了一道道蓝色条纹，泛光再把它放大成光晕。硬遮罩透明的地方就该是黑的（同 BC1）。
  - 考虑过的别的做法：贴图标成"已经预乘"、着色器里不再乘 alpha（更准，但要改贴图、精灵、UI 整条约定，只为边缘一个纹素以内的差别不值）。
- **泛光的权重少算了一次颜色空间转换**：Stride 的 Bloom 用 `Scaler.Color = new Color4(Amount)` 把模糊后的图加回画面，ImageScaler 把这个颜色当 sRGB 换到线性空间（`Color.ToColorSpace`，rgb 换、alpha 不换），Additive 混合又乘一次 alpha，实际权重是 srgbToLinear(0.3) × 0.3 = 0.022；我们照着"颜色乘 alpha"算成了 0.09，泛光强了 4 倍。之前的样例里亮的东西是大片的天空，差不明显；箱子的标志是 50 倍亮度的小光源，光晕一眼就看得出来。是逐个效果和桌面版比（两边只开泛光、只开光芒、只开镜头光晕）定位到的：光芒和镜头光晕各自对得上，只有泛光不对。
- **比对时两边都关掉色调映射的亮度适应**（`TemporalAdaptation`，时间常数 1 秒）：相机移到位以后曝光还在变，早截晚截墙面能差 4/255（桌面 Stride 自己两次截图就差这么多），之前"属性"那张差 5.98 有一半是它。截图入口和 `capture-ours.ps1` 都把它关掉。别的样例的截图工程是相机不动、等够了再截，不受影响；以后有相机移动的比对都照这个做。

## 2026-11-19 目标改成比 Stride 做得更好（用户决定）；CSharpBeginner：实体克隆、场景归属、调试文字

用户把目标从"对齐 Stride"改成"比 Stride 做得更好，同时整理文档和代码"（docs/roadmap.md 的"原则"）。之后每一项都要回头看两件事：Stride 的毛病不跟，我们比 Stride 差的限制补掉。CSharpBeginner 是按这个标准做的第一项：

- **实体克隆是实体层的通用能力**（`entity.clone()`，`engine/clone.ts`）：第一版放在内容管理里，按建实体的场景文件再实例化一次，只能克隆文件建出来的实体，运行时加的组件不跟着——比 Stride 差，职责也放错了层，所以重做。现在照抄数据组件和脚本属性现在的值，子树里的实体引用、组件引用换成克隆的；只有运行时状态的组件（字段全是 transient）不抄，由挂它的系统在 `entities.onClone` 里重新挂（动画系统给克隆的模型建自己的骨架实例和形变权重）；脚本属性以外的创作数据由脚本的 `cloneFrom` 抄（AnimationComponent 的剪辑、粒子系统、约束的设置）。
  - 和 Stride 不同：克隆出来的实体马上就在游戏里。Stride 的克隆要加进场景才看得见、才跑脚本，教程里的 clone0 就是演示"不加进场景就看不见"；我们没有"游离的实体"这个状态，演示改成克隆完就销毁，那行字跟着改。
  - 考虑过的别的做法：保留按文件再实例化（最省事，但限制去不掉）；给每个组件写克隆函数（数据组件有 schema，用不着）。
- **实体所在的场景**（`entity.scene`，Stride 的 Entity.Scene）：以前卸载场景只销毁场景文件建的实体，脚本克隆、实例化到场景根的实体留在游戏里（换一圈教程实体数从 143 涨到 175）。现在运行时建的根实体可以放进一个场景（`clone.scene = this.entity.scene`，或者 `create({ scene })`），卸载时一起销毁；没放进去的跟着父实体。多网格模型多出来的网格子实体改用 `ModelPart` 标记认（以前内容管理按实体记一张表，克隆的实体不在表里）。
- **调试文字按 CSS 像素、按设计分辨率摆**：Stride 按后备缓冲的真实像素摆，高分屏上字只有一半大，画布和设计的窗口不一样大时字和画面对不上（教程把字摆在 3D 物体旁边）。现在位置的单位是 CSS 像素，字按像素比放大整数倍（往下取整，挨着的两段字不会叠）；`debugText.virtualResolution` 设了以后位置按那么大的画面给，按高度缩放、水平居中换到画布上，`loadGameSettings` 把它设成游戏设置的后备缓冲大小，所以样例照搬 Stride 的位置就行。画布和设计的窗口一样大、像素比是 1 时和以前逐像素一样（已有的截图比对不受影响）。
  - `input.absoluteMousePosition` 跟着改成 CSS 像素（Stride 是后备缓冲的像素），`debugText.fromCanvas` 换成 print 用的位置。
- **调试文字默认只在开发版画**（`debugText.visible`）：同 Stride 的 `DebugTextSystem.Visible = Platform.IsRunningDebugAssembly`，调试用的字不该出现在正式版里；拿它当内容的样例（CSharpBeginner 的教程说明、BepuSample 的操作提示）自己设成 true。不画的时候文字照样记在 `lines` 里，调试 CLI 读得到。
- **相机插值封顶**：TutorialUI 的 `Vector3.Lerp(起点, 终点, 计时 / 2 秒)` 不封顶，最后一帧的系数大于 1，相机冲过头一点，冲多少看那一帧多长（帧率相关）。我们到 1 为止，相机正好停在教程的 Camera 上。
- **教程里的笔误不跟**：InstantiatingPrefabsDemo 写的是 `Quaternion.RotationY(135)`（弧度，转出来约 175 度），按 135 度转。
- **照 Stride 的**：`Content.Load` 是同步的，我们的 `loadModel`、`loadPrefab` 是异步的（网页上读文件只能异步），加载完之前算没加载。

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
- **RecastNavigationComponent**：寻路（`tryFindPath`）之外，2026-11-20 补上了排队寻路（`setTarget`，导航系统每帧最多算 10 条）和沿路径走（`startFollowingPath`，按 `speed` 挪实体、转向前进的方向）。和 Stride 不同：一开始的状态是 pathIsInvalid（Stride 的枚举默认值是 QueuePathPlanning，每个组件一出生就排队找一条去原点的路）；排队的寻路没找到时状态是 pathIsInvalid（Stride 停在 PlanningPath）；已经站在路径点上时不转向（Stride 对零向量求朝向得到 NaN）。BepuNavigationBoundingBoxComponent 在 Stride 里本身没实现（源码里是 #warning），导入时忽略。
- **挂到骨骼节点用变换存储的链接**：ModelNodeLink 的实体世界矩阵 = 目标的世界 × 节点矩阵 × 本地，不看父节点（Stride 的 TransformLink）。做在原生的变换存储里（`setLink`），计算顺序按链接排，帧末一次算完；别的做法是在 TS 里每帧算好世界矩阵写回本地变换，但子实体和物理都要跟着处理，容易出错。
- **跟着实体走的刚体**：运动学刚体的世界变换被物理以外改过（脚本移动了它或它的父实体：JumpyJet 移动管子组的根，掉落金币的拾取触发器跟着金币落）、挂在骨骼节点上的刚体（出拳的碰撞体），每个物理步先瞬移到实体当前的世界位姿。Bepu 里刚体由仿真驱动变换，这些情况都停在原处（运动学的醒着时被写回、睡下后变换才跟父实体走，物理里仍在原处；出拳的碰撞体停在加进仿真时手的位置），样例的本意显然是跟着走。和 Stride 不同：运动学的在原生侧（stride-native 的 FollowMovedKinematics，按上次写回的位姿比较），骨骼节点的在 Simulation 的 followNodeLinks。
- **设计分辨率取默认后备缓冲**（2026-11-19）：Stride 的游戏在初始化时取后备缓冲大小当设计分辨率（JumpyJetRenderer 的虚拟分辨率、PipesScript 的场景宽度），桌面上窗口一开始就是 GameSettings 的 DefaultBackBufferWidth、Height（所有样例都是 AdaptBackBufferToScreen: false）。浏览器里画布跟着窗口和像素比走，第一次画时就可能比背景图大，背景露底。所以导入器带上默认后备缓冲大小（`game.settings.defaultBackBufferSize`），这类游戏按它算设计分辨率，窗口多大都拉伸铺满；竖屏的 JumpyJet 页面让画布保持 640:1136 居中（同桌面的窗口）。和 Stride 不同的只是取值的时机，桌面上两者相同。
- **脚本属性互相引用不要求顺序**：Stride 反序列化时引用总能解析；我们挂脚本时被引用的脚本还没挂上就推迟到下一轮（TopDownRPG 的 CrateScript 排在它引用的 Trigger 前面）。
- **节点名照 Stride 的 CleanNodeName**：FBX 的命名空间（`mannequinModel:CATRigHub001`）只留最后一段，去掉 `#`、`__` 之后的部分和空格；动画一个关节都对不上时导入警告（以前静默变成静止姿势）。
- **流式加载时停住物理**：Stride 的 SceneStreaming 用同步的 Content.Load，加载那一帧整个游戏停住；我们的场景加载是异步的（取文件、建实体），分块加载期间把物理仿真停住，角色不会在地面出现之前掉下去（DynamicScene 一开始就是这样：角色站在中央分块的触发器里，脚下还没有地面）。渲染和脚本照常跑。
- **正在接触只报最深的深度**：Stride 的 OnTouching 每步给全部接触点，原生侧按一对物体只报这一步最深的穿透深度（样例只用最深的）；物体要打开（设了带 onTouching 的处理器）才报，免得每步每对都产生事件。
- **场景的偏移在场景上**（2026-11-20 改，以前加在根实体的本地位置上）：每个场景在变换存储里占一个槽位当隐藏的根（`SceneRoot`，不是实体），场景里没有父实体的实体在存储里挂在它下面，子场景的根挂在父场景的根下面。所以同 Stride：实体的本地位置不带偏移，世界位置带（一层层累加）；`scene.offset` 可以运行时改；`Transform.parent` 对脚本仍然是 undefined。运行时放进场景的实体（`entity.scene = …`）跟着场景的偏移，移出来就不跟；克隆出来、还没放进场景的实体不带偏移（Stride 里也是加进场景才算数）。
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
