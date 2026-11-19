// 截参考图用（stride-ts 和桌面 Stride 比对）：加 --capture <目录> 时窗口是 1280x720（GameSettings 的大小），不放启动画面，
// 依次把根场景换成几个教程的场景（同点菜单里的按钮），各等一会儿截一张后退出。--only <图名> 只截那一张。
// 色调映射的亮度适应（TemporalAdaptation）关掉：不然截图时曝光还在变，两边对不上（见 ../csharp-beginner）。
// stride-ts 这边是 capture-ours.ps1。--benchmark N [--gpu-profile] 测帧时间（见 ../Benchmark.cs）。
#nullable enable
using System;
using System.IO;
using System.Linq;
using Stride.Engine;
using Stride.Games;
using Stride.Graphics;
using Stride.Rendering.Compositing;
using Stride.Rendering.Images;

string? Option(string name) => Array.IndexOf(args, name) is var i and >= 0 ? args[i + 1] : null;
var capture = Option("--capture");
using var game = BenchmarkGame.FromArgs(args) ?? (capture == null ? new Game() : new CaptureGame(capture, Option("--only"), Array.IndexOf(args, "--no-local-shadows") >= 0));
game.Run();

sealed class CaptureGame(string directory, string? only, bool noLocalShadows) : Game
{
    private const int Width = 1280;
    private const int Height = 720;
    /** 换场景以后等这么多帧再截（脚本启动、资源上传、物体落稳）。 */
    private const int SettleFrames = 90;
    private readonly (string Scene, string Shot)[] shots = new[]
        {
            ("03_Raycasting/Completed-Raycasting", "raycasting"), ("04_ProjectUnproject/Completed-ProjectUnproject", "project"),
            ("06_SceneLoading/Completed-SceneA", "scene"), ("06_SceneLoading/Completed-SceneB", "sceneb"), ("08_Audio/Completed-Audio", "audio"),
        }
        .Where(shot => only == null || shot.Item2 == only).ToArray();
    private int shot = -1;
    private int frame;

    protected override void PrepareContext()
    {
        base.PrepareContext();
        SceneSystem.SplashScreenUrl = null;
        GraphicsDeviceManager.PreferredBackBufferWidth = Width;
        GraphicsDeviceManager.PreferredBackBufferHeight = Height;
    }

    private void Load()
    {
        var renderers = SceneSystem.GraphicsCompositor.Game is SceneCameraRenderer { Child: SceneRendererCollection collection } ? collection.Children : [];
        foreach (var post in renderers.OfType<ForwardRenderer>().Select(r => r.PostEffects).OfType<PostProcessingEffects>())
        {
            if (post.ColorTransforms.Transforms.Get<ToneMap>() is { } toneMap) toneMap.TemporalAdaptation = false;
        }
        // 同 TutorialUI.BtnLoadTutorial
        var scene = Content.Load<Scene>("Scenes/" + shots[shot].Scene);
        // --no-local-shadows：点光、聚光不投阴影（分开比光照本身和阴影）
        if (noLocalShadows)
        {
            foreach (var light in scene.Entities.SelectMany(Descendants).SelectMany(entity => entity.Components.OfType<LightComponent>()))
            {
                if (light.Type is Stride.Rendering.Lights.LightPoint point) point.Shadow.Enabled = false;
                if (light.Type is Stride.Rendering.Lights.LightSpot spot) spot.Shadow.Enabled = false;
            }
        }
        SceneSystem.SceneInstance.RootScene = scene;
        frame = 0;
    }

    // SceneB 里的球带刚体，两边的物理引擎不同、滚到的地方不一样：这一张停住仿真，球留在场景里摆的位置（半空中）
    protected override void Update(GameTime gameTime)
    {
        var freeze = shot >= 0 && shot < shots.Length && shots[shot].Shot == "sceneb";
        foreach (var simulation in Services.GetService<Stride.BepuPhysics.BepuConfiguration>()?.BepuSimulations ?? [])
            simulation.Enabled = !freeze;
        base.Update(gameTime);
    }

    private static System.Collections.Generic.IEnumerable<Entity> Descendants(Entity entity) => new[] { entity }.Concat(entity.GetChildren().SelectMany(Descendants));

    protected override void Draw(GameTime gameTime)
    {
        base.Draw(gameTime);
        if (SceneSystem.SceneInstance?.RootScene == null) return;
        if (shot < 0)
        {
            shot = 0;
            Load();
            return;
        }
        if (++frame < SettleFrames) return;
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, $"{shots[shot].Shot}.png");
        using (var stream = File.Create(path))
            GraphicsDevice.Presenter.BackBuffer.Save(GraphicsContext.CommandList, stream, ImageFileType.Png);
        Console.WriteLine($"captured {path}");
        if (++shot == shots.Length)
        {
            Exit();
            return;
        }
        Load();
    }
}
