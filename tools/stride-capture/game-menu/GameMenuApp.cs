// 截参考图用（stride-ts 和桌面 Stride 比对）：加 --capture <目录> 时窗口是 540x960（GameMenu 的 UI 按窗口大小布局），不放启动
// 画面，依次截四张后退出：splash.png（启动页）、welcome.png（主菜单和欢迎弹窗）、main.png（关掉弹窗）、ships.png（选飞船的
// 弹窗）。飞船的属性随机，截图时换成固定的（第 i 艘：力量 i % 4、操控 (i + 1) % 4、速度 (i + 2) % 4），血条停在一半。
// stride-ts 这边是 capture-ours.ps1，做同样的事。--benchmark N [--gpu-profile] 测帧时间（见 ../Benchmark.cs）。
#nullable enable
using System;
using System.Collections;
using System.IO;
using System.Linq;
using System.Reflection;
using GameMenu;
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
    private const int Width = 540;
    private const int Height = 960;
    /** 每张图之前等的帧数（运行时字体在后台生成字形，要等几帧）。 */
    private const int Frames = 60;
    private static readonly string[] Shots = ["splash", "welcome", "main", "ships"];
    private const BindingFlags Members = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;
    private int shot;
    private int frame;
    private bool shipsFixed;

    protected override void PrepareContext()
    {
        base.PrepareContext();
        SceneSystem.SplashScreenUrl = null;
        GraphicsDeviceManager.PreferredBackBufferWidth = Width;
        GraphicsDeviceManager.PreferredBackBufferHeight = Height;
    }

    // MainScript 的私有字段、属性、方法
    private static object? Get(object target, string name) =>
        target.GetType().GetField(name, Members)?.GetValue(target) ?? target.GetType().GetProperty(name, Members)?.GetValue(target);

    private static void Set(object target, string name, object value)
    {
        if (target.GetType().GetField(name, Members) is { } field) field.SetValue(target, value);
        else target.GetType().GetProperty(name, Members)!.SetValue(target, value);
    }

    private static void Call(object target, string name) => target.GetType().GetMethod(name, Members)!.Invoke(target, null);

    private MainScript? Main => SceneSystem.SceneInstance?.RootScene?.Entities.SelectMany(e => e.Components).OfType<MainScript>().FirstOrDefault();

    protected override void Update(GameTime gameTime)
    {
        base.Update(gameTime);
        if (Main is not { } main || Get(main, "lifebarGrid") is not Grid grid) return;
        // 固定的飞船属性（主菜单建好后一次）和一半的血条（每帧，FillLifeBar 会接着改）
        if (!shipsFixed && Get(main, "shipList") is IList ships)
        {
            shipsFixed = true;
            for (var i = 0; i < ships.Count; i++)
            {
                Set(ships[i]!, "Power", i % 4);
                Set(ships[i]!, "Control", (i + 1) % 4);
                Set(ships[i]!, "Speed", (i + 2) % 4);
            }
            Set(main, "PowerStatus", 0);
            Set(main, "ControlStatus", 1);
            Set(main, "SpeedStatus", 2);
        }
        var gauge = (Sprite)Get(main, "lifebarGaugeImage")!;
        var full = (RectangleF)Get(main, "gaugeBarRegion")!;
        gauge.Region = new RectangleF(full.X, full.Y, full.Width / 2, full.Height);
        grid.ColumnDefinitions[1].SizeValue = 0.5f;
        grid.ColumnDefinitions[2].SizeValue = 0.5f;
    }

    protected override void Draw(GameTime gameTime)
    {
        base.Draw(gameTime);
        if (SceneSystem.SceneInstance?.RootScene == null) return;
        if (++frame < Frames) return;
        frame = 0;
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, $"{Shots[shot]}.png");
        using (var stream = File.Create(path))
            GraphicsDevice.Presenter.BackBuffer.Save(GraphicsContext.CommandList, stream, ImageFileType.Png);
        Console.WriteLine($"captured {path}");
        switch (Shots[shot++])
        {
            case "splash":
                // 同 SplashScript：点一下换成主菜单
                SceneSystem.SceneInstance.RootScene = Content.Load<Scene>("MainScene");
                break;
            case "welcome":
                ((UIElement)Get(Main!, "welcomePopup")!).Visibility = Visibility.Collapsed;
                break;
            case "main":
                var ui = Main!.Entity.Get<UIComponent>();
                DumpLayout(ui.Page.RootElement, ui.Resolution, Path.Combine(directory, "layout.txt"));
                Call(Main!, "UpdateShipStatus");
                Call(Main!, "ShowShipSelectionPopup");
                break;
            default:
                Exit();
                break;
        }
    }

    /** 每个元素一行：深度、类型、名字、大小、中心的位置（虚拟像素，左上角是原点），和 stride-ts 的布局逐个比。 */
    private static void DumpLayout(UIElement root, Vector3 resolution, string path)
    {
        using var writer = new StreamWriter(path);
        void Visit(UIElement element, int depth)
        {
            if (element.Visibility == Visibility.Collapsed) return;
            var world = element.WorldMatrix.TranslationVector;
            writer.WriteLine(FormattableString.Invariant($"{depth} {element.GetType().Name} {element.Name ?? "-"} {element.RenderSize.X:0.##} {element.RenderSize.Y:0.##} {world.X + resolution.X / 2:0.##} {world.Y + resolution.Y / 2:0.##}"));
            foreach (var child in element.VisualChildren) Visit(child, depth + 1);
        }
        Visit(root, 0);
    }
}
