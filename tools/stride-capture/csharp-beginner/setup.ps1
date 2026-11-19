# 从 Stride 源码搭出截参考图用的桌面 CSharpBeginner（官方 nuget 包）再编译。取源码当前分支的样例（Bepu 版，stride-ts 导入的
# 就是它），改成用 4.4.2 的包、net10.0，合成器资源的版本号从 3.1.0.3 改回 3.1.0.1（同 first-person-shooter），nuget 源只用
# nuget.org，入口换成本目录的 CSharpBeginnerApp.cs。
# 用法：pwsh tools/stride-capture/csharp-beginner/setup.ps1 [-Stride <Stride 源码目录>] [-Out <输出目录>]
param(
    [string]$Stride = 'C:\Users\Administrator\IdeaProjects\stride',
    [string]$Out = 'C:\code\stride-csharp-beginner'
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

if (Test-Path $Out) { throw "$Out already exists; remove it first" }
# 样例的工程按 ..\..\..\..\Templates\Packs 引用资源包，目录结构照源码的 samples 摆
New-Item -ItemType Directory -Force (Join-Path $Out 'Templates\Packs'), (Join-Path $Out 'Tutorials') | Out-Null
Copy-Item -Recurse (Join-Path $Stride 'samples\Tutorials\CSharpBeginner') (Join-Path $Out 'Tutorials')
foreach ($pack in 'PrototypingBlocks', 'mannequinModel', 'SamplesAssetPackage') {
    Copy-Item -Recurse (Join-Path $Stride "samples\Templates\Packs\$pack") (Join-Path $Out 'Templates\Packs')
}
# 源码里编过的中间文件不要
Get-ChildItem -Recurse -Directory $Out -Include 'obj', 'Bin' | Remove-Item -Recurse -Force

Set-Content -LiteralPath (Join-Path $Out 'nuget.config') -Value @'
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
  </packageSources>
</configuration>
'@

foreach ($csproj in Get-ChildItem -Recurse $Out -Filter *.csproj) {
    $text = (Get-Content -Raw $csproj.FullName) -replace 'net11\.0', 'net10.0' -replace 'Version="4\.4\.0"', 'Version="4.4.2"'
    Set-Content -LiteralPath $csproj.FullName -Value $text -NoNewline
}
$game = Join-Path $Out 'Tutorials\CSharpBeginner\CSharpBeginner'
$compositor = Join-Path $game 'Assets\GraphicsCompositor.sdgfxcomp'
(Get-Content -Raw $compositor) -replace 'SerializedVersion: \{Stride: 3\.1\.0\.3\}', 'SerializedVersion: {Stride: 3.1.0.1}' | Set-Content -LiteralPath $compositor -NoNewline
Copy-Item (Join-Path $PSScriptRoot 'CSharpBeginnerApp.cs') (Join-Path $game 'CSharpBeginner.Windows\CSharpBeginnerApp.cs') -Force
Copy-Item (Join-Path $PSScriptRoot '..\Benchmark.cs') (Join-Path $game 'CSharpBeginner.Windows\Benchmark.cs') -Force

dotnet build (Join-Path $game 'CSharpBeginner.Windows\CSharpBeginner.Windows.csproj') -c Release
Write-Host "built $(Join-Path $game 'Bin\Windows\Release\CSharpBeginner.Windows.exe')"
