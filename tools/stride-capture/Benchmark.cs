// 测帧时间（各样例的截图工程共用，setup.ps1 复制进 Windows 工程）：入口加 `--benchmark N` 时用 BenchmarkGame，游戏照常跑
// （脚本、物理、动画都在，没有输入），关掉垂直同步、不固定步长，先画 600 帧稳定下来，再测 N 帧的平均帧时间，连同分辨率和
// 显卡打印到标准输出后退出（窗口程序，要重定向才看得到）。再加 `--gpu-profile` 时打开 Stride 的 Profiler，另外打印各渲染器的
// 平均 GPU 时间（时间戳，同 GameProfilingSystem 的 GPU 页；嵌套的渲染器各算各的）。stride-ts 这边对应的是 tools/measure.ps1
// 和 `stride perf`。
#nullable enable
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Threading.Channels;
using Stride.Core.Diagnostics;
using Stride.Engine;
using Stride.Games;

sealed class BenchmarkGame : Game
{
    private const int Warmup = 600;
    private readonly int count;
    private readonly Stopwatch stopwatch = new();
    private readonly ChannelReader<ProfilingEvent>? profilingEvents;
    private readonly Dictionary<string, (double Milliseconds, int Count)> gpuTimes = new();
    private int frame;

    public BenchmarkGame(int count, bool gpuProfile)
    {
        this.count = count;
        GraphicsDeviceManager.SynchronizeWithVerticalRetrace = false;
        IsFixedTimeStep = false;
        if (!gpuProfile) return;
        Profiler.EnableAll();
        profilingEvents = Profiler.Subscribe();
    }

    /**
     * 不放启动画面：测帧时间用不着它；而且 Stride 4.4.2 在有启动画面、没有默认场景时（SpriteFonts）永远等不到场景的加载任务，
     * 合成器一直换不上，画面一直是黑的（SceneSystem.Draw 要 sceneTask 和 compositorTask 都不为空）。
     */
    protected override void PrepareContext()
    {
        base.PrepareContext();
        SceneSystem.SplashScreenUrl = null;
    }

    /** 命令行的 `--benchmark N`（加 `--gpu-profile` 时另外记 GPU 时间），没有时是 null。 */
    public static BenchmarkGame? FromArgs(string[] args) =>
        Array.IndexOf(args, "--benchmark") is var i and >= 0 ? new BenchmarkGame(int.Parse(args[i + 1]), args.Contains("--gpu-profile")) : null;

    protected override void Draw(GameTime gameTime)
    {
        base.Draw(gameTime);
        if (SceneSystem.SceneInstance?.RootScene == null) return;
        CollectGpuTimes();
        if (++frame == Warmup)
        {
            stopwatch.Restart();
            gpuTimes.Clear();
        }
        if (frame != Warmup + count) return;
        var size = GraphicsDevice.Presenter.BackBuffer;
        Console.WriteLine($"{stopwatch.Elapsed.TotalMilliseconds / count:F2} ms a frame over {count} frames ({size.Width}x{size.Height}, {GraphicsDevice.Adapter.Description})");
        foreach (var (name, (milliseconds, times)) in gpuTimes.OrderByDescending(entry => entry.Value.Milliseconds))
            Console.WriteLine($"  gpu {name,-48} {milliseconds / count,8:F3} ms x{(double)times / count:F0}");
        Exit();
    }

    /** GPU 的时间戳晚一两帧才读回来，按到达的顺序累计。 */
    private void CollectGpuTimes()
    {
        if (profilingEvents == null) return;
        while (profilingEvents.TryRead(out var e))
        {
            if (!e.IsGPUEvent() || e.Type != ProfilingMessageType.End) continue;
            var (milliseconds, times) = gpuTimes.GetValueOrDefault(e.Key.Name);
            gpuTimes[e.Key.Name] = (milliseconds + e.ElapsedTime.TotalMilliseconds, times + 1);
        }
    }
}
