# 验收要保存场景：先把样例的内容目录保护起来，验完还原，保存只写到临时的那一份。
#   pwsh tools/editor-accept/content.ps1 protect <样例>   验收前
#   pwsh tools/editor-accept/content.ps1 restore <样例>   验收后（出错也要跑）
# 内容目录是指向主检出的联接（验证工作树）：联接换成一份拷贝，还原时删掉拷贝、重建联接，主检出不动。
# 内容目录是真目录（主检出）：整份备份到临时目录，还原时按备份镜像回去（保存改的、加的文件都撤掉）。
param(
  [Parameter(Mandatory)][ValidateSet('protect', 'restore')] [string]$Mode,
  [Parameter(Mandatory)] [string]$App
)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..' '..')
$content = Join-Path $root 'apps' $App 'public' 'content'
$backup = Join-Path ([IO.Path]::GetTempPath()) "stride-editor-accept-$App"
$marker = "$backup.json"

function Copy-Tree([string]$From, [string]$To, [switch]$Mirror) {
  robocopy $From $To /E @(if ($Mirror) { '/MIR' }) /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy $From -> $To failed: $LASTEXITCODE" }
}

if ($Mode -eq 'protect') {
  if (Test-Path $marker) { throw "$App is already protected ($marker); restore it first" }
  $item = Get-Item $content
  if ($item.LinkType -eq 'Junction') {
    $target = $item.Target
    cmd /c rmdir $content   # 只去掉联接本身，不碰它指向的目录
    Copy-Tree $target $content
    @{ kind = 'junction'; target = "$target" } | ConvertTo-Json | Set-Content $marker
  } else {
    if (Test-Path $backup) { Remove-Item $backup -Recurse -Force }
    Copy-Tree $content $backup
    @{ kind = 'directory' } | ConvertTo-Json | Set-Content $marker
  }
  "$App protected"
} else {
  if (-not (Test-Path $marker)) { "$App was not protected"; return }
  $state = Get-Content $marker -Raw | ConvertFrom-Json
  if ($state.kind -eq 'junction') {
    if ((Get-Item $content -ErrorAction SilentlyContinue)?.LinkType -ne 'Junction') {
      if (Test-Path $content) { Remove-Item $content -Recurse -Force }
      New-Item -ItemType Junction -Path $content -Target $state.target | Out-Null
    }
  } else {
    Copy-Tree $backup $content -Mirror
    Remove-Item $backup -Recurse -Force
  }
  Remove-Item $marker
  "$App restored"
}
