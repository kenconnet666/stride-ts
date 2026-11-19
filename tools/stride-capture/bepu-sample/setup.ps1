# 从 Stride 源码的 master 取出 BepuSample（4.4.2 的标签里还没有这个样例），改成用 4.4.2 的官方 nuget 包、net10.0（和其他参考
# 一致），入口换成本目录的 BepuSampleApp.cs（去掉另一个入口 DemoApp.cs）再编译。
# 用法：pwsh tools/stride-capture/bepu-sample/setup.ps1 [-Stride <Stride 源码目录>] [-Out <输出目录>] [-Ref <git 引用>]
param(
    [string]$Stride = 'C:\Users\Administrator\IdeaProjects\stride',
    [string]$Out = 'C:\code\stride-bepu-sample',
    [string]$Ref = 'master'
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

if (Test-Path $Out) { throw "$Out already exists; remove it first" }
New-Item -ItemType Directory -Force $Out | Out-Null
$archive = Join-Path $Out 'sample.tar'
git -C $Stride archive --format=tar -o $archive $Ref 'samples/Physics/BepuSample'
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

$sample = Join-Path $Out 'samples\Physics\BepuSample'
foreach ($project in Get-ChildItem $sample -Recurse -Filter '*.csproj') {
    $text = Get-Content -Raw $project.FullName
    $text = $text -replace 'Version="4\.4\.0"', 'Version="4.4.2"' -replace 'net11\.0', 'net10.0'
    Set-Content -LiteralPath $project.FullName -Value $text -NoNewline
}
# master 的合成器资源是 3.1.0.3：两次升级只是把粒子、UI 的渲染特性标成自有项（4.4.2 里它们本来就在基础合成器里），
# 4.4.2 读不了这个版本号，改回 3.1.0.1
$compositor = Join-Path $sample 'Assets\Shared\GraphicsCompositor.sdgfxcomp'
(Get-Content -Raw $compositor) -replace 'SerializedVersion: \{Stride: 3\.1\.0\.3\}', 'SerializedVersion: {Stride: 3.1.0.1}' | Set-Content -LiteralPath $compositor -NoNewline
# 截图入口要用 BepuSimulation（--freeze-physics），Windows 工程直接引用 Stride.BepuPhysics
$windows = Join-Path $sample 'BepuSample.Windows\BepuSample.Windows.csproj'
(Get-Content -Raw $windows) -replace '(<ProjectReference Include=[^>]*/>)', "`$1`n    <PackageReference Include=`"Stride.BepuPhysics`" Version=`"4.4.2`" />" | Set-Content -LiteralPath $windows -NoNewline
Remove-Item (Join-Path $sample 'BepuSample.Windows\BepuSample.Windows.DemoApp.cs')
Copy-Item (Join-Path $PSScriptRoot 'BepuSampleApp.cs') (Join-Path $sample 'BepuSample.Windows\BepuSampleApp.cs') -Force
Copy-Item (Join-Path $PSScriptRoot '..\Benchmark.cs') (Join-Path $sample 'BepuSample.Windows\Benchmark.cs') -Force
dotnet build (Join-Path $sample 'BepuSample.Windows\BepuSample.Windows.csproj') -c Release
# 样例的 Windows 工程指定了 RuntimeIdentifier，输出在 win-x64 子目录里
Write-Host "built $(Join-Path $sample 'Bin\Windows\Release\win-x64\BepuSample.Windows.exe')"
