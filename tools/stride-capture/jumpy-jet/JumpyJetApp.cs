// 截参考图用（stride-ts 和桌面 Stride 比对）：加 --capture <目录> 时固定步长 1/60 秒、不放启动画面，窗口是 GameSettings 的 640x1136。
// 第 30 帧把画面定住：四层背景停在固定的滚动位置（ScrollPos 是 50、100、150、200 像素），几组管子放到固定的位置；下一帧截
// Menu.png（主菜单）；再下一帧广播开始、UI 换到计分页面，20 帧后截 Game.png，然后退出。stride-ts 这边是 capture-ours.ps1，
// 做同样的事。--benchmark N [--gpu-profile] 测帧时间（见 ../Benchmark.cs）。不加参数时就是原来的样例。
#nullable enable
using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using JumpyJet;
using Stride.Core.Mathematics;
using Stride.Engine;
using Stride.Engine.Events;
using Stride.Games;
using Stride.Graphics;
using Stride.Rendering.Compositing;

string? Option(string name) => Array.IndexOf(args, name) is var i and >= 0 ? args[i + 1] : null;
var capture = Option("--capture");
// 不声明 DPI 感知时，150% 缩放下 1136 高的窗口放大到 1704 物理像素、超出屏幕，被压到屏幕高度（后备缓冲跟着变小）
if (capture != null) SetProcessDpiAwarenessContext(-4); // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
using var game = BenchmarkGame.FromArgs(args) ?? (capture == null ? new Game() : new CaptureGame(capture));
game.Run();

[DllImport("user32.dll")]
static extern bool SetProcessDpiAwarenessContext(nint value);

sealed class CaptureGame(string directory) : Game
{
    private const int Freeze = 30;
    private const int GameFrames = 20;
    /** 几组管子的高度（PipesScript 随机给的那个），x 照 PipesScript.Reset 从 4 起每隔 4。 */
    private static readonly float[] PipeHeights = [1.0f, 1.6f, 0.7f, 2.0f, 1.3f];
    private int frame;

    protected override void PrepareContext()
    {
        base.PrepareContext();
        SceneSystem.SplashScreenUrl = null;
        IsFixedTimeStep = true;
        TargetElapsedTime = TimeSpan.FromSeconds(1 / 60.0);
        // 画得慢时固定步长会连跑几次 Update 才画一次，按帧号截图就会错过：每次 Update 都画
        ForceOneUpdatePerDraw = true;
    }

    private Entity[] Entities() => SceneSystem.SceneInstance.RootScene.Entities.SelectMany(e => e.GetChildren().Prepend(e)).ToArray();

    /** 背景停在固定的滚动位置（BackgroundSection 的 ScrollPos 只能在里面设，用反射），管子放到固定的位置。 */
    private void FreezeScene()
    {
        var renderer = (JumpyJetRenderer)((SceneCameraRenderer)SceneSystem.GraphicsCompositor.Game).Child;
        renderer.StopScrolling();
        var sections = (System.Collections.Generic.List<BackgroundSection>)typeof(JumpyJetRenderer).GetField("backgroundParallax", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(renderer)!;
        var update = typeof(BackgroundSection).GetMethod("UpdateSpriteQuads", BindingFlags.NonPublic | BindingFlags.Instance)!;
        for (var i = 0; i < sections.Count; i++)
        {
            typeof(BackgroundSection).GetProperty(nameof(BackgroundSection.ScrollPos))!.SetValue(sections[i], 50f * (i + 1));
            update.Invoke(sections[i], null);
        }
        var pipeSets = Entities().Single(e => e.Get<PipesScript>() != null).Transform.Children;
        for (var i = 0; i < pipeSets.Count; i++)
            pipeSets[i].Position = new Vector3(4 + 4 * i, PipeHeights[i % PipeHeights.Length], 0);
    }

    protected override void Update(GameTime gameTime)
    {
        base.Update(gameTime);
        if (SceneSystem.SceneInstance?.RootScene == null) return;
        frame++;
        if (frame == Freeze)
        {
            var size = (GraphicsDevice.Presenter.BackBuffer.Width, GraphicsDevice.Presenter.BackBuffer.Height);
            if (size != (640, 1136)) throw new InvalidOperationException($"back buffer is {size}, expected 640x1136 (the window does not fit on the screen?)");
            FreezeScene();
        }
        if (frame == Freeze + 2)
        {
            // GameGlobals 是 internal：用反射取事件键（同开始按钮的 Click）
            var globals = typeof(UIScript).Assembly.GetType("JumpyJet.GameGlobals")!;
            ((EventKey)globals.GetField("GameStartedEventKey")!.GetValue(null)!).Broadcast();
            Entities().Select(e => e.Get<UIScript>()).Single(s => s != null).StartGameMode();
        }
    }

    protected override void Draw(GameTime gameTime)
    {
        base.Draw(gameTime);
        var name = frame == Freeze + 1 ? "Menu" : frame == Freeze + 2 + GameFrames ? "Game" : null;
        if (name == null) return;
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, $"{name}.png");
        using (var stream = File.Create(path))
            GraphicsDevice.Presenter.BackBuffer.Save(GraphicsContext.CommandList, stream, ImageFileType.Png);
        Console.WriteLine($"captured {path}");
        if (name == "Game") Exit();
    }
}
