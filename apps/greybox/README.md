# greybox

关卡白盒的演示（docs/roadmap.md 的 S2"关卡白盒"）：`Level/Room.brush.json` 是一串笔刷——地板、四面墙、门洞和三个窗洞（减）、平台、斜坡（挤出的三角形）、台阶、柱子、中空的圆塔（圆柱减圆柱）、地上的坑（减）——编辑器后端用 Manifold 烘成同名的模型 `Level/Room.model`（平直法线、按朝向投影的世界坐标 UV，三个材质槽）。材质贴的是 1 米一格的网格图（`Level/Textures/Grid.svg`），尺度一眼看得出来；场景里的 `Room` 实体用这个模型，碰撞体是同一个模型的网格。

用 `stride-editor new` 建的工程，开发服务器 `pnpm dev`（端口 5228），编辑器在 `/__stride/editor/`：资源浏览器里选中 `Level/Room`（白盒），属性面板里改笔刷的形状、运算、位置、尺寸，改了马上烘、视口里热重载；"新建"菜单里有"白盒"。这个关卡是经编辑器的 MCP 服务（`write_asset` 写白盒和材质、`import_file` 导入网格图、`edit_scene` 放实体）搭的。
