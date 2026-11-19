# stride-ts 这边截同样的两张（600x600：导火索一半、粒子固定种子重置后 60 步的新游戏；进入结束后同样 60 步），和桌面 Stride 的
# 参考图逐张比，打印每张的差。先开着开发服务器（pnpm --filter @stride-ts/ui-particles dev），参考图用
# UIParticles.Windows.exe --capture <目录> 截好。暂停后单步走，每步 1/60 秒（同桌面的固定步长）。
# 用法：pwsh tools/stride-capture/ui-particles/capture-ours.ps1 [-Reference <参考图目录>] [-Out <输出目录>]
param(
    [string]$Reference = 'C:\code\stride-ui-particles\reference',
    [string]$Out = 'C:\code\stride-ui-particles\ours'
)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent)
# 自己的无头 Chrome（浏览器的记录和用户目录分开），不关 `stride open` 开着的窗口
$env:STRIDE_BROWSER_DIR = Join-Path $HOME '.stride-ts\capture'
New-Item -ItemType Directory -Force $Out | Out-Null
pnpm exec stride close | Out-Null
pnpm exec stride open 'http://localhost:5204/' --headless --size 600x600 --dpr 1 | Out-Null
Start-Sleep -Milliseconds 1500
pnpm exec stride pause --hub ui-particles | Out-Null

# 同 UIParticlesApp.cs 的 FreezeParticles；splash 是场景里的 SplashScript
$splash = "const type = strideGame.registry.scriptsNamed('SplashScript')[0]; const splash = [...strideGame.rootScene.entities.values()].map((e) => e.get(type)).find(Boolean)"
$freeze = "for (const c of strideGame.particles.components) { for (const e of c.particleSystem.emitters) e.randomSeedMethod = 'fixed'; c.particleSystem.resetSimulation(); }"

function Shot([string]$name, [string]$code) {
    pnpm exec stride eval "$splash; $code; $freeze; 1" --hub ui-particles | Out-Null
    pnpm exec stride step 60 --hub ui-particles | Out-Null
    Start-Sleep -Milliseconds 500
    $result = pnpm exec stride shot (Join-Path $Out "$name.png") --diff (Join-Path $Reference "$name.png") --hub ui-particles | ConvertFrom-Json
    $d = $result.diff
    '{0}: per channel {1:N2}, over 8 {2}, over 32 {3}' -f $name, $d.meanChannel, $d.over.'8', $d.over.'32'
}

Shot 'newgame' 'splash.fusePercentage = 0.5'
Shot 'endgame' 'splash.enterEndGame()'
# 用完就关：无头 Chrome 开着会一直按满帧率渲染
pnpm exec stride close | Out-Null
