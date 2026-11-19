# 测每个样例的工程数字（路线图第三节"工程质量"和"性能"的验收）：导入时间、构建时间、页面下载量（原始和 brotli）、启动时间、
# 帧时间。每个样例：重新导入（-SkipImport 跳过），vite build，起 preview，开无头 Chrome（不限帧率、关垂直同步，窗口和桌面版一样大），
# 读 stride status 的启动时间和浏览器记下的资源，再用 stride perf 测 5 秒帧时间。桌面 Stride 的帧时间用各截图工程的
# --benchmark（tools/stride-capture/Benchmark.cs）。结果打印成表，也写进 -Out 给的 JSON。
# 用法：pwsh tools/measure.ps1 [-Apps topdown-rpg,first-person-shooter] [-SkipImport] [-Out measure.json]
param([string[]]$Apps, [switch]$SkipImport, [string]$Out)
$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$all = Get-ChildItem apps -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'scripts\import.ts') } | ForEach-Object Name
$selected = $Apps ? ($Apps -split ',' | ForEach-Object Trim) : $all
# 和桌面 Stride 的窗口一样大（GameSettings 的后备缓冲；截图工程的 README 用的也是这个尺寸），没列的是 1280x720
$sizes = @{ 'animated-model' = '640x1061'; 'bepu-sample' = '1600x900'; 'game-menu' = '640x1061' }
# 页面下载的资源：路径对到 dist 里的文件，brotli 量取旁边的 .br（没有就是压不小，按原样算）
$resources = 'JSON.stringify([location.pathname, ...performance.getEntriesByType("resource").map((e) => new URL(e.name).pathname)])'

$results = foreach ($app in $selected) {
    # preview 默认是开发服务器的端口加 1；被别的服务器占着时往后找空的
    $port = [int]([regex]::Match((Get-Content -Raw "apps\$app\vite.config.ts"), 'strideApp\((\d+)').Groups[1].Value) + 1
    while (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { $port += 100 }
    $import = $SkipImport ? $null : (Measure-Command { pnpm --filter "@stride-ts/$app" import:stride 2>&1 | Out-Null }).TotalSeconds
    $build = (Measure-Command { pnpm --filter "@stride-ts/$app" build 2>&1 | Out-Null }).TotalSeconds
    if ($LASTEXITCODE -ne 0) { throw "$app failed to build" }
    $dist = Join-Path $root "apps\$app\dist"
    $server = Start-Process pwsh -ArgumentList '-NoProfile', '-Command', "Set-Location apps\$app; pnpm preview --port $port --strictPort" -PassThru -WindowStyle Hidden
    try {
        $deadline = (Get-Date).AddSeconds(60)
        while (-not (Test-NetConnection localhost -Port $port -InformationLevel Quiet -WarningAction SilentlyContinue)) {
            if ((Get-Date) -gt $deadline) { throw "$app's preview server did not listen on $port" }
            Start-Sleep -Milliseconds 500
        }
        pnpm exec stride close | Out-Null
        pnpm exec stride open "http://localhost:$port/?debug" --headless --size ($sizes[$app] ?? '1280x720') --dpr 1 --chrome-arg=--disable-frame-rate-limit --chrome-arg=--disable-gpu-vsync | Out-Null
        Start-Sleep -Seconds 3
        $status = pnpm exec stride status --hub $app | ConvertFrom-Json
        $paths = pnpm exec stride eval $resources --hub $app | ConvertFrom-Json | ConvertFrom-Json
        $raw = 0; $brotli = 0
        foreach ($path in $paths | Select-Object -Unique) {
            $file = Join-Path $dist ($path -eq '/' ? 'index.html' : [uri]::UnescapeDataString($path.TrimStart('/')))
            if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { continue }
            $size = (Get-Item -LiteralPath $file).Length
            $raw += $size
            $brotli += (Test-Path -LiteralPath "$file.br") ? (Get-Item -LiteralPath "$file.br").Length : $size
        }
        $perf = pnpm exec stride perf --seconds 5 --no-gpu --hub $app | ConvertFrom-Json
        [pscustomobject]@{
            App = $app
            ImportS = $import ? [math]::Round($import, 1) : $null
            BuildS = [math]::Round($build, 1)
            DownloadMB = [math]::Round($raw / 1MB, 2)
            BrotliMB = [math]::Round($brotli / 1MB, 2)
            NativeMs = [math]::Round($status.startup.native)
            ContentMs = [math]::Round($status.startup.content)
            FirstFrameMs = [math]::Round($status.startup.firstFrame)
            FrameMs = $perf.frameMs.mean
            FrameP95Ms = $perf.frameMs.p95
            Gpu = $status.gpu.description
        }
    } finally {
        pnpm exec stride close | Out-Null
        taskkill /T /F /PID $server.Id | Out-Null
    }
}
$results | Format-Table -AutoSize
if ($Out) { $results | ConvertTo-Json | Set-Content $Out }
