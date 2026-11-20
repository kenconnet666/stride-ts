# 耗时的验证（全量回归、截图比对、测量）放进单独的 git 工作树里跑，主检出可以接着改代码（开发服务器的热重载不会打断它）。
# 先在主检出提交（不用推送），再用这个脚本让工作树切到那个提交、装依赖、跑脚本；通过后再推送。
#   pwsh tools/verify.ps1                                  # 槽位 1 的工作树切到 HEAD，跑 tools/regress.ps1
#   pwsh tools/verify.ps1 -Slot 2 -Ref abc123 -Apps jumpy-jet,physics-sample   # 认不出的参数原样转给脚本
#   pwsh tools/verify.ps1 -Script tools/measure.ps1
# 两个槽位（-Slot 1、2）各有一个工作树（主检出旁边的 stride-ts-verify-<槽位>，分离头指针，第一次运行时建），可以同时跑：
# 每个槽位的 CLI 状态（中枢、无头 Chrome 的用户目录）在 ~/.stride-ts/regress-<槽位>，开发服务器的端口加 1000 × 槽位，互不抢。
# 工作树和主检出是同一个仓库，主检出提交了工作树就能切过去，不用推送。导入的内容（git 忽略的 apps/*/public/content）用目录
# 联接指向主检出：导入器改了以后先在主检出重新导入。
param(
    [ValidateSet(1, 2)]
    [int]$Slot = 1,
    [string]$Ref = 'HEAD',
    [string]$Path,
    [string]$Script = 'tools/regress.ps1',
    [Parameter(ValueFromRemainingArguments)][string[]]$Arguments = @()
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

$main = Split-Path $PSScriptRoot -Parent
$Path = $Path ? $Path : (Join-Path (Split-Path $main -Parent) "stride-ts-verify-$Slot")
$commit = git -C $main rev-parse --verify "$Ref^{commit}"
$dirty = git -C $main status --porcelain --untracked-files=no
if ($Ref -eq 'HEAD' -and $dirty) { Write-Warning "uncommitted changes in $main are not verified (commit them first)" }

if (Test-Path $Path) {
    # 工作树被拿去开发了（在分支上、或有没提交的改动）时不动它：下面的强制切换和清理会把那些工作丢掉
    $branch = git -C $Path symbolic-ref --quiet --short HEAD 2>$null
    $changes = git -C $Path status --porcelain --untracked-files=no
    if ($branch -or $changes) { throw "$Path is in use for development (branch '$branch'$(if ($changes) { ', uncommitted changes' })); run tools/regress.ps1 there instead, or use the other slot" }
    # 工作树只用来验证，丢掉上次留下的改动
    git -C $Path checkout --quiet --force --detach $commit
    git -C $Path clean --quiet -fd
} else {
    git -C $main worktree add --quiet --detach $Path $commit
}
Write-Host "verifying $(git -C $Path log --oneline -1) in $Path (slot $Slot)"

# 脚本（regress.ps1、measure.ps1）照这两个变量放 CLI 状态、挑端口
$env:STRIDE_STATE_DIR = Join-Path $HOME ".stride-ts\regress-$Slot"
$env:STRIDE_BROWSER_DIR = $env:STRIDE_STATE_DIR
$env:STRIDE_PORT_OFFSET = 1000 * $Slot

Push-Location $Path
try {
    # 工作树挪过位置或换过 pnpm 版本时 pnpm 要清掉 node_modules 重装，后台没有终端让它问：工作树可丢弃，不问直接清
    pnpm install --frozen-lockfile --reporter=silent --config.confirmModulesPurge=false
    foreach ($content in Get-ChildItem (Join-Path $main 'apps\*\public\content') -Directory) {
        $app = $content.Parent.Parent.Name
        $target = Join-Path $Path "apps\$app\public\content"
        if (-not (Test-Path (Join-Path $Path "apps\$app"))) { continue }
        if (-not (Test-Path $target)) { New-Item -ItemType Junction -Path $target -Target $content.FullName | Out-Null }
    }
    # 脚本失败时照它的退出码退出，不抛异常
    $PSNativeCommandUseErrorActionPreference = $false
    pwsh -NoProfile -File (Join-Path $Path $Script) @Arguments
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
