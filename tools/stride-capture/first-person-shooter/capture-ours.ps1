# stride-ts 这边截同样的一张（1280x720，不挂脚本：手臂停在静止姿势，视角不动），和桌面 Stride 的参考图比。先开着开发服务器
# （pnpm --filter @stride-ts/first-person-shooter dev），参考图用 FirstPersonShooter.Windows.exe --capture <png> --frames 240
# --no-scripts 截好。
# 用法：pwsh tools/stride-capture/first-person-shooter/capture-ours.ps1 [-Reference <参考图>] [-Out <输出的图>]
param(
    [string]$Reference = 'C:\code\stride-first-person-shooter\reference.png',
    [string]$Out = 'C:\code\stride-first-person-shooter\ours.png'
)
. (Join-Path $PSScriptRoot '..\ours.ps1')
Open-Capture first-person-shooter 'http://localhost:5196/'
Set-SceneWithoutScripts 'FirstPersonShooter/MainScene' @(
    'FirstPersonShooter.Player.PlayerController', 'FirstPersonShooter.Player.PlayerInput', 'FirstPersonShooter.FpsCamera',
    'FirstPersonShooter.Player.WeaponScript', 'FirstPersonShooter.Player.AnimationController', 'FirstPersonShooter.EffectController'
)
# 自动曝光要几秒才稳定（桌面那边画 240 帧）
Start-Sleep -Seconds 5
Compare-Capture first-person-shooter $Out $Reference
Close-Capture
