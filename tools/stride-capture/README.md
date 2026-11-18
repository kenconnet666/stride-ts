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

不加 `--capture`、`--benchmark` 就是原来的游戏。加了以后去掉脚本、动画和角色物理（相机停在场景里的位置），`--capture` 画满 N 帧（默认 180）后把后备缓冲存成 PNG 再退出。窗口是 1280x720，和比对脚本的视口一样。

| 参数 | 作用 |
|---|---|
| `--benchmark N` | 不截图，关掉垂直同步，先画 600 帧稳定下来，再测 N 帧的平均帧时间，连同分辨率和显卡打印到标准输出（窗口程序，要重定向才看得到）|
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

画面：默认设置下平均每通道差 0.6/255，差超过 10 的像素 0%。比对中找到并修掉的：
- 直射光少乘了 π（Stride 的 `MaterialSurfaceLightingAndShading` 把直射光的总和乘 π，`hdr-ratio.cjs` 量出处处 3.14 倍）；
- 材质贴图开了 16 倍各向异性，Stride 默认是三线性（`Filtering = Linear`），远处斜看的网格线因此不同。

剩下的：
- 关掉 FXAA 时近处的粗网格线有差（差超过 10 的像素 1.5%），全是手写 SVG 棋盘格和原 PNG 的差别：换回原 PNG 导入后降到 0.01%；
- 天空盒光照偏暗约 1–2%，蓝色最多（阴影里 191 对 196），没查。

帧时间（RTX 3050 笔记本，1280x720，不限帧率，两边交替各测三轮）：

| | 桌面 Stride 4.4.2（D3D11） | stride-ts（Chrome WebGPU，无头） |
|---|---|---|
| 默认 | 7.48 ms | 8.86 ms |
| 关掉 FXAA、亮部提取和三个效果 | 3.94 ms | 4.95 ms |

我们慢约 18%：不含后处理的部分多 1.0 ms，后处理多 0.4 ms。stride-ts 这边的通道明细见 `../gpu-profile.cjs`（不透明 3.0 ms、阴影图 1.1 ms、后处理 4.0 ms）；桌面 Stride 的通道明细还没测。
