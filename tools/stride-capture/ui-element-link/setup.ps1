# 从 Stride 源码的 releases/4.4.2 标签取出 UIElementLink 样例（那个版本的样例已经是 4.4.2 / net10.0），入口换成本目录的
# UIElementLinkApp.cs，用官方 nuget 包编译。
# 用法：pwsh tools/stride-capture/ui-element-link/setup.ps1 [-Stride <Stride 源码目录>] [-Out <输出目录>]
param(
    [string]$Stride = 'C:\Users\Administrator\IdeaProjects\stride',
    [string]$Out = 'C:\code\stride-ui-element-link'
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

if (Test-Path $Out) { throw "$Out already exists; remove it first" }
New-Item -ItemType Directory -Force $Out | Out-Null
$archive = Join-Path $Out 'sample.tar'
git -C $Stride archive --format=tar -o $archive 'releases/4.4.2' 'samples/UI/UIElementLink'
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

$sample = Join-Path $Out 'samples\UI\UIElementLink'
Copy-Item (Join-Path $PSScriptRoot 'UIElementLinkApp.cs') (Join-Path $sample 'UIElementLink.Windows\UIElementLinkApp.cs') -Force
Copy-Item (Join-Path $PSScriptRoot '..\Benchmark.cs') (Join-Path $sample 'UIElementLink.Windows\Benchmark.cs') -Force
dotnet build (Join-Path $sample 'UIElementLink.Windows\UIElementLink.Windows.csproj') -c Release
Write-Host "built $(Join-Path $sample 'Bin\Windows\Release\UIElementLink.Windows.exe')"
