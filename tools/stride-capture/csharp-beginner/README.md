# CSharpBeginner 的参考截图

```bash
pwsh tools/stride-capture/csharp-beginner/setup.ps1
C:/code/stride-csharp-beginner/Tutorials/CSharpBeginner/CSharpBeginner/Bin/Windows/Release/CSharpBeginner.Windows.exe --capture C:/code/stride-csharp-beginner/reference
pnpm --filter @stride-ts/csharp-beginner dev
pwsh tools/stride-capture/csharp-beginner/capture-ours.ps1
pwsh tools/stop-dev.ps1
```

`setup.ps1` 取 Stride 源码当前分支的样例（Bepu 版，stride-ts 导入的就是它）和三个资源包，改成用 4.4.2 的 nuget 包、net10.0，入口换成 `CSharpBeginnerApp.cs`。`--capture <目录>` 用 GameSettings 的 1280x720，不放启动画面，依次进三个教程（调 TutorialUI 的 BtnLoadTutorial，同点菜单里的按钮），各截一张：

| 图 | 教程 | 看什么 |
|---|---|---|
| `cloning.png` | Cloning entities | 克隆出来的三把剑的位置和大小（`entity.clone()`，多网格的模型） |
| `keyboard.png` | Keyboard input | 三个茶壶（程序模型 Teapot） |
| `properties.png` | Properties | 近处的箱子（带材质层的发光标志） |

两边都关掉色调映射的亮度适应（`TemporalAdaptation`，时间常数 1 秒）：相机移到位以后曝光还在变，早截晚截墙面能差 4/255，桌面 Stride 自己两次截图就差这么多。两边都等相机的 2 秒插值走完。桌面版走完后把相机摆到教程的 Camera 实体那里：Stride 的插值不封顶，最后一帧会冲过头一点，冲多少看那一帧多长（我们封顶到 1，见 decisions.md）。

逐个效果比对时，桌面版加 `--only properties --disable bloom,lightstreak`（可选 fxaa、brightfilter、bloom、lightstreak、lensflare），我们这边用 `stride eval` 关同样的效果（`strideGame.graphicsCompositor.postEffects.bloom.enabled = false`）。

参考图里没有调试文字：Stride 的 `DebugTextSystem.Visible` 默认只在调试版是 true，截图工程是 Release 版。`capture-ours.ps1` 把我们的 `debugText.visible` 关掉再截。它只比顶上 100 像素的 UI 以下的部分（`stride shot --region`）：Stride 的 UI 在后处理之前画、被色调映射（白底成了灰的），我们画在后处理之后，是有意的偏差。

## 2026-11-20 的结果（换了机器，RX 9070 GRE）

参考图在这台机器上重截。`stride shot --diff` 那一帧不加输出的抖动。

| 图 | 平均差 | 超过 8 | 超过 32 |
|---|---|---|---|
| cloning | 1.55 | 1.14% | 0.28% |
| keyboard | 1.41 | 1.05% | 0.31% |
| properties | 1.62 | 0.95% | 0.15% |

比 11-19 的高 0.05 到 0.15：主要是箱子标志的遮罩贴图（有颜色键）现在无损存成 PNG，桌面 Stride 压成 BC，边缘不一样（见 docs/decisions.md 的"csharp-beginner 的截图差变大"）。

## 2026-11-19 的结果

UI 以下的场景，平均每通道差（/255）和任一通道差超过 8、32 的像素的比例：

| 图 | 平均差 | 超过 8 | 超过 32 |
|---|---|---|---|
| cloning | 1.44 | 0.94% | 0.16% |
| keyboard | 1.24 | 0.66% | 0.09% |
| properties | 1.55 | 0.71% | 0.04% |

物体的位置、大小、阴影两边一致（克隆的剑、茶壶、梯子逐像素对得上），剩下的差在格子贴图的颜色（Stride 压成 BC 格式）。

第一次比是 2.35、2.27、5.98，属性那张近处的箱子标志比 Stride 多一圈蓝光。逐个效果比（两边只开泛光、只开光芒、只开镜头光晕，都关）找到三处，修掉以后降到上面的数（见 docs/decisions.md 的"贴图的颜色键和 1 位 alpha；泛光的权重"）：

- 泛光的权重强了 4 倍（少算了一次颜色空间转换）：三张都受影响，占了差的大头；
- 箱子的遮罩贴图有颜色键和 `Alpha: Mask`，以前没导入，标志周围的黑底上漏出蓝色的条纹；
- 两边截图时色调映射的亮度适应还没走完，墙面差 4/255。
