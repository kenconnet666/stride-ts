# collect-dodge

P3 编辑器的验收游戏（路线图 C1）：用编辑器从零搭的 3D 收集加躲避。WASD 或方向键按相机的朝向走，空格跳；吃完 5 个金币门升起来，躲开来回走的红色障碍（被撞回出生点），穿过门走进绿色的终点就赢了。

- 开发：`pnpm --filter @stride-ts/collect-dodge dev`（端口 5224），编辑器在 `/__stride/editor/`。
- 冒烟：`pnpm --filter @stride-ts/collect-dodge smoke`（对着正在运行的页面，把一局走完）。
- 脚本在 `src/game/`；场景和资源在 `public/content/`（用编辑器建、存）。

`public/content/UI/OpenSans-Regular.*` 由 Open Sans（Copyright 2010–2011 Google Corporation，Apache License 2.0）转换而来，源字体来自 Stride 的 CSharpBeginner 样例。
