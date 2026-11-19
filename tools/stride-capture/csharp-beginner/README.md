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

两边都等相机的 2 秒插值走完。桌面版走完后把相机摆到教程的 Camera 实体那里：Stride 的插值不封顶，最后一帧会冲过头一点，冲多少看那一帧多长（我们封顶到 1，见 decisions.md）。

参考图里没有调试文字：Stride 的 `DebugTextSystem.Visible` 默认只在调试版是 true，截图工程是 Release 版。`capture-ours.ps1` 把我们的 `debugText.visible` 关掉再截。它只比顶上 100 像素的 UI 以下的部分（`stride shot --region`）：Stride 的 UI 在后处理之前画、被色调映射（白底成了灰的），我们画在后处理之后，是有意的偏差。

## 2026-11-19 的结果

UI 以下的场景，平均每通道差（/255）和任一通道差超过 8、32 的像素的比例：

| 图 | 平均差 | 超过 8 | 超过 32 |
|---|---|---|---|
| cloning | 2.35 | 4.52% | 1.30% |
| keyboard | 2.27 | 4.08% | 1.44% |
| properties | 5.98 | 11.39% | 2.09% |

物体的位置、大小、阴影两边一致（克隆的剑、茶壶、梯子逐像素对得上）。差的来源：

- 格子贴图的颜色：Stride 压成 BC 格式，我们用原样的 PNG（同 TopDownRPG、FirstPersonShooter，它们是 2.2 到 2.7）。
- 箱子的发光标志（properties 那张近处有两个，所以差大）：我们的蓝色光晕比 Stride 宽、亮。带材质层的箱子这是第一次近距离比，还没查是自发光的强度还是泛光的问题，记在 docs/roadmap.md 的"进度"里。
