# 回归：把所有样例的冒烟脚本（apps/*/scripts/smoke.ts）挨个跑一遍。每个样例单独起开发服务器（--force，换掉 Vite 缓存的旧
# 原生包）、单独开一个无头 Chrome（多个标签同时跑时帧循环可能卡住），跑完关掉。场景要先导入过（各样例的 import:stride）。
# 用法：pwsh tools/regress.ps1 [-Apps physics-sample,topdown-rpg]
param([string[]]$Apps)
$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$all = Get-ChildItem apps -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'scripts\smoke.ts') } | ForEach-Object Name
$selected = $Apps ? $Apps : $all
$results = foreach ($app in $selected) {
    $port = [int]([regex]::Match((Get-Content -Raw "apps\$app\vite.config.ts"), 'strideApp\((\d+)').Groups[1].Value)
    $server = Start-Process pwsh -ArgumentList '-NoProfile', '-Command', "Set-Location apps\$app; pnpm dev --force --strictPort" -PassThru -WindowStyle Hidden
    try {
        $deadline = (Get-Date).AddSeconds(60)
        while (-not (Test-NetConnection localhost -Port $port -InformationLevel Quiet -WarningAction SilentlyContinue)) {
            if ((Get-Date) -gt $deadline) { throw "$app's dev server did not listen on $port" }
            Start-Sleep -Milliseconds 500
        }
        pnpm exec stride close | Out-Null
        pnpm exec stride open "http://localhost:$port/" --headless --size 1280x720 --dpr 1 | Out-Null
        $output = pnpm --filter "@stride-ts/$app" smoke -- --hub $app 2>&1
        $output | Write-Host
        [pscustomobject]@{ App = $app; Passed = $LASTEXITCODE -eq 0; Failed = @($output | Select-String '^FAIL').Count }
    } finally {
        pnpm exec stride close | Out-Null
        taskkill /T /F /PID $server.Id | Out-Null
    }
}
$results | Format-Table -AutoSize
if ($results.Passed -contains $false) { exit 1 }
