# stride-ts 这边截同样的一张（1280x720，不挂脚本：角色停在静止姿势、金币不转），和桌面 Stride 的参考图比。先开着开发服务器
# （pnpm --filter @stride-ts/topdown-rpg dev），参考图用 TopDownRPG.Windows.exe --capture <png> --frames 240 --no-scripts 截好。
# 用法：pwsh tools/stride-capture/topdown-rpg/capture-ours.ps1 [-Reference <参考图>] [-Out <输出的图>]
param(
    [string]$Reference = 'C:\code\stride-topdown-rpg\reference.png',
    [string]$Out = 'C:\code\stride-topdown-rpg\ours.png'
)
. (Join-Path $PSScriptRoot '..\ours.ps1')
Open-Capture topdown-rpg 'http://localhost:5194/'
Set-SceneWithoutScripts 'TopDownRPG/MainScene' @(
    'TopDownRPG.Player.PlayerController', 'TopDownRPG.Player.PlayerInput', 'TopDownRPG.Player.AnimationController',
    'TopDownRPG.Gameplay.CrateScript', 'TopDownRPG.Gameplay.Trigger', 'TopDownRPG.Gameplay.CoinScript',
    'TopDownRPG.Gameplay.MusicScript', 'TopDownRPG.Gameplay.LootCoinScript', 'RecastNavigationComponent'
)
# 自动曝光要几秒才稳定（桌面那边画 240 帧）
Start-Sleep -Seconds 5
Compare-Capture topdown-rpg $Out $Reference
Close-Capture
