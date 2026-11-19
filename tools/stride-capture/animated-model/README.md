# AnimatedModel 的参考截图

```bash
pwsh tools/stride-capture/animated-model/setup.ps1
C:/code/stride-animated-model/samples/Graphics/AnimatedModel/Bin/Windows/Release/AnimatedModel.Windows.exe --capture C:/code/stride-animated-model/reference.png --frames 90
```

`setup.ps1` 从 Stride 源码的 `releases/4.4.2` 标签取出样例（那个版本已经是 4.4.2 / net10.0），入口换成 `AnimatedModelApp.cs` 再编译。
`--capture` 时正在播放的动画每帧都停在第 0 帧，画满 `--frames` 帧后存后备缓冲。窗口在 200% 缩放的屏幕上放不下 640x1136，
系统把它缩成 640x1061，stride-ts 这边用无头 Chrome 开同样大小的视口，把动画也停在第 0 帧再截：

```bash
pnpm exec stride open http://localhost:5186 --headless --size 640x1061 --dpr 1
pnpm exec stride eval "const g = strideGame; const id = g.entities.ids().find((i) => g.entities.entity(i).name === 'CharacterModel'); const a = g.entities.entity(id).get(strideEngine.AnimationComponent); setInterval(() => { for (const p of a.playingAnimations) { p.timeFactor = 0; p.currentTime = 0; } }, 1)"
pnpm exec stride shot ours.png --diff C:/code/stride-animated-model/reference.png
```

## 2026-11-19 的结果

去掉左上角的 UI 按钮（P2 才做 UI）后，平均每通道差 0.148/255，有符号差 -0.05/255，差超过 10 的像素 0.31%，都在角色的边缘。
比对中找到并修掉的：
- 合成器的 PostEffects 是 null 时 Stride 原样拷贝 HDR 画面，我们之前还做色调映射；
- 画进渲染目标贴图的前向渲染器没有透明阶段（TransparentRenderStage 是 null），贴图里不该再出现精灵（我们之前画了，贴图里套着贴图）。
- （P1 收尾时测帧时间发现）合成器的 ForwardLightingRenderFeature 没有 ShadowMapRenderer（是 null），Stride 根本不画阴影，
  我们之前照灯光的设置画了。改成按合成器关掉后，去掉 UI 按钮的区域平均差 0.083/255，差超过 10 的像素 0.105%；
  帧时间从 1.21 ms 降到 0.82 ms（桌面 Stride 0.95 ms）。
