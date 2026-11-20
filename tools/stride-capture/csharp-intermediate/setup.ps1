# 从 Stride 源码搭出截参考图用的桌面 CSharpIntermediate（官方 nuget 包）再编译。取源码当前分支的样例（Bepu 版，stride-ts 导入的
# 就是它），改成用 4.4.2 的包、net10.0，合成器资源的版本号从 3.1.0.3 改回 3.1.0.1（同 csharp-beginner），nuget 源只用 nuget.org，
# 入口换成本目录的 CSharpIntermediateApp.cs。
# 导航教程（11_Navigation）去掉：它用的 Stride.BepuPhysics.Navigation 没有发布 4.4.2 的包，别的教程用不到它。
# 用法：pwsh tools/stride-capture/csharp-intermediate/setup.ps1 [-Stride <Stride 源码目录>] [-Out <输出目录>]
param(
    [string]$Stride = ($env:STRIDE_REPO ?? (Join-Path $HOME 'IdeaProjects\stride')),
    [string]$Out = 'C:\code\stride-csharp-intermediate'
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

if (Test-Path $Out) { throw "$Out already exists; remove it first" }
# 样例的工程按 ..\..\..\..\Templates\Packs 引用资源包，目录结构照源码的 samples 摆
New-Item -ItemType Directory -Force (Join-Path $Out 'Templates\Packs'), (Join-Path $Out 'Tutorials') | Out-Null
Copy-Item -Recurse (Join-Path $Stride 'samples\Tutorials\CSharpIntermediate') (Join-Path $Out 'Tutorials')
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

# 读一个文件、按顺序做几次正则替换（模式、替换成什么，成对给）、写回去。
function Edit-Text([string]$Path, [string[]]$Replacements) {
    $text = Get-Content -Raw -LiteralPath $Path
    for ($i = 0; $i -lt $Replacements.Count; $i += 2) { $text = $text -replace $Replacements[$i], $Replacements[$i + 1] }
    Set-Content -LiteralPath $Path -Value $text -NoNewline
}

foreach ($csproj in Get-ChildItem -Recurse $Out -Filter *.csproj) {
    Edit-Text $csproj.FullName 'net11\.0', 'net10.0', '\s*<PackageReference Include="Stride\.BepuPhysics\.Navigation"[^>]*/>', '', 'Version="4\.4\.0"', 'Version="4.4.2"'
}
$game = Join-Path $Out 'Tutorials\CSharpIntermediate\CSharpIntermediate'
Edit-Text (Join-Path $game 'Assets\GraphicsCompositor.sdgfxcomp') 'SerializedVersion: \{Stride: 3\.1\.0\.3\}', 'SerializedVersion: {Stride: 3.1.0.1}'

# 去掉导航教程：脚本、场景、包里登记的根资源、游戏设置里导航的配置
Remove-Item -Recurse -Force (Join-Path $game 'CSharpIntermediate.Game\11_Navigation'), (Join-Path $game 'Assets\Scenes\11_Navigation')
foreach ($package in Get-ChildItem -Recurse $game -Filter *.sdpkg) {
    Edit-Text $package.FullName '(?m)^.*/Scenes/11_Navigation/.*\r?\n', ''
}
Edit-Text (Join-Path $game 'Assets\GameSettings.sdgamesettings') '(?ms)^    - !RecastNavigationConfiguration.*?(?=^    - !)', ''

Copy-Item (Join-Path $PSScriptRoot 'CSharpIntermediateApp.cs') (Join-Path $game 'CSharpIntermediate.Windows\CSharpIntermediateApp.cs') -Force
Copy-Item (Join-Path $PSScriptRoot '..\Benchmark.cs') (Join-Path $game 'CSharpIntermediate.Windows\Benchmark.cs') -Force

dotnet build (Join-Path $game 'CSharpIntermediate.Windows\CSharpIntermediate.Windows.csproj') -c Release
Write-Host "built $(Join-Path $game 'Bin\Windows\Release\CSharpIntermediate.Windows.exe')"
