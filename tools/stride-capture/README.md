# 桌面 Stride 的参考截图

用官方 Stride 4.4.2（nuget）编出 Third Person Platformer，截一张静态画面，和 stride-ts 的 `apps/platformer` 逐像素比对（`stride shot --diff`、`../hdr-ratio.ts`）。

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
| `--gpu-profile` | 和 `--benchmark` 一起用：打开 Stride 的 Profiler，另外打印各渲染器的平均 GPU 时间（Stride 自己的时间戳，嵌套的渲染器各算各的） |
| `--dump-skybox` | 场景出现时打印天空盒光照的运行时数据：球谐系数、镜面立方体贴图的规格和每级每个面的平均颜色 |
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
- 直射光少乘了 π（Stride 的 `MaterialSurfaceLightingAndShading` 把直射光的总和乘 π，`hdr-ratio` 量出处处 3.14 倍）；
- 材质贴图开了 16 倍各向异性，Stride 默认是三线性（`Filtering = Linear`），远处斜看的网格线因此不同；
- 天空盒光照偏暗约 2%、蓝色最多：我们用了 DDS 自带的 mip（侧面偏暗偏黄），Stride 的贴图编译默认从第 0 级重建 mip。
  `--dump-skybox` 和 stride-ts 运行时的镜面立方体贴图逐级比找到的，修正后每级每个面的平均值一致到 4 位小数。

剩下的只有有意保留的：关掉 FXAA 时近处的粗网格线有差（差超过 10 的像素 1.5%），是手写 SVG 棋盘格和原 PNG 的差别，
换回原 PNG 导入后降到 0.01%。固定曝光、关掉后处理时整图平均有符号差在 ±0.15/255 以内。

帧时间（RTX 3050 笔记本，1280x720，不限帧率，两边交替各测三轮，取中位数）：

| | 桌面 Stride 4.4.2（D3D11） | stride-ts 第一次比 | stride-ts 现在（Chrome WebGPU，无头） |
|---|---|---|---|
| 默认 | 7.70 ms | 8.86 ms | 6.65 ms |
| 关掉 FXAA、亮部提取和三个效果 | 3.95 ms | 4.95 ms | 3.34 ms |

第一次比时我们慢 18%。按通道比（Stride 用 `--gpu-profile`，我们用 `stride perf`）找到并修掉：

| 通道 | Stride | 修之前 | 修之后 | 原因 |
|---|---|---|---|---|
| 不透明 | 0.91 ms（加深度预通道 0.16） | 3.0 ms | 1.6 ms（加深度预通道 0.11） | PCF 按运行时的核大小循环、动态下标取权重，改成照 Stride 按核大小完全展开；补上 Stride 默认合成器的深度预通道 |
| FXAA 本身 | 0.41 ms | 0.62 ms | 0.52 ms | 沿边搜索按预设展开（Stride 的预设是编译期定义） |
| 后处理合计 | 3.36 ms | 5.46 ms | 3.9 ms | 上一轮：合并叠加、光芒多渲染目标、共用 1/2 亮部图 |
| 阴影图 | 1.71 ms | 1.2 ms | 1.2 ms | |

不透明通道还比 Stride 多约 0.6 ms，几乎都在阴影采样上（关掉阴影接收只剩 1.0 ms）；采样次数、图集尺寸和格式两边一样，
剩下的差多半是 Chrome 的 D3D12 翻译层，没再往下查。全分辨率的简单全屏通道我们也普遍慢 30% 左右（比如 FXAA 的范围压缩 0.24 对 0.17 ms），原因同上。
