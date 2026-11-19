// 截参考图用（stride-ts 和桌面 Stride 比对）：加 --capture <png> 时画满 --frames 帧（默认 60）后把后备缓冲存成 PNG 再退出。
// --no-scripts 去掉场景里所有实体（含子实体：相机和手臂上都有脚本）的脚本：手臂停在静止姿势，视角不动。
// --benchmark N [--gpu-profile] 测帧时间（游戏照常跑，见 ../Benchmark.cs）。不加参数时就是原来的游戏。
#nullable enable
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Stride.Engine;
using Stride.Games;
using Stride.Graphics;

string? Option(string name) => Array.IndexOf(args, name) is var i and >= 0 ? args[i + 1] : null;
var capture = Option("--capture");
var frames = int.Parse(Option("--frames") ?? "60");
using var game = BenchmarkGame.FromArgs(args) ?? (capture == null ? new Game() : new CaptureGame(capture, frames, args.Contains("--no-scripts")));
game.Run();

sealed class CaptureGame(string path, int frames, bool noScripts) : Game
{
    private int frame;
    private bool stripped;

    protected override void Update(GameTime gameTime)
    {
        // 场景出现的那一帧、脚本启动之前去掉
        if (noScripts && !stripped && SceneSystem.SceneInstance?.RootScene is { } scene)
        {
            foreach (var entity in scene.Entities.SelectMany(Descendants))
                foreach (var script in entity.Components.OfType<ScriptComponent>().ToList())
                    entity.Components.Remove(script);
            stripped = true;
        }
        base.Update(gameTime);
    }

    private static IEnumerable<Entity> Descendants(Entity entity) =>
        entity.Transform.Children.SelectMany(child => Descendants(child.Entity)).Prepend(entity);

    protected override void Draw(GameTime gameTime)
    {
        base.Draw(gameTime);
        if (SceneSystem.SceneInstance?.RootScene == null || ++frame != frames) return;
        using (var stream = File.Create(path))
            GraphicsDevice.Presenter.BackBuffer.Save(GraphicsContext.CommandList, stream, ImageFileType.Png);
        Console.WriteLine($"captured {path} after {frames} frames");
        // 角色站立的高度决定相机的高度，和 stride-ts 比对时先对这个
        foreach (var name in new[] { "PlayerCharacter", "Camera" })
            if (SceneSystem.SceneInstance.RootScene.Entities.SelectMany(Descendants).FirstOrDefault(e => e.Name == name) is { } entity)
                Console.WriteLine($"{name} at {entity.Transform.WorldMatrix.TranslationVector}");
        Exit();
    }
}
