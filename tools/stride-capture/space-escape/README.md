# SpaceEscape 的参考截图

```bash
pwsh tools/stride-capture/space-escape/setup.ps1
C:/code/stride-space-escape/samples/Games/SpaceEscape/Bin/Windows/Release/SpaceEscape.Windows.exe --capture C:/code/stride-space-escape/reference
pwsh tools/stride-capture/space-escape/capture-ours.ps1
```

`setup.ps1` 从 Stride 源码的 `releases/4.4.2` 标签取出 SpaceEscape。那个版本已经用 4.4.2 的 nuget 包、net10.0，和 master 只差 GameSettings 里一项音频设置。入口换成 `SpaceEscapeApp.cs`。

`--capture <目录>` 的截图流程：
1. 固定步长 1/60 秒，每次 Update 都画（`ForceOneUpdatePerDraw`）。窗口 640x1136，声明 DPI 感知（同 jumpy-jet）。
2. 关卡是随机生成的。第 30 帧把它换成固定的：清掉生成的段，按 a00、b00、b01、b02、b03、b04 接上，都不放随机障碍物；b00 那段的中间道、段中心放一个 Obstacle1（LevelGenerator、BackgroundScript 的私有成员用反射取）。
3. 下一帧截 `Menu.png`。
4. 再下一帧开始游戏（`GameScript.StartGame`），20 帧后截 `Run.png`。

`capture-ours.ps1` 在 stride-ts 这边做同样的事：自己开一个 640x1136 的无头 Chrome，暂停后用固定步长单步；关卡用调试命令 `fixed-level`，开始用 `start-game`；然后和参考图逐张比。

## 2026-11-19 的结果

| 画面 | 平均每通道差 | 差超过 8 的像素 | 差超过 32 的像素 |
|---|---|---|---|
| Menu | 3.14/255 | 36801（5.1%） | 4336（0.6%） |
| Run | 5.30/255 | 82516（11.3%） | 10177（1.4%） |

关卡、走廊往远处弯、远处的雾、天空板、角色、UI 两边一致。看得出的差别：金属表面的高光略有不同；角色跑起来的姿势差一点（动画采样）。

帧时间（主菜单，640x1136，不限帧率）：桌面 Stride 0.91 ms（`--benchmark 2000`），stride-ts 0.78 ms。构建 8 s，页面下载 5.75 MB
（brotli 4.0 MB），第一帧 1.0 s。
