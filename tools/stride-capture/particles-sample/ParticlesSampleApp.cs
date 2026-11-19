// 截参考图用（stride-ts 和桌面 Stride 比对）：加 --capture <目录> 时窗口是 1280x720（GameSettings 的大小），固定步长 1/60 秒，
// 不放启动画面。七个场景挨个换成根场景：跑 30 帧后所有粒子系统的发射器改成固定种子（RandomSeedMethod.Fixed）并重置，再跑
// 60 帧截 <场景名>.png，全部截完退出。stride-ts 这边是 capture-ours.ps1，做同样的事。--benchmark N [--gpu-profile] 测帧时间
// （见 ../Benchmark.cs，测的是开始的场景 MainScene）。
#nullable enable
using System;
using System.IO;
using System.Linq;
using Stride.Engine;
using Stride.Games;
using Stride.Graphics;
using Stride.Particles;
using Stride.Particles.Components;

string? Option(string name) => Array.IndexOf(args, name) is var i and >= 0 ? args[i + 1] : null;
var capture = Option("--capture");
using var game = BenchmarkGame.FromArgs(args) ?? (capture == null ? new Game() : new CaptureGame(capture));
game.Run();

sealed class CaptureGame(string directory) : Game
{
    private static readonly string[] Scenes = ["MainScene", "AnimatedParticles", "ChildParticles", "CustomMaterials", "CustomParticles", "Lasers", "RibbonParticles"];
    private const int Settle = 30;
    private const int Frames = 60;
    private int scene = -1;
    private int frame;

    protected override void PrepareContext()
    {
        base.PrepareContext();
        SceneSystem.SplashScreenUrl = null;
        GraphicsDeviceManager.PreferredBackBufferWidth = 1280;
        GraphicsDeviceManager.PreferredBackBufferHeight = 720;
        IsFixedTimeStep = true;
        TargetElapsedTime = TimeSpan.FromSeconds(1 / 60.0);
    }

    /** 场景里（包括子实体）所有粒子系统的发射器改成固定种子并重置。 */
    private void FreezeParticles()
    {
        var entities = SceneSystem.SceneInstance.RootScene.Entities.SelectMany(e => e.GetChildren().Prepend(e));
        foreach (var component in entities.SelectMany(e => e.Components).OfType<ParticleSystemComponent>())
        {
            foreach (var emitter in component.ParticleSystem.Emitters)
                emitter.RandomSeedMethod = EmitterRandomSeedMethod.Fixed;
            component.ParticleSystem.ResetSimulation();
        }
    }

    protected override void Update(GameTime gameTime)
    {
        if (SceneSystem.SceneInstance?.RootScene != null && (scene < 0 || frame == Settle + Frames + 1))
        {
            scene++;
            frame = 0;
            SceneSystem.SceneInstance.RootScene = Content.Load<Scene>($"Shared/{Scenes[scene]}");
        }
        base.Update(gameTime);
        if (scene < 0) return;
        frame++;
        if (frame == Settle) FreezeParticles();
    }

    protected override void Draw(GameTime gameTime)
    {
        base.Draw(gameTime);
        if (scene < 0 || frame != Settle + Frames) return;
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, $"{Scenes[scene]}.png");
        using (var stream = File.Create(path))
            GraphicsDevice.Presenter.BackBuffer.Save(GraphicsContext.CommandList, stream, ImageFileType.Png);
        Console.WriteLine($"captured {path}");
        frame++;
        if (scene == Scenes.Length - 1) Exit();
    }
}
