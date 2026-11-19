# stride-ts 这边截同样的七张（1600x900，仿真停住，不画 UI 和调试文字），和桌面 Stride 的参考图逐张比。先开着开发服务器
# （pnpm --filter @stride-ts/bepu-sample dev），参考图用 BepuSample.Windows.exe --capture <目录>\<场景>.png --scene "Scenes/<场景>"
# --frames 120 --freeze-physics 截好（文件名里的空格换成下划线）。
# 用法：pwsh tools/stride-capture/bepu-sample/capture-ours.ps1 [-Reference <参考图目录>] [-Out <输出目录>]
param(
    [string]$Reference = 'C:\code\stride-bepu-sample',
    [string]$Out = 'C:\code\stride-bepu-sample\ours'
)
. (Join-Path $PSScriptRoot '..\ours.ps1')
Open-Capture bepu-sample 'http://localhost:5190/?scene=Colliders' '1600x900'
# 停住时生成器、绳子的脚本照样建物体，物体不动；选场景的按钮（UI）和调试文字不画，同桌面那边的 --capture
Invoke-Stride eval 'strideGame.simulation.enabled = false; strideGame.debugText.visible = false; for (const c of strideGame.ui.components) c.enabled = false; 1'
foreach ($scene in 'Colliders', 'Constraint', 'Convex And Mesh Collider', 'Cube Fountain', 'Cube Mixer', 'Material Properties', 'Ropes') {
    Invoke-Stride call scene ('"{0}"' -f $scene)
    Start-Sleep -Seconds 2
    $file = $scene.Replace(' ', '_') + '.png'
    Compare-Capture $scene (Join-Path $Out $file) (Join-Path $Reference $file)
}
Close-Capture
