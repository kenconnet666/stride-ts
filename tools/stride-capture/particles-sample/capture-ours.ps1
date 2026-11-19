# stride-ts 这边截同样的七张（1280x720：每个场景换上以后 30 步，粒子改成固定种子并重置，再 60 步），和桌面 Stride 的参考图
# 逐张比，打印每张的差。先开着开发服务器（pnpm --filter @stride-ts/particles-sample dev），参考图用
# ParticlesSample.Windows.exe --capture <目录> 截好。暂停后换场景、单步走，每步 1/60 秒（同桌面的固定步长）。
# 用法：pwsh tools/stride-capture/particles-sample/capture-ours.ps1 [-Reference <参考图目录>] [-Out <输出目录>]
param(
    [string]$Reference = 'C:\code\stride-particles-sample\reference',
    [string]$Out = 'C:\code\stride-particles-sample\ours'
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
Set-Location (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent)
# 自己的无头 Chrome（浏览器的记录和用户目录分开），不关 `stride open` 开着的窗口
$env:STRIDE_BROWSER_DIR = Join-Path $HOME '.stride-ts\capture'
New-Item -ItemType Directory -Force $Out | Out-Null
pnpm exec stride close | Out-Null
pnpm exec stride open 'http://localhost:5208/' --headless --size 1280x720 --dpr 1 | Out-Null
Start-Sleep -Milliseconds 1500
pnpm exec stride pause --hub particles-sample | Out-Null

# 同 ParticlesSampleApp.cs 的 FreezeParticles
$freeze = "for (const c of strideGame.particles.components) { for (const e of c.particleSystem.emitters) e.randomSeedMethod = 'fixed'; c.particleSystem.resetSimulation(); }; 1"

foreach ($scene in 'MainScene', 'AnimatedParticles', 'ChildParticles', 'CustomMaterials', 'CustomParticles', 'Lasers', 'RibbonParticles') {
    pnpm exec stride eval "strideGame.setRootScene('ParticlesSample/Shared/$scene').then(() => 1)" --hub particles-sample | Out-Null
    pnpm exec stride step 30 --hub particles-sample | Out-Null
    pnpm exec stride eval $freeze --hub particles-sample | Out-Null
    pnpm exec stride step 60 --hub particles-sample | Out-Null
    Start-Sleep -Milliseconds 500
    $result = pnpm exec stride shot (Join-Path $Out "$scene.png") --diff (Join-Path $Reference "$scene.png") --hub particles-sample | ConvertFrom-Json
    $d = $result.diff
    '{0}: mean {1:N2}, over 8 {2}, over 32 {3}' -f $scene, $d.mean, $d.over.'8', $d.over.'32'
}
