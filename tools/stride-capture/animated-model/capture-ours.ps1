# stride-ts 这边截同样的一张（640x1061，动画停在第 0 帧），和桌面 Stride 的参考图比。先开着开发服务器
# （pnpm --filter @stride-ts/animated-model dev），参考图用 AnimatedModel.Windows.exe --capture <png> --frames 90 截好。
# 用法：pwsh tools/stride-capture/animated-model/capture-ours.ps1 [-Reference <参考图>] [-Out <输出的图>]
param(
    [string]$Reference = 'C:\code\stride-animated-model\reference.png',
    [string]$Out = 'C:\code\stride-animated-model\ours.png'
)
. (Join-Path $PSScriptRoot '..\ours.ps1')
Open-Capture animated-model 'http://localhost:5186/' '640x1061'
Invoke-Stride eval "const g = strideGame; const id = g.entities.ids().find((i) => g.entities.entity(i).name === 'CharacterModel'); const a = g.entities.entity(id).get(strideEngine.AnimationComponent); setInterval(() => { for (const p of a.playingAnimations) { p.timeFactor = 0; p.currentTime = 0; } }, 1); 1"
Start-Sleep -Seconds 1
# 左边 60 像素是 Idle、Run 两个按钮（Stride 那边是 UI 页面，我们这边还是调试命令）
Compare-Capture animated-model $Out $Reference '60,0,580,1061'
Close-Capture
