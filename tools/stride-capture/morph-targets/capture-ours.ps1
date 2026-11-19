# stride-ts 这边截同样的一张（1280x720，固定步长 1/60 秒；各个模型的剪辑拨到参考图那一帧的时间），和桌面 Stride 的参考图比，
# 打印差。先开着开发服务器（pnpm --filter @stride-ts/morph-targets dev），参考图用
# MorphTargets.Windows.exe --capture <png> 截好（旁边的 .time 是那一帧各个剪辑的时间，实体名=秒）。
# 用法：pwsh tools/stride-capture/morph-targets/capture-ours.ps1 [-Reference <参考图>] [-Out <输出>] [-Port 5218]
param(
    [string]$Reference = 'C:\code\stride-morph-targets\reference\Clips.png',
    [string]$Out = 'C:\code\stride-morph-targets\ours\Clips.png',
    [int]$Port = 5218
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
Set-Location (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent)
# 自己的无头 Chrome（浏览器的记录和用户目录分开），不碰开着的浏览器
$env:STRIDE_BROWSER_DIR = Join-Path $HOME '.stride-ts\capture'
New-Item -ItemType Directory -Force (Split-Path $Out) | Out-Null
$times = Get-Content ([IO.Path]::ChangeExtension($Reference, '.time')) | ForEach-Object { $name, $seconds = $_ -split '=', 2; [pscustomobject]@{ Name = $name; Seconds = [double]$seconds } }
pnpm exec stride close | Out-Null
pnpm exec stride open "http://localhost:$Port/" --headless --size 1280x720 --dpr 1 | Out-Null
$hub = "localhost:$Port"
# 等场景和脚本都起来（FBX 的甜甜圈、字体加载完）再停住，不然停之前的帧还在走
pnpm exec stride wait --hub $hub | Out-Null
Start-Sleep -Milliseconds 1000
pnpm exec stride pause --hub $hub | Out-Null
pnpm exec stride time --fixed (1 / 60) --hub $hub | Out-Null
pnpm exec stride step 10 --hub $hub | Out-Null
# 每个剪辑拨到前两帧的时间，再走两步：画的那一帧剪辑的时间和参考图一样，面板显示的（脚本在动画之前读，是上一帧的权重）也一样
$set = ($times | ForEach-Object { "['$($_.Name)', $($_.Seconds - 2 / 60)]" }) -join ', '
$code = "for (const [name, time] of [$set]) { const g = strideGame; const e = g.entities.entity(g.entities.ids().find((i) => g.entities.entity(i).name === name)); e.get(strideEngine.AnimationComponent).playingAnimations[0].currentTime = time; } 1"
$code | pnpm exec stride eval - --hub $hub | Out-Null
pnpm exec stride step 2 --hub $hub | Out-Null
Start-Sleep -Milliseconds 300
$result = pnpm exec stride shot $Out --diff $Reference --hub $hub | ConvertFrom-Json
$d = $result.diff
'Clips at {0}: per channel {1:N2}, over 8 {2}, over 32 {3}' -f (($times | ForEach-Object { '{0} {1:N3} s' -f $_.Name, $_.Seconds }) -join ', '), $d.meanChannel, $d.over.'8', $d.over.'32'
pnpm exec stride close | Out-Null
