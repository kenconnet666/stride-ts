# 从 Stride 源码搭出截参考图用的桌面 Third Person Platformer（官方 nuget 包），再编译。
# 和源码里模板的差别：Stride 包用 4.4.2、目标框架 net10.0（源码 master 的模板是 4.4.0 / net11.0，4.4.0 读不了它的 GraphicsCompositor），
# GraphicsCompositor 取 releases/4.4.2 标签里的版本，nuget 源只用 nuget.org（不用本机编的开发版包），入口换成本目录的 ThirdPersonPlatformerApp.cs。
# 用法：pwsh tools/stride-capture/tpp/setup.ps1 [-Stride <Stride 源码目录>] [-Out <输出目录>]
param(
    [string]$Stride = 'C:\Users\Administrator\IdeaProjects\stride',
    [string]$Out = 'C:\code\stride-tpp'
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

$templates = Join-Path $Stride 'samples\Templates'
if (Test-Path $Out) { throw "$Out already exists; remove it first" }
New-Item -ItemType Directory -Force (Join-Path $Out 'Templates\Packs') | Out-Null
Copy-Item -Recurse (Join-Path $templates 'ThirdPersonPlatformer') (Join-Path $Out 'Templates')
foreach ($pack in 'PrototypingBlocks', 'mannequinModel') {
    Copy-Item -Recurse (Join-Path $templates "Packs\$pack") (Join-Path $Out 'Templates\Packs')
}

Set-Content -LiteralPath (Join-Path $Out 'nuget.config') -Value @'
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
  </packageSources>
</configuration>
'@

$game = Join-Path $Out 'Templates\ThirdPersonPlatformer\ThirdPersonPlatformer'
foreach ($csproj in Get-ChildItem -Recurse (Join-Path $Out 'Templates') -Filter *.csproj) {
    $text = (Get-Content -Raw $csproj.FullName) -replace 'net11\.0', 'net10.0' -replace 'Version="4\.4\.0"', 'Version="4.4.2"'
    Set-Content -LiteralPath $csproj.FullName -Value $text -NoNewline
}
git -C $Stride show 'releases/4.4.2:samples/Templates/ThirdPersonPlatformer/ThirdPersonPlatformer/Assets/GraphicsCompositor.sdgfxcomp' |
    Set-Content -LiteralPath (Join-Path $game 'Assets\GraphicsCompositor.sdgfxcomp')
Copy-Item (Join-Path $PSScriptRoot 'ThirdPersonPlatformerApp.cs') (Join-Path $game 'ThirdPersonPlatformer.Windows\ThirdPersonPlatformerApp.cs') -Force

dotnet build (Join-Path $game 'ThirdPersonPlatformer.Windows\ThirdPersonPlatformer.Windows.csproj') -c Release
Write-Host "built $(Join-Path $game 'Bin\Windows\Release\ThirdPersonPlatformer.Windows.exe')"
