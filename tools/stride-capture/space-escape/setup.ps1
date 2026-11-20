# 从 Stride 源码的 releases/4.4.2 标签取出 SpaceEscape（那个版本已经是 4.4.2 的 nuget 包、net10.0，和 master 只差 GameSettings
# 里一项音频设置），入口换成本目录的 SpaceEscapeApp.cs 再编译。在 PowerShell 里跑（Git Bash 的 tar 把 `C:` 当成远程主机）。
# 用法：pwsh tools/stride-capture/space-escape/setup.ps1 [-Stride <Stride 源码目录>] [-Out <输出目录>] [-Ref <git 引用>]
param(
    [string]$Stride = ($env:STRIDE_REPO ?? (Join-Path $HOME 'IdeaProjects\stride')),
    [string]$Out = 'C:\code\stride-space-escape',
    [string]$Ref = 'releases/4.4.2'
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

if (Test-Path $Out) { throw "$Out already exists; remove it first" }
New-Item -ItemType Directory -Force $Out | Out-Null
$archive = Join-Path $Out 'sample.tar'
git -C $Stride archive --format=tar -o $archive $Ref 'samples/Games/SpaceEscape'
tar -xf $archive -C $Out
Remove-Item $archive

Set-Content -LiteralPath (Join-Path $Out 'nuget.config') -Value @'
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
  </packageSources>
</configuration>
'@

$sample = Join-Path $Out 'samples\Games\SpaceEscape'
Copy-Item (Join-Path $PSScriptRoot 'SpaceEscapeApp.cs') (Join-Path $sample 'SpaceEscape.Windows\SpaceEscapeApp.cs') -Force
Copy-Item (Join-Path $PSScriptRoot '..\Benchmark.cs') (Join-Path $sample 'SpaceEscape.Windows\Benchmark.cs') -Force
dotnet build (Join-Path $sample 'SpaceEscape.Windows\SpaceEscape.Windows.csproj') -c Release
Write-Host "built $(Join-Path $sample 'Bin\Windows\Release\SpaceEscape.Windows.exe')"
