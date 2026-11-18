# @stride-ts/cli（`stride`）

从命令行查看和操作正在运行的 stride-ts 游戏，给 agent 和开发者调试用。结果是 JSON，打到 stdout；出错时信息打到 stderr，退出码 1。

```bash
pnpm exec stride --help
```

## 怎么连上的

```
CLI ──HTTP + 令牌──▶ 调试中枢（开发服务器上的 Vite 插件） ◀──WebSocket（同源）── 页面里的 Game（game.debug）
```

- **中枢**：`tools/vite-app.ts` 给所有 app 的开发服务器和 preview 服务器挂上 `strideDebug()`（`src/vite.ts`、`src/hub.ts`）。中枢把地址和令牌登记在 `~/.stride-ts/hubs/`，CLI 按它找。同时开着几个中枢时，默认用页面连上得最晚的那个；`--hub <名字或地址里的文字>` 指定。
- **页面**：`Game.run` 的 `debug` 选项打开时连中枢。app 的入口传 `import.meta.env.DEV || undefined`，所以开发服务器上总是打开，preview 或部署出去的页面在地址后加 `?debug` 才打开。
- **安全**：中枢只接受同源页面的 WebSocket；HTTP 接口要带令牌，并且拒绝带 Origin 头的请求，其他网页没法借用户的浏览器调用。

## 常用命令

| 命令 | 作用 |
|---|---|
| `open <url> [--headless] [--size 1400x900] [--dpr 2]` | 用自己启动的 Chrome 打开（独立的用户目录，开着 CDP 端口），等到游戏运行起来再返回；再次 open 时在同一个浏览器里开新标签。`close` 关掉这个浏览器 |
| `status` | 状态、帧号、游戏时间、帧率、画布、GPU 适配器、计数器、观察项 |
| `entities [--name x] [--with C]`、`inspect <实体>` | 列实体；看某个实体的所有组件值和脚本属性。实体写 id 或名字 |
| `set <实体> <组件.字段> <JSON>` | 改组件字段或脚本属性，例如 `set PlayerCharacter Character.speed 20` |
| `pause`、`resume`、`step [n]`、`time --scale 0.5 --fixed 0.016` | 暂停（只画不更新）、单步、时间倍率、固定步长（复现用） |
| `key KeyW --hold 1000`、`mouse move 100 0`、`mouse left` | 模拟输入（合成 DOM 事件，走 InputManager 的正常路径；拿不到指针锁定） |
| `mouse left --trusted` | 用 DevTools 协议在画布中央真实地按一下（stride open 启动的 Chrome）：算用户操作，页面能锁定指针；锁定后 `mouse move` 的移动量照常进 `mouseDelta` |
| `shot out.png [--diff ref.png]` | 截下一帧的后备缓冲（不含页面上的文字）；和参考图逐像素比较，写放大 16 倍的差异图 |
| `perf [--seconds 3]` | 帧时间分布、每个系统和阶段的 CPU 时间、每个渲染通道的 GPU 时间、渲染统计 |
| `raycast <x,y,z> <dx,dy,dz>` | 物理射线 |
| `logs [-f] [--level warn]` | 页面的 console 输出、未捕获的异常、引擎日志、埋的事件 |
| `eval <代码>` | 在页面里执行（`strideGame`、`strideEngine` 是全局变量） |
| `commands`、`call <命令> <JSON>` | 列出页面登记的命令；调任意命令（游戏自己加的也行） |

**测性能前**：确认笔记本的电源模式（静谧模式下 GPU 慢好几倍），`status` 里的 `gpu.description` 记下了适配器。

## 在游戏里埋点

```ts
game.debug.command('spawnEnemies', 'Spawn n enemies. args: n', ({ n }) => spawn(Number(n)));
game.debug.counter('ai.agents', agents.length);           // status 里列出
game.debug.watch('player.velocity', () => player.velocity);  // 读状态时才求值
game.debug.event('player.jump', { height });              // 进日志；没连中枢时什么都不做
```

渲染特性重写 `stats()`，`perf` 里就有它的统计；`EntityManager.timings` 打开时按系统和阶段计 CPU 时间（`perf` 采样时自动打开）。
