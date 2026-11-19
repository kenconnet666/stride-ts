# JumpyJet 的参考截图

```bash
pwsh tools/stride-capture/jumpy-jet/setup.ps1
C:/code/stride-jumpy-jet/samples/Games/JumpyJet/Bin/Windows/Release/JumpyJet.Windows.exe --capture C:/code/stride-jumpy-jet/reference
pwsh tools/stride-capture/jumpy-jet/capture-ours.ps1
```

`setup.ps1` 从 Stride 源码的 master 取出 JumpyJet：`releases/4.4.2` 标签里的还是 Bullet 版，我们移植的是 master 上的 Bepu 版。
它做了这几处改动：
- 改用 4.4.2 的 nuget 包、net10.0；
- 合成器资源的版本号从 3.1.0.3 改回 3.1.0.1（同 physics-sample）；
- 入口换成 `JumpyJetApp.cs`。

`--capture <目录>` 的截图流程：
1. 固定步长 1/60 秒，每次 Update 都画（`ForceOneUpdatePerDraw`，不然画得慢时会跳帧，按帧号截不到）。
2. 第 30 帧把画面定住：四层背景停在 ScrollPos 50、100、150、200（BackgroundSection 的私有成员，用反射设），几组管子放到固定的位置和高度。
3. 下一帧截 `Menu.png`。
4. 再下一帧广播开始（GameGlobals 是 internal，用反射取事件键）、UI 换到计分页面，20 帧后截 `Game.png`。

截图模式下进程声明 per-monitor DPI 感知：不声明时，150% 缩放下 1136 高的窗口放大到 1704 物理像素、超出屏幕，被压到屏幕高度，
后备缓冲也跟着变成 640x1061。后备缓冲不是 640x1136 时报错。

`capture-ours.ps1` 在 stride-ts 这边做同样的事：
- 自己开一个 640x1136 的无头 Chrome，暂停后用固定步长单步；
- 背景用 `BackgroundSection.scrollTo` 定住，开始用调试命令 `start-game`；
- 然后和参考图逐张比。

## 2026-11-19 的结果

| 画面 | 平均每通道差 | 差超过 8 的像素 | 差超过 32 的像素 |
|---|---|---|---|
| Menu | 4.04/255 | 64000（8.8%） | 4662（0.6%） |
| Game | 5.79/255 | 133046（18.3%） | 10514（1.4%） |

布局（背景、管子、飞机的位置和转角、按钮、计分板）两边一致。剩下的差别主要来自贴图的块压缩，两边的编码器不同：
- 把地面这一层和源图 tex1.png 按 1:1 对齐来比，Stride 的 BC 压缩平均差 2.85，我们的 UASTC 转 BC7 平均差 3.2；
- 我们在源图很暗（0–14）的像素上平均亮 5–8。贴图本身转码回来和源图在 ±0.5 以内，不是取样位置的问题（已排除半像素偏移、线性空间加常数、2.2 次幂这几种假设）。目前看是 UASTC 转 BC7 在暗的纹理区域的误差，还没有完全确认。

比对中找到并修掉的：
- 背景的设计分辨率取游戏设置的默认后备缓冲（以前取第一次画时的窗口大小，窗口比背景图大时露底）；
- 游戏渲染器下面借用的前向渲染器不做后处理（以前开着默认的色调映射，整体暗约四分之一）；
- 异步脚本的续体在当帧画之前跑完（以前 await nextFrame 之后的代码要等整帧画完才执行，飞机的移动晚一帧才画出来）。

帧时间（主菜单，640x1136，不限帧率）：桌面 Stride 0.57 ms（`--benchmark 2000`），stride-ts 0.57 ms。导入 41 s，构建 13 s，
页面下载 7.0 MB（brotli 4.2 MB），第一帧 1.4 s。
