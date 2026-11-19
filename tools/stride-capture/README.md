# 桌面 Stride 的参考截图

每个对齐用的样例一个子目录：`setup.ps1` 从 Stride 源码搭出用官方 nuget 包（4.4.2）编的桌面版，入口换成能截图的版本；
截好的参考图不进仓库，需要时重新截。stride-ts 这边用 `stride shot --diff` 比。各工程共用 [Benchmark.cs](Benchmark.cs)：
`--benchmark N [--gpu-profile]` 让游戏照常跑着测帧时间（TPP 有自己的静态模式），stride-ts 这边对应 `tools/measure.ps1`。

各样例说明里的"平均差"是平均每通道差（/255，`stride shot --diff` 结果里的 `meanChannel`，`capture-ours.ps1` 打印的就是它）。P1 的几个（tpp、animated-model、physics-sample、bepu-sample、platformer2d、topdown-rpg、first-person-shooter）当时记的是每个像素取差最大的通道再平均，偏大，重截时换成每通道的。

| 目录 | 样例 | 说明 |
|---|---|---|
| [tpp/](tpp/README.md) | Third Person Platformer | 静态画面（去掉脚本、动画、角色物理）；可以关单个后处理、固定曝光、只留一种光、测帧时间 |
| [animated-model/](animated-model/README.md) | AnimatedModel | 动画停在第 0 帧 |
| [physics-sample/](physics-sample/README.md) | PhysicsSample（Bepu 版，取自 master） | 选场景、可以停住物理 |
| [bepu-sample/](bepu-sample/README.md) | BepuSample（取自 master） | 选子场景、可以停住物理；截图时关掉 UI 和调试文字 |
| [platformer2d/](platformer2d/README.md) | Platformer2D（取自 releases/4.4.2） | 可以去掉脚本（精灵停在默认帧） |
| [topdown-rpg/](topdown-rpg/README.md) | TopDownRPG（取自 Stride 源码当前分支的 Bepu 版） | 可以去掉脚本；截图工程去掉了没有 4.4.2 包的导航插件 |
| [game-menu/](game-menu/README.md) | GameMenu（取自 releases/4.4.2） | 540x960 截启动页、欢迎弹窗、主菜单、选飞船的弹窗（飞船属性固定、血条一半），另外导出每个元素的布局（layout.txt）；`capture-ours.ps1` 截我们这边并逐张比 |
| [simple-audio/](simple-audio/README.md) | SimpleAudio（取自 releases/4.4.2） | 1280x720 截静止和波形图不透明两张；`capture-ours.ps1` 截我们这边并逐张比 |
| [ui-particles/](ui-particles/README.md) | UIParticles（取自 releases/4.4.2） | 600x600、固定步长，粒子固定种子重置后 60 步截新游戏和结束两张；`capture-ours.ps1` 截我们这边并逐张比 |
| [ui-element-link/](ui-element-link/README.md) | UIElementLink（取自 releases/4.4.2） | 1280x720 截三个场景（全屏的 UI、倾斜的 UI、面向相机的 UI；按钮定在一处、动画停在第 0 帧、去掉烟的粒子）；`capture-ours.ps1` 截我们这边并逐张比 |
| [sprite-fonts/](sprite-fonts/README.md) | SpriteFonts（取自 releases/4.4.2） | 八屏各截一张；不放启动画面（4.4.2 原样运行是黑屏）；`capture-ours.ps1` 截我们这边并逐屏比 |
| [first-person-shooter/](first-person-shooter/README.md) | FirstPersonShooter（取自 Stride 源码当前分支的 Bepu 版） | 可以去掉脚本（含子实体上的）；截图后打印角色和相机的位置 |
| [particles-sample/](particles-sample/README.md) | ParticlesSample（取自 releases/4.4.2） | 七个场景，粒子固定种子后各截一张；`capture-ours.ps1` 截我们这边并逐张比 |
| [jumpy-jet/](jumpy-jet/README.md) | JumpyJet（取自 master 的 Bepu 版） | 截主菜单和游戏中两张；`capture-ours.ps1` 截我们这边并逐张比 |
| [space-escape/](space-escape/README.md) | SpaceEscape（取自 releases/4.4.2） | 关卡换成固定的几段，截主菜单和跑动中两张；`capture-ours.ps1` 截我们这边并逐张比 |
| [material-shader/](material-shader/README.md) | MaterialShader（取自 releases/4.4.2） | 固定步长，第 120 帧截一张，记下那一帧的游戏时间；`capture-ours.ps1` 把我们的时钟拨到同一时间再比 |
| [custom-effect/](custom-effect/README.md) | CustomEffect（取自 releases/4.4.2） | 同 material-shader：第 120 帧截一张，按同一时间比 |
| [morph-targets/](morph-targets/README.md) | MorphTargets（master 新加的样例，包用本机编的 4.5.3-dev4） | 第 58 帧截一张；`capture-ours.ps1` 把各剪辑拨到同一时间再比 |
| [csharp-beginner/](csharp-beginner/README.md) | CSharpBeginner（取自 Stride 源码当前分支的 Bepu 版） | 进克隆、键盘、属性三个教程，相机插值走完后各截一张；`capture-ours.ps1` 截我们这边并逐张比 |
| [csharp-intermediate/](csharp-intermediate/README.md) | CSharpIntermediate（取自 Stride 源码当前分支的 Bepu 版，去掉导航教程） | 进射线、投影、场景加载、声音四个教程的完成版各截一张；`capture-ours.ps1` 截我们这边并逐张比 |
