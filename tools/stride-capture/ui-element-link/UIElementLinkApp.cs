// 截参考图用（stride-ts 和桌面 Stride 比对）：加 --capture <目录> 时窗口是 1280x720（GameSettings 的大小），不放启动画面，
// 三个场景各截一张后退出：fullscreen.png、tilted.png、billboarded.png。每个场景定住会动的东西：SplashScript 移除（按钮不再
// 来回移动），跟着走的按钮放在 sin = 0.5 的位置；骑士的动画停在第 0 帧；烟的粒子去掉（stride-ts 还没有粒子）。
// stride-ts 这边是 capture-ours.ps1，做同样的事。--benchmark N [--gpu-profile] 测帧时间（见 ../Benchmark.cs）。
#nullable enable
using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Stride.Core.Mathematics;
using Stride.Engine;
using Stride.Games;
using Stride.Graphics;
using Stride.UI;
using Stride.UI.Controls;
using UIElementLink;

string? Option(string name) => Array.IndexOf(args, name) is var i and >= 0 ? args[i + 1] : null;
var capture = Option("--capture");
using var game = BenchmarkGame.FromArgs(args) ?? (capture == null ? new Game() : new CaptureGame(capture));
game.Run();

sealed class CaptureGame(string directory) : Game
{
    private const int Width = 1280;
    private const int Height = 720;
    /** 换场景后等几帧再定住（脚本 Start、AnimationStart 跑完），再等几帧截图。 */
    private const int FreezeFrame = 5;
    private const int Frames = 60;
    private static readonly (string Scene, string Shot)[] Shots = [("FullScreen", "fullscreen"), ("TiltedScreen", "tilted"), ("BillboardedScreen", "billboarded")];
    private const BindingFlags Members = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;
    private int shot;
    private int frame;

    protected override void PrepareContext()
    {
        base.PrepareContext();
        SceneSystem.SplashScreenUrl = null;
        GraphicsDeviceManager.PreferredBackBufferWidth = Width;
        GraphicsDeviceManager.PreferredBackBufferHeight = Height;
    }

    private static object? Get(object target, string name) => target.GetType().GetField(name, Members)?.GetValue(target);

    /** 定住会动的东西（见文件开头）。 */
    private void Freeze(Scene scene)
    {
        var entities = scene.Entities.SelectMany(e => e.GetChildren().Prepend(e)).ToList();
        var splash = entities.Select(e => e.Get<SplashScript>()).First(s => s != null)!;
        var button = (Button)Get(splash, "followedButton")!;
        var center = (Vector2)Get(splash, "centerPoint")!;
        splash.Entity.Remove(splash);
        button.SetCanvasAbsolutePosition(new Vector3(center.X + center.X * 0.75f * 0.5f, center.Y, 0));

        var knight = entities.First(e => e.Name == "Running Knight").Get<AnimationComponent>();
        foreach (var playing in knight.PlayingAnimations)
        {
            playing.CurrentTime = TimeSpan.Zero;
            playing.TimeFactor = 0;
        }
        var smoke = entities.First(e => e.Name == "Smoke Effect");
        smoke.Transform.Parent = null;
    }

    protected override void Draw(GameTime gameTime)
    {
        base.Draw(gameTime);
        if (SceneSystem.SceneInstance?.RootScene is not { } scene) return;
        if (++frame == FreezeFrame) Freeze(scene);
        if (frame < Frames) return;
        frame = 0;
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, $"{Shots[shot].Shot}.png");
        using (var stream = File.Create(path))
            GraphicsDevice.Presenter.BackBuffer.Save(GraphicsContext.CommandList, stream, ImageFileType.Png);
        Console.WriteLine($"captured {path}");
        if (++shot == Shots.Length)
        {
            Exit();
            return;
        }
        // 同 SplashScript：直接换根场景
        SceneSystem.SceneInstance.RootScene = Content.Load<Scene>(Shots[shot].Scene);
    }
}
