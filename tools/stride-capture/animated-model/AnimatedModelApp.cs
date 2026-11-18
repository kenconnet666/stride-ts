// 截参考图用（stride-ts 和桌面 Stride 比对）：加 --capture <png> 时，正在播放的动画每帧都停在第 0 帧（姿势和 stride-ts 那边
// 一样定住），画满 --frames 帧（默认 60）后把后备缓冲存成 PNG 再退出。不加参数时就是原来的样例。
using System;
using System.IO;
using Stride.Engine;
using Stride.Games;
using Stride.Graphics;

var capture = Array.IndexOf(args, "--capture") is var i and >= 0 ? args[i + 1] : null;
var frames = Array.IndexOf(args, "--frames") is var j and >= 0 ? int.Parse(args[j + 1]) : 60;
using var game = capture == null ? new Game() : new CaptureGame(capture, frames);
game.Run();

sealed class CaptureGame(string path, int frames) : Game
{
    private int frame;

    protected override void Update(GameTime gameTime)
    {
        base.Update(gameTime);
        if (SceneSystem.SceneInstance?.RootScene is not { } scene) return;
        foreach (var entity in scene.Entities)
        {
            var animation = entity.Get<AnimationComponent>();
            if (animation == null) continue;
            foreach (var playing in animation.PlayingAnimations)
            {
                playing.TimeFactor = 0;
                playing.CurrentTime = TimeSpan.Zero;
            }
        }
    }

    protected override void Draw(GameTime gameTime)
    {
        base.Draw(gameTime);
        if (SceneSystem.SceneInstance?.RootScene == null || ++frame != frames) return;
        using (var stream = File.Create(path))
            GraphicsDevice.Presenter.BackBuffer.Save(GraphicsContext.CommandList, stream, ImageFileType.Png);
        Console.WriteLine($"captured {path} after {frames} frames");
        Exit();
    }
}
