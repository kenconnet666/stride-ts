# 从 Stride 源码的 releases/4.4.2 标签取出 Platformer2D 模板（已经是 4.4.2 的包、net10.0），Game 工程补上脚本用到的
# Stride.BepuPhysics（标签里的模板工程没有列出这个包），入口换成本目录的 Platformer2DApp.cs 再编译。
# 用法：pwsh tools/stride-capture/platformer2d/setup.ps1 [-Stride <Stride 源码目录>] [-Out <输出目录>] [-Ref <git 引用>]
param(
    [string]$Stride = ($env:STRIDE_REPO ?? (Join-Path $HOME 'IdeaProjects\stride')),
    [string]$Out = 'C:\code\stride-platformer2d',
    [string]$Ref = 'releases/4.4.2'
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

if (Test-Path $Out) { throw "$Out already exists; remove it first" }
New-Item -ItemType Directory -Force $Out | Out-Null
$archive = Join-Path $Out 'template.tar'
git -C $Stride archive --format=tar -o $archive $Ref 'samples/Templates/Platformer2D'
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

$template = Join-Path $Out 'samples\Templates\Platformer2D\Platformer2D'
$gameProject = Join-Path $template 'Platformer2D.Game\Platformer2D.csproj'
(Get-Content -Raw $gameProject) -replace '(<PackageReference Include="Stride.Engine"[^>]*/>)', "`$1`n    <PackageReference Include=`"Stride.BepuPhysics`" Version=`"4.4.2`" />" |
    Set-Content -LiteralPath $gameProject -NoNewline
Copy-Item (Join-Path $PSScriptRoot 'Platformer2DApp.cs') (Join-Path $template 'Platformer2D.Windows\Platformer2DApp.cs') -Force
Copy-Item (Join-Path $PSScriptRoot '..\Benchmark.cs') (Join-Path $template 'Platformer2D.Windows\Benchmark.cs') -Force
dotnet build (Join-Path $template 'Platformer2D.Windows\Platformer2D.Windows.csproj') -c Release
Write-Host "built $(Join-Path $template 'Bin\Windows\Release\Platformer2D.Windows.exe')"
