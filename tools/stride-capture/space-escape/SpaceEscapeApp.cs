// 截参考图用（stride-ts 和桌面 Stride 比对）：加 --capture <目录> 时固定步长 1/60 秒、每次 Update 都画、不放启动画面，窗口是
// GameSettings 的 640x1136（声明 DPI 感知，不然 150% 缩放下窗口超出屏幕被压矮）。关卡是随机生成的，第 30 帧换成固定的：
// 清掉生成的段，按 a00、b00、b01、b02、b03、b04 接上（都不放随机障碍物），b00 那段的中间道、段中心放一个 Obstacle1；下一帧截
// Menu.png（主菜单）；再下一帧开始游戏（GameScript.StartGame），20 帧后截 Run.png，退出。私有成员用反射取。stride-ts 这边是
// capture-ours.ps1（调试命令 fixed-level、start-game）。--benchmark N [--gpu-profile] 测帧时间（见 ../Benchmark.cs）。
#nullable enable
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using SpaceEscape;
using SpaceEscape.Background;
using Stride.Core.Mathematics;
using Stride.Engine;
using Stride.Games;
using Stride.Graphics;

string? Option(string name) => Array.IndexOf(args, name) is var i and >= 0 ? args[i + 1] : null;
var capture = Option("--capture");
if (capture != null || Array.IndexOf(args, "--benchmark") >= 0) SetProcessDpiAwarenessContext(-4); // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
using var game = BenchmarkGame.FromArgs(args) ?? (capture == null ? new Game() : new CaptureGame(capture));
game.Run();

[DllImport("user32.dll")]
static extern bool SetProcessDpiAwarenessContext(nint value);

sealed class CaptureGame(string directory) : Game
{
    private const int Freeze = 30;
    private const int RunFrames = 20;
    private const BindingFlags Private = BindingFlags.NonPublic | BindingFlags.Instance;
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

    private T Script<T>() where T : EntityComponent => Entities().Select(e => e.Get<T>()).Single(s => s != null);

    /** 关卡换成固定的几段（见文件开头）。 */
    private void FixLevel()
    {
        var background = Script<BackgroundScript>();
        var blocks = (List<Section>)typeof(BackgroundScript).GetField("levelBlocks", Private)!.GetValue(background)!;
        var generator = (LevelGenerator)typeof(BackgroundScript).GetField("levelGenerator", Private)!.GetValue(background)!;
        foreach (var block in blocks)
            background.Entity.RemoveChild(block.RootEntity);
        blocks.Clear();
        var create = typeof(LevelGenerator).GetMethod("CreateLevelBlock", Private)!;
        var add = typeof(BackgroundScript).GetMethod("AddLevelBlock", Private)!;
        foreach (var template in new[] { generator.Background_a00, generator.Background_b00, generator.Background_b01, generator.Background_b02, generator.Background_b03, generator.Background_b04 })
        {
            var section = (Section)create.Invoke(generator, [template.Clone(), 0])!;
            if (template == generator.Background_b00)
            {
                var obstacle = generator.Obstacle1.Clone();
                obstacle.Transform.Position = Vector3.Zero;
                section.AddObstacleEntity(obstacle, generator.Obstacle1.Get<ObstacleInfo>().UseSubMeshBoundingBoxes);
            }
            add.Invoke(background, [section]);
        }
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
            FixLevel();
        }
        if (frame == Freeze + 2)
            typeof(GameScript).GetMethod("StartGame", Private)!.Invoke(Script<GameScript>(), [null, EventArgs.Empty]);
    }

    protected override void Draw(GameTime gameTime)
    {
        base.Draw(gameTime);
        var name = frame == Freeze + 1 ? "Menu" : frame == Freeze + 2 + RunFrames ? "Run" : null;
        if (name == null) return;
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, $"{name}.png");
        using (var stream = File.Create(path))
            GraphicsDevice.Presenter.BackBuffer.Save(GraphicsContext.CommandList, stream, ImageFileType.Png);
        Console.WriteLine($"captured {path}");
        if (name == "Run") Exit();
    }
}
