# stride-ts 这边截同样的四张（射线、投影、场景加载、声音四个教程的完成版；1280x720，不画调试文字），和桌面 Stride 的参考图逐张比，
# 打印每张的差。先开着开发服务器（pnpm --filter @stride-ts/csharp-intermediate dev），参考图用 CSharpIntermediate.Windows.exe
# --capture <目录> 截好。
# 用法：pwsh tools/stride-capture/csharp-intermediate/capture-ours.ps1 [-Reference <参考图目录>] [-Out <输出目录>]
param(
    [string]$Reference = 'C:\code\stride-csharp-intermediate\reference',
    [string]$Out = 'C:\code\stride-csharp-intermediate\ours'
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
Set-Location (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent)
# 自己的无头 Chrome（浏览器的记录和用户目录分开），不关 `stride open` 开着的窗口
$env:STRIDE_BROWSER_DIR = Join-Path $HOME '.stride-ts\capture'
New-Item -ItemType Directory -Force $Out | Out-Null
pnpm exec stride close | Out-Null
pnpm exec stride open 'http://localhost:5222/' --headless --size 1280x720 --dpr 1 | Out-Null
pnpm exec stride wait --hub csharp-intermediate | Out-Null
# 菜单的按钮（和 tutorial 命令）在 TutorialUI 的 start 里才建
Start-Sleep -Seconds 2
# 参考图是 Release 版截的，Stride 的调试文字只在调试版显示；色调映射的亮度适应两边都关掉（见 CSharpIntermediateApp.cs）
pnpm exec stride eval 'strideGame.debugText.visible = false; strideGame.graphicsCompositor.postEffects.toneMap.temporalAdaptation = false' --hub csharp-intermediate | Out-Null

foreach ($shot in @(@('Raycasting', 'raycasting'), @('Project & Unproject', 'project'), @('Scene loading', 'scene'), @('Audio', 'audio'))) {
    $name = '"{0}"' -f $shot[0]
    pnpm exec stride call tutorial $name --hub csharp-intermediate | Out-Null
    Start-Sleep -Milliseconds 1500
    # 顶上 40 像素是菜单的按钮：Stride 的 UI 在后处理之前画、被色调映射，我们画在后处理之后（有意的偏差），所以只比下面的场景
    $result = pnpm exec stride shot (Join-Path $Out "$($shot[1]).png") --diff (Join-Path $Reference "$($shot[1]).png") --region '0,40,1280,680' --hub csharp-intermediate | ConvertFrom-Json
    $d = $result.diff
    '{0}: per channel {1:N2}, over 8 {2:P2}, over 32 {3:P2}' -f $shot[1], $d.meanChannel, ($d.over.'8' / (1280 * 680)), ($d.over.'32' / (1280 * 680))
}
# 用完就关：无头 Chrome 开着会一直按满帧率渲染
pnpm exec stride close | Out-Null
