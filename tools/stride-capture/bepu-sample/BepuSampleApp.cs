// 截参考图用（stride-ts 和桌面 Stride 比对）：加 --capture <png> 时，主场景加载好后把 --scene <内容地址>（比如
// Scenes/Colliders）加成子场景（同样例的 SceneSelectorComponent），关掉选场景的 UI、调试文字和性能叠加层（stride-ts 还没有），
// 画满 --frames 帧（默认 90）后把后备缓冲存成 PNG 再退出；--freeze-physics 让仿真不步进。--benchmark N [--gpu-profile] 测帧时间（游戏照常跑，见 ../Benchmark.cs）。不加参数时就是原来的样例。
#nullable enable
using System;
using System.IO;
using Stride.BepuPhysics;
using Stride.Engine;
using Stride.Games;
using Stride.Graphics;

string? Option(string name) => Array.IndexOf(args, name) is var i and >= 0 ? args[i + 1] : null;
var capture = Option("--capture");
var frames = int.Parse(Option("--frames") ?? "90");
using var game = BenchmarkGame.FromArgs(args) ?? (capture == null ? new Game() : new CaptureGame(capture, Option("--scene"), frames, Array.IndexOf(args, "--freeze-physics") >= 0));
game.Run();

sealed class CaptureGame(string path, string? scene, int frames, bool freezePhysics) : Game
{
    private int frame;
    private bool added;

    protected override void Update(GameTime gameTime)
    {
        var root = SceneSystem.SceneInstance?.RootScene;
        if (root != null && !added)
        {
            if (scene != null)
                root.Children.Add(Content.Load<Scene>(scene));
            foreach (var entity in root.Entities)
            {
                var ui = entity.Get<UIComponent>();
                if (ui != null)
                    ui.Enabled = false;
            }
            DebugTextSystem.Visible = false;
            added = true;
            frame = 0;
        }
        // 场景里的 GameProfilerComponent 会打开性能叠加层，截图时一直关着
        Services.GetService<Stride.Profiling.GameProfilingSystem>()?.DisableProfiling();
        if (freezePhysics)
        {
            foreach (var simulation in Services.GetService<BepuConfiguration>()?.BepuSimulations ?? [])
                simulation.Enabled = false;
        }
        base.Update(gameTime);
    }

    protected override void Draw(GameTime gameTime)
    {
        base.Draw(gameTime);
        if (!added || ++frame != frames) return;
        using (var stream = File.Create(path))
            GraphicsDevice.Presenter.BackBuffer.Save(GraphicsContext.CommandList, stream, ImageFileType.Png);
        Console.WriteLine($"captured {path} after {frames} frames");
        Exit();
    }
}
