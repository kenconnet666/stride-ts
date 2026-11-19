# 从 Stride 源码的 master 取出 PhysicsSample（Bepu 版；releases/4.4.2 标签里的还是 Bullet 版），改成用 4.4.2 的官方 nuget 包、
# net10.0（和 TPP、AnimatedModel 的参考一致），入口换成本目录的 PhysicsSampleApp.cs 再编译。
# 用法：pwsh tools/stride-capture/physics-sample/setup.ps1 [-Stride <Stride 源码目录>] [-Out <输出目录>] [-Ref <git 引用>]
param(
    [string]$Stride = 'C:\Users\Administrator\IdeaProjects\stride',
    [string]$Out = 'C:\code\stride-physics-sample',
    [string]$Ref = 'master'
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

if (Test-Path $Out) { throw "$Out already exists; remove it first" }
New-Item -ItemType Directory -Force $Out | Out-Null
$archive = Join-Path $Out 'sample.tar'
git -C $Stride archive --format=tar -o $archive $Ref 'samples/Physics/PhysicsSample'
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

$sample = Join-Path $Out 'samples\Physics\PhysicsSample'
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
$windows = Join-Path $sample 'PhysicsSample.Windows\PhysicsSample.Windows.csproj'
(Get-Content -Raw $windows) -replace '(<ProjectReference Include=[^>]*/>)', "`$1`n    <PackageReference Include=`"Stride.BepuPhysics`" Version=`"4.4.2`" />" | Set-Content -LiteralPath $windows -NoNewline
Copy-Item (Join-Path $PSScriptRoot 'PhysicsSampleApp.cs') (Join-Path $sample 'PhysicsSample.Windows\PhysicsSampleApp.cs') -Force
Copy-Item (Join-Path $PSScriptRoot '..\Benchmark.cs') (Join-Path $sample 'PhysicsSample.Windows\Benchmark.cs') -Force
dotnet build (Join-Path $sample 'PhysicsSample.Windows\PhysicsSample.Windows.csproj') -c Release
Write-Host "built $(Join-Path $sample 'Bin\Windows\Release\PhysicsSample.Windows.exe')"
