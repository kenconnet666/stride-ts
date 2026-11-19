# 各样例的 capture-ours.ps1 共用的几步（在脚本开头点引用：. (Join-Path $PSScriptRoot '..\ours.ps1')）：
# 开一个自己的无头 Chrome、在页面里执行、截图并和参考图比（打印一行结果）、关掉。先开着那个样例的开发服务器。
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
Set-Location (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent)
# 自己的无头 Chrome（浏览器的记录和用户目录分开），不关 `stride open` 开着的窗口
$env:STRIDE_BROWSER_DIR = Join-Path $HOME '.stride-ts\capture'

function Open-Capture([string]$Hub, [string]$Url, [string]$Size = '1280x720') {
    $script:CaptureHub = $Hub
    pnpm exec stride close | Out-Null
    pnpm exec stride open $Url --headless --size $Size --dpr 1 | Out-Null
    pnpm exec stride wait --hub $Hub | Out-Null
}

# stride 的子命令，对着 Open-Capture 开的那个页面：Invoke-Stride eval '...'、Invoke-Stride step 5
function Invoke-Stride {
    pnpm exec stride @args --hub $script:CaptureHub | Out-Null
}

# 不挂这些脚本加载场景（同桌面那边的 --no-scripts）；$Then 是场景换好以后接着执行的表达式
function Set-SceneWithoutScripts([string]$Scene, [string[]]$Scripts, [string]$Then = '1') {
    $names = ($Scripts | ForEach-Object { "'$_'" }) -join ', '
    Invoke-Stride eval "strideGame.setRootScene('$Scene', { scripts: Object.fromEntries([$names].map((k) => [k, null])) }).then(() => { $Then; return 1; })"
}

# 截一张存到 $OutFile，和 $ReferenceFile 比；$Region（x,y,w,h）只比这一块（去掉两边画法不同的 UI）
function Compare-Capture([string]$Name, [string]$OutFile, [string]$ReferenceFile, [string]$Region) {
    New-Item -ItemType Directory -Force (Split-Path $OutFile -Parent) | Out-Null
    $arguments = @('shot', $OutFile, '--diff', $ReferenceFile, '--hub', $script:CaptureHub) + ($Region ? @('--region', $Region) : @())
    $d = (pnpm exec stride @arguments | ConvertFrom-Json).diff
    $pixels = $Region ? [int]$Region.Split(',')[2] * [int]$Region.Split(',')[3] : $d.width * $d.height
    '{0}: per channel {1:N2}, over 8 {2:P2}, over 32 {3:P2}' -f $Name, $d.meanChannel, ($d.over.'8' / $pixels), ($d.over.'32' / $pixels)
}

# 用完就关：无头 Chrome 开着会一直按满帧率渲染
function Close-Capture {
    pnpm exec stride close | Out-Null
}
