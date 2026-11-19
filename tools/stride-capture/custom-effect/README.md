# CustomEffect 的参考截图

```bash
pwsh tools/stride-capture/custom-effect/setup.ps1
C:/code/stride-custom-effect/samples/Graphics/CustomEffect/Bin/Windows/Release/CustomEffect.Windows.exe --capture C:/code/stride-custom-effect/reference/Ripple.png
pnpm --filter @stride-ts/custom-effect dev
pwsh tools/stride-capture/custom-effect/capture-ours.ps1
```

`setup.ps1` 从 Stride 源码的 `releases/4.4.2` 标签取出 CustomEffect（已经是 4.4.2 的包、net10.0），入口换成 `CustomEffectApp.cs`。

`--capture <png>`：固定步长 1/60 秒、每次 Update 都画，窗口 1280x720，不放启动画面，画满 `--frames` 帧（默认 120）后截图，把那一帧的游戏时间写进旁边的 `.time`。水波纹的相位按时间算，所以 `capture-ours.ps1` 在 stride-ts 这边把游戏时钟拨到参考图那一帧的时间再截（做法同 [material-shader](../material-shader/README.md)）。

## 2026-11-19 的结果

2.000 秒时平均每通道差 0.43/255。波纹的形状、相位和亮度两边一致，差在标志的字母边缘：Stride 的边缘有一圈暗边（源图透明区是黑的，Stride 不渗色），我们导入时做了 alpha 渗色（见 docs/architecture.md 的贴图），没有暗边。
