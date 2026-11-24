# 编辑器验收：每个样例保护好内容目录、起开发服务器、无头 Chrome 开编辑器、跑 accept.ts、全部停掉、还原内容目录，最后打印结果表。
#   pwsh tools/editor-accept/run.ps1 [-Apps platformer,topdown-rpg] [-Out <输出目录>]
# 不给 -Apps 时跑所有有场景文件的样例。端口 = 样例的端口 + $env:STRIDE_PORT_OFFSET（默认 0）；CLI 的状态目录照
# $env:STRIDE_STATE_DIR、$env:STRIDE_BROWSER_DIR（几个会话同时用时各设各的）。一次只开一个无头游戏。
param(
  [string[]]$Apps,
  [string]$Out = (Join-Path ([IO.Path]::GetTempPath()) 'stride-editor-accept')
)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..' '..')
Set-Location $root
# pwsh -File 把 `-Apps a,b` 当成一个字符串传进来
$Apps = @($Apps | ForEach-Object { $_ -split ',' } | Where-Object { $_ })
if ($Apps.Count -eq 0) {
  $Apps = Get-ChildItem apps -Directory | Where-Object {
    $content = Join-Path $_.FullName 'public\content'
    (Test-Path $content) -and (Get-ChildItem $content -Recurse -Filter '*.scene.json' -ErrorAction SilentlyContinue | Select-Object -First 1)
  } | ForEach-Object Name
}
$offset = [int]($env:STRIDE_PORT_OFFSET ?? 0)
# 过期的生成模型烘完再开（默认在后台补烘，验收到一半页面会热重载）
$env:STRIDE_BAKE_ON_OPEN = 'wait'
New-Item -ItemType Directory -Force $Out | Out-Null

$results = foreach ($app in $Apps) {
  Write-Host "===== $app"
  $port = $offset + [int](Select-String -Path "apps\$app\vite.config.ts" -Pattern 'strideApp\((\d+)').Matches.Groups[1].Value
  Remove-Item (Join-Path $Out "$app.json") -ErrorAction SilentlyContinue
  # 输出送到屏幕上：留在管道里会混进 $results（字符串没有 Passed，最后被当成没通过、退出码成了 1）
  pwsh (Join-Path $PSScriptRoot 'content.ps1') protect $app | Out-Host
  $server = Start-Process -FilePath pwsh -ArgumentList '-NoProfile', '-Command', "pnpm dev --strictPort --port $port *> `"$Out\$app-dev.log`"" -WorkingDirectory (Join-Path $root 'apps' $app) -PassThru -WindowStyle Hidden
  try {
    # stride open 等到游戏页面跑起来；新起的开发服务器第一次要预构建依赖，可能要一分钟
    # 界面按中文开：accept.ts 按中文的按钮名（aria-label）找按钮
    pnpm exec stride open "http://localhost:$port/__stride/editor/?lang=zh-CN" --headless --size 1400x900 --dpr 1 *> "$Out\$app-open.log"
    node (Join-Path $PSScriptRoot 'accept.ts') $app $port $Out *> "$Out\$app.log"
  } finally {
    pnpm exec stride close *> $null
    taskkill /T /F /PID $server.Id *> $null
    pwsh (Join-Path $PSScriptRoot 'content.ps1') restore $app | Out-Host
  }
  $file = Join-Path $Out "$app.json"
  $report = (Test-Path $file) ? (Get-Content $file -Raw | ConvertFrom-Json) : $null
  $first = $report ? "$(@($report.problems)[0])" : '(no report)'
  [pscustomobject]@{
    App      = $app
    Passed   = $report ? [bool]$report.passed : $false
    Scenes   = $report ? @($report.scenes).Count : 0
    Problems = $report ? @($report.problems).Count : 0
    First    = $first.Substring(0, [Math]::Min(100, $first.Length))
  }
}
$results | Format-Table -AutoSize | Out-String -Width 200
"reports and screenshots: $Out"
if ($results | Where-Object { -not $_.Passed }) { exit 1 }
exit 0
