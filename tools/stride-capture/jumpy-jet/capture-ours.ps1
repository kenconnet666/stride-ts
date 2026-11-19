# stride-ts 这边截同样的两张（640x1136，同 JumpyJetApp.cs：固定步长 1/60 秒，背景停在固定的滚动位置、管子放到固定的位置后
# 截 Menu.png；广播开始、UI 换到计分页面，20 步后截 Game.png），和桌面 Stride 的参考图逐张比，打印每张的差。先开着开发服务器
# （pnpm --filter @stride-ts/jumpy-jet dev），参考图用 JumpyJet.Windows.exe --capture <目录> 截好。
# 用法：pwsh tools/stride-capture/jumpy-jet/capture-ours.ps1 [-Reference <参考图目录>] [-Out <输出目录>] [-Port 5210]
param(
    [string]$Reference = 'C:\code\stride-jumpy-jet\reference',
    [string]$Out = 'C:\code\stride-jumpy-jet\ours',
    [int]$Port = 5210
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
Set-Location (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent)
# 自己的无头 Chrome（浏览器的记录和用户目录分开），不关 `stride open` 开着的窗口
$env:STRIDE_BROWSER_DIR = Join-Path $HOME '.stride-ts\capture'
New-Item -ItemType Directory -Force $Out | Out-Null
pnpm exec stride close | Out-Null
pnpm exec stride open "http://localhost:$Port/" --headless --size 640x1136 --dpr 1 | Out-Null
Start-Sleep -Milliseconds 1500
$hub = "localhost:$Port"
pnpm exec stride pause --hub $hub | Out-Null
pnpm exec stride time --fixed (1 / 60) --hub $hub | Out-Null
pnpm exec stride step 30 --hub $hub | Out-Null

# 同 JumpyJetApp.cs 的 FreezeScene
$freeze = @'
(() => {
  const entities = strideGame.entities.ids().map((id) => strideGame.entities.entity(id));
  strideGame.rootRenderer.sections.forEach((section, i) => section.scrollTo(50 * (i + 1)));
  const heights = [1.0, 1.6, 0.7, 2.0, 1.3];
  entities.filter((e) => e.name === 'PipeSetRoot').forEach((e, i) => Object.assign(e.require(strideEngine.Transform).position, { x: 4 + 4 * i, y: heights[i % heights.length], z: 0 }));
  return 1;
})()
'@
function Shot([string]$name) {
    Start-Sleep -Milliseconds 300
    $result = pnpm exec stride shot (Join-Path $Out "$name.png") --diff (Join-Path $Reference "$name.png") --hub $hub | ConvertFrom-Json
    $d = $result.diff
    '{0}: mean {1:N2}, over 8 {2}, over 32 {3}' -f $name, $d.mean, $d.over.'8', $d.over.'32'
}

# 多行的代码从标准输入传（经过 pnpm 的 .cmd 包装时，参数里的换行会截断命令行）
$freeze | pnpm exec stride eval - --hub $hub | Out-Null
pnpm exec stride step 1 --hub $hub | Out-Null
Shot 'Menu'
pnpm exec stride step 1 --hub $hub | Out-Null
pnpm exec stride call start-game --hub $hub | Out-Null
pnpm exec stride step 20 --hub $hub | Out-Null
Shot 'Game'
pnpm exec stride close | Out-Null
