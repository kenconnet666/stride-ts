// 截参考图用（stride-ts 和桌面 Stride 比对）：加 --capture <png> 时，--scene <内容地址> 换成那个场景（默认是 GameSettings 的
// Raycasting），画满 --frames 帧（默认 90）后把后备缓冲存成 PNG 再退出；--freeze-physics 让仿真不步进（物体停在脚本 Start 后的
// 位置，Bepu 和 Jolt 的动力学差别不影响画面比对）。不加参数时就是原来的样例。
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
using var game = capture == null ? new Game() : new CaptureGame(capture, Option("--scene"), frames, Array.IndexOf(args, "--freeze-physics") >= 0);
game.Run();

sealed class CaptureGame(string path, string? scene, int frames, bool freezePhysics) : Game
{
    private int frame;
    private bool switched;

    protected override void Update(GameTime gameTime)
    {
        // 默认场景加载好以后换成要截的场景（同 NextSceneScript 换 RootScene）
        if (scene != null && !switched && SceneSystem.SceneInstance?.RootScene != null)
        {
            SceneSystem.SceneInstance.RootScene = Content.Load<Scene>(scene);
            switched = true;
            frame = 0;
        }
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
        if (SceneSystem.SceneInstance?.RootScene == null || ++frame != frames) return;
        using (var stream = File.Create(path))
            GraphicsDevice.Presenter.BackBuffer.Save(GraphicsContext.CommandList, stream, ImageFileType.Png);
        Console.WriteLine($"captured {path} after {frames} frames");
        Exit();
    }
}
