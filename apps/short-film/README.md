# short-film

路线图 F4 验收用的 30 秒短片《Evening》（docs/stages.md 的"原来的执行清单"F 组第 4 项）：傍晚，小机器人在路灯下等日落、挥手，走到空地上跳舞，最后竖大拇指、挥手告别。四个机位（远景推近、跟拍、环绕、特写，物理相机带景深）、角色动画（片段之间交叉淡化）、太阳慢慢落下（时间轴驱动 DayNightCycle 的时刻）、体积云和雾、配乐、字幕。

用 `stride-editor new` 建的工程，开发服务器 `pnpm dev`（端口 5226），编辑器在 `/__stride/editor/`。

- 场景 `MainScene`，短片是时间轴 `Films/Evening`，`Film` 实体上的 TimelinePlayer 一开始就放。
- 出片：编辑器里打开 `Films/Evening`，时间轴面板选预设（横屏 1080p、竖屏 9:16、方形）点"出片"；或者 `stride call render '{"timeline":"Evening","preset":"vertical1080"}'`、编辑器 MCP 服务的 `render` 工具。成片存在 `exports/`（不提交）。
- 怎么做出来的：场景、材质、基本形状的模型、时间轴都是经编辑器的 MCP 服务（`import_file`、`write_asset`、`edit_scene`、`render`）写的，没有手改文件；再在编辑器界面里拖时间检查、改字幕、出片。过程和发现的问题见 docs/decisions.md 2026-11-21 的"F4 验收"。

素材来源：

- `Characters/RobotExpressive`：Tomás Laulhé（Quaternius）的 Robot Expressive，Don McCurdy 加了表情形变、转成 glTF，取自 three.js 的示例（`examples/models/gltf/RobotExpressive`），CC0 1.0。拖进资源浏览器（或 MCP 的 `import_file`）导入：骨架、14 个动画剪辑、形变目标。
- `Music/Theme.ogg`：`scripts/compose.ts` 合成的（和弦进行加几种简单音色，确定性的），`node scripts/compose.ts theme.wav` 再编成 Ogg Vorbis 导入。
- `Fonts/OpenSans-Regular`：Open Sans（Copyright 2010–2011 Google Corporation，Apache License 2.0），源字体来自 Stride 的 CSharpBeginner 样例。
