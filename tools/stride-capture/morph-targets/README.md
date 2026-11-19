# MorphTargets 的参考截图

```bash
pwsh tools/stride-capture/morph-targets/setup.ps1
C:/code/stride-morph-targets/samples/Graphics/MorphTargets/Bin/Windows/Release/MorphTargets.Windows.exe --capture C:/code/stride-morph-targets/reference/Clips.png
pwsh tools/stride-capture/morph-targets/capture-ours.ps1
```

`setup.ps1` 从 Stride 源码的当前提交取出 MorphTargets。这个样例和形变都是 master 新加的，4.4.2 里没有，所以包用本机编的 4.5.3-dev4（NuGet 全局缓存里的），入口换成 `MorphTargetsApp.cs`。

`--capture <png>`：
- 固定步长 1/60 秒、每次 Update 都画，窗口 1280x720；
- 画满 `--frames` 帧（默认 58，约 0.97 秒，同样例自带的截图）后截图；
- 把三个模型正在播的剪辑的时间写进旁边的 `.time`（`实体名=秒`）。

`capture-ours.ps1` 在 stride-ts 这边：
1. 等游戏跑起来，暂停，用固定步长；
2. 把各剪辑拨到参考图那一帧的前两帧，再走两步。这样画的那一帧剪辑的时间相同，面板上显示的权重（脚本在动画之前读，是上一帧的）也相同；
3. 截图和参考图比。

## 2026-11-19 的结果

0.967 秒时平均每通道差 3.88/255，差超过 8 的像素 67269 个（7.3%），超过 32 的 9886 个。

- 三个模型的形变（立方体扭转、二十面球凹凸、甜甜圈的骨骼加形变）和桌面一致，场景里只有零星的点不同。
- 差都在左上角的面板上。主要是 UI 的颜色：
  - Stride 的合成器把 UIRenderFeature 放进前向渲染器的透明阶段，UI 跟着色调映射（Hejl2）走；我们的 UI 画在后处理之后（decisions.md 的取舍）。
  - 面板的纯色贴图是 rgba8unorm，按线性值用：按钮 Stride 显示 88、我们 125；面板底色 Stride 10、我们 32。
  - 试过照 Stride 在后处理之前画 UI，平均差降到 1.27（剩下的是文字的栅格化和边缘），没有采用：UI 的颜色会跟着场景的自动曝光变。
- 文字是有意的偏差：Stride 用 FreeType 栅格化，我们按轮廓算覆盖率。

帧时间（`--benchmark 600`，1280x720）：桌面 Stride 4.10 ms。
