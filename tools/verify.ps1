# 耗时的验证（全量回归、截图比对、测量）放进单独的 git 工作树里跑，主检出可以接着改代码（开发服务器的热重载不会打断它）。
# 先在主检出提交（不用推送），再用这个脚本让工作树切到那个提交、装依赖、跑脚本；通过后再推送。
#   pwsh tools/verify.ps1                                  # 工作树切到 HEAD，跑 tools/regress.ps1
#   pwsh tools/verify.ps1 -Ref abc123 -Arguments '-Apps','jumpy-jet,physics-sample'
#   pwsh tools/verify.ps1 -Script tools/measure.ps1
# 工作树默认在主检出旁边（stride-ts-verify），分离头指针，第一次运行时建。导入的内容（git 忽略的 apps/*/public/content）用目录
# 联接指向主检出：导入器改了以后先在主检出重新导入。回归用固定的 CLI 状态目录和端口（见 regress.ps1），同一时间只跑一个。
param(
    [string]$Ref = 'HEAD',
    [string]$Path,
    [string]$Script = 'tools/regress.ps1',
    [string[]]$Arguments = @()
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

$main = Split-Path $PSScriptRoot -Parent
$Path = $Path ? $Path : (Join-Path (Split-Path $main -Parent) 'stride-ts-verify')
$commit = git -C $main rev-parse --verify "$Ref^{commit}"
$dirty = git -C $main status --porcelain --untracked-files=no
if ($Ref -eq 'HEAD' -and $dirty) { Write-Warning "uncommitted changes in $main are not verified (commit them first)" }

if (Test-Path $Path) {
    # 工作树只用来验证，丢掉上次留下的改动
    git -C $Path checkout --quiet --force --detach $commit
    git -C $Path clean --quiet -fd
} else {
    git -C $main worktree add --quiet --detach $Path $commit
}
Write-Host "verifying $(git -C $Path log --oneline -1) in $Path"

Push-Location $Path
try {
    pnpm install --frozen-lockfile --reporter=silent
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
