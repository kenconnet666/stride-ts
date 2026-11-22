# @stride-ts/devkit

样例和新工程共用的开发配置，免得每个工程各抄一份。

- `@stride-ts/devkit/vite` 的 `strideApp(port, extra)`：Vite 配置。跨源隔离的响应头（原生模块用 SharedArrayBuffer）、
  原生模块不预打包、调试中枢（`stride` 命令连得上）、编辑器（开发服务器上的 `/__stride/editor/`）、资源包同步、构建后预压缩
  （`.br`、`.gz`）。preview 用 `port + 1`。
- `@stride-ts/devkit/smoke` 的 `startSmoke(hub)`、`PAGE_HELPERS`：冒烟脚本（`apps/*/scripts/smoke.ts`）的骨架。`stride(...)`
  跑一条调试 CLI 命令拿 JSON，`check(名字, 通过, 细节)` 记一条结果，`finish()` 查本次运行以来的错误日志、按结果退出；
  `PAGE_HELPERS` 在页面里装上 `frames`、`seconds`、`named`、`tap` 这些帮手（说明在 `src/smoke.ts`）。

新工程（`node packages/editor/src/server/cli.ts new apps/<名字>`）生成的 `vite.config.ts` 和 `scripts/smoke.ts` 就是用这两个。
