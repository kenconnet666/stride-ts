// 截参考图用（stride-ts 和桌面 Stride 比对）：加 --capture <目录> 时，FontRenderer 停在 --time 秒（默认 2；动画那屏用 4，文字转回
// 正、完全不透明），八屏依次各画 30 帧（运行时字体在后台生成字形，要等几帧；第一屏等 90 帧）后存成 <目录>/screen<N>.png 再退出。
// --benchmark N [--gpu-profile] 测帧时间（游戏照常跑，见 ../Benchmark.cs）。不加参数时就是原来的样例。
#nullable enable
using System;
using System.Globalization;
using System.IO;
using System.Reflection;
using SpriteFonts;
using Stride.Engine;
using Stride.Games;
using Stride.Graphics;

string? Option(string name) => Array.IndexOf(args, name) is var i and >= 0 ? args[i + 1] : null;
var capture = Option("--capture");
var time = float.Parse(Option("--time") ?? "2", CultureInfo.InvariantCulture);
using var game = BenchmarkGame.FromArgs(args) ?? (capture == null ? new Game() : new CaptureGame(capture, time));
game.Run();

sealed class CaptureGame(string directory, float time) : Game
{
    private const int FramesPerScreen = 30;
    private const int FirstScreenFrames = 90;
    private int screen;
    private int frame;

    // Stride 4.4.2 有启动画面、没有默认场景时合成器永远换不上（黑屏，见 ../Benchmark.cs），截图时不放启动画面
    protected override void PrepareContext()
    {
        base.PrepareContext();
        SceneSystem.SplashScreenUrl = null;
    }

    // FontRenderer 的私有字段：暂停、当前屏、这一屏的时间
    private static void Set(FontRenderer renderer, string name, object value) =>
        typeof(FontRenderer).GetField(name, BindingFlags.NonPublic | BindingFlags.Instance)!.SetValue(renderer, value);

    protected override void Update(GameTime gameTime)
    {
        base.Update(gameTime);
        if (SceneSystem.GraphicsCompositor?.Game is not FontRenderer renderer) return;
        Set(renderer, "isPlaying", false);
        Set(renderer, "currentScreenIndex", screen);
        Set(renderer, "currentTime", screen == 7 ? 4f : time);
    }

    protected override void Draw(GameTime gameTime)
    {
        base.Draw(gameTime);
        if (SceneSystem.GraphicsCompositor?.Game is not FontRenderer) return;
        if (++frame < (screen == 0 ? FirstScreenFrames : FramesPerScreen)) return;
        frame = 0;
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, $"screen{screen}.png");
        using (var stream = File.Create(path))
            GraphicsDevice.Presenter.BackBuffer.Save(GraphicsContext.CommandList, stream, ImageFileType.Png);
        Console.WriteLine($"captured {path}");
        if (++screen == 8) Exit();
    }
}
