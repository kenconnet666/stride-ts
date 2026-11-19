// 截参考图用（stride-ts 和桌面 Stride 比对）：加 --capture <目录> 时窗口是 600x600（GameSettings 的大小），固定步长 1/60 秒，
// 不放启动画面。场景跑 30 帧后定住：导火索设成一半，所有粒子系统的发射器改成固定种子（RandomSeedMethod.Fixed）并重置；
// 再跑 60 帧截 newgame.png。然后进入结束（SplashScript.EnterEndGame：火停掉、大彩纸放起来），同样定住粒子，60 帧后截
// endgame.png，退出。stride-ts 这边是 capture-ours.ps1，做同样的事。--benchmark N [--gpu-profile] 测帧时间（见 ../Benchmark.cs）。
#nullable enable
using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Stride.Engine;
using Stride.Games;
using Stride.Graphics;
using Stride.Particles;
using Stride.Particles.Components;
using UIParticles;

string? Option(string name) => Array.IndexOf(args, name) is var i and >= 0 ? args[i + 1] : null;
var capture = Option("--capture");
using var game = BenchmarkGame.FromArgs(args) ?? (capture == null ? new Game() : new CaptureGame(capture));
game.Run();

sealed class CaptureGame(string directory) : Game
{
    private const int Size = 600;
    private const int Settle = 30;
    private const int Frames = 60;
    private const BindingFlags Members = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;
    private int frame;
    private int shot;

    protected override void PrepareContext()
    {
        base.PrepareContext();
        SceneSystem.SplashScreenUrl = null;
        GraphicsDeviceManager.PreferredBackBufferWidth = Size;
        GraphicsDeviceManager.PreferredBackBufferHeight = Size;
        IsFixedTimeStep = true;
        TargetElapsedTime = TimeSpan.FromSeconds(1 / 60.0);
    }

    private SplashScript? Splash => SceneSystem.SceneInstance?.RootScene?.Entities.SelectMany(e => e.Components).OfType<SplashScript>().FirstOrDefault();

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
        base.Update(gameTime);
        if (Splash is not { } splash) return;
        frame++;
        if (shot == 0 && frame == Settle)
        {
            typeof(SplashScript).GetField("fusePercentage", Members)!.SetValue(splash, 0.5f);
            FreezeParticles();
        }
        else if (shot == 1 && frame == 1)
        {
            typeof(SplashScript).GetMethod("EnterEndGame", Members)!.Invoke(splash, null);
            FreezeParticles();
        }
    }

    protected override void Draw(GameTime gameTime)
    {
        base.Draw(gameTime);
        var target = shot == 0 ? Settle + Frames : 1 + Frames;
        if (Splash == null || frame != target) return;
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, shot == 0 ? "newgame.png" : "endgame.png");
        using (var stream = File.Create(path))
            GraphicsDevice.Presenter.BackBuffer.Save(GraphicsContext.CommandList, stream, ImageFileType.Png);
        Console.WriteLine($"captured {path}");
        frame = 0;
        if (++shot == 2) Exit();
    }
}
