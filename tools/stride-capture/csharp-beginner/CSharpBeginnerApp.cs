// 截参考图用（stride-ts 和桌面 Stride 比对）：加 --capture <目录> 时窗口是 1280x720（GameSettings 的大小），不放启动画面，
// 依次进三个教程（同点菜单里的按钮，调 TutorialUI 的 BtnLoadTutorial），各截一张后退出：cloning.png、keyboard.png、
// properties.png。相机的 2 秒插值走完后把相机摆到教程的 Camera 实体那里再截：TutorialUI 的插值不封顶，最后一帧会冲过头
// 一点，冲多少看那一帧多长。stride-ts 这边是 capture-ours.ps1。--benchmark N [--gpu-profile] 测帧时间（见 ../Benchmark.cs）。
// 色调映射的亮度适应（TemporalAdaptation，时间常数 1 秒）关掉：不然截图时曝光还在变，早截晚截亮度能差 4/255，两边对不上。
// 逐个比对时用：--only <图名> 只截那一张；--disable fxaa,brightfilter,bloom,lightstreak,lensflare 关掉这些后处理。
#nullable enable
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using CSharpBeginner.Code;
using Stride.Engine;
using Stride.Games;
using Stride.Graphics;
using Stride.Rendering.Compositing;
using Stride.Rendering.Images;

string? Option(string name) => Array.IndexOf(args, name) is var i and >= 0 ? args[i + 1] : null;
var capture = Option("--capture");
var disabled = Option("--disable")?.Split(',') ?? [];
using var game = BenchmarkGame.FromArgs(args) ?? (capture == null ? new Game() : new CaptureGame(capture, Option("--only"), disabled));
game.Run();

sealed class CaptureGame(string directory, string? only, string[] disabled) : Game
{
    private const int Width = 1280;
    private const int Height = 720;
    /** 相机插值走完、摆正以后再等几帧截图。 */
    private const int SettleFrames = 10;
    private readonly (string Label, string Scene, string Shot)[] Shots = new[]
        { ("Cloning entities", "Cloning entities", "cloning"), ("Keyboard input", "Keyboard input", "keyboard"), ("Properties", "Properties", "properties") }
        .Where(shot => only == null || shot.Item3 == only).ToArray();
    private const BindingFlags Members = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;
    private int shot = -1;
    private int settled;

    protected override void PrepareContext()
    {
        base.PrepareContext();
        SceneSystem.SplashScreenUrl = null;
        GraphicsDeviceManager.PreferredBackBufferWidth = Width;
        GraphicsDeviceManager.PreferredBackBufferHeight = Height;
    }

    private static object? Get(object target, string name) => target.GetType().GetField(name, Members)!.GetValue(target);

    private TutorialUI? FindUI() =>
        SceneSystem.SceneInstance?.RootScene?.Entities.SelectMany(e => e.GetChildren().Prepend(e)).Select(e => e.Get<TutorialUI>()).FirstOrDefault(s => s != null);

    private void ConfigurePostEffects()
    {
        var renderers = SceneSystem.GraphicsCompositor.Game is SceneCameraRenderer { Child: SceneRendererCollection collection } ? collection.Children : [];
        foreach (var post in renderers.OfType<ForwardRenderer>().Select(r => r.PostEffects).OfType<PostProcessingEffects>())
        {
            if (post.ColorTransforms.Transforms.Get<ToneMap>() is { } toneMap) toneMap.TemporalAdaptation = false;
            foreach (var name in disabled)
            {
                switch (name)
                {
                    case "fxaa": post.Antialiasing.Enabled = false; break;
                    case "brightfilter": post.BrightFilter.Enabled = false; break;
                    case "bloom": post.Bloom.Enabled = false; break;
                    case "lightstreak": post.LightStreak.Enabled = false; break;
                    case "lensflare": post.LensFlare.Enabled = false; break;
                    default: throw new ArgumentException($"unknown post effect '{name}'");
                }
            }
        }
    }

    private void Load(TutorialUI ui)
    {
        var (label, scene, _) = Shots[shot];
        typeof(TutorialUI).GetMethod("BtnLoadTutorial", Members)!.Invoke(ui, [null, null, new KeyValuePair<string, string>(label, scene)]);
        settled = 0;
    }

    protected override void Draw(GameTime gameTime)
    {
        base.Draw(gameTime);
        // 菜单的按钮在 TutorialUI.Start 里建，建好了才能进教程
        if (FindUI() is not { } ui || Get(ui, "tutorialButtonsStackPanel") == null) return;
        if (shot < 0)
        {
            ConfigurePostEffects();
            shot = 0;
            Load(ui);
            return;
        }
        if ((float)Get(ui, "cameraLerpTimer")! < (float)Get(ui, "cameraLerpTime")!) return;
        var target = (TransformComponent)Get(ui, "targetTransform")!;
        ui.Camera.Transform.Position = target.Position;
        ui.Camera.Transform.Rotation = target.Rotation;
        if (++settled < SettleFrames) return;
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
        Load(ui);
    }
}
