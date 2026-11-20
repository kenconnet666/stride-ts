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

## 安装（一次）

1. 在 Chrome 地址栏打开 `chrome://extensions`。
2. 打开右上角的"开发者模式"开关。
3. 点左上角的"加载已解压的扩展程序"，选这个目录：本仓库的 `tools\debug-bridge`。
4. 列表里出现"Stride Debug Bridge"就装好了。已经开着的游戏页面要刷新一次，内容脚本才会注入。

改了扩展的文件以后，在 `chrome://extensions` 里点它卡片上的刷新按钮（↻），再刷新游戏页面。卡片上的"Service Worker（无效）"不是出错：MV3 的后台脚本空闲约 30 秒就被停掉，页面发消息时会自动醒来。

## 验证

```bash
pnpm exec stride status
```

```bash
pnpm exec stride cpu-profile --seconds 3
```

`status` 里的 `devtoolsBridge` 是版本号，`cpu-profile` 能出每帧的耗时，就装好了。
