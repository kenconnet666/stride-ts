# UIParticles 的参考截图

```bash
pwsh tools/stride-capture/ui-particles/setup.ps1
C:/code/stride-ui-particles/samples/UI/UIParticles/Bin/Windows/Release/UIParticles.Windows.exe --capture C:/code/stride-ui-particles/reference
pnpm --filter @stride-ts/ui-particles dev
pwsh tools/stride-capture/ui-particles/capture-ours.ps1
```

`setup.ps1` 从 Stride 源码的 `releases/4.4.2` 标签取出样例，入口换成 `UIParticlesApp.cs`（在 PowerShell 里跑：Git Bash 的 tar
把 `C:` 当成远程主机）。`--capture <目录>` 用 GameSettings 的 600x600、固定步长 1/60 秒，不放启动画面：

| 图 | 内容 |
|---|---|
| `newgame.png` | 场景跑 30 帧后导火索设成一半，所有发射器改成固定种子并重置，再跑 60 帧（火在冒） |
| `endgame.png` | 进入结束（SplashScript.EnterEndGame：火停掉，大彩纸移到画面上方），同样定住粒子，60 帧 |

`capture-ours.ps1` 在 stride-ts 这边暂停后单步走同样的 60 步再截，逐张比。CLI 打印的 mean 是三个通道加起来的，下面的表是每通道的平均。

## 2026-11-19 的结果

每通道的平均差（/255，只比 RGB），任一通道差超过 8、32 的像素的比例：

| 图 | 平均差 | 超过 8 | 超过 32 |
|---|---|---|---|
| newgame | 4.65 | 13.6% | 3.6% |
| endgame | 4.68 | 13.3% | 3.6% |

UI 的布局（标题、两个按钮、导火索的位置和长度）、火的位置和翻页动画、彩纸的范围和颜色两边一致。差的来源：

- 背景和按钮的贴图：Stride 把精灵表压成 BC 格式（我们用源图，`--textures source`），平的地方 2.6/255，砖缝、按钮的边这些
  细节处大一些（同 GameMenu 的比对）；文字按 hinting 吸附到像素。
- 彩纸的每个粒子的位置差一点：两边种子相同，但生成器每帧生成数的小数部分（carryOver）在重置时不清零（Stride 就是这样），
  重置前两边跑的时长不一样，生成的时刻差一帧，粒子的年龄就差 1/60 秒。把力场的衰减换回 Stride 的写法（见 decisions.md）
  结果不变，所以不是那处偏差引起的。

帧时间（RTX 3050 笔记本，高性能电源模式，新游戏的状态，600x600，不限帧率，`--benchmark 1200`）：桌面 Stride 0.79 ms，
stride-ts 0.47 ms（`tools/measure.ps1`）。一开始 1.28 ms：每个粒子展开顶点时分配了好几个小数组（改成标量），画面外的粒子
系统也展开（改成按包围盒剔除，同 Stride；新游戏时大彩纸停在画面外，400 个粒子）。
