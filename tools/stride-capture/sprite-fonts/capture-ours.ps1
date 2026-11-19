# stride-ts 这边截同样的八屏（停在 2 秒，动画那屏 4 秒），和桌面 Stride 的参考图逐屏比，打印每屏的差。
# 先开着开发服务器（pnpm --filter @stride-ts/sprite-fonts dev），参考图用 SpriteFonts.Windows.exe --capture <目录> 截好。
# -NoKerning 关掉字距（Stride 不做字距，是有意的偏差），看字距以外的差。
# 用法：pwsh tools/stride-capture/sprite-fonts/capture-ours.ps1 [-Reference <参考图目录>] [-Out <输出目录>] [-NoKerning]
param(
    [string]$Reference = 'C:\code\stride-sprite-fonts\reference',
    [string]$Out = 'C:\code\stride-sprite-fonts\ours',
    [switch]$NoKerning
)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent)
# 自己的无头 Chrome（浏览器的记录和用户目录分开），不关 `stride open` 开着的窗口
$env:STRIDE_BROWSER_DIR = Join-Path $HOME '.stride-ts\capture'
New-Item -ItemType Directory -Force $Out | Out-Null
pnpm exec stride close | Out-Null
pnpm exec stride open 'http://localhost:5198/' --headless --size 1280x720 --dpr 1 | Out-Null
if ($NoKerning) {
    $fonts = "'StaticFont','DynamicFont','BoldFont','ItalicFont','AliasedFont','AntialiasedFont','ClearTypeFont','JapaneseFont','TimesNewRoman','HeaderFont'"
    pnpm exec stride eval "Promise.all([$fonts].map((n) => strideGame.content.loadFont('SpriteFonts/Shared/' + n).then((f) => { f.useKerning = false; }))).then(() => 1)" --hub sprite-fonts | Out-Null
}
foreach ($screen in 0..7) {
    $time = $screen -eq 7 ? 4 : 2
    pnpm exec stride eval "const r = strideGame.rootRenderer; r.isPlaying = false; r.currentScreen = $screen; r.currentTime = $time; 1" --hub sprite-fonts | Out-Null
    Start-Sleep -Milliseconds 400
    $result = pnpm exec stride shot (Join-Path $Out "screen$screen.png") --diff (Join-Path $Reference "screen$screen.png") --hub sprite-fonts | ConvertFrom-Json
    $d = $result.diff
    '{0}: mean {1:N2}, over 8 {2}, over 32 {3}' -f $screen, $d.mean, $d.over.'8', $d.over.'32'
}
