# 桌面 Stride 的参考截图

每个对齐用的样例一个子目录：`setup.ps1` 从 Stride 源码搭出用官方 nuget 包（4.4.2）编的桌面版，入口换成能截图的版本；
截好的参考图不进仓库，需要时重新截。stride-ts 这边用 `stride shot --diff` 比。

| 目录 | 样例 | 说明 |
|---|---|---|
| [tpp/](tpp/README.md) | Third Person Platformer | 静态画面（去掉脚本、动画、角色物理）；可以关单个后处理、固定曝光、只留一种光、测帧时间 |
| [animated-model/](animated-model/README.md) | AnimatedModel | 动画停在第 0 帧 |
| [physics-sample/](physics-sample/README.md) | PhysicsSample（Bepu 版，取自 master） | 选场景、可以停住物理 |
| [bepu-sample/](bepu-sample/README.md) | BepuSample（取自 master） | 选子场景、可以停住物理；截图时关掉 UI 和调试文字 |
