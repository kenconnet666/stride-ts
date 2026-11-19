# stride-ts 这边截同样的三张（全屏的 UI、倾斜的 UI、面向相机的 UI；1280x720，SplashScript 移除、跟着走的按钮放在 sin = 0.5 的
# 位置，骑士的动画停在第 0 帧），和桌面 Stride 的参考图逐张比，打印每张的差。先开着开发服务器
# （pnpm --filter @stride-ts/ui-element-link dev），参考图用 UIElementLink.Windows.exe --capture <目录> 截好。
# 用法：pwsh tools/stride-capture/ui-element-link/capture-ours.ps1 [-Reference <参考图目录>] [-Out <输出目录>]
param(
    [string]$Reference = 'C:\code\stride-ui-element-link\reference',
    [string]$Out = 'C:\code\stride-ui-element-link\ours'
)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent)
New-Item -ItemType Directory -Force $Out | Out-Null
pnpm exec stride close | Out-Null
pnpm exec stride open 'http://localhost:5202/' --headless --size 1280x720 --dpr 1 | Out-Null

# 同 UIElementLinkApp.cs 的 Freeze
$freeze = @'
(async () => {
  const g = strideGame;
  const all = g.entities.ids().map((id) => g.entities.entity(id));
  const type = g.registry.scriptsNamed('SplashScript')[0];
  const splash = all.map((e) => e.get(type)).find(Boolean);
  const button = splash.followedButton;
  const center = [g.graphicsDevice.canvas.width / 2, g.graphicsDevice.canvas.height / 2];
  splash.entity.remove(type);
  button.canvasAbsolutePosition = [center[0] + center[0] * 0.75 * 0.5, center[1]];
  const knight = all.find((e) => e.name === 'Running Knight').get(strideEngine.AnimationComponent);
  for (const playing of knight.playingAnimations) { playing.currentTime = 0; playing.timeFactor = 0; }
  return 1;
})()
'@

foreach ($shot in @(@('UIElementLink/Shared/FullScreen', 'fullscreen'), @('UIElementLink/Shared/TiltedScreen', 'tilted'), @('UIElementLink/Shared/BillboardedScreen', 'billboarded'))) {
    pnpm exec stride eval "strideGame.setRootScene('$($shot[0])').then(() => 1)" --hub ui-element-link | Out-Null
    Start-Sleep -Milliseconds 500
    $freeze | pnpm exec stride eval - --hub ui-element-link | Out-Null
    Start-Sleep -Milliseconds 800
    $result = pnpm exec stride shot (Join-Path $Out "$($shot[1]).png") --diff (Join-Path $Reference "$($shot[1]).png") --hub ui-element-link | ConvertFrom-Json
    $d = $result.diff
    '{0}: mean {1:N2}, over 8 {2}, over 32 {3}' -f $shot[1], $d.mean, $d.over.'8', $d.over.'32'
}
