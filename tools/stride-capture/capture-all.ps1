# 把各样例的 capture-ours.ps1 挨个跑一遍：每个样例单独起开发服务器（它自己的端口，脚本里写的就是这个端口）、截图、和参考图比，
# 跑完停掉服务器。参考图要先截好（各目录的 README），场景要先导入过。
# 用法：pwsh tools/stride-capture/capture-all.ps1 [-Samples tpp,physics-sample]
param([string[]]$Samples)
$ErrorActionPreference = 'Stop'

$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
Set-Location $root
# 目录名和 apps 下的名字不一样的
$apps = @{ tpp = 'platformer' }
$all = Get-ChildItem $PSScriptRoot -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'capture-ours.ps1') } | ForEach-Object Name
# pwsh -File 把 `-Samples a,b` 当成一个字符串传进来，自己按逗号拆
$selected = $Samples ? ($Samples -split ',' | ForEach-Object Trim) : $all
foreach ($sample in $selected) {
    $app = $apps[$sample] ?? $sample
    $port = [int]([regex]::Match((Get-Content -Raw "apps\$app\vite.config.ts"), 'strideApp\((\d+)').Groups[1].Value)
    $server = Start-Process pwsh -ArgumentList '-NoProfile', '-Command', "Set-Location apps\$app; pnpm dev --strictPort" -PassThru -WindowStyle Hidden
    try {
        $deadline = (Get-Date).AddSeconds(60)
        while (-not (Test-NetConnection localhost -Port $port -InformationLevel Quiet -WarningAction SilentlyContinue)) {
            if ((Get-Date) -gt $deadline) { throw "$app's dev server did not listen on $port" }
            Start-Sleep -Milliseconds 500
        }
        "== $sample"
        pwsh -NoProfile -File (Join-Path $PSScriptRoot "$sample\capture-ours.ps1") 2>&1 | ForEach-Object { "$_" }
    } finally {
        taskkill /T /F /PID $server.Id | Out-Null
    }
}
