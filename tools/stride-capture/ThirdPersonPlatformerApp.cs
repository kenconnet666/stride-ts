// 截参考图用（stride-ts 和桌面 Stride 比对渲染）：加 --capture <png> [--frames N] 时，场景按静态的样子显示
// （去掉相机、动画、操控脚本和角色物理，相机留在场景里的位置），画满 N 帧后把这一帧存成 PNG 再退出。
// 不加参数时就是原来的游戏。
using System;
using System.IO;
using System.Linq;
using Stride.BepuPhysics;
using Stride.Engine;
using Stride.Games;
using Stride.Graphics;
using Stride.Rendering.Compositing;
using Stride.Rendering.Images;

var capture = Array.IndexOf(args, "--capture") is var i and >= 0 ? args[i + 1] : null;
var frames = Array.IndexOf(args, "--frames") is var j and >= 0 ? int.Parse(args[j + 1]) : 180;
// --disable fxaa,brightfilter,bloom,lightstreak,lensflare：关掉这些后处理（逐个比对时用）
var disabled = Array.IndexOf(args, "--disable") is var k and >= 0 ? args[k + 1].Split(',') : [];
// --exposure EV：关掉自动曝光，固定曝光 2^EV（比对光照本身时用）
float? exposure = Array.IndexOf(args, "--exposure") is var e and >= 0 ? float.Parse(args[e + 1], System.Globalization.CultureInfo.InvariantCulture) : null;
// --only-light directional|skybox：只留这一种光（分开比对直射光和环境光时用）
var onlyLight = Array.IndexOf(args, "--only-light") is var o and >= 0 ? args[o + 1] : null;
using var game = capture == null ? new Game() : new CaptureGame(capture, frames, disabled, exposure, onlyLight);
game.Run();

sealed class CaptureGame(string path, int frames, string[] disabled, float? exposure, string? onlyLight) : Game
{
    private int frame;
    private bool stripped;

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
        if (!stripped || ++frame != frames) return;
        using (var stream = File.Create(path))
            GraphicsDevice.Presenter.BackBuffer.Save(GraphicsContext.CommandList, stream, ImageFileType.Png);
        Console.WriteLine($"captured {path} after {frames} frames");
        Exit();
    }

    private static System.Collections.Generic.IEnumerable<Entity> Descendants(Entity entity) =>
        new[] { entity }.Concat(entity.Transform.Children.SelectMany(child => Descendants(child.Entity)));
}
