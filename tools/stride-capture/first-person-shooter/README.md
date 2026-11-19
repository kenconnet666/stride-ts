# FirstPersonShooter 的参考截图

```bash
pwsh tools/stride-capture/first-person-shooter/setup.ps1
C:/code/stride-first-person-shooter/Templates/FirstPersonShooter/FirstPersonShooter/Bin/Windows/Release/FirstPersonShooter.Windows.exe --capture C:/code/stride-first-person-shooter/reference.png --frames 240 --no-scripts
```

`setup.ps1` 从 Stride 源码当前分支复制 FirstPersonShooter 模板和它用的四个 Packs（这个分支的模板已经是 Bepu 版，stride-ts 导入的
就是它；`releases/4.4.2` 标签里还是 Bullet 版），改成用 4.4.2 的 nuget 包、net10.0，合成器资源的版本号改回 3.1.0.1，入口换成
`FirstPersonShooterApp.cs`。

| 参数 | 作用 |
|---|---|
| `--capture <png>` | 画满 `--frames` 帧（默认 60）后存后备缓冲并退出；自动曝光要几秒才稳定，用 240 |
| `--no-scripts` | 场景出现时、脚本启动前去掉所有实体（含子实体）的脚本：手臂停在静止姿势，视角不动，子弹数精灵停在第 0 帧 |

截完图还打印 PlayerCharacter 和 Camera 的世界位置：角色站立的高度决定相机的高度，地面上的网格线对不齐时先比这个。

窗口是 1280x720。stride-ts 这边同样不挂脚本加载 MainScene：

```bash
pnpm exec stride open "http://localhost:5196/" --headless --size 1280x720 --dpr 1
pnpm exec stride eval "const n = ['FirstPersonShooter.Player.PlayerController', 'FirstPersonShooter.Player.PlayerInput', 'FirstPersonShooter.FpsCamera', 'FirstPersonShooter.Player.WeaponScript', 'FirstPersonShooter.Player.AnimationController', 'FirstPersonShooter.EffectController']; strideGame.setRootScene('FirstPersonShooter/MainScene', { scripts: Object.fromEntries(n.map((k) => [k, null])) }).then(() => 1)"
pnpm exec stride shot ours.png --diff C:/code/stride-first-person-shooter/reference.png
```

## 2026-11-19 的结果

平均每通道差 2.69/255，差超过 8 的像素 1.3%，超过 32 的 819 个（0.09%）。各处都是我们整体亮约 1.5–2.3/255（天空、地面、
墙、枪一样），格子贴图上还有 Stride 压成 BC 格式带来的颜色差（同 TopDownRPG）；几何、阴影、准星、子弹数精灵一致。

第一次比时平均差 3.98/255，地面的网格线竖直方向错开约 4 像素：桌面 Stride 的角色站在 y = 0.0497（胶囊底贴着地面），我们的
陷进地面 2 cm（0.030），相机跟着矮 2 cm。原因是 Jolt 默认的穿透容差（`mPenetrationSlop` = 2 cm），Bepu 的软接触静止时
几乎不陷进去。原生 0.21.1 把它降到 1 mm 后角色站在 0.049、箱子在 0.499（边长 1 m）。

2026-11-19 加了粒子（SpawnerBurst、SpawnerFromDistance）和材质层（LogoA、LogoD 的箱子）之后重截：平均差 2.70/255，起始视角里没有
带层的箱子，结果不变。

## 2026-11-19 重截（`capture-ours.ps1`，平均每通道差）

`pwsh tools/stride-capture/capture-all.ps1 -Samples first-person-shooter` 起开发服务器、截图、和参考图比、停服务器，一步做完。

平均差 0.74，超过 8 的像素 0.24%，超过 32 的 0.07%。
