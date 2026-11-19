# stride-ts 这边截同样的三张（1280x720，仿真停住），和桌面 Stride 的参考图逐张比。先开着开发服务器
# （pnpm --filter @stride-ts/physics-sample dev），参考图用 PhysicsSample.Windows.exe --capture <目录>\<场景>-frozen.png
# --scene <场景> --freeze-physics 截好。
# 用法：pwsh tools/stride-capture/physics-sample/capture-ours.ps1 [-Reference <参考图目录>] [-Out <输出目录>]
param(
    [string]$Reference = 'C:\code\stride-physics-sample',
    [string]$Out = 'C:\code\stride-physics-ours'
)
. (Join-Path $PSScriptRoot '..\ours.ps1')
Open-Capture physics-sample 'http://localhost:5188/?scene=PhysicsSample/VolumeTrigger'
Invoke-Stride pause
foreach ($scene in 'Raycasting', 'VolumeTrigger', 'Constraints') {
    # 暂停着换场景，固定步长设得很大（仿真不再步进），再单步几帧让脚本的 start 跑完
    Invoke-Stride eval "strideGame.setRootScene('PhysicsSample/$scene').then(() => { strideGame.simulation.configure({ fixedTimeStep: 1e9 }); return 1; })"
    Invoke-Stride step 5
    Start-Sleep -Milliseconds 500
    # Constraints 只比右半边的场景：球在脚本的 Start 里受了一次冲量，两边停住的时刻不同，位置对不上；参考图取自 master，
    # 约束的名字（底下的字）也和我们照着移植的版本不一样
    $region = $scene -eq 'Constraints' ? '640,0,536,600' : ''
    Compare-Capture $scene (Join-Path $Out "$scene-frozen.png") (Join-Path $Reference "$scene-frozen.png") $region
}
Close-Capture
