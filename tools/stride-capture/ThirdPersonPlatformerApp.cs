// 截参考图和测帧时间用（stride-ts 和桌面 Stride 比对）：加 --capture <png> 或 --benchmark <帧数> 时，场景按静态的样子显示
// （去掉相机、动画、操控脚本和角色物理，相机留在场景里的位置）。
// --capture：画满 N 帧后把这一帧存成 PNG 再退出；--benchmark：关掉垂直同步，稳定后测这么多帧的平均帧时间，打印后退出；
// 再加 --gpu-profile 时打开 Stride 的 Profiler，同时打印各渲染器的平均 GPU 时间（时间戳，同 GameProfilingSystem 的 GPU 页）。
// 不加参数时就是原来的游戏。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading.Channels;
using Stride.Core.Diagnostics;
using Stride.BepuPhysics;
using Stride.Engine;
using Stride.Games;
using Stride.Graphics;
using Stride.Rendering.Compositing;
using Stride.Rendering.Images;

var capture = Array.IndexOf(args, "--capture") is var i and >= 0 ? args[i + 1] : null;
var frames = Array.IndexOf(args, "--frames") is var j and >= 0 ? int.Parse(args[j + 1]) : 180;
int? benchmark = Array.IndexOf(args, "--benchmark") is var b and >= 0 ? int.Parse(args[b + 1]) : null;
var gpuProfile = args.Contains("--gpu-profile");
// --disable fxaa,brightfilter,bloom,lightstreak,lensflare：关掉这些后处理（逐个比对时用）
var disabled = Array.IndexOf(args, "--disable") is var k and >= 0 ? args[k + 1].Split(',') : [];
// --exposure EV：关掉自动曝光，固定曝光 2^EV（比对光照本身时用）
float? exposure = Array.IndexOf(args, "--exposure") is var e and >= 0 ? float.Parse(args[e + 1], System.Globalization.CultureInfo.InvariantCulture) : null;
// --only-light directional|skybox：只留这一种光（分开比对直射光和环境光时用）
var onlyLight = Array.IndexOf(args, "--only-light") is var o and >= 0 ? args[o + 1] : null;
using var game = capture == null && benchmark == null ? new Game() : new CaptureGame(capture, frames, benchmark, gpuProfile, disabled, exposure, onlyLight);
game.Run();

sealed class CaptureGame : Game
{
    /** 测帧时间之前先画这么多帧（场景、着色器、自动曝光都稳定下来）。 */
    private const int BenchmarkWarmup = 600;
    private readonly string? path;
    private readonly int frames;
    private readonly int? benchmark;
    private readonly string[] disabled;
    private readonly float? exposure;
    private readonly string? onlyLight;
    private readonly Stopwatch stopwatch = new();
    private readonly ChannelReader<ProfilingEvent>? profilingEvents;
    /** 各渲染器（按 ProfilingKey 的名字）累计的 GPU 毫秒数和次数；嵌套的渲染器各算各的。 */
    private readonly Dictionary<string, (double Milliseconds, int Count)> gpuTimes = new();
    private int frame;
    private bool stripped;

    public CaptureGame(string? path, int frames, int? benchmark, bool gpuProfile, string[] disabled, float? exposure, string? onlyLight)
    {
        (this.path, this.frames, this.benchmark, this.disabled, this.exposure, this.onlyLight) = (path, frames, benchmark, disabled, exposure, onlyLight);
        if (benchmark != null)
        {
            GraphicsDeviceManager.SynchronizeWithVerticalRetrace = false;
            IsFixedTimeStep = false;
        }
        if (gpuProfile)
        {
            Profiler.EnableAll();
            profilingEvents = Profiler.Subscribe();
        }
    }

    // 场景是异步加载的：出现以后、脚本开始之前（这一帧的 base.Update 之前）去掉脚本和动画
    protected override void Update(GameTime gameTime)
    {
        if (!stripped && SceneSystem.SceneInstance?.RootScene is { } scene)
        {
            stripped = true;
            Strip(scene);
            if (onlyLight != null) KeepOnlyLight(scene, onlyLight);
            DisablePostEffects();
        }
        base.Update(gameTime);
    }

    private static void KeepOnlyLight(Scene scene, string kind)
    {
        foreach (var entity in scene.Entities.SelectMany(Descendants))
        {
            foreach (var light in entity.Components.OfType<LightComponent>().ToList())
            {
                var keep = kind switch { "directional" => light.Type is Stride.Rendering.Lights.LightDirectional, "skybox" => light.Type is Stride.Rendering.Lights.LightSkybox, _ => throw new ArgumentException(kind) };
                if (!keep) entity.Components.Remove(light);
            }
        }
    }

    private void DisablePostEffects()
    {
        var renderers = SceneSystem.GraphicsCompositor.Game is SceneCameraRenderer { Child: SceneRendererCollection collection } ? collection.Children : [];
        foreach (var post in renderers.OfType<ForwardRenderer>().Select(r => r.PostEffects).OfType<PostProcessingEffects>())
        {
            if (exposure is { } ev && post.ColorTransforms.Transforms.Get<ToneMap>() is { } toneMap)
            {
                toneMap.AutoExposure = false;
                toneMap.Exposure = ev;
            }
            foreach (var name in disabled)
            {
                switch (name)
                {
                    case "fxaa": post.Antialiasing.Enabled = false; break;
                    case "brightfilter": post.BrightFilter.Enabled = false; break;
                    case "bloom": post.Bloom.Enabled = false; break;
                    case "lightstreak": post.LightStreak.Enabled = false; break;
                    case "lensflare": post.LensFlare.Enabled = false; break;
                    default: throw new ArgumentException($"unknown post effect '{name}'");
                }
            }
        }
    }

    private static void Strip(Scene scene)
    {
        foreach (var entity in scene.Entities.SelectMany(Descendants))
        {
            foreach (var component in entity.Components.ToList())
            {
                if (component is ScriptComponent || component is AnimationComponent || component is CharacterComponent)
                    entity.Components.Remove(component);
            }
        }
    }

    protected override void Draw(GameTime gameTime)
    {
        base.Draw(gameTime);
        if (!stripped) return;
        frame++;
        if (benchmark is { } count)
        {
            CollectGpuTimes();
            if (frame == BenchmarkWarmup)
            {
                stopwatch.Restart();
                gpuTimes.Clear();
            }
            if (frame != BenchmarkWarmup + count) return;
            var size = GraphicsDevice.Presenter.BackBuffer;
            Console.WriteLine($"{stopwatch.Elapsed.TotalMilliseconds / count:F2} ms a frame over {count} frames ({size.Width}x{size.Height}, {GraphicsDevice.Adapter.Description})");
            foreach (var (name, (milliseconds, times)) in gpuTimes.OrderByDescending(entry => entry.Value.Milliseconds))
                Console.WriteLine($"  gpu {name,-48} {milliseconds / count,8:F3} ms x{(double)times / count:F0}");
            Exit();
            return;
        }
        if (frame != frames) return;
        using (var stream = File.Create(path!))
            GraphicsDevice.Presenter.BackBuffer.Save(GraphicsContext.CommandList, stream, ImageFileType.Png);
        Console.WriteLine($"captured {path} after {frames} frames");
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

    private static IEnumerable<Entity> Descendants(Entity entity) =>
        new[] { entity }.Concat(entity.Transform.Children.SelectMany(child => Descendants(child.Entity)));
}
