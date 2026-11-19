# SpriteFonts 的参考截图

```bash
pwsh tools/stride-capture/sprite-fonts/setup.ps1
C:/code/stride-sprite-fonts/samples/Graphics/SpriteFonts/Bin/Windows/Release/SpriteFonts.Windows.exe --capture C:/code/stride-sprite-fonts/reference
pnpm --filter @stride-ts/sprite-fonts dev
pwsh tools/stride-capture/sprite-fonts/capture-ours.ps1 [-NoKerning]
```

`setup.ps1` 从 Stride 源码的 `releases/4.4.2` 标签取出样例，入口换成 `SpriteFontsApp.cs`。`--capture <目录>` 不放启动画面，用反射把
FontRenderer 停在第 2 秒（动画那屏第 4 秒：文字转回正、完全不透明），八屏各画 30 帧（运行时字体在后台生成字形）后存成
`screen<N>.png`。`capture-ours.ps1` 在 stride-ts 这边截同样的八屏并逐屏比；`-NoKerning` 关掉字距（Stride 不做字距）。

**Stride 4.4.2 的这个样例原样运行是黑屏**：GameSettings 配了启动画面时，场景和合成器都异步加载、等启动画面放完一起换上，
而换上的条件是场景和合成器两个加载任务都不为空（`SceneSystem.Draw`）；SpriteFonts 没有默认场景，场景任务永远是空的，合成器
就永远换不上。截图和测帧时间（`../Benchmark.cs`）都不放启动画面，绕开它。stride-ts 没有这个问题。

## 2026-11-19 的结果

每通道的平均差（/255），括号里是关掉字距的：

| 屏 | 内容 | 平均差（每个像素取差最大的通道） | 说明 |
|---|---|---|---|
| 0 | 介绍（运行时字体 80） | 0.25 | |
| 1 | 编译期字体 | 0.57 | |
| 2 | 运行时字体 50、80 | 0.86 | |
| 3 | 粗体、斜体 | 1.01（0.49） | 字距 |
| 4 | 三种抗锯齿 | 4.93（4.96） | Aliased 的字 FreeType 用完整的 TrueType hinting 画，前进宽度差一两个像素，这一行量出的宽度带着三行整体左移 5 像素 |
| 5 | 日文 | 0.46 | |
| 6 | 左中右对齐（Times New Roman 28） | 2.72（2.40） | 字的位置差不到 1 像素；小字号下 Stride 的笔画按 hinting 吸附到像素上，我们按轮廓算覆盖率，笔画边缘不同 |
| 7 | 动画 | 0.96 | 旋转原点：Stride 把虚拟坐标的原点当字体像素用，文字偏到左上，我们的在动画位置的正中（有意的偏差） |

按平均每通道差算（别的样例用的口径），八屏依次是 0.21、0.53、0.82、0.97、4.80、0.40、2.65、0.87。

比对中找到并修掉的：字体要求整数 ppem 时（Arial 的 head 表 flags 第 3 位），FreeType 开 hinting 时把 ppem 取整，字号 33.33 的
字按 33 排、按 33 画；我们之前按 33.33，正文每个字宽 0.3 像素左右，一行宽 3%。修了以后单词的起止位置和 Stride 一致到 1 像素。

帧时间（RTX 3050 笔记本，1280x720，不限帧率，`--benchmark 1200`，基本停在第 0 屏）：桌面 Stride 0.42 ms，stride-ts 0.39 ms
（第 0 屏和对齐那屏一样；对齐那屏一开始是 2.1 ms，几乎都是 CPU：每帧把同样的文字排好几遍、每个字新建临时数组。排版加了缓存、
SpriteBatch 直接写缓冲以后降下来）。
