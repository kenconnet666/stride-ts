# 把所有样例（或 -Apps 给的）的内容从 Stride 源码重新导入到各自的 public/content。几个样例同时导（-Parallel，默认每 8 个逻辑核一路、
# 最多 4 路；导入器自己也用原生模块的工作线程编码贴图），每个样例的输出等它导完再整段打印。Stride 源码的位置见各样例的
# scripts/import.ts（STRIDE_REPO，默认 ~/IdeaProjects/stride，要是 kenconnet666/stride 的 web-experiment-base 分支）。
# 验证工作树联接着主检出的内容：验证跑着的时候不要重新导入。
# 用法：pwsh tools/import-all.ps1 [-Apps jumpy-jet,physics-sample] [-Parallel 4]
param(
    [string[]]$Apps,
    [int]$Parallel = [Math]::Clamp([Math]::Floor([Environment]::ProcessorCount / 8), 1, 4)
)
$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent
$all = Get-ChildItem (Join-Path $root 'apps') -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'scripts\import.ts') } | ForEach-Object Name
$selected = $Apps ? ($Apps -split ',' | ForEach-Object Trim) : $all
$results = $selected | ForEach-Object -ThrottleLimit $Parallel -Parallel {
    $started = Get-Date
    $output = pnpm --dir (Join-Path $using:root "apps\$_") -s import:stride 2>&1
    [pscustomobject]@{ App = $_; Passed = $LASTEXITCODE -eq 0; Seconds = [int]((Get-Date) - $started).TotalSeconds; Output = $output }
} | ForEach-Object {
    Write-Host "===== $($_.App) ($($_.Seconds) s)"
    $_.Output | Write-Host
    $_
}
$results | Sort-Object App | Format-Table App, Passed, Seconds -AutoSize
# 预制体实例应该都转成了引用（见 docs/decisions.md 的预制体那条）
$expanded = $results | Where-Object { $_.Output -match 'prefab instances kept expanded' } | ForEach-Object App
if ($expanded) { Write-Warning "prefab instances kept expanded in: $($expanded -join ', ')" }
if ($results.Passed -contains $false) { exit 1 }
