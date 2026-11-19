# ParticlesSample 的参考截图

```bash
pwsh tools/stride-capture/particles-sample/setup.ps1
C:/code/stride-particles-sample/samples/Particles/ParticlesSample/Bin/Windows/Release/ParticlesSample.Windows.exe --capture C:/code/stride-particles-sample/reference
pnpm --filter @stride-ts/particles-sample dev
pwsh tools/stride-capture/particles-sample/capture-ours.ps1
```

`setup.ps1` 从 Stride 源码的 `releases/4.4.2` 标签取出样例，入口换成 `ParticlesSampleApp.cs`（在 PowerShell 里跑：Git Bash 的 tar
把 `C:` 当成远程主机）。`--capture <目录>` 用 GameSettings 的 1280x720、固定步长 1/60 秒，不放启动画面，七个场景挨个换成根场景：
跑 30 帧后所有发射器改成固定种子并重置，再跑 60 帧截 `<场景名>.png`。

`capture-ours.ps1` 在 stride-ts 这边暂停后换场景、单步走同样的步数再截，逐张比。它用自己的无头 Chrome（`STRIDE_BROWSER_DIR`），
不关 `stride open` 开着的窗口。结果是 `ours/` 下的图和 `-diff.png`，跑完自己关掉这个 Chrome。

## 2026-11-19 的结果

每通道的平均差（/255，只比 RGB），任一通道差超过 8、32 的像素的比例：

| 场景 | 平均差 | 超过 8 | 超过 32 |
|---|---|---|---|
| MainScene | 1.74 | 4.7% | 2.7% |
| AnimatedParticles | 0.70 | 1.0% | 0.2% |
| ChildParticles | 1.42 | 4.6% | 1.5% |
| CustomMaterials | 0.91 | 1.3% | 0.5% |
| CustomParticles | 2.09 | 2.6% | 1.9% |
| Lasers | 1.85 | 2.4% | 1.5% |
| RibbonParticles | 1.19 | 2.1% | 1.6% |

粒子的位置、形状、颜色、飘带、子粒子、自定义模块和材质、激光的滚动纹理两边一致。剩下的差在火和烟的翻页贴图（BC 压缩和
我们的 KTX2 转码不同）和粒子边缘。

帧时间（RTX 3050 笔记本，MainScene，1280x720，不限帧率，`tools/measure.ps1` 和 `--benchmark 1200`）：桌面 Stride 1.02 ms，stride-ts
0.86 ms。构建 10.6 s，页面下载 4.4 MB（brotli 2.85 MB），第一帧 1.12 s。

比对中找到并修掉的：

- 平台的金属材质（DullSilver、RedCoating）的光泽度来自贴图，我们以前只用后备值（粗糙度 0，金属表面只映出暗的环境，发黑）：
  加上光泽度贴图（`glossinessTexture`），ChildParticles 11.6 → 1.4，Lasers 12.0 → 1.9。
- 镜面颜色工作流（PolishedStone）Stride 默认能量守恒（`IsEnergyConservative`：漫反射乘 1 - 镜面），我们以前漫反射不变暗，
  平台亮了约 25%：改正后 MainScene 5.8 → 1.7，RibbonParticles 5.9 → 1.2。PhysicsSample 的 Raycasting 重新比过，去掉 UI 后
  1.34/255（原来 1.32，差在材质层的标志上），没有变差。
- 冒烟时查到的：换场景时 PrefabInstance 的后台任务留下未处理的拒绝，加了 `addTask`（Stride 的 Script.AddTask）。
