# BepuSample 的参考截图

```bash
pwsh tools/stride-capture/bepu-sample/setup.ps1
C:/code/stride-bepu-sample/samples/Physics/BepuSample/Bin/Windows/Release/win-x64/BepuSample.Windows.exe --capture C:/code/stride-bepu-sample/Ropes.png --scene "Scenes/Ropes" --frames 120 --freeze-physics
```

`setup.ps1` 从 Stride 源码的 master 取出 BepuSample（4.4.2 的标签里还没有这个样例），改成用 4.4.2 的 nuget 包、net10.0，
合成器资源的版本号从 3.1.0.3 改回 3.1.0.1（同 [physics-sample](../physics-sample/README.md)），Windows 工程直接引用
Stride.BepuPhysics，去掉另一个入口 `BepuSample.Windows.DemoApp.cs`，入口换成 `BepuSampleApp.cs`。

| 参数 | 作用 |
|---|---|
| `--capture <png>` | 画满 `--frames` 帧（默认 90）后存后备缓冲并退出；同时关掉 UI、调试文字和性能统计的叠加层 |
| `--scene <内容地址>` | 主场景加载好后把子场景换成这个（`Scenes/Colliders`、`Scenes/Constraint`、`Scenes/Convex And Mesh Collider`、`Scenes/Cube Fountain`、`Scenes/Cube Mixer`、`Scenes/Material Properties`、`Scenes/Ropes`） |
| `--freeze-physics` | 仿真不步进（`BepuSimulation.Enabled = false`），物体停在场景里摆的位置 |

窗口是 1600x900。stride-ts 这边用无头 Chrome，同样的尺寸，先停住仿真再换场景（停住时生成器、绳子的脚本照样建物体，
物体不动）：

```bash
pnpm exec stride open "http://localhost:5190/?scene=Colliders" --headless --size 1600x900 --dpr 1
pnpm exec stride eval "strideGame.simulation.enabled = false"
pnpm exec stride call scene '"Ropes"'
pnpm exec stride shot ours.png --diff C:/code/stride-bepu-sample/Ropes.png
```

## 2026-11-19 的结果

停住物理、去掉 UI 和调试文字后：

| 场景 | 平均每通道差 | 差超过 8 的像素 | 差超过 32 的像素 |
|---|---|---|---|
| Colliders | 0.58/255 | 0.86% | 0.04% |
| Constraint | 0.63/255 | 0.73% | 0.02% |
| Convex And Mesh Collider | 1.11/255 | 3.2% | 0.01% |
| Cube Fountain | 0.61/255 | 0.60% | 0% |
| Cube Mixer | 0.37/255 | 0.29% | 0.02% |
| Material Properties | 0.58/255 | 0.64% | 0.01% |
| Ropes | 0.59/255 | 0.65% | 0.05% |

剩下的差：地板 QR 图案的边缘（两边的块压缩不同：我们是 UASTC 转码成 BC7，Stride 直接编 BC 格式），Convex 场景里桥上的镜面
（Stride 的合成器开着环境光遮蔽和屏幕空间反射，P4）。

比对中找到并修掉的：
- 整个画面暗约 40/255：合成器关掉了色调映射（ColorTransforms 里的 ToneMap），我们以前只导入"有没有后处理"，效果一律按默认全开。
  现在按效果导入开关（`ScenePostEffects`）。
- 桥（bridge.obj）是白色的平滑过渡，桌面版是黑色平面：OBJ 没写 `usemtl`，Assimp 给它叫 DefaultMaterial 的材质，对应模型资源里
  同名的槽位（场景把它覆盖成 QRMat），我们以前落到了默认材质；OBJ 没有法线，Assimp 生成逐面法线，我们以前让 ufbx 按平滑组生成。
- 地板图案的边缘错开一个纹素：Github.png 是 1015x1015，Stride 压缩前用 Lanczos3 缩放到 1016（块压缩要 4 的倍数），我们以前原样用。
