// 截参考图用（stride-ts 和桌面 Stride 比对）：加 --capture <png> 时固定步长 1/60 秒、每次 Update 都画、不放启动画面，窗口是
// GameSettings 的 1280x720；画满 --frames 帧（默认 120）后存后备缓冲，把那一帧画的时候的游戏时间（波纹的相位按它算，
// CustomEffectRenderer 用 RenderContext.Time）写进旁边的 .time，然后退出。这个样例没有场景，合成器的根直接画。
// --benchmark N [--gpu-profile] 测帧时间（见 ../Benchmark.cs）。
#nullable enable
using System;
using System.Globalization;
using System.IO;
using Stride.Engine;
using Stride.Games;
using Stride.Graphics;

string? Option(string name) => Array.IndexOf(args, name) is var i and >= 0 ? args[i + 1] : null;
var capture = Option("--capture");
var frames = int.Parse(Option("--frames") ?? "120", CultureInfo.InvariantCulture);
using var game = BenchmarkGame.FromArgs(args) ?? (capture == null ? new Game() : new CaptureGame(capture, frames));
game.Run();

sealed class CaptureGame(string path, int frames) : Game
{
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

    protected override void Draw(GameTime gameTime)
    {
        base.Draw(gameTime);
        if (++frame != frames) return;
        var size = (GraphicsDevice.Presenter.BackBuffer.Width, GraphicsDevice.Presenter.BackBuffer.Height);
        if (size != (1280, 720)) throw new InvalidOperationException($"back buffer is {size}, expected 1280x720");
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        using (var stream = File.Create(path))
            GraphicsDevice.Presenter.BackBuffer.Save(GraphicsContext.CommandList, stream, ImageFileType.Png);
        var time = gameTime.Total.TotalSeconds.ToString("R", CultureInfo.InvariantCulture);
        Console.WriteLine($"captured {path} at {time} s");
        File.WriteAllText(Path.ChangeExtension(path, ".time"), time);
        Exit();
    }
}
