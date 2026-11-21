# Stride Debug Bridge（Chrome 扩展）

调试 CLI 的 `cpu-profile` 和 `mouse --trusted` 要用 DevTools 协议。用户平时用的 Chrome 走默认配置文件，Chrome 136 起不许它开远程调试端口，所以 CLI 从外面连不进去。

这个扩展用 `chrome.debugger` 在浏览器里面对游戏标签执行这些命令，这两条命令在任何装了它的 Chrome 里都能用。

## 怎么工作

```
stride cpu-profile ──▶ 开发服务器的调试中枢 ──▶ 页面（引擎的 devtools 调试命令）
                                                  │ window.postMessage
                                                  ▼
                                   扩展的内容脚本 content.js ──▶ service-worker.js
                                                                 chrome.debugger.sendCommand(标签, 方法, 参数)
```

- 只在 `http://localhost`、`http://127.0.0.1` 的页面里注入，只能调试发请求的标签自己。
- 附加调试器期间，Chrome 在页面顶部显示"Stride Debug Bridge 已开始调试此浏览器"。CLI 的命令做完会断开，提示条随之消失。
- 页面上 `<html data-stride-debug-bridge="版本">` 表示扩展装着；`stride status` 的 `devtoolsBridge` 字段就是它。
- CLI 先看页面有没有这个扩展：有就走扩展，没有才找 `stride open` 启动的 Chrome 的调试端口。
- 扩展在 Chrome 眼里是不受信任的调试客户端，拿不到 V8 的 `Profiler` 域（`Runtime`、`Input`、`Tracing`、`IO` 这些可以）。所以 `cpu-profile` 用 Tracing 录 `disabled-by-default-v8.cpu_profiler(.hires)`，这和 DevTools 性能面板的做法一样；再从页面主线程的 `ProfileChunk` 事件拼出 CPU profile。直连 CDP 时也走这条路。
- 扩展按标签各管各的，几个游戏页面可以同时调试。CLI 用 `--hub`（哪个开发服务器）和 `--page`（哪个页面）选。
- 多会话（0.3.0 起）：同一个标签可以几个调试会话同时用（几个 agent 会话、几条 CLI 命令）。每条命令带会话 ID，第一个会话用时附加，最后一个会话断开时才真的断开；哪些会话附加着记在 `chrome.storage.session` 里，service worker 被回收也不丢。同一个事件可以几个会话同时等。

`stride open` 起的 Chrome（有界面、无头）不用装这个扩展：CLI 直接连它的调试端口（`stride debug` 的断点也只能走这条路，见 packages/cli/README.md）。

## 直连中枢（0.4 起）

页面连上开发服务器的调试中枢时，中枢发给它一张桥票（页面连着时有效）；页面经内容脚本交给扩展，扩展的 service worker 拿票连中枢的 `/__stride/bridge`（扩展的 Origin 不是同源，中枢只认票，口令不给页面）。之后 CLI 带口令连中枢的 `/__stride/devtools?page=<id>`，命令、回复和 DevTools 事件在 CLI 和扩展之间直接来回，**不经过页面的 JS**：

- `stride debug` 的断点在主 Chrome 里也能用了（页面停住时照样能发"继续"）；
- 事件（`Debugger.paused`、`Debugger.scriptParsed`……）收得到；
- 中枢每 20 秒发一次心跳，service worker 一直保持"有效"，不会闲置被停；
- `stride hubs`、中枢的 `/pages` 里页面的 `bridge: true` 表示直连着；
- 扩展重新加载以后新注入的内容脚本向页面要一次票（`want-hub`），页面不用刷新就重新连上；直连的命令来时同样比一次文件指纹，改了就自己更新；
- 最后一个会话断开以后先留着附加 5 分钟再真断开（0.4.3）：附加时页面顶上的提示条占 56 像素，每条命令都附加、断开的话页面高度来回变、重新布局，上一条命令量的坐标下一条就对不上；
- `stride front`（`Page.bringToFront`）还把标签所在的窗口还原（最小化着时）、拿到前面：只切标签的话最小化的窗口里页面照样 hidden、不出帧。锁屏时谁也拿不到前面，页面都不出帧，用 `stride open --headless` 的 Chrome。

```
stride（CLI）──WebSocket（口令）──▶ 调试中枢 ──WebSocket（桥票）──▶ 扩展的 service worker ──chrome.debugger──▶ 标签
```

## 安装（一次）

1. 在 Chrome 地址栏打开 `chrome://extensions`。
2. 打开右上角的"开发者模式"开关。
3. 点左上角的"加载已解压的扩展程序"，选这个目录：本仓库的 `tools\debug-bridge`。
4. 列表里出现"Stride Debug Bridge"就装好了。已经开着的游戏页面要刷新一次，内容脚本才会注入。

0.2.0 起扩展改了文件会自己重新加载：页面打开时、CLI 发命令时它比一次自己文件的指纹，变了就重新加载，并把内容脚本注入已经开着的本机页面（页面不用刷新；那一条命令会报"正在更新，再跑一次"）。从 0.1.0 升上来要在 `chrome://extensions` 里最后点一次它卡片上的刷新按钮（↻），之后不用再点。卡片上的"Service Worker（无效）"不是出错：MV3 的后台脚本空闲约 30 秒就被停掉，页面发消息时会自动醒来。

## 验证

```bash
pnpm exec stride status
```

```bash
pnpm exec stride cpu-profile --seconds 3
```

`status` 里的 `devtoolsBridge` 是版本号，`cpu-profile` 能出每帧的耗时，就装好了。
