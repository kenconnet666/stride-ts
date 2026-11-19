// 截参考图用（stride-ts 和桌面 Stride 比对）：加 --capture <目录> 时窗口是 1280x720（GameSettings 的大小），不放启动画面。
// 60 帧后截 idle.png（波形图透明）；下一帧在脚本更新之后把两个波形图放回起点（左 0.35、右 0.65，同点击时）、不透明度设成 1，
// 截 wave.png，退出。stride-ts 这边是 capture-ours.ps1，做同样的事。--benchmark N [--gpu-profile] 测帧时间（见 ../Benchmark.cs）。
#nullable enable
using System;
using System.IO;
using System.Linq;
using Stride.Core.Mathematics;
using Stride.Engine;
using Stride.Games;
using Stride.Graphics;
using Stride.UI;
using Stride.UI.Controls;
using Stride.UI.Panels;

string? Option(string name) => Array.IndexOf(args, name) is var i and >= 0 ? args[i + 1] : null;
var capture = Option("--capture");
using var game = BenchmarkGame.FromArgs(args) ?? (capture == null ? new Game() : new CaptureGame(capture));
game.Run();

sealed class CaptureGame(string directory) : Game
{
    private const int Frames = 60;
    private int frame;

    protected override void PrepareContext()
    {
        base.PrepareContext();
        SceneSystem.SplashScreenUrl = null;
        GraphicsDeviceManager.PreferredBackBufferWidth = 1280;
        GraphicsDeviceManager.PreferredBackBufferHeight = 720;
    }

    private UIComponent? UI => SceneSystem.SceneInstance?.RootScene?.Entities.Select(e => e.Get<UIComponent>()).FirstOrDefault(c => c != null);

    protected override void Update(GameTime gameTime)
    {
        base.Update(gameTime);
        if (UI?.Page?.RootElement is not { } root) return;
        if (++frame != Frames + 1) return;
        // 同 SoundScript 点击时：波形图回到起点、不透明（脚本这一帧已经更新过，下一帧才会再改）
        foreach (var (name, x) in new[] { ("LeftWave", 0.35f), ("RightWave", 0.65f) })
        {
            var image = root.FindVisualChildOfType<ImageElement>(name);
            image.SetCanvasRelativePosition(new Vector3(x, 0.5f, 0));
            image.Opacity = 1;
        }
    }

    protected override void Draw(GameTime gameTime)
    {
        base.Draw(gameTime);
        if (frame != Frames && frame != Frames + 1) return;
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, frame == Frames ? "idle.png" : "wave.png");
        using (var stream = File.Create(path))
            GraphicsDevice.Presenter.BackBuffer.Save(GraphicsContext.CommandList, stream, ImageFileType.Png);
        Console.WriteLine($"captured {path}");
        if (frame == Frames + 1) Exit();
    }
}
