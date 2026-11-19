# stride-ts 这边截同样的四张（启动页、欢迎弹窗、主菜单、选飞船的弹窗；540x960，飞船的属性固定、血条停在一半），和桌面 Stride 的
# 参考图逐张比，打印每张的差。先开着开发服务器（pnpm --filter @stride-ts/game-menu dev），参考图用 GameMenu.Windows.exe --capture
# <目录> 截好。4.4.2 的样例没有 InputCaptureMonitor（左上角的调试文字），这边换场景时去掉它。-NoKerning 关掉字距（Stride 不做
# 字距，是有意的偏差），看字距以外的差。
# 用法：pwsh tools/stride-capture/game-menu/capture-ours.ps1 [-Reference <参考图目录>] [-Out <输出目录>] [-NoKerning]
param(
    [string]$Reference = 'C:\code\stride-game-menu\reference',
    [string]$Out = 'C:\code\stride-game-menu\ours',
    [switch]$NoKerning
)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent)
# 自己的无头 Chrome（浏览器的记录和用户目录分开），不关 `stride open` 开着的窗口
$env:STRIDE_BROWSER_DIR = Join-Path $HOME '.stride-ts\capture'
New-Item -ItemType Directory -Force $Out | Out-Null
pnpm exec stride close | Out-Null
pnpm exec stride open 'http://localhost:5200/' --headless --size 540x960 --dpr 1 | Out-Null
if ($NoKerning) {
    pnpm exec stride eval "Promise.all(['WesternFont', 'JapaneseFont'].map((n) => strideGame.content.loadFont('GameMenu/Shared/' + n).then((f) => { f.useKerning = false; }))).then(() => 1)" --hub game-menu | Out-Null
}

function Shot([string]$name) {
    Start-Sleep -Milliseconds 800
    $result = pnpm exec stride shot (Join-Path $Out "$name.png") --diff (Join-Path $Reference "$name.png") --hub game-menu | ConvertFrom-Json
    $d = $result.diff
    '{0}: mean {1:N2}, over 8 {2}, over 32 {3}' -f $name, $d.mean, $d.over.'8', $d.over.'32'
}
function Main([string]$code) {
    pnpm exec stride eval "const type = strideGame.registry.scriptsNamed('MainScript')[0]; const main = [...strideGame.rootScene.entities.values()].map((e) => e.get(type)).find(Boolean); $code; 1" --hub game-menu | Out-Null
}

Shot 'splash'
pnpm exec stride eval "strideGame.setRootScene('GameMenu/Shared/MainScene', { scripts: { 'GameMenu.InputCaptureMonitor': null } }).then(() => 1)" --hub game-menu | Out-Null
Start-Sleep -Milliseconds 500
# 同 GameMenuApp.cs：固定的飞船属性；暂停（血条不再涨）后把血条设成一半
pnpm exec stride pause --hub game-menu | Out-Null
Main 'main.ships.forEach((ship, i) => { ship.power = i % 4; ship.control = (i + 1) % 4; ship.speed = (i + 2) % 4; }); main.powerStatus = 0; main.controlStatus = 1; main.speedStatus = 2; main.setLifeBar(0.5)'
Shot 'welcome'
Main "main.welcomePopup.visibility = 'collapsed'"
Shot 'main'
Main 'main.updateShipStatus(); main.showShipSelectionPopup()'
Shot 'ships'
# 用完就关：无头 Chrome 开着会一直按满帧率渲染
pnpm exec stride close | Out-Null
