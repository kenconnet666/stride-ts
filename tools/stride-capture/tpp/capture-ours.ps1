# stride-ts 这边截同样的一张（1280x720，默认的后处理；不挂脚本、仿真停住，角色留在场景里摆的位置），和桌面 Stride 的参考图比。
# 先开着开发服务器（pnpm --filter @stride-ts/platformer dev），参考图用 ThirdPersonPlatformer.Windows.exe --capture <png>
# --frames 240 截好。
# 用法：pwsh tools/stride-capture/tpp/capture-ours.ps1 [-Reference <参考图>] [-Out <输出的图>]
param(
    [string]$Reference = 'C:\code\stride-tpp\reference.png',
    [string]$Out = 'C:\code\stride-tpp\ours.png'
)
. (Join-Path $PSScriptRoot '..\ours.ps1')
Open-Capture platformer 'http://localhost:5184/'
# 暂停着换场景：仿真在第一步之前就停住，角色不往下落
Invoke-Stride pause
Set-SceneWithoutScripts 'ThirdPersonPlatformer/MainScene' @(
    'ThirdPersonPlatformer.Player.PlayerController', 'ThirdPersonPlatformer.Player.PlayerInput',
    'ThirdPersonPlatformer.Player.AnimationController', 'ThirdPersonPlatformer.Camera.ThirdPersonCamera'
) 'strideGame.simulation.enabled = false'
Invoke-Stride resume
# 自动曝光要几秒才稳定（桌面那边画 240 帧）
Start-Sleep -Seconds 5
Compare-Capture tpp $Out $Reference
Close-Capture
