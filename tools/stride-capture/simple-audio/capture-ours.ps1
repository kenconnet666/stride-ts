# stride-ts 这边截同样的两张（1280x720：静止时 idle；暂停后把两个波形图放回起点、不透明度设成 1 的 wave），和桌面 Stride 的
# 参考图逐张比，打印每张的差。先开着开发服务器（pnpm --filter @stride-ts/simple-audio dev），参考图用
# SimpleAudio.Windows.exe --capture <目录> 截好。
# 用法：pwsh tools/stride-capture/simple-audio/capture-ours.ps1 [-Reference <参考图目录>] [-Out <输出目录>]
param(
    [string]$Reference = 'C:\code\stride-simple-audio\reference',
    [string]$Out = 'C:\code\stride-simple-audio\ours'
)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent)
New-Item -ItemType Directory -Force $Out | Out-Null
pnpm exec stride close | Out-Null
pnpm exec stride open 'http://localhost:5206/' --headless --size 1280x720 --dpr 1 | Out-Null
Start-Sleep -Milliseconds 1500

function Shot([string]$name) {
    Start-Sleep -Milliseconds 500
    $result = pnpm exec stride shot (Join-Path $Out "$name.png") --diff (Join-Path $Reference "$name.png") --hub simple-audio | ConvertFrom-Json
    $d = $result.diff
    '{0}: mean {1:N2}, over 8 {2}, over 32 {3}' -f $name, $d.mean, $d.over.'8', $d.over.'32'
}

Shot 'idle'
# 同 SimpleAudioApp.cs：暂停（脚本不再改波形图）后放回起点、不透明
pnpm exec stride pause --hub simple-audio | Out-Null
pnpm exec stride eval "const root = strideGame.ui.components[0].page.rootElement; for (const [name, x] of [['LeftWave', 0.35], ['RightWave', 0.65]]) { const e = root.findName(name); e.canvasRelativePosition = [x, 0.5]; e.opacity = 1; } 1" --hub simple-audio | Out-Null
Shot 'wave'
