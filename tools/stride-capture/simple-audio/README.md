# SimpleAudio 的参考截图

```bash
pwsh tools/stride-capture/simple-audio/setup.ps1
C:/code/stride-simple-audio/samples/Audio/SimpleAudio/Bin/Windows/Release/SimpleAudio.Windows.exe --capture C:/code/stride-simple-audio/reference
pnpm --filter @stride-ts/simple-audio dev
pwsh tools/stride-capture/simple-audio/capture-ours.ps1
```

`setup.ps1` 从 Stride 源码的 `releases/4.4.2` 标签取出样例，入口换成 `SimpleAudioApp.cs`（在 PowerShell 里跑：Git Bash 的 tar
把 `C:` 当成远程主机）。`--capture <目录>` 用 GameSettings 的 1280x720，不放启动画面：

| 图 | 内容 |
|---|---|
| `idle.png` | 60 帧后，波形图透明 |
| `wave.png` | 下一帧把两个波形图放回起点（左 0.35、右 0.65，同点击时）、不透明度设成 1 |

`capture-ours.ps1` 在 stride-ts 这边暂停后做同样的设置再截，逐张比。声音不比：两边放的是同一个源文件（我们原样复制），
冒烟脚本核对播放状态、位置在走、主音量的输出不是静音。

## 2026-11-19 的结果

每通道的平均差（/255，只比 RGB）：idle、wave 都是 1.53，差超过 8 的像素 0.5%、0.6%，超过 32 的 0.2%。差在背景图上：
Stride 把贴图压成 BC 格式，暗的渐变上有一圈圈的色带，我们用源图；文字按 hinting 吸附到像素。布局、波形图的位置和不透明度一致。

帧时间（RTX 3050 笔记本，高性能电源模式，1280x720，不限帧率，`--benchmark 1200`）：桌面 Stride 0.48 ms，stride-ts 0.39 ms
（`tools/measure.ps1`）。
