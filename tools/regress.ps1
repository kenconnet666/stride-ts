# 回归：把所有样例的冒烟脚本（apps/*/scripts/smoke.ts）跑一遍。每个样例单独起开发服务器（--force，换掉 Vite 缓存的旧
# 原生包）、单独开一个无头 Chrome（同一个浏览器里多个标签同时跑时帧循环可能卡住），跑完关掉。场景要先导入过（各样例的 import:stride）。
# 和平时用的分开：CLI 的状态（中枢、浏览器、Chrome 用户目录）放在 ~/.stride-ts/regress\<样例>，开发服务器的端口加 1000，所以不会
# 关掉 `stride open` 开着的窗口，也不和开着的开发服务器抢端口。verify.ps1 按槽位设 STRIDE_STATE_DIR 和 STRIDE_PORT_OFFSET，
# 两个槽位的回归可以同时跑。
# 几个样例同时跑（-Parallel，默认每 8 个逻辑核一路、最多 4 路）：每个样例在自己的子进程里跑，状态目录和端口各不相同。冒烟只看功能和
# 计数，不看帧时间，显卡够用时并行不影响结果；测帧时间用 measure.ps1，它一个一个来。
# 用法：pwsh tools/regress.ps1 [-Apps physics-sample,topdown-rpg] [-Parallel 4]
param(
    [string[]]$Apps,
    [int]$Parallel = [Math]::Clamp([Math]::Floor([Environment]::ProcessorCount / 8), 1, 4),
    # 内部用：只跑这一个样例（并行时每个子进程跑一个）
    [string]$App
)
$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$stateRoot = $env:STRIDE_STATE_DIR ?? (Join-Path $HOME '.stride-ts\regress')
$portOffset = [int]($env:STRIDE_PORT_OFFSET ?? 1000)
$workerThreads = 4

if ($App) {
    # 自己的进程，环境变量随便设：中枢、无头 Chrome 都按样例分开
    $env:STRIDE_STATE_DIR = Join-Path $stateRoot $App
    $env:STRIDE_BROWSER_DIR = $env:STRIDE_STATE_DIR
    $port = $portOffset + [int]([regex]::Match((Get-Content -Raw "apps\$App\vite.config.ts"), 'strideApp\((\d+)').Groups[1].Value)
    $server = Start-Process pwsh -ArgumentList '-NoProfile', '-Command', "Set-Location apps\$App; pnpm dev --force --strictPort --port $port" -PassThru -WindowStyle Hidden
    try {
        $deadline = (Get-Date).AddSeconds(60)
        while (-not (Test-NetConnection localhost -Port $port -InformationLevel Quiet -WarningAction SilentlyContinue)) {
            if ((Get-Date) -gt $deadline) { throw "$App's dev server did not listen on $port" }
            Start-Sleep -Milliseconds 500
        }
        pnpm exec stride close | Out-Null
        # 工作线程数固定：每个线程的栈算在原生内存里，预算（budgets.json）才和机器的核数无关。
        # 指针锁用模拟的：无头 Chrome 真锁上时会把用户的系统鼠标限制在它那个看不见的窗口（屏幕左上角）里
        pnpm exec stride open "http://localhost:$port/?stride-workers=$workerThreads&stride-pointer-lock=virtual" --headless --size 1280x720 --dpr 1 --chrome-arg=--autoplay-policy=no-user-gesture-required | Out-Null
        pnpm --filter "@stride-ts/$App" smoke -- --hub $App 2>&1
        exit $LASTEXITCODE
    } finally {
        pnpm exec stride close | Out-Null
        taskkill /T /F /PID $server.Id | Out-Null
    }
}

$all = Get-ChildItem apps -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'scripts\smoke.ts') } | ForEach-Object Name
# pwsh -File 把 `-Apps a,b` 当成一个字符串传进来，自己按逗号拆
$selected = $Apps ? ($Apps -split ',' | ForEach-Object Trim) : $all
Write-Host "running $($selected.Count) smoke tests, $Parallel at a time"
$results = $selected | ForEach-Object -ThrottleLimit $Parallel -Parallel {
    $started = Get-Date
    $output = pwsh -NoProfile -File $using:PSCommandPath -App $_ 2>&1
    [pscustomobject]@{
        App = $_
        Passed = $LASTEXITCODE -eq 0
        Failed = @($output | Select-String '^FAIL').Count
        Seconds = [int]((Get-Date) - $started).TotalSeconds
        Output = $output
    }
} | ForEach-Object {
    # 一个样例跑完才整段打印，并行时输出不交错
    Write-Host "===== $($_.App) ($($_.Seconds) s)"
    $_.Output | Write-Host
    $_
}
$results | Sort-Object App | Format-Table App, Passed, Failed, Seconds -AutoSize
if ($results.Passed -contains $false) { exit 1 }
