# 从 Stride 源码搭出截参考图用的桌面 FirstPersonShooter（官方 nuget 包）再编译。源码当前分支的模板已经换成 Bepu 版（stride-ts 导入的
# 就是它；releases/4.4.2 标签里还是 Bullet 版），改成用 4.4.2 的包、net10.0，合成器资源的版本号从 3.1.0.3 改回 3.1.0.1
# （同 physics-sample），nuget 源只用 nuget.org，入口换成本目录的 FirstPersonShooterApp.cs。
# 用法：pwsh tools/stride-capture/first-person-shooter/setup.ps1 [-Stride <Stride 源码目录>] [-Out <输出目录>]
param(
    [string]$Stride = ($env:STRIDE_REPO ?? (Join-Path $HOME 'IdeaProjects\stride')),
    [string]$Out = 'C:\code\stride-first-person-shooter'
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

$templates = Join-Path $Stride 'samples\Templates'
if (Test-Path $Out) { throw "$Out already exists; remove it first" }
New-Item -ItemType Directory -Force (Join-Path $Out 'Templates\Packs') | Out-Null
Copy-Item -Recurse (Join-Path $templates 'FirstPersonShooter') (Join-Path $Out 'Templates')
foreach ($pack in 'VFXPackage', 'PrototypingBlocks', 'mannequinModel', 'SamplesAssetPackage') {
    Copy-Item -Recurse (Join-Path $templates "Packs\$pack") (Join-Path $Out 'Templates\Packs')
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

foreach ($csproj in Get-ChildItem -Recurse (Join-Path $Out 'Templates') -Filter *.csproj) {
    $text = (Get-Content -Raw $csproj.FullName) -replace 'net11\.0', 'net10.0' -replace 'Version="4\.4\.0"', 'Version="4.4.2"'
    Set-Content -LiteralPath $csproj.FullName -Value $text -NoNewline
}
$game = Join-Path $Out 'Templates\FirstPersonShooter\FirstPersonShooter'
$compositor = Join-Path $game 'Assets\GraphicsCompositor.sdgfxcomp'
(Get-Content -Raw $compositor) -replace 'SerializedVersion: \{Stride: 3\.1\.0\.3\}', 'SerializedVersion: {Stride: 3.1.0.1}' | Set-Content -LiteralPath $compositor -NoNewline
Copy-Item (Join-Path $PSScriptRoot 'FirstPersonShooterApp.cs') (Join-Path $game 'FirstPersonShooter.Windows\FirstPersonShooterApp.cs') -Force
Copy-Item (Join-Path $PSScriptRoot '..\Benchmark.cs') (Join-Path $game 'FirstPersonShooter.Windows\Benchmark.cs') -Force

dotnet build (Join-Path $game 'FirstPersonShooter.Windows\FirstPersonShooter.Windows.csproj') -c Release
Write-Host "built $(Join-Path $game 'Bin\Windows\Release\FirstPersonShooter.Windows.exe')"
