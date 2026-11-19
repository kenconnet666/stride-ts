# stride-ts 这边截同样的一张（1280x720，固定步长 1/60 秒；游戏时钟拨到参考图那一帧的时间，水面按时间动），和桌面 Stride 的参考图比，
# 打印差。先开着开发服务器（pnpm --filter @stride-ts/material-shader dev），参考图用
# MaterialShader.Windows.exe --capture <png> 截好（旁边的 .time 是那一帧的游戏时间）。
# 用法：pwsh tools/stride-capture/material-shader/capture-ours.ps1 [-Reference <参考图>] [-Out <输出>] [-Port 5214]
param(
    [string]$Reference = 'C:\code\stride-material-shader\reference\Water.png',
    [string]$Out = 'C:\code\stride-material-shader\ours\Water.png',
    [int]$Port = 5214
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
Set-Location (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent)
# 自己的无头 Chrome（浏览器的记录和用户目录分开），不碰开着的浏览器
$env:STRIDE_BROWSER_DIR = Join-Path $HOME '.stride-ts\capture'
New-Item -ItemType Directory -Force (Split-Path $Out) | Out-Null
$time = [double](Get-Content ([IO.Path]::ChangeExtension($Reference, '.time')))
pnpm exec stride close | Out-Null
pnpm exec stride open "http://localhost:$Port/" --headless --size 1280x720 --dpr 1 | Out-Null
Start-Sleep -Milliseconds 1500
$hub = "localhost:$Port"
pnpm exec stride pause --hub $hub | Out-Null
pnpm exec stride time --fixed (1 / 60) --hub $hub | Out-Null
pnpm exec stride step 10 --hub $hub | Out-Null
# 拨到前一帧的时间，再走一步：画的那一帧的游戏时间和参考图一样
pnpm exec stride time --total ($time - 1 / 60) --hub $hub | Out-Null
pnpm exec stride step 1 --hub $hub | Out-Null
Start-Sleep -Milliseconds 300
$result = pnpm exec stride shot $Out --diff $Reference --hub $hub | ConvertFrom-Json
$d = $result.diff
'Water at {0:N3} s: per channel {1:N2}, over 8 {2}, over 32 {3}' -f $time, $d.meanChannel, $d.over.'8', $d.over.'32'
pnpm exec stride close | Out-Null
