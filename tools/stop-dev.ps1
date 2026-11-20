# 停掉本仓库留在后台的东西：各样例的开发服务器（vite）和调试 CLI 开的无头 Chrome（~/.stride-ts 下的）。它们不用了也会一直
# 占着：无头 Chrome 里的游戏按满帧率渲染，几个叠在一起能把显卡吃满，测出来的帧时间和冒烟的时序都不可信。
# 做完一个样例的验证就跑一遍。回归（tools/regress.ps1、verify.ps1）自己的服务器和浏览器默认不动，-All 连它们一起停。
# 用法：pwsh tools/stop-dev.ps1 [-Keep <样例名>[,<样例名>]] [-List] [-All]
#   -Keep 留下还在用的样例的开发服务器；-List 只列出来、不停。
param(
    [string[]]$Keep = @(),
    [switch]$List,
    [switch]$All
)
$ErrorActionPreference = 'Stop'

$found = @()
foreach ($process in Get-CimInstance Win32_Process -Filter "Name='node.exe'") {
    if ($process.CommandLine -notmatch 'stride-ts(-verify(?:-\d+)?)?\\apps\\([\w-]+)\\node_modules\\.bin\\\\\.\.\\vite\\bin\\vite\.js') { continue }
    $regress = [bool]$Matches[1]
    $found += [pscustomobject]@{ Kind = 'dev server'; Name = $Matches[2]; Regress = $regress; Id = $process.ProcessId; Started = $process.CreationDate }
}
foreach ($process in Get-CimInstance Win32_Process -Filter "Name='chrome.exe'") {
    # 只要浏览器的主进程（子进程带 --type=），而且用户目录在 ~/.stride-ts 下：用户自己的 Chrome 不碰
    if ($process.CommandLine -match '--type=' -or $process.CommandLine -notmatch '--user-data-dir="?[^"]*\\\.stride-ts\\([^"\s]+)') { continue }
    $found += [pscustomobject]@{ Kind = 'headless chrome'; Name = $Matches[1]; Regress = $Matches[1] -like 'regress*'; Id = $process.ProcessId; Started = $process.CreationDate }
}

foreach ($item in $found) {
    $kept = ($item.Kind -eq 'dev server' -and $Keep -contains $item.Name) -or ($item.Regress -and -not $All)
    $action = $List ? 'running' : ($kept ? 'kept' : 'stopped')
    '{0,-8} {1,-16} {2,-28} pid {3,-6} since {4:HH:mm}' -f $action, $item.Kind, $item.Name, $item.Id, $item.Started
    if (-not $List -and -not $kept) { Stop-Process -Id $item.Id -Force -Confirm:$false }
}
if ($found.Count -eq 0) { 'nothing running' }
