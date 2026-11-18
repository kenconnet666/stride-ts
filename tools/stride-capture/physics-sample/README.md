# PhysicsSample 的参考截图

```bash
pwsh tools/stride-capture/physics-sample/setup.ps1
C:/code/stride-physics-sample/samples/Physics/PhysicsSample/Bin/Windows/Release/PhysicsSample.Windows.exe --capture C:/code/stride-physics-sample/VolumeTrigger.png --scene VolumeTrigger --frames 360
```

`setup.ps1` 从 Stride 源码的 master 取出 PhysicsSample：`releases/4.4.2` 标签里的还是 Bullet 版（`Stride.Physics`），我们移植的是
master 上的 Bepu 版。它改成用 4.4.2 的 nuget 包、net10.0（和另外两个参考一致），合成器资源的版本号从 3.1.0.3 改回 3.1.0.1
（两次升级只是把粒子、UI 的渲染特性标成自有项，4.4.2 读不了新版本号），Windows 工程直接引用 Stride.BepuPhysics，入口换成
`PhysicsSampleApp.cs`。

| 参数 | 作用 |
|---|---|
| `--capture <png>` | 画满 `--frames` 帧（默认 90）后存后备缓冲并退出 |
| `--scene <内容地址>` | 默认场景加载好后换成这个场景（`Raycasting`、`VolumeTrigger`、`Constraints`），帧数从换场景时算 |
| `--freeze-physics` | 仿真不步进（`BepuSimulation.Enabled = false`） |

换场景那一帧要同步加载内容，耗时长，Bepu 那一帧补满 0.25 秒（`MaximumTimeSpanToProcess`），所以帧号和模拟时间对不上；动态的物体
（Constraints 的球）比不了位置，比对时去掉它们。stride-ts 这边用无头 Chrome，1280x720、dpr 1（窗口和样例的 1280x720 一样，没有后处理）：

```bash
pnpm exec stride open "http://localhost:5188/?scene=PhysicsSample/VolumeTrigger" --headless --size 1280x720 --dpr 1
pnpm exec stride shot ours.png --diff C:/code/stride-physics-sample/VolumeTrigger.png
```

要停住物理时，在页面里暂停、重新加载场景、把固定步长设得很大，再单步几帧让脚本的 start 跑完：

```bash
pnpm exec stride pause
pnpm exec stride eval "strideGame.setRootScene('PhysicsSample/Constraints').then(() => strideGame.simulation.configure({ fixedTimeStep: 1e9 }))"
pnpm exec stride step 5
```

## 2026-11-19 的结果

去掉 UI（左右的 `<<`、`>>` 按钮和底部文字，P2）后：

| 场景 | 平均每通道差 | 差超过 10 的像素 | 差在哪里 |
|---|---|---|---|
| Raycasting | 1.32/255 | 2.40% | 箱子正面发光的标志：LogoD 的材质层（MaskC 带自发光），P2 |
| VolumeTrigger | 0.44/255 | 0.81% | 同上；静止后角色胶囊的位置差 1 像素以内 |
| Constraints | 0.13/255（去掉两边的球） | 0.56% | 球在摆，两边相位不同；立方体上的细格线是 mip 的生成方式不同（我们在 GPU 上生成），深浅一致 |

比对中找到并修掉的：VolumeTrigger 的相机是正交投影（`Camera.projection`、`orthographicSize`，Stride 的 OrthoRH），我们之前一律按透视画。
