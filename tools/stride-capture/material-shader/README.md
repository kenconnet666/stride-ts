# MaterialShader 的参考截图

```bash
pwsh tools/stride-capture/material-shader/setup.ps1
C:/code/stride-material-shader/samples/Graphics/MaterialShader/Bin/Windows/Release/MaterialShader.Windows.exe --capture C:/code/stride-material-shader/reference/Water.png
pwsh tools/stride-capture/material-shader/capture-ours.ps1
```

`setup.ps1` 从 Stride 源码的 `releases/4.4.2` 标签取出 MaterialShader（已经是 4.4.2 的包、net10.0），入口换成 `MaterialShaderApp.cs`。

`--capture <png>`：固定步长 1/60 秒、每次 Update 都画，窗口 1280x720，画满 `--frames` 帧（默认 120）后截图，把那一帧的游戏时间写进旁边的 `.time`。水面按 Global.Time 动，所以 `capture-ours.ps1` 在 stride-ts 这边：
1. 暂停、用固定步长；
2. 用 `stride time --total` 把游戏时钟拨到参考图那一帧的前一帧，再走一步，这样画的那一帧时间相同；
3. 截图和参考图比。

## 2026-11-19 的结果

2.000 秒时平均每通道差 0.36/255，差超过 8 的像素 1227 个（0.13%），超过 32 的 4 个。水面的起伏（位移贴图）和高光的波纹（法线贴图）两边一致。
