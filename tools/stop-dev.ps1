# 停掉本仓库留在后台的东西：各样例的开发服务器（vite）和调试 CLI 开的无头 Chrome（~/.stride-ts 下的）。它们不用了也会一直
# 占着：无头 Chrome 里的游戏按满帧率渲染，几个叠在一起能把显卡吃满，测出来的帧时间和冒烟的时序都不可信。
# 做完一个样例的验证就跑一遍。回归（tools/regress.ps1、verify.ps1、验证工作树）自己的服务器和浏览器、别的会话的无头 Chrome（状态目录
# ~/.stride-ts/agent-*）默认不动，-All 连它们一起停；STRIDE_STATE_DIR、STRIDE_BROWSER_DIR 指着的是自己的，照停。
# 有窗口的测试浏览器（`stride open` 不带 --headless 开的，装着调试桥，用户看着 agent 操作）默认也留着，-All 才停；它里面开着本机页面的
# 标签关掉（只留一个空白页）。
# 用法：pwsh tools/stop-dev.ps1 [-Keep <名字>[,<名字>]] [-List] [-All]
#   -Keep 留下还在用的（样例的开发服务器按样例名，浏览器按 ~/.stride-ts 下的目录名）；-List 只列出来、不停（running 是会停的，kept 是会留下的）。
param(
    [string[]]$Keep = @(),
    [switch]$List,
    [switch]$All
)
$ErrorActionPreference = 'Stop'

# 自己的状态目录（相对 ~/.stride-ts 的名字）
$home_ = Join-Path $HOME '.stride-ts'
$own = @($env:STRIDE_STATE_DIR, $env:STRIDE_BROWSER_DIR) | Where-Object { $_ } | ForEach-Object { [IO.Path]::GetRelativePath($home_, $_) }
$found = @()
foreach ($process in Get-CimInstance Win32_Process -Filter "Name='node.exe'") {
    if ($process.CommandLine -notmatch 'stride-ts(-verify(?:-\d+)?)?\\apps\\([\w-]+)\\node_modules\\.bin\\\\\.\.\\vite\\bin\\vite\.js') { continue }
    $regress = [bool]$Matches[1]
    $found += [pscustomobject]@{ Kind = 'dev server'; Name = $Matches[2]; Regress = $regress; Id = $process.ProcessId; Started = $process.CreationDate }
}
foreach ($process in Get-CimInstance Win32_Process -Filter "Name='chrome.exe'") {
    # 只要浏览器的主进程（子进程带 --type=），而且用户目录在 ~/.stride-ts 下：用户自己的 Chrome 不碰
    if ($process.CommandLine -match '--type=' -or $process.CommandLine -notmatch '--user-data-dir="?[^"]*\\\.stride-ts\\([^"\s]+)') { continue }
    $name = $Matches[1]
    $headless = $process.CommandLine -match '--headless'
    $found += [pscustomobject]@{ Kind = $headless ? 'headless chrome' : 'test browser'; Name = $name; Regress = ($name -like 'regress*' -or $name -like 'agent-*') -and -not ($own | Where-Object { $name -like "$_*" }); Windowed = -not $headless; Id = $process.ProcessId; Started = $process.CreationDate }
}

foreach ($item in $found) {
    $kept = ($Keep -contains $item.Name) -or (($item.Regress -or $item.Windowed) -and -not $All)
    $action = $kept ? 'kept' : ($List ? 'running' : 'stopped')
    '{0,-8} {1,-16} {2,-28} pid {3,-6} since {4:HH:mm}' -f $action, $item.Kind, $item.Name, $item.Id, $item.Started
    if (-not $List -and -not $kept) { Stop-Process -Id $item.Id -Force -Confirm:$false }
}
if ($found.Count -eq 0) { 'nothing running' }

# 留着的测试浏览器（有窗口的）：关掉开着本机页面的标签（开发服务器停了，这些页面没用了，开着的游戏页还在按满帧率画）；全是本机页面时
# 先开一个空白页，窗口留着（扩展、登录都在里面）
$browserFile = Join-Path $home_ 'browser.json'
if (-not $List -and (Test-Path $browserFile)) {
    try {
        $port = (Get-Content $browserFile -Raw | ConvertFrom-Json).port
        # 先放进变量再过滤：Invoke-RestMethod 把 JSON 数组当一个对象往管道里送，直接接 Where-Object 会把所有标签当成一项
        $targets = Invoke-RestMethod "http://127.0.0.1:$port/json/list" -TimeoutSec 2
        $pages = @($targets | Where-Object { $_.type -eq 'page' })
        $local = @($pages | Where-Object { $_.url -match '^https?://(localhost|127\.0\.0\.1)[:/]' })
        if ($local.Count -gt 0) {
            if ($local.Count -eq $pages.Count) { $null = Invoke-RestMethod -Method Put "http://127.0.0.1:$port/json/new?about:blank" -TimeoutSec 2 }
            foreach ($page in $local) { $null = Invoke-WebRequest "http://127.0.0.1:$port/json/close/$($page.id)" -TimeoutSec 2 }
            'closed   {0} local tab(s) in the test browser' -f $local.Count
        }
    } catch { }
}
