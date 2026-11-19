# UIElementLink 的参考截图

```bash
pwsh tools/stride-capture/ui-element-link/setup.ps1
C:/code/stride-ui-element-link/samples/UI/UIElementLink/Bin/Windows/Release/UIElementLink.Windows.exe --capture C:/code/stride-ui-element-link/reference
pnpm --filter @stride-ts/ui-element-link dev
pwsh tools/stride-capture/ui-element-link/capture-ours.ps1
```

`setup.ps1` 从 Stride 源码的 `releases/4.4.2` 标签取出样例，入口换成 `UIElementLinkApp.cs`（在 PowerShell 里跑：Git Bash 的 tar
把 `C:` 当成远程主机）。`--capture <目录>` 用 GameSettings 的 1280x720，不放启动画面，三个场景各截一张：

| 图 | 内容 |
|---|---|
| `fullscreen.png` | 全屏的 UI（UICamera 正交，跟着走的实体按像素放） |
| `tilted.png` | 斜放在 3D 里的 UI |
| `billboarded.png` | 放在 3D 里、面向相机的 UI |

每个场景换进来 5 帧后定住会动的东西：SplashScript 移除（按钮不再来回移动），跟着走的按钮放在 sin = 0.5 的位置（中心往右
0.375 个半宽），骑士的动画停在第 0 帧，烟的粒子去掉（stride-ts 还没有粒子）；再等 60 帧截图。`capture-ours.ps1` 在 stride-ts
这边做同样的事，逐张比。

Stride 存的 PNG 带 gAMA/iCCP 块，有的看图软件按它把图显示得发白；比的是像素值，不受影响。

## 2026-11-19 的结果

每通道的平均差（/255，只比 RGB），任一通道差超过 8、32 的像素的比例：

| 图 | 平均差 | 超过 8 | 超过 32 |
|---|---|---|---|
| fullscreen | 6.81 | 19.4% | 4.4% |
| tilted | 4.62 | 2.4% | 1.8% |
| billboarded | 4.46 | 3.5% | 2.8% |

UI 的位置、大小（四角的按钮、跟着走的按钮，3D 里的透视和朝向）和跟着走的球、骑士的位置两边一致。差的来源：

- UI 的颜色：Stride 的 UI 在透明阶段里画，被色调映射（Hejl2，自动曝光）处理；这个场景的背景很暗，曝光大于 1，UI 被提亮
  （按钮的橙色 Stride 138,35,0，我们 51,15,1）。我们的 UI 画在后处理之后，颜色照原样（有意的偏差，见 decisions.md）。
- 骑士：4.4.2 的样例把骑士的法线贴图当成 sRGB 的颜色贴图（`c100_body_nm.sdtex` 的 `Type: !ColorTextureType`，后来的版本
  改成了 NormalMapTextureType），法线是错的，骑士几乎是黑的；我们导入的是改过的版本。
- 背景：Stride 的整体暗一些（中间区域平均：全屏场景暗 7/255，面向相机的暗 4/255）。和 UI 的颜色同一个原因：Stride 量平均
  亮度时 UI 已经画进去了，亮的按钮拉高平均亮度、曝光变小；我们量的只有场景。全屏场景四角的按钮占得多，差得也多（超过 8
  的像素 19.4% 大多是这个）。另外是 JPEG 解码的 1 到 2 级的差（暗的渐变上一圈圈的）。

帧时间（RTX 3050 笔记本，高性能电源模式，全屏场景，1280x720，不限帧率，`--benchmark 1200`）：桌面 Stride 1.24 ms（带烟的
粒子），stride-ts 1.10 ms（`tools/measure.ps1`，没有粒子）。
