# stride-ts 这边截同样的两张（640x1136，同 SpaceEscapeApp.cs：固定步长 1/60 秒，第 30 步后换成固定的关卡，下一步截 Menu.png；
# 再一步后开始游戏，20 步后截 Run.png），和桌面 Stride 的参考图逐张比，打印每张的差。先开着开发服务器
# （pnpm --filter @stride-ts/space-escape dev），参考图用 SpaceEscape.Windows.exe --capture <目录> 截好。
# 用法：pwsh tools/stride-capture/space-escape/capture-ours.ps1 [-Reference <参考图目录>] [-Out <输出目录>] [-Port 5212]
param(
    [string]$Reference = 'C:\code\stride-space-escape\reference',
    [string]$Out = 'C:\code\stride-space-escape\ours',
    [int]$Port = 5212
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
Set-Location (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent)
# 自己的无头 Chrome（浏览器的记录和用户目录分开），不碰开着的浏览器
$env:STRIDE_BROWSER_DIR = Join-Path $HOME '.stride-ts\capture'
New-Item -ItemType Directory -Force $Out | Out-Null
pnpm exec stride close | Out-Null
pnpm exec stride open "http://localhost:$Port/" --headless --size 640x1136 --dpr 1 | Out-Null
Start-Sleep -Milliseconds 1500
$hub = "localhost:$Port"
pnpm exec stride pause --hub $hub | Out-Null
pnpm exec stride time --fixed (1 / 60) --hub $hub | Out-Null
pnpm exec stride step 30 --hub $hub | Out-Null

function Shot([string]$name) {
    Start-Sleep -Milliseconds 300
    $result = pnpm exec stride shot (Join-Path $Out "$name.png") --diff (Join-Path $Reference "$name.png") --hub $hub | ConvertFrom-Json
    $d = $result.diff
    '{0}: per channel {1:N2}, over 8 {2}, over 32 {3}' -f $name, $d.meanChannel, $d.over.'8', $d.over.'32'
}

pnpm exec stride call fixed-level --hub $hub | Out-Null
pnpm exec stride step 1 --hub $hub | Out-Null
Shot 'Menu'
pnpm exec stride step 1 --hub $hub | Out-Null
pnpm exec stride call start-game --hub $hub | Out-Null
pnpm exec stride step 20 --hub $hub | Out-Null
Shot 'Run'
pnpm exec stride close | Out-Null
