# Platformer2D 的参考截图

```bash
pwsh tools/stride-capture/platformer2d/setup.ps1
C:/code/stride-platformer2d/samples/Templates/Platformer2D/Platformer2D/Bin/Windows/Release/Platformer2D.Windows.exe --capture C:/code/stride-platformer2d/reference.png --frames 120 --no-scripts
```

`setup.ps1` 从 Stride 源码的 `releases/4.4.2` 标签取出模板（已经是 4.4.2 的包和 net10.0），Game 工程补上脚本用到的
Stride.BepuPhysics，入口换成 `Platformer2DApp.cs`。

| 参数 | 作用 |
|---|---|
| `--capture <png>` | 画满 `--frames` 帧（默认 60）后存后备缓冲并退出 |
| `--no-scripts` | 场景出现时、脚本启动前去掉所有脚本：金币和角色的精灵停在默认帧（两边的动画时间对不上）；角色照常落到地面上 |

窗口是 1280x720（GameSettings 的后备缓冲尺寸）。stride-ts 这边同样不挂脚本，物理照常跑（角色落地后静止）：

```bash
pnpm exec stride open "http://localhost:5192/" --headless --size 1280x720 --dpr 1
pnpm exec stride eval "strideGame.setRootScene('Platformer2D/MainScene', { scripts: { 'Platformer2D.Player.PlayerController': null, 'Platformer2D.Gameplay.CoinRotation': null, 'Platformer2D.Gameplay.CollectCoin': null } }).then(() => 1)"
pnpm exec stride shot ours.png --diff C:/code/stride-platformer2d/reference.png
```

参考图带 alpha 通道（后备缓冲原样存的），看图时按 RGB 看。

## 2026-11-19 的结果

平均每通道差 2.17/255，差超过 32 的像素 1.1%。精灵的形状和位置一致（按"不是天空的颜色"比，两边只差 1173 个像素，都在骑士的轮廓上），
天空的平均差 0.07/255；差都在精灵内部（平均 9/255）：Stride 把精灵表压成 BC 格式（SpriteSheet 的 IsCompressed 默认开），
像素画的颜色被块压缩带偏，骑士的轮廓也有一两个像素的出入；我们导入时用 `--textures source`，精灵表的源图原样用 PNG。

## 2026-11-19 重截（`capture-ours.ps1`，平均每通道差）

`pwsh tools/stride-capture/capture-all.ps1 -Samples platformer2d` 起开发服务器、截图、和参考图比、停服务器，一步做完。

平均差 1.08，超过 8 的像素 5.61%，超过 32 的 1.77%。原因同上：差都在精灵内部（Stride 把精灵表压成 BC 格式）。
