# CSharpIntermediate 的参考截图

```bash
pwsh tools/stride-capture/csharp-intermediate/setup.ps1
C:/code/stride-csharp-intermediate/Tutorials/CSharpIntermediate/CSharpIntermediate/Bin/Windows/Release/CSharpIntermediate.Windows.exe --capture C:/code/stride-csharp-intermediate/reference
pnpm --filter @stride-ts/csharp-intermediate dev
pwsh tools/stride-capture/csharp-intermediate/capture-ours.ps1
pwsh tools/stop-dev.ps1
```

`setup.ps1` 取 Stride 源码当前分支的样例（Bepu 版，stride-ts 导入的就是它）和三个资源包，改成用 4.4.2 的 nuget 包、net10.0，入口换成 `CSharpIntermediateApp.cs`。导航教程（11_Navigation）从截图工程里去掉了：它用的 Stride.BepuPhysics.Navigation 没有发布 4.4.2 的包（本机编的 4.5.3-dev4 有，但那一版的资源编译器要另外的原生库），别的教程用不到它。

`--capture <目录>` 用 GameSettings 的 1280x720，不放启动画面，依次把根场景换成四个教程的完成版（同点菜单里的按钮），各等 90 帧截一张：

| 图 | 教程 | 看什么 |
|---|---|---|
| `raycasting.png` | Raycasting | 两把武器的激光伸到命中的地方（射线的结果直接画在场景里）、三排箱子 |
| `project.png` | Project & Unproject | 父子两个球 |
| `scene.png` | Scene loading | 场景 A |
| `audio.png` | Audio | 带发射器的实体和相机的位置 |

截五张：射线、投影、场景加载、声音四个教程的完成版，加上场景加载教程里按键才换到的第二个场景（SceneB，直接当根场景加载；
里面有一盏投阴影的点光，球带刚体，所以这一张两边都停住仿真）。`--only <名字>` 只截一张，`--no-local-shadows` 关掉点光、聚光的阴影
（分开比光照本身和阴影）。选的都是不按键就不动的场景。两个相机教程没有截：Stride 的脚本一启动就锁住鼠标、按鼠标的移动转视角，截图的那一秒半里碰一下鼠标画面就变了。

两边都关掉色调映射的亮度适应、不画调试文字（Stride 的调试文字只在调试版显示），只比顶上 40 像素的菜单按钮以下的部分，原因同 [csharp-beginner](../csharp-beginner/README.md)。

## 2026-11-19 的结果

菜单按钮以下的画面，平均每通道差（/255）和任一通道差超过 8、32 的像素的比例：

| 图 | 平均差 | 超过 8 | 超过 32 |
|---|---|---|---|
| raycasting | 1.00 | 2.19% | 0.75% |
| project | 0.52 | 0.02% | 0.00% |
| scene | 0.66 | 0.58% | 0.00% |
| audio | 1.05 | 0.81% | 0.18% |
| sceneb（2026-11-20，点光的阴影；法线改用逆转置以后） | 0.29 | 0.02% | 0.00% |

射线那张：绿色的玻璃箱子（`MaterialSpecularThinGlassModelFeature`）做了以后从 2.11 降到 1.71，蓝色的清漆箱子（`MaterialClearCoatFeature`，车漆：底漆、金属碎片、清漆）做了以后降到 1.00，两种箱子各个面的平均颜色两边差不到 2/255。剩下最大的一块在左边玻璃箱子的下半截（透过玻璃看到的东西，红色通道差 7/255）。

第一次比是 25.64、60.18、67.00、47.10：木地板在我们这边是映着天空的镜面（曝光跟着整个变暗），激光是白的、没伸到命中的地方。都是材质和模型的导入问题，这个样例第一次碰到，见 docs/decisions.md 的"材质：着色模型、停用的特性、化不成固定槽的属性"：

- 木地板（board1B）只有镜面颜色、没有镜面着色模型，在 Stride 里不反光；它的光泽度是"贴图 × 0.3"，以前导入成 0；
- 激光的材质里有一个停用的自发光，以前照样导入了；
- 激光是没给材质的程序模型（圆柱），红色的材质由实体覆盖，以前这种模型没有材质槽、覆盖用不上；
- 脚本用 `FindChild("Laser")` 找激光，它在武器模型下面一层，以前只找直接子实体。

SceneB：点光投在地面上的拱的影子、两个球投在拱顶和柱子上的影子两边对得上。第一次比是 1.23，差在拱顶内侧的两肩（我们亮 12/255 左右），关掉阴影比也在：这个拱的缩放不等比（X 1.68、Z 1.99），我们直接用世界矩阵变换法线，斜着的法线歪了；改成逆转置（同 Stride 的 WorldInverseTranspose）以后是 0.29。
