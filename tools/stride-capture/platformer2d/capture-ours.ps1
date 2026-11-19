# stride-ts 这边截同样的一张（1280x720，不挂脚本：金币和角色的精灵停在默认帧，角色照常落到地面上），和桌面 Stride 的参考图比。
# 先开着开发服务器（pnpm --filter @stride-ts/platformer2d dev），参考图用 Platformer2D.Windows.exe --capture <png> --frames 120
# --no-scripts 截好。
# 用法：pwsh tools/stride-capture/platformer2d/capture-ours.ps1 [-Reference <参考图>] [-Out <输出的图>]
param(
    [string]$Reference = 'C:\code\stride-platformer2d\reference.png',
    [string]$Out = 'C:\code\stride-platformer2d\ours.png'
)
. (Join-Path $PSScriptRoot '..\ours.ps1')
Open-Capture platformer2d 'http://localhost:5192/'
Set-SceneWithoutScripts 'Platformer2D/MainScene' @('Platformer2D.Player.PlayerController', 'Platformer2D.Gameplay.CoinRotation', 'Platformer2D.Gameplay.CollectCoin')
Start-Sleep -Seconds 2
Compare-Capture platformer2d $Out $Reference
Close-Capture
