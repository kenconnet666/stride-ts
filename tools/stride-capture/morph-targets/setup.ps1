# 从 Stride 源码的当前提交取出 MorphTargets（master 新加的样例，形变也只在 master 里，4.4.2 没有），包换成本机编的
# 4.5.3-dev4（NuGet 全局缓存里的，带形变），入口换成本目录的 MorphTargetsApp.cs 再编译。在 PowerShell 里跑（Git Bash 的 tar
# 把 `C:` 当成远程主机）。
# 用法：pwsh tools/stride-capture/morph-targets/setup.ps1 [-Stride <Stride 源码目录>] [-Out <输出目录>] [-Ref <git 引用>] [-Version <包版本>]
param(
    [string]$Stride = 'C:\Users\Administrator\IdeaProjects\stride',
    [string]$Out = 'C:\code\stride-morph-targets',
    [string]$Ref = 'HEAD',
    [string]$Version = '4.5.3-dev4'
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

if (Test-Path $Out) { throw "$Out already exists; remove it first" }
$cached = Join-Path $HOME ".nuget\packages\stride.engine\$Version"
if (-not (Test-Path $cached)) { throw "Stride $Version is not in the NuGet cache ($cached); build and pack the engine first" }
New-Item -ItemType Directory -Force $Out | Out-Null
$archive = Join-Path $Out 'sample.tar'
git -C $Stride archive --format=tar -o $archive $Ref 'samples/Graphics/MorphTargets'
tar -xf $archive -C $Out
Remove-Item $archive

# 本机编的包在全局缓存里，按版本直接用；别的依赖从 nuget.org 取
Set-Content -LiteralPath (Join-Path $Out 'nuget.config') -Value @'
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
  </packageSources>
</configuration>
'@

$sample = Join-Path $Out 'samples\Graphics\MorphTargets'
$game = Join-Path $sample 'MorphTargets.Game\MorphTargets.Game.csproj'
(Get-Content $game -Raw) -replace 'Version="4\.4\.0"', "Version=`"$Version`"" | Set-Content $game -NoNewline
Copy-Item (Join-Path $PSScriptRoot 'MorphTargetsApp.cs') (Join-Path $sample 'MorphTargets.Windows\MorphTargetsApp.cs') -Force
Copy-Item (Join-Path $PSScriptRoot '..\Benchmark.cs') (Join-Path $sample 'MorphTargets.Windows\Benchmark.cs') -Force
dotnet build (Join-Path $sample 'MorphTargets.Windows\MorphTargets.Windows.csproj') -c Release
Write-Host "built $(Join-Path $sample 'Bin\Windows\Release\MorphTargets.Windows.exe')"
