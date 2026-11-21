# 回归：把所有样例的冒烟脚本（apps/*/scripts/smoke.ts）跑一遍。每个样例单独起开发服务器（--force，换掉 Vite 缓存的旧
# 原生包）、单独开一个无头 Chrome（同一个浏览器里多个标签同时跑时帧循环可能卡住），跑完关掉。场景要先导入过（各样例的 import:stride）。
# 和平时用的分开：CLI 的状态（中枢、浏览器、Chrome 用户目录）放在 ~/.stride-ts/regress\<样例>，开发服务器的端口加 1000，所以不会
# 关掉 `stride open` 开着的窗口，也不和开着的开发服务器抢端口。verify.ps1 按槽位设 STRIDE_STATE_DIR 和 STRIDE_PORT_OFFSET，
# 两个槽位的回归可以同时跑。
# 几个样例同时跑（-Parallel，默认每 8 个逻辑核一路、最多 4 路）：每个样例在自己的子进程里跑，状态目录和端口各不相同。冒烟只看功能和
# 计数，不看帧时间，显卡够用时并行不影响结果；测帧时间用 measure.ps1，它一个一个来。
# 用法：pwsh tools/regress.ps1 [-Apps physics-sample,topdown-rpg | -Changed [-Base HEAD~1]] [-Parallel 4]
#   -Changed：只跑改动影响到的样例（和 -Base 比，默认 origin/main，见 tools/affected.ts），第 2 层测试；全量在 CI 里跑。
#   提交后马上推送了的，用 -Base 指推送前的提交（例如 HEAD~1）
#   -Slow 300：每帧多忙等 300 毫秒（页面地址的 stride-slow），本机复现 CI 的软件 WebGPU 上的慢帧（冒烟的时序问题）
#   -Editor：冒烟过了以后在同一个开发服务器上再跑编辑器验收（tools/editor-accept/accept.ts：打开、逐个实体画面板、不改就保存、
#     改、保存、重开、试玩；内容目录先保护、验完还原）。-Changed 时改了编辑器、场景的加载和格式、验收工具就自动对 platformer、
#     greybox 跑（tools/affected.ts --editor）
param(
    [string[]]$Apps,
    [switch]$Changed,
    [string]$Base = 'origin/main',
    [int]$Parallel = [Math]::Clamp([Math]::Floor([Environment]::ProcessorCount / 8), 1, 4),
    [int]$Slow = 0,
    [switch]$Editor,
    # 内部用：只跑这一个样例（并行时每个子进程跑一个）
    [string]$App
)
$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$stateRoot = $env:STRIDE_STATE_DIR ?? (Join-Path $HOME '.stride-ts' 'regress')
$portOffset = [int]($env:STRIDE_PORT_OFFSET ?? 1000)
$workerThreads = 4

# 端口上有没有在监听（Test-NetConnection 只有 Windows 有）
function Test-Port([int]$Port) {
    $client = [System.Net.Sockets.TcpClient]::new()
    # 按名字连：Vite 监听的 localhost 在 Windows 上是 ::1，在 Linux 上可能是 127.0.0.1
    try { return $client.ConnectAsync('localhost', $Port).Wait(500) } catch { return $false } finally { $client.Dispose() }
}

if ($App) {
    # 自己的进程，环境变量随便设：中枢、无头 Chrome 都按样例分开
    $env:STRIDE_STATE_DIR = Join-Path $stateRoot $App
    $env:STRIDE_BROWSER_DIR = $env:STRIDE_STATE_DIR
    # 上一轮强杀的开发服务器来不及删中枢的登记；这个目录只有这个样例用，开始前清掉
    Remove-Item (Join-Path $env:STRIDE_STATE_DIR 'hubs') -Recurse -Force -ErrorAction SilentlyContinue
    $appDir = Join-Path $root 'apps' $App
    $port = $portOffset + [int]([regex]::Match((Get-Content -Raw (Join-Path $appDir 'vite.config.ts')), 'strideApp\((\d+)').Groups[1].Value)
    $hidden = $IsWindows ? @{ WindowStyle = 'Hidden' } : @{}
    $server = Start-Process pwsh -ArgumentList '-NoProfile', '-Command', "Set-Location '$appDir'; pnpm dev --force --strictPort --port $port" -PassThru @hidden
    try {
        $deadline = (Get-Date).AddSeconds(90)
        while (-not (Test-Port $port)) {
            if ((Get-Date) -gt $deadline) { throw "$App's dev server did not listen on $port" }
            Start-Sleep -Milliseconds 500
        }
        pnpm exec stride close | Out-Null
        # 工作线程数固定：每个线程的栈算在原生内存里，预算（budgets.json）才和机器的核数无关。
        # 指针锁用模拟的：无头 Chrome 真锁上时会把用户的系统鼠标限制在它那个看不见的窗口（屏幕左上角）里。
        # STRIDE_CHROME_ARGS（空格分开）：CI 里用软件 WebGPU。画面固定 1280x720：冒烟的点击坐标、按后备缓冲布局的 UI 都按这个大小写
        # 外面的 @() 不能少：只有一个元素时管道的结果是字符串，@chromeArgs 展开字符串什么也不传（本地不设 STRIDE_CHROME_ARGS 时自动播放的参数就丢了）
        $chromeArgs = @(@('--autoplay-policy=no-user-gesture-required') + @(($env:STRIDE_CHROME_ARGS ?? '') -split ' ' | Where-Object { $_ }) | ForEach-Object { "--chrome-arg=$_" })
        $slowQuery = $Slow -gt 0 ? "&stride-slow=$Slow" : ''
        # 设备只要 WebGPU 的默认上限（同 CI 的软件 WebGPU）：本机的显卡给得多，超了默认上限的绑定只有 CI 上才报错
        pnpm exec stride open "http://localhost:$port/?stride-workers=$workerThreads&stride-pointer-lock=virtual&stride-limits=default$slowQuery" --headless --size 1280x720 --dpr 1 @chromeArgs | Out-Null
        pnpm --filter "@stride-ts/$App" smoke -- --hub $App 2>&1
        $code = $LASTEXITCODE
        # 失败时带上 Chrome 自己的日志里和 GPU 有关的行（GPU 进程崩溃、看门狗、共享内存不够这类事页面的控制台看不到）
        $chromeLog = Join-Path $env:STRIDE_BROWSER_DIR 'chrome-headless' 'chrome.log'
        if ($code -ne 0 -and (Test-Path $chromeLog)) {
            $gpuLines = Select-String -Path $chromeLog -Pattern 'gpu|dawn|webgpu|vulkan|swiftshader|crash|watchdog|shared ?memory|shm|out of memory|exit_code|lost' |
                Where-Object { $_.Line -notmatch ':CONSOLE[:(]' } | Select-Object -Last 60 | ForEach-Object Line
            if ($gpuLines) { Write-Host "--- chrome.log (GPU-related lines)"; $gpuLines | ForEach-Object { Write-Host $_ } }
        }
        if ($Editor -and $code -eq 0) {
            # 编辑器验收：同一个开发服务器，换开编辑器的页面；要保存场景，内容目录先保护起来（验完还原），报告和截图放在状态目录下
            pnpm exec stride close | Out-Null
            $out = Join-Path $env:STRIDE_STATE_DIR 'editor-accept'
            $report = Join-Path $out "$App.json"
            Remove-Item $report -ErrorAction SilentlyContinue
            pwsh -NoProfile -File (Join-Path $root 'tools' 'editor-accept' 'content.ps1') protect $App | Out-Null
            try {
                # 界面按中文开：accept.ts 按中文的按钮名找按钮
                pnpm exec stride open "http://localhost:$port/__stride/editor/?lang=zh-CN&stride-limits=default" --headless --size 1400x900 --dpr 1 @chromeArgs | Out-Null
                node (Join-Path $root 'tools' 'editor-accept' 'accept.ts') $App $port $out 2>&1 | Out-Null
            } finally {
                pnpm exec stride close | Out-Null
                pwsh -NoProfile -File (Join-Path $root 'tools' 'editor-accept' 'content.ps1') restore $App | Out-Null
            }
            $result = (Test-Path $report) ? (Get-Content $report -Raw | ConvertFrom-Json) : $null
            if ($result -and $result.passed) {
                Write-Host "ok   编辑器验收：$(@($result.scenes).Count) 个场景（$out）"
            } else {
                $problems = $result ? @($result.problems) : @('no report (see the dev server and Chrome logs)')
                $problems | ForEach-Object { Write-Host "FAIL 编辑器验收：$_" }
                $code = 1
            }
        }
        exit $code
    } finally {
        pnpm exec stride close | Out-Null
        # 连同 pnpm、vite 子进程一起停（taskkill /T 只有 Windows 有）
        try { [System.Diagnostics.Process]::GetProcessById($server.Id).Kill($true) } catch { }
    }
}

$all = Get-ChildItem apps -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'scripts' 'smoke.ts') } | ForEach-Object Name
# pwsh -File 把 `-Apps a,b` 当成一个字符串传进来，自己按逗号拆；-Changed 按改动挑（tools/affected.ts）
$selected = if ($Changed) { (node (Join-Path $root 'tools' 'affected.ts') $Base) -split ',' | Where-Object { $_ } }
    elseif ($Apps) { $Apps -split ',' | ForEach-Object Trim }
    else { $all }
# 跑编辑器验收的样例：-Editor 时是选中的全部，-Changed 时按改动（改了编辑器才有）
$editorApps = @(if ($Editor) { $selected } elseif ($Changed) { (node (Join-Path $root 'tools' 'affected.ts') $Base --editor) -split ',' | Where-Object { $_ } })
$selected = @(@($selected) + $editorApps | Select-Object -Unique)
# 没有冒烟脚本的样例（新建的工程还没写）不跑，说一声
$missing = @($selected | Where-Object { $_ -notin $all })
if ($missing.Count -gt 0) { Write-Host "no smoke test (scripts/smoke.ts) in: $($missing -join ', ')" }
$selected = @($selected | Where-Object { $_ -in $all })
if ($selected.Count -eq 0) {
    Write-Host 'no smoke test is affected by the changes'
    exit 0
}
Write-Host "running $($selected.Count) smoke tests, $Parallel at a time$($editorApps.Count -gt 0 ? " (editor acceptance on $($editorApps -join ', '))" : '')"
$results = $selected | ForEach-Object -ThrottleLimit $Parallel -Parallel {
    $started = Get-Date
    $editorArg = $_ -in $using:editorApps ? @('-Editor') : @()
    $output = pwsh -NoProfile -File $using:PSCommandPath -App $_ -Slow $using:Slow @editorArg 2>&1
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
