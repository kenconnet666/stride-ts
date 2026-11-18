# TopDownRPG 的参考截图

```bash
pwsh tools/stride-capture/topdown-rpg/setup.ps1
C:/code/stride-topdown-rpg/Templates/TopDownRPG/TopDownRPG/Bin/Windows/Release/TopDownRPG.Windows.exe --capture C:/code/stride-topdown-rpg/reference.png --frames 240 --no-scripts
```

`setup.ps1` 从 Stride 源码当前分支复制 TopDownRPG 模板和它用的四个 Packs（这个分支的模板已经是 Bepu 版，stride-ts 导入的就是它；
`releases/4.4.2` 标签里还是 Bullet 版），改成用 4.4.2 的 nuget 包、net10.0，合成器资源的版本号改回 3.1.0.1，入口换成 `TopDownRPGApp.cs`。
`Stride.BepuPhysics.Navigation` 没有 4.4.2 的 nuget 包，截图又不需要脚本，所以去掉这个包和用到它的 PlayerController、
AnimationController、EnableDynamicNavigation，场景里的导航组件由 Stride 当作无法加载的对象跳过。

| 参数 | 作用 |
|---|---|
| `--capture <png>` | 画满 `--frames` 帧（默认 60）后存后备缓冲并退出；自动曝光要几秒才稳定，用 240 |
| `--no-scripts` | 场景出现时、脚本启动前去掉所有脚本：角色停在静止姿势、金币不转；角色照常落到地面上 |

窗口是 1280x720。stride-ts 这边同样不挂脚本加载 MainScene：

```bash
pnpm exec stride open "http://localhost:5194/" --headless --size 1280x720 --dpr 1
pnpm exec stride eval "const n = ['TopDownRPG.Player.PlayerController', 'TopDownRPG.Player.PlayerInput', 'TopDownRPG.Player.AnimationController', 'TopDownRPG.Gameplay.CrateScript', 'TopDownRPG.Gameplay.Trigger', 'TopDownRPG.Gameplay.CoinScript', 'TopDownRPG.Gameplay.MusicScript', 'TopDownRPG.Gameplay.LootCoinScript', 'RecastNavigationComponent']; strideGame.setRootScene('TopDownRPG/MainScene', { scripts: Object.fromEntries(n.map((k) => [k, null])) }).then(() => 1)"
pnpm exec stride shot ours.png --diff C:/code/stride-topdown-rpg/reference.png
```

## 2026-11-19 的结果

平均每通道差 2.45/255，差超过 8 的像素 0.13%，超过 32 的 7 个像素。差在格子贴图的颜色上（亮格子差在红、蓝，暗格子差在绿，
整体我们亮约 1.5/255）：Stride 把 PrototypingBlocks 的网格贴图压成 BC 格式，我们导入时用 `--textures source`，原样用 PNG。
几何、光照、阴影、角色的静止姿势一致。
