# 桌面 Stride 的参考截图

用官方 Stride 4.4.2（nuget）编出 Third Person Platformer，截一张静态画面，和 stride-ts 的 `apps/platformer` 逐像素比对（`../compare-stride.cjs`、`../hdr-ratio.cjs`）。

## 搭建

```bash
pwsh tools/stride-capture/setup.ps1
```

从 `C:\Users\Administrator\IdeaProjects\stride` 的 `samples/Templates` 拷出模板和两个素材包到 `C:\code\stride-tpp`，改成 4.4.2 / net10.0，换上截图用的入口 `ThirdPersonPlatformerApp.cs`，再编 Release。参考图不进仓库（每张约 1 MB），需要时重新截。

## 截图

```bash
C:/code/stride-tpp/Templates/ThirdPersonPlatformer/ThirdPersonPlatformer/Bin/Windows/Release/ThirdPersonPlatformer.Windows.exe --capture C:/code/stride-tpp/reference.png --frames 240
```

不加 `--capture` 就是原来的游戏。加了以后去掉脚本、动画和角色物理（相机停在场景里的位置），画满 N 帧（默认 180）后把后备缓冲存成 PNG 再退出。窗口是 1280x720，和比对脚本的视口一样。

| 参数 | 作用 |
|---|---|
| `--frames N` | 画满几帧再截（自动曝光要几秒才稳定，默认设置下用 240） |
| `--disable fxaa,brightfilter,bloom,lightstreak,lensflare` | 关掉这些后处理 |
| `--exposure EV` | 关掉自动曝光，固定曝光 2^EV（比光照本身时用 0） |
| `--only-light directional\|skybox` | 只留一种光（分开比直射光和环境光） |

stride-ts 这边对应的设置在页面里执行，例如固定曝光加关 FXAA 和亮部提取：

```js
const P = globalThis.strideGame.graphicsCompositor.postEffects;
P.antialiasing.enabled = P.brightFilter.enabled = false; P.toneMap.autoExposure = false; P.toneMap.exposure = 0;
```

## 2026-11-18 的结果

默认设置下平均每通道差 0.7/255，差超过 10 的像素 0%，只剩地面网格线的亚像素差（SVG 栅格化的棋盘格和原 PNG 的 mip 不同）。比对中找到并修掉的：直射光少乘了 π（Stride 的 `MaterialSurfaceLightingAndShading` 把直射光的总和乘 π，`hdr-ratio.cjs` 量出处处 3.14 倍）。天空盒光照的蓝色通道还低约 2%（阴影里 191 对 196），没查。
