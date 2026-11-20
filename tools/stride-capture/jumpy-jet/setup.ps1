# 从 Stride 源码的 master 取出 JumpyJet（Bepu 版；releases/4.4.2 标签里的还是 Bullet 版），改成用 4.4.2 的官方 nuget 包、
# net10.0（同 physics-sample），入口换成本目录的 JumpyJetApp.cs 再编译。在 PowerShell 里跑（Git Bash 的 tar 把 `C:` 当成远程主机）。
# 用法：pwsh tools/stride-capture/jumpy-jet/setup.ps1 [-Stride <Stride 源码目录>] [-Out <输出目录>] [-Ref <git 引用>]
param(
    [string]$Stride = ($env:STRIDE_REPO ?? (Join-Path $HOME 'IdeaProjects\stride')),
    [string]$Out = 'C:\code\stride-jumpy-jet',
    [string]$Ref = 'master'
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

if (Test-Path $Out) { throw "$Out already exists; remove it first" }
New-Item -ItemType Directory -Force $Out | Out-Null
$archive = Join-Path $Out 'sample.tar'
git -C $Stride archive --format=tar -o $archive $Ref 'samples/Games/JumpyJet'
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

$sample = Join-Path $Out 'samples\Games\JumpyJet'
foreach ($project in Get-ChildItem $sample -Recurse -Filter '*.csproj') {
    $text = Get-Content -Raw $project.FullName
    $text = $text -replace 'Version="4\.4\.0"', 'Version="4.4.2"' -replace 'net11\.0', 'net10.0'
    Set-Content -LiteralPath $project.FullName -Value $text -NoNewline
}
# 合成器资源的版本号 3.1.0.3 改回 3.1.0.1（4.4.2 读不了，两次升级只是把粒子、UI 的渲染特性标成自有项，见 physics-sample）
$compositor = Join-Path $sample 'Assets\Shared\GraphicsCompositor.sdgfxcomp'
(Get-Content -Raw $compositor) -replace 'SerializedVersion: \{Stride: 3\.1\.0\.3\}', 'SerializedVersion: {Stride: 3.1.0.1}' | Set-Content -LiteralPath $compositor -NoNewline
Copy-Item (Join-Path $PSScriptRoot 'JumpyJetApp.cs') (Join-Path $sample 'JumpyJet.Windows\JumpyJetApp.cs') -Force
Copy-Item (Join-Path $PSScriptRoot '..\Benchmark.cs') (Join-Path $sample 'JumpyJet.Windows\Benchmark.cs') -Force
dotnet build (Join-Path $sample 'JumpyJet.Windows\JumpyJet.Windows.csproj') -c Release
Write-Host "built $(Join-Path $sample 'Bin\Windows\Release\JumpyJet.Windows.exe')"
