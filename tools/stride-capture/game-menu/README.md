# GameMenu 的参考截图

```bash
pwsh tools/stride-capture/game-menu/setup.ps1
C:/code/stride-game-menu/samples/UI/GameMenu/Bin/Windows/Release/GameMenu.Windows.exe --capture C:/code/stride-game-menu/reference
pnpm --filter @stride-ts/game-menu dev
pwsh tools/stride-capture/game-menu/capture-ours.ps1 [-NoKerning]
```

`setup.ps1` 从 Stride 源码的 `releases/4.4.2` 标签取出样例，入口换成 `GameMenuApp.cs`。`--capture <目录>` 把窗口设成 540x960
（GameMenu 的 UI 按窗口大小布局；GameSettings 的 640x1136 在 1080 高的屏幕上放不下），不放启动画面，每张等 60 帧后存：

| 图 | 内容 |
|---|---|
| `splash.png` | 启动页 |
| `welcome.png` | 主菜单和欢迎弹窗（换场景同 SplashScript：直接设根场景） |
| `main.png` | 关掉欢迎弹窗 |
| `ships.png` | 选飞船的弹窗（调 UpdateShipStatus、ShowShipSelectionPopup） |

飞船的属性在样例里是随机的，截图时用反射换成固定的（第 i 艘：力量 i % 4、操控 (i + 1) % 4、速度 (i + 2) % 4），血条每帧设成一半。
截 `main.png` 时另外把每个看得见的元素的类型、名字、大小、中心位置写进 `layout.txt`，和 stride-ts 的布局逐个比（比截图更容易找出
布局的差）。`capture-ours.ps1` 在 stride-ts 这边做同样的事（4.4.2 的样例没有 InputCaptureMonitor，换场景时去掉它），逐张比；
`-NoKerning` 关掉字距（Stride 不做字距）。

## 2026-11-19 的结果

布局：40 个元素的大小和位置都和 Stride 一致（差不到 0.6 像素）。比对中找到并修掉的：Stride 反序列化时只覆盖文件里写了的成员，
`Padding: {Left: 45.0, Top: 20.0, Bottom: 25.0}` 的右边还是 Button 默认的 10，我们当成了 0，当前飞船的按钮大了 10 像素。

每通道的平均差（/255，只比 RGB），超过 8、32 的像素的比例：

| 图 | 平均差 | 关掉字距 | 超过 8（关掉字距） | 超过 32（关掉字距） |
|---|---|---|---|---|
| splash | 4.62 | 3.65 | 8.8% | 2.6% |
| welcome | 3.78 | 3.43 | 9.9% | 2.0% |
| main | 3.55 | 3.55 | 12.0% | 2.4% |
| ships | 3.96 | 3.96 | 14.8% | 3.0% |

差的来源：Stride 把精灵表压成 BC 格式（SpriteSheet 的 IsCompressed 默认开），我们用源图（`--textures source`），背景图上平均差
2/255，细节多的图（头像、飞船）4/255；文字的笔画按 hinting 吸附到像素（同 SpriteFonts 的比对），文字区域 4 到 5/255。

帧时间（RTX 3050 笔记本，高性能电源模式，启动页，640x1061（GameSettings 的 640x1136 被屏幕高度截断），不限帧率，`--benchmark 1200`）：
桌面 Stride 0.52 ms，stride-ts 0.43 ms（一开始 0.57 ms：场景、UI 各提交一次命令；改成每帧只提交一次以后降下来）。
