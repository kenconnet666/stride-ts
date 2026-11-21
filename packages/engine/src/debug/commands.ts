/**
 * 引擎自带的调试命令（Game.run 打开 debug 时登记）。参数和返回值都是能 JSON 的值；CLI（@stride-ts/cli）的子命令
 * 一一对应地调用它们，游戏可以用 game.debug.command 再加自己的。
 *
 * 实体参数可以是 id（数字）或名字（先按全名找，再按包含这段文字找，不唯一时报错并列出候选）。组件和脚本按登记的名字
 * （`路径#导出名`）或 # 后面的部分找。
 */
import { QUALITY_TIERS, type QualityTier } from '../rendering/Quality';
import { Camera, Decal, Light, Model, ReflectionProbe, SkyAtmosphere, VolumetricClouds, VolumetricFog } from '../rendering/components';
import { cameraVerticalFieldOfView } from '../rendering/cameraRays';
import { DayNightCycle, lightRotationTowards } from '../rendering/sky/DayNightCycle';
import { Material, type MaterialTransmission } from '../rendering/mesh/Material';
import { Transform } from '../engine/transform';
import { Matrix } from '../data/Matrix';
import type { DebugColor } from './DebugDraw';
import { roadLanes } from '../modeling/roadLanes';
import { Texture, type TextureId } from '../graphics/Texture';
import { PARTICLE_BYTES } from '../particles/gpuKernel';
import { ParticleSystemComponent } from '../particles/ParticleSystemComponent';
import { Precipitation } from '../weather/Precipitation';
import { Weather, WEATHER_PRESETS, type WeatherPreset, type WeatherTarget } from '../weather/Weather';
import type { EntityId } from '../data/prop';
import type { ComponentType } from '../engine/component';
import type { Entity } from '../engine/Entity';
import { scriptName, type ScriptComponent, type ScriptConstructor } from '../engine/scripts';
import type { Game } from '../engine/Game';
import type { MouseButton } from '../input/InputManager';
import { keyCode } from '../input/keys';
import { describe, type Debug } from './Debug';
import { pageHelpers } from './pageHelpers';
import { devtoolsBridgeVersion, sendDevtools } from './devtoolsBridge';

type Args = Readonly<Record<string, unknown>>;

const RENDER_HELP = 'Offline render (fixed time step, sub-frame antialiasing and motion blur) to an MP4 (H.264 + AAC) or a PNG sequence, saved in the project\'s exports folder. '
  + 'args: name (default "render"), preset (landscape1080 | vertical1080 | square1080 | landscape4k), width, height, fps, '
  + 'timeline (entity with a TimelinePlayer, or a timeline name: restarted from 0, seconds defaults to its length), seconds, samples (sub-frames per frame, default 8), '
  + 'shutter (0..1 of the frame interval, default 0.5), format (mp4 | png), bitrate, audio (default true). In the editor it renders in a hidden play-mode page.';

const BAKE_HELP = 'Bake a particle system into a flipbook atlas (columns x rows frames over some seconds, orthographic camera, alpha from a black and a white pass), '
  + 'saved as a png in the content folder through the editor backend. args: entity, columns (default 4), rows (default 4), size (pixels per frame, default 256), '
  + 'seconds (default 2), start (seconds simulated before the first frame), view (front | side | top), path (content path, default Textures/<entity>Flipbook). '
  + 'Returns the atlas layout and a particleSystem file that plays it back with one particle.';

export function registerGameCommands(debug: Debug, game: Game): void {
  debug.command('commands', 'List the registered commands.', () => debug.commands());
  debug.command('status', 'Game status, time, frame rate, canvas, GPU adapter, counters and watches.', () => status(debug, game));
  debug.command('entities', 'List entities. args: name (substring), with (component or script name), limit (default 200).', (args) => entities(game, args));
  debug.command('inspect', 'All component values and script properties of one entity. args: entity (id, name, or in the editor the scene file id).', (args) => inspect(game, entityArg(game, args)));
  debug.command('set', "Set a component field or script property. args: entity, path ('Component.field' or 'Script.prop', optionally '.x'), value.", (args) => set(game, args));
  debug.command('time', 'Pause, resume, step frames, time scale, fixed time step, set the game clock. args: pause, resume, step (frames), timeScale, fixedTimeStep (seconds, or null to clear), total (seconds).', (args) => time(game, args));
  debug.command('input', "Simulate input. args: key (KeyboardEvent.code or a Stride key name) with action 'press' | 'down' | 'up' | 'hold' (ms); mouse [dx, dy] in CSS pixels; button ('left' | 'middle' | 'right') with action.", (args) => input(game, args));
  debug.command('screenshot', 'PNG of the next drawn frame (back buffer only, no page UI), as base64. args: exact (true: that frame without the output dither, for pixel comparisons).', (args) => screenshot(debug, game, args['exact'] === true));
  // 离线渲染的几个模块（编码、封装、混音）用到时才加载，不进每个游戏页面
  debug.command('render', RENDER_HELP, async (args) => (await import('../offline/renderCommand')).renderCommand(game, args));
  debug.command('bake', BAKE_HELP, async (args) => {
    const component = entityArg(game, args).get(ParticleSystemComponent);
    if (!component) throw new Error('bake: the entity has no particle system');
    return (await import('../offline/FlipbookBaker')).bakeCommand(game, component, args);
  });
  debug.command('perf', 'Sample for some seconds: frame times, CPU time per system and phase, GPU time per pass, render stats. args: seconds (default 3), gpu (default true).', (args) => perf(debug, game, args));
  debug.command('native', 'Native module stats: counters, timings since the last reset (or since perf started), memory. args: reset (clear the timings afterwards).', (args) => nativeStats(game, args));
  debug.command('draws', 'Draw calls of the last frame per GPU render pass (scene stages, shadows, each post-processing step, UI, debug lines), in drawing order.', () => {
    const { total, byPass } = game.graphicsDevice.draws;
    return { total, passes: Object.fromEntries(byPass) };
  });
  debug.command('metrics', 'Statistics of the systems and their budgets (entities, draw calls, GPU memory, native memory, frame times, and what the game registered). args: over (only those over budget).', (args) => {
    return args['over'] === true ? game.metrics.over() : game.metrics.snapshot();
  });
  debug.command('quality', 'Quality tier of the renderer (caps on shadows and post effects). args: tier (low, medium, high, ultra; omitted reads the current settings).', (args) => {
    const tier = args['tier'];
    if (typeof tier === 'string') {
      if (!Object.hasOwn(QUALITY_TIERS, tier)) throw new Error(`quality tier must be one of ${Object.keys(QUALITY_TIERS).join(', ')}, got '${tier}'`);
      game.graphicsCompositor.quality = QUALITY_TIERS[tier as QualityTier];
    }
    const current = game.graphicsCompositor.quality;
    return { tier: Object.entries(QUALITY_TIERS).find(([, settings]) => settings === current)?.[0] ?? 'custom', ...current };
  });
  debug.command('ao', 'Screen-space ambient occlusion (GTAO) of the main view. args: on (true/false, or "toggle"; omitted keeps it and just reports), radius (world units).', (args) => {
    const ao = game.graphicsCompositor.ambientOcclusion;
    ao.enabled = switchArg(args, ao.enabled);
    if (typeof args['radius'] === 'number') ao.radius = args['radius'];
    return { enabled: ao.enabled, radius: ao.radius, power: ao.power };
  });
  debug.command('blur', 'Motion blur of the main view. args: on (true/false, or "toggle"; omitted keeps it and just reports), shutter (fraction of a frame), maxPixels.', (args) => {
    const blur = game.graphicsCompositor.motionBlur;
    blur.enabled = switchArg(args, blur.enabled);
    for (const key of ['shutter', 'maxPixels'] as const) if (typeof args[key] === 'number') blur[key] = args[key];
    return { enabled: blur.enabled, shutter: blur.shutter, maxPixels: blur.maxPixels };
  });
  debug.command('lens', 'Physical camera of the main view (Camera component: physical, focal length, aperture, focus, shutter, exposure, depth of field). args: physical, depthOfField (true/false), focalLength (mm), aperture (f-number), focusDistance (m), focusOn (entity name: focus at its distance), shutterAngle (deg), exposureCompensation (EV). Reports the camera and its vertical field of view.', (args) => {
    const compositor = game.graphicsCompositor;
    const cameras = game.entities.ids().map((id) => game.entities.entity(id)).filter((entity) => entity.has(Camera));
    const entity = cameras.find((e) => e.id === compositor.mainCamera) ?? cameras.find((e) => e.require(Camera).slot === compositor.cameraSlot);
    if (!entity) throw new Error('no camera renders the main view');
    const camera = entity.require(Camera);
    for (const key of ['physical', 'depthOfField'] as const) if (typeof args[key] === 'boolean') camera[key] = args[key];
    for (const key of ['focalLength', 'aperture', 'focusDistance', 'shutterAngle', 'exposureCompensation'] as const) if (typeof args[key] === 'number') camera[key] = args[key];
    if (typeof args['focusOn'] === 'string') {
      const target = entityArg(game, { entity: args['focusOn'] });
      const [a, b] = [entity.require(Transform).world, target.require(Transform).world];
      camera.focusDistance = Math.hypot(a[12]! - b[12]!, a[13]! - b[13]!, a[14]! - b[14]!);
    }
    const { physical, focalLength, aperture, focusDistance, shutterAngle, exposureCompensation, depthOfField, sensorWidth, sensorHeight } = camera;
    return {
      camera: entity.name, physical, focalLength, aperture, focusDistance, shutterAngle, exposureCompensation, depthOfField, sensor: [sensorWidth, sensorHeight],
      verticalFieldOfView: cameraVerticalFieldOfView({ ...camera, projection: camera.projection }),
    };
  });
  debug.command('contact', 'Contact shadows (screen-space shadows of the shadow-casting directional light). args: on (true/false, or "toggle"; omitted keeps it and just reports), length (world units), steps, thickness.', (args) => {
    const contact = game.graphicsCompositor.contactShadows;
    contact.enabled = switchArg(args, contact.enabled);
    for (const key of ['length', 'steps', 'thickness'] as const) if (typeof args[key] === 'number') contact[key] = args[key];
    return { enabled: contact.enabled, length: contact.length, steps: contact.steps, thickness: contact.thickness };
  });
  debug.command('ssgi', 'Screen-space global illumination of the main view (indirect diffuse light and occlusion; replaces GTAO while on). args: on (true/false, or "toggle"; omitted keeps it and just reports), radius, thickness (world units), intensity, feedback.', (args) => {
    const gi = game.graphicsCompositor.globalIllumination;
    gi.enabled = switchArg(args, gi.enabled);
    for (const key of ['radius', 'thickness', 'intensity', 'feedback'] as const) if (typeof args[key] === 'number') gi[key] = args[key];
    return { enabled: gi.enabled, radius: gi.radius, thickness: gi.thickness, intensity: gi.intensity, feedback: gi.feedback };
  });
  debug.command('sss', 'Subsurface scattering blur of the main view (compositor switch). args: on (true/false, or "toggle"; omitted keeps it and just reports), entity (id or name): the models of this entity and its children get Stride\'s skin scattering while on (width, translucency override it) and lose it while off.', (args) => {
    const sss = game.graphicsCompositor.subsurfaceScattering;
    sss.enabled = switchArg(args, sss.enabled);
    const materials = new Set<string>();
    if (args['entity'] !== undefined) {
      const root = entityArg(game, args);
      const under = (entity: Entity) => {
        for (let at: Entity | undefined = entity; at; at = (at.get(Transform) as { parent?: Entity } | undefined)?.parent) if (at === root) return true;
        return false;
      };
      const settings = Object.fromEntries((['width', 'translucency'] as const).filter((key) => typeof args[key] === 'number').map((key) => [key, args[key] as number]));
      for (const entity of game.entities.ids().map((id) => game.entities.entity(id)).filter(under)) {
        const material = Material.byId(entity.get(Model)?.material ?? 0);
        if (!material) continue;
        material.setSubsurfaceScattering(sss.enabled ? settings : undefined);
        materials.add(material.name);
      }
    }
    return { enabled: sss.enabled, materials: [...materials], scatteringMaterials: game.renderSystem.subsurfaceMaterials.count };
  });
  debug.command('probe', 'Reflection probes. args: at "x,y,z" adds a probe there (size: edge length, default 10; blend; box: false turns off box projection; everyFrame: true), clear removes all probes, refresh re-captures them, on (true/false) switches them. Returns the probes in use.', (args) => {
    const probes = game.renderSystem.reflectionProbes;
    if (typeof args['on'] === 'boolean') game.graphicsCompositor.quality = { ...game.graphicsCompositor.quality, reflectionProbes: args['on'] };
    if (args['clear'] === true) for (const id of game.entities.ids()) if (game.entities.entity(id).get(ReflectionProbe)) game.entities.destroy(id);
    if (args['refresh'] === true) probes.refresh();
    if (typeof args['at'] === 'string') {
      const position = args['at'].split(',').map(Number);
      if (position.length !== 3 || position.some((value) => !Number.isFinite(value))) throw new Error(`probe: at takes "x,y,z", got '${args['at']}'`);
      const size = typeof args['size'] === 'number' ? args['size'] : 10;
      game.entities.create({
        name: 'Reflection probe',
        components: [
          Transform.with({ position: [position[0]!, position[1]!, position[2]!] }),
          ReflectionProbe.with({
            size: [size, size, size],
            blendDistance: typeof args['blend'] === 'number' ? args['blend'] : 1,
            boxProjection: args['box'] !== false,
            refresh: args['everyFrame'] === true ? 'everyFrame' : 'once',
          }),
        ],
      });
    }
    const entities = game.entities.ids().map((id) => game.entities.entity(id)).filter((entity) => entity.get(ReflectionProbe));
    return { enabled: probes.enabled, inUse: probes.count, probes: entities.map(describe) };
  });
  debug.command('sky', 'Physical sky (SkyAtmosphere). args: on (true/false) adds or removes an atmosphere entity; elevation and azimuth (degrees) turn the sun (SkyAtmosphere.sun, else the shadow-casting directional light, else the first one); intensity scales the sky; aerial scales the distances of aerial perspective (0 turns it off); stars sets the brightness of the stars; moon (true/false) adds or removes a moon light. Day-night cycle (adds a DayNightCycle next to the atmosphere): time (hours), dayLength (game seconds per day, 0 stops), day (of the year), latitude, north (degrees), moonPhase (0 new, 0.5 full). Returns the sun and the moon as the atmosphere sees them.', (args) => {
    const all = () => game.entities.ids().map((id) => game.entities.entity(id));
    const atmospheres = all().filter((entity) => entity.get(SkyAtmosphere));
    if (args['on'] === true && atmospheres.length === 0) atmospheres.push(game.entities.create({ name: 'Sky atmosphere', components: [Transform, SkyAtmosphere] }));
    if (args['on'] === false) for (const entity of atmospheres.splice(0)) entity.destroy();
    const entity = atmospheres[0];
    const sky = entity?.require(SkyAtmosphere);
    const number = (key: string) => (typeof args[key] === 'number' ? (args[key] as number) : undefined);
    if (sky) {
      sky.skyIntensity = number('intensity') ?? sky.skyIntensity;
      sky.aerialPerspectiveScale = number('aerial') ?? sky.aerialPerspectiveScale;
      sky.starsIntensity = number('stars') ?? sky.starsIntensity;
    }
    const directionals = () => all().filter((light) => light.get(Light)?.type === 'directional');
    const findSun = () => (sky && sky.sun >= 0 && game.entities.isAlive(sky.sun) ? game.entities.entity(sky.sun) : directionals().find((light) => light.id !== sky?.moon && light.get(Light)?.shadow) ?? directionals().find((light) => light.id !== sky?.moon));
    if (sky && args['moon'] === true && !(sky.moon >= 0 && game.entities.isAlive(sky.moon))) {
      // 月光：偏蓝，强度是太阳的几十分之一（真实的是四十万分之一，那样没有自动曝光就是全黑）
      const moon = game.entities.create({ name: 'Moon', components: [Transform, Light.with({ type: 'directional', color: [0.6, 0.7, 1, 1], intensity: 0.15, shadow: true, shadowLightAngle: 0.52 })] });
      moon.require(Transform).rotation = lightRotationTowards([-0.5, 0.6, -0.62]);
      sky.moon = moon.id;
    }
    if (sky && args['moon'] === false && sky.moon >= 0) {
      if (game.entities.isAlive(sky.moon)) game.entities.entity(sky.moon).destroy();
      sky.moon = -1 as typeof sky.moon;
    }
    if (number('elevation') !== undefined || number('azimuth') !== undefined) {
      const sun = findSun();
      if (!sun) throw new Error('sky: the scene has no directional light to turn');
      const elevation = ((number('elevation') ?? 45) * Math.PI) / 180, azimuth = ((number('azimuth') ?? 0) * Math.PI) / 180;
      sun.require(Transform).rotation = lightRotationTowards([Math.cos(elevation) * Math.sin(azimuth), Math.sin(elevation), Math.cos(elevation) * Math.cos(azimuth)]);
    }
    const cycleArgs = { time: 'timeOfDay', dayLength: 'dayLength', day: 'dayOfYear', latitude: 'latitude', north: 'north', moonPhase: 'moonPhase' } as const;
    if (entity && sky && Object.keys(cycleArgs).some((key) => number(key) !== undefined)) {
      // 日夜循环转的是 SkyAtmosphere.sun 指的实体：没设时把现在当太阳的那盏光记上
      if (!(sky.sun >= 0 && game.entities.isAlive(sky.sun))) {
        const sun = findSun();
        if (!sun) throw new Error('sky: the scene has no directional light for the day-night cycle to turn');
        sky.sun = sun.id;
      }
      if (!entity.get(DayNightCycle)) entity.add(DayNightCycle);
      const cycle = entity.require(DayNightCycle);
      for (const [key, field] of Object.entries(cycleArgs) as [keyof typeof cycleArgs, (typeof cycleArgs)[keyof typeof cycleArgs]][]) cycle[field] = number(key) ?? cycle[field];
    }
    const { atmosphere, lighting } = game.renderSystem;
    const cycle = entity?.get(DayNightCycle);
    const lit = (id: number | undefined) => {
      const light = lighting.directionals.slice(0, lighting.directionalCount).find((directional) => directional.entity === id);
      return light ? [light.color.r, light.color.g, light.color.b] : [0, 0, 0];
    };
    return {
      active: atmosphere.active,
      sun: { direction: atmosphere.sun.direction, atCamera: lit(findSun()?.id) },
      moon: atmosphere.moon.present ? { direction: atmosphere.moon.direction, phase: atmosphere.moonPhase, atCamera: lit(sky?.moon) } : null,
      stars: atmosphere.starsIntensity,
      shadowLight: lighting.shadowLight >= 0 ? game.entities.entity(lighting.directionals[lighting.shadowLight]!.entity).name : null,
      ...(cycle ? { cycle: { timeOfDay: cycle.timeOfDay, dayLength: cycle.dayLength, dayOfYear: cycle.dayOfYear, latitude: cycle.latitude, north: cycle.north, moonPhase: cycle.moonPhase } } : {}),
    };
  });
  debug.command('ssr','Screen-space reflections of the main view. args: on (true/false, or "toggle"; omitted keeps it and just reports), maxRoughness, thickness, maxSteps, debug (off, hits, reflection).', (args) => {
    const ssr = game.graphicsCompositor.screenSpaceReflections;
    ssr.enabled = switchArg(args, ssr.enabled);
    for (const key of ['maxRoughness', 'thickness', 'maxSteps'] as const) if (typeof args[key] === 'number') ssr[key] = args[key];
    if (args['debug'] === 'off' || args['debug'] === 'hits' || args['debug'] === 'reflection') ssr.debug = args['debug'];
    return { enabled: ssr.enabled, maxRoughness: ssr.maxRoughness, thickness: ssr.thickness, edgeFade: ssr.edgeFade, maxSteps: ssr.maxSteps, debug: ssr.debug };
  });
  debug.command('clouds', 'Volumetric clouds (VolumetricClouds; needs the physical sky, see sky). args: on (true/false) adds or removes a cloud entity; coverage (0..1), density, bottom and thickness (m), type (0 stratus .. 1 cumulus), scale, windSpeed (m/s), windDirection (degrees).', (args) => {
    const all = game.entities.ids().map((id) => game.entities.entity(id)).filter((entity) => entity.get(VolumetricClouds));
    if (args['on'] === true && all.length === 0) all.push(game.entities.create({ name: 'Clouds', components: [Transform, VolumetricClouds] }));
    if (args['on'] === false) for (const entity of all.splice(0)) entity.destroy();
    const clouds = all[0]?.require(VolumetricClouds);
    const names = { coverage: 'coverage', density: 'density', bottom: 'bottom', thickness: 'thickness', type: 'cloudType', scale: 'scale', windSpeed: 'windSpeed', windDirection: 'windDirection' } as const;
    if (clouds) for (const [key, field] of Object.entries(names) as [keyof typeof names, (typeof names)[keyof typeof names]][]) if (typeof args[key] === 'number') clouds[field] = args[key];
    const { active, settings } = game.renderSystem.clouds;
    return { active, ...(clouds ? { settings: { ...settings } } : {}) };
  });
  debug.command('fog', 'Volumetric fog and light shafts (VolumetricFog). args: on (true/false) adds or removes a fog entity; density (extinction per meter), heightFalloff, baseHeight, anisotropy, distance (m), ambient, noise (0..1), noiseScale (m); farFog (true/false).', (args) => {
    const all = game.entities.ids().map((id) => game.entities.entity(id)).filter((entity) => entity.get(VolumetricFog));
    if (args['on'] === true && all.length === 0) all.push(game.entities.create({ name: 'Fog', components: [Transform, VolumetricFog] }));
    if (args['on'] === false) for (const entity of all.splice(0)) entity.destroy();
    const fog = all[0]?.require(VolumetricFog);
    if (fog) for (const key of ['density', 'heightFalloff', 'baseHeight', 'anisotropy', 'distance', 'ambient', 'noise', 'noiseScale'] as const) if (typeof args[key] === 'number') fog[key] = args[key];
    if (fog && typeof args['farFog'] === 'boolean') fog.farFog = args['farFog'];
    const { active, settings } = game.renderSystem.fog;
    return { active, ...(fog ? { settings: { ...settings } } : {}) };
  });
  debug.command('decal', 'Decals (Decal). args: on (true adds test decals, false removes them); at [x, y, z] (default: in front of the camera on the ground); size [x, y, z] (m); count (n: an n x n grid of decals 3 m apart, to measure the cost); color [r, g, b]; opacity; albedoMix; normalFade; pattern ("ring" draws a ring with an alpha mask, "none" a solid box); bumps (true adds a normal map of round bumps). Without on, changes the test decals.', (args) => {
    const tests = () => game.entities.ids().map((id) => game.entities.entity(id)).filter((entity) => entity.name === 'Test decal');
    if (args['on'] === false) for (const entity of tests()) entity.destroy();
    if (args['on'] === true) {
      for (const entity of tests()) entity.destroy();
      const eye = game.graphicsCompositor.mainView?.eye;
      const at = Array.isArray(args['at']) ? (args['at'] as number[]) : [eye?.x ?? 0, 0, (eye?.z ?? 0) - 6];
      const n = Math.max(1, Math.round(Number(args['count'] ?? 1)));
      for (let i = 0; i < n * n; i++) {
        const entity = game.entities.create({ name: 'Test decal', components: [Transform, Decal] });
        Object.assign(entity.require(Transform).position, { x: at[0]! + ((i % n) - (n - 1) / 2) * 3, y: at[1]!, z: at[2]! + (Math.floor(i / n) - (n - 1) / 2) * 3 });
      }
    }
    for (const entity of tests()) {
      const decal = entity.require(Decal);
      const vec3 = (value: unknown) => { const [x, y, z] = value as number[]; return { x: x!, y: y!, z: z! }; };
      if (Array.isArray(args['size'])) decal.size = vec3(args['size']);
      if (Array.isArray(args['color'])) decal.color = vec3(args['color']);
      for (const key of ['opacity', 'albedoMix', 'normalFade'] as const) if (typeof args[key] === 'number') decal[key] = args[key];
      if (args['pattern'] === 'ring' || (args['on'] === true && args['pattern'] === undefined)) decal.albedo = testDecalTexture('ring').id;
      if (args['pattern'] === 'none') decal.albedo = 0 as TextureId;
      if (args['bumps'] === true) decal.normal = testDecalTexture('bumps').id;
      if (args['bumps'] === false) decal.normal = 0 as TextureId;
    }
    return { decals: tests().length, drawn: game.renderSystem.decals.count };
  });
  debug.command('material', 'Materials by name (part of it; without name lists them): extended shading. args: name; sheen [r, g, b, roughness] (null removes); anisotropy [strength, rotation in degrees] (null removes); transmission { factor, ior, thickness, attenuationColor, attenuationDistance } (null removes).', (args) => {
    const all: Material[] = [];
    for (let id = 1; Material.byId(id); id++) all.push(Material.byId(id)!);
    const name = typeof args['name'] === 'string' ? args['name'] : undefined;
    const matched = name === undefined ? all : all.filter((material) => material.name.includes(name));
    if (name !== undefined) {
      for (const material of matched) {
        const sheen = args['sheen'] as number[] | null | undefined;
        if (sheen === null) material.setSheen(undefined);
        else if (Array.isArray(sheen)) material.setSheen({ color: [sheen[0]!, sheen[1]!, sheen[2]!], roughness: sheen[3] ?? 0.5 });
        const anisotropy = args['anisotropy'] as number[] | null | undefined;
        if (anisotropy === null) material.setAnisotropy(undefined);
        else if (Array.isArray(anisotropy)) material.setAnisotropy({ strength: anisotropy[0]!, rotation: ((anisotropy[1] ?? 0) * Math.PI) / 180 });
        const transmission = args['transmission'] as MaterialTransmission | null | undefined;
        if (transmission === null) material.setTransmission(undefined);
        else if (transmission) material.setTransmission(transmission);
      }
    }
    return matched.map((material) => ({ id: material.id, name: material.name, metalness: material.metalness, roughness: material.roughness, sheen: material.sheen, anisotropy: material.anisotropy, transmission: material.transmission }));
  });
  debug.command('lights', 'Test point lights: an n x n grid of colored point lights 1 m above the ground, spacing m apart, around at [x, z] (default: below the camera). args: count (n; 0 removes them), radius (m), intensity, spacing (m), at.', (args) => {
    for (const entity of game.entities.ids().map((id) => game.entities.entity(id)).filter((e) => e.name === 'Test light')) entity.destroy();
    const n = Math.max(0, Math.round(Number(args['count'] ?? 4)));
    const spacing = Number(args['spacing'] ?? 3), radius = Number(args['radius'] ?? 4), intensity = Number(args['intensity'] ?? 4);
    const eye = game.graphicsCompositor.mainView?.eye;
    const at = Array.isArray(args['at']) ? (args['at'] as number[]) : [eye?.x ?? 0, (eye?.z ?? 0) - 6];
    for (let i = 0; i < n * n; i++) {
      const entity = game.entities.create({ name: 'Test light', components: [Transform, Light] });
      Object.assign(entity.require(Transform).position, { x: at[0]! + ((i % n) - (n - 1) / 2) * spacing, y: 1, z: at[1]! + (Math.floor(i / n) - (n - 1) / 2) * spacing });
      const light = entity.require(Light);
      light.type = 'point';
      light.radius = radius;
      light.intensity = intensity;
      // 色相按下标转一圈
      const hue = (i * 0.618) % 1;
      light.color = { r: 0.5 + 0.5 * Math.cos(2 * Math.PI * hue), g: 0.5 + 0.5 * Math.cos(2 * Math.PI * (hue - 1 / 3)), b: 0.5 + 0.5 * Math.cos(2 * Math.PI * (hue - 2 / 3)), a: 1 };
    }
    return { lights: n * n, local: game.renderSystem.lighting.localCount };
  });
  debug.command('clusters', 'Clustered shading of point lights, spot lights and decals (lighting/Clusters.ts): the main view, reflection probe faces and render-texture cameras each get a cluster table. args: on (true/false, or "toggle"; omitted keeps it and just reports). stats (true): per view, clusters with lights, most and mean lights per cluster, and the index pool (requested > capacity means lights were cut this frame; the pool grows the next frame). Turn it off to compare the picture and the cost. Reports the state of the last frame.', async (args) => {
    const renderer = game.graphicsCompositor;
    if (typeof args['on'] === 'boolean') renderer.clustering = args['on'];
    else if (args['on'] === 'toggle') renderer.clustering = !renderer.clustering;
    const views = game.renderSystem.views.filter((view) => view.clustered);
    const clusteredViews = await Promise.all(views.map(async (view) => ({
      slot: view.clusterSlot, size: [view.width, view.height], ...(args['stats'] === true ? await game.renderSystem.clusters.occupancy(view.clusterSlot) : {}),
    })));
    return { clustering: renderer.clustering, clusteredViews, lights: game.renderSystem.lighting.localCount, decals: game.renderSystem.decals.count };
  });
  debug.command('weather', `Weather state (Weather): drives clouds, fog, wind and precipitation that are in the scene. args: on (true/false) adds a weather entity with precipitation, or removes it; preset (${Object.keys(WEATHER_PRESETS).join(', ')}); cloudCoverage, cloudType, precipitation, temperature (°C), fog, windSpeed (m/s), windDirection (degrees), gustiness, transitionTime (s); instant (true) jumps to the target.`, (args) => {
    const all = game.entities.ids().map((id) => game.entities.entity(id)).filter((entity) => entity.get(Weather));
    if (args['on'] === true && all.length === 0) all.push(game.entities.create({ name: 'Weather', components: [Transform, Weather, Precipitation] }));
    if (args['on'] === false) for (const entity of all.splice(0)) entity.destroy();
    const weather = all[0]?.require(Weather);
    if (weather) {
      const preset = WEATHER_PRESETS[args['preset'] as WeatherPreset] as WeatherTarget | undefined;
      if (preset) Object.assign(weather, preset);
      for (const key of ['cloudCoverage', 'cloudType', 'precipitation', 'temperature', 'fog', 'windSpeed', 'windDirection', 'gustiness', 'transitionTime'] as const) if (typeof args[key] === 'number') weather[key] = args[key];
      if (args['instant'] === true) game.weather.current = undefined;
    }
    const current = game.weather.current;
    return { ...(weather ? { target: Object.fromEntries(Object.keys(WEATHER_PRESETS.clear).map((key) => [key, weather[key as keyof WeatherTarget]])) } : {}), ...(current ? { current: { ...current } } : {}) };
  });
  debug.command('dither', 'Dithering of the 8-bit output in the tone mapping pass (hides the banding of dark gradients). args: on (true/false, or "toggle"; omitted keeps it and just reports). Turn it off to compare screenshots pixel by pixel with desktop Stride.', (args) => {
    const toneMap = game.graphicsCompositor.postEffects.toneMap;
    toneMap.dither = switchArg(args, toneMap.dither);
    return { dither: toneMap.dither };
  });
  debug.command('world', 'World streaming (game.world, .world.json): cells load around the main camera and StreamingSource entities. args: load (world content path) switches to that world; unload (true) drops its cells. Reports the world, cell size, loaded and loading cells (layer/x_z), the streaming sources and how many cell loads and unloads happened.', async (args) => {
    const world = game.world;
    if (typeof args['load'] === 'string') await world.load(args['load']);
    if (args['unload'] === true) world.unload();
    return {
      world: world.path ?? null, cellSize: world.file?.cellSize, layers: world.file?.layers,
      loaded: world.loaded, loading: world.loading, sources: world.sources.map((source) => [Math.round(source.x), Math.round(source.z)]),
      loads: world.loads, unloads: world.unloads,
    };
  });
  debug.command('terrain', 'Vector terrain (game.terrain, Terrain components): per terrain entity, how many tiles are drawn, cached and being evaluated. args: height ([x, z] in world coordinates) also reports the ground height there for the first terrain.', (args) => {
    const at = args['height'];
    return { terrains: game.terrain.stats(), ...(Array.isArray(at) ? { height: game.terrain.heightAt(Number(at[0]), Number(at[1])) } : {}) };
  });
  debug.command('lanes', 'Lane graph of a road spline (modeling/roadLanes.ts, right-hand traffic): lanes along the roads and connector lanes through the junctions. args: spline (content path, required), entity (whose transform places it; default the origin), seconds (draws the lanes that long with direction arrows: roads cyan, connectors yellow; default 10, 0 draws nothing).', async (args) => {
    if (typeof args['spline'] !== 'string') throw new Error('lanes needs spline (a content path)');
    const lanes = roadLanes(await game.content.loadSpline(args['spline']));
    const world = args['entity'] === undefined ? undefined : entityArg(game, args).require(Transform).world;
    // 画在路面上方 5 厘米（贴着画会和路面打架）
    const place = (p: readonly number[]): [number, number, number] => (world ? Matrix.transformPoint(world, p[0]!, p[1]! + 0.05, p[2]!) : [p[0]!, p[1]! + 0.05, p[2]!]) as [number, number, number];
    const seconds = Number(args['seconds'] ?? 10);
    if (seconds > 0) {
      for (const lane of lanes) {
        const points = lane.points.map(place);
        const color: DebugColor = lane.junction === undefined ? [0.2, 0.9, 1, 1] : [1, 0.85, 0.2, 1];
        game.debugDraw.polyline(points, color, { duration: seconds, width: 2 });
        // 每 20 米一个箭头，指着行驶方向
        for (let i = 10; i + 1 < points.length; i += 10) game.debugDraw.arrow(points[i - 1]!, points[i + 1]!, color, { duration: seconds, width: 2, headLength: 1.5 });
      }
    }
    const roads = lanes.filter((lane) => lane.junction === undefined);
    return {
      lanes: roads.length, connectors: lanes.length - roads.length,
      length: Math.round(roads.reduce((sum, lane) => sum + lane.length, 0)), deadEnds: roads.filter((lane) => lane.next.length === 0).length,
    };
  });
  debug.command('scatter', 'Procedural placement (game.scatter, Scatter components on terrains): per terrain, how many cells are scattered around the camera and how many instances they hold, how many cells and instances were built since the start, and at the last new version of a scatter file or terrain how many cells were kept, marked for re-scattering or dropped; impostorsBaking: how many far-tree cards (lods with impostor) are still being baked.', () => ({
    terrains: game.scatter.stats(), built: game.scatter.built, lastChange: game.scatter.carried, impostorsBaking: game.renderSystem.impostors.pending,
  }));
  debug.command('taa', 'Temporal anti-aliasing of the main view instead of FXAA. args: on (true/false, or "toggle"; omitted keeps it and just reports).', (args) => {
    const taa = game.graphicsCompositor.temporalAntialiasing;
    taa.enabled = switchArg(args, taa.enabled);
    return { enabled: taa.enabled, feedback: taa.feedback, clipSigma: taa.clipSigma, sharpness: taa.sharpness };
  });
  debug.command('wireframe', 'Overlay the wireframe of the meshes on the main view. args: on (true/false, or "toggle"; omitted keeps it and just reports).', (args) => {
    const compositor = game.graphicsCompositor;
    compositor.wireframe = switchArg(args, compositor.wireframe);
    return { wireframe: compositor.wireframe };
  });
  debug.command('pick', 'Entity under a canvas pixel (GPU id buffer). args: x, y in CSS pixels from the top-left of the canvas.', async (args) => {
    const entity = await game.pick(Number(args['x']), Number(args['y']));
    return { entity: entity ? describe(entity) : null };
  });
  debug.command('raycast', 'Physics ray cast. args: origin [x,y,z], direction [x,y,z], maxDistance (default 1000), mask.', (args) => raycast(game, args));
  debug.command('debug-text', 'Lines the scripts printed with game.debugText in the last frame.', () => game.debugText.lines);
  debug.command('devtools', "Run a DevTools protocol command on this tab through the Stride Debug Bridge extension (tools/debug-bridge). args: method ('detach' ends this session's debugging; the tab stays attached while other sessions use it), params, waitFor (an event to wait for after the command; returns its params), session (the debugging session's id, so several sessions can share the tab).", (args) =>
    sendDevtools(String(args['method']), (args['params'] ?? {}) as Readonly<Record<string, unknown>>, args['waitFor'] === undefined ? undefined : String(args['waitFor']), args['session'] === undefined ? undefined : String(args['session'])));
  debug.command('eval', 'Evaluate JavaScript in the page. An expression: its value; await works; in scope are game, engine, entity(name | id), named(name), frames(n), seconds(s) (game time). Statements: the value of the last one, in global scope; with a top-level await they run as an async function body (use return). args: code.', (args) => evaluate(game, args));
  // 慢帧：每帧在 requestAnimationFrame 里忙等 ms 毫秒（和游戏的帧在同一轮，所以帧间隔加长这么多）。页面地址带
  // ?stride-slow=<毫秒> 时一开始就慢（regress.ps1 -Slow；重载页面后还在）
  let slowMs = 0, slowing = false;
  const slow = (ms: number) => {
    slowMs = Math.max(0, ms);
    if (slowMs > 0 && !slowing) {
      slowing = true;
      const tick = () => {
        if (slowMs <= 0) {
          slowing = false;
          return;
        }
        // 游戏跑起来以后才慢：加载、连中枢的时候忙等会把它们饿死（CI 上慢的是每一帧的画，不是加载）
        if (game.status === 'running' && game.frames > 0) {
          const end = performance.now() + slowMs;
          while (performance.now() < end);
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
    return { ms: slowMs };
  };
  if (typeof location !== 'undefined') slow(Number(new URLSearchParams(location.search).get('stride-slow') ?? 0));
  debug.command('slow', "Make every frame take ms longer (busy wait on the main thread), to reproduce slow machines such as CI's software WebGPU (frames of a few hundred ms); the page url's ?stride-slow=<ms> does it from the start. args: ms (0 stops).", (args) => slow(Number(args['ms'] ?? 0)));
  debug.command('particles', 'Particle emitters: where they simulate, pool size, living particles and their world bounds (GPU ones are read back). args: name (part of the entity name).', (args) => particles(game, args));
}

function status(debug: Debug, game: Game): unknown {
  const recent = debug.frames.last(60, debug.frames.interval).filter((ms) => ms > 0);
  const meanInterval = recent.reduce((sum, ms) => sum + ms, 0) / Math.max(1, recent.length);
  const device = game.graphicsDevice as Game['graphicsDevice'] | undefined;
  const canvas = device?.canvas;
  return {
    status: game.status,
    error: game.error ?? null,
    frame: game.frames,
    sceneFrame: game.sceneFrame ?? null,
    scene: game.rootScene?.name ?? null,
    time: { total: game.updateTime.total, paused: game.paused, timeScale: game.timeScale, fixedTimeStep: game.fixedTimeStep ?? null },
    fps: recent.length > 0 ? 1000 / meanInterval : null,
    startup: game.startup,
    canvas: canvas ? { width: canvas.width, height: canvas.height, clientWidth: canvas.clientWidth, clientHeight: canvas.clientHeight, devicePixelRatio } : null,
    gpu: device ? { ...adapterInfo(device.device.adapterInfo), textureTarget: device.textureTarget, timestamps: device.profiler.supported } : null,
    native: game.native ? { workerThreads: game.native.workerThreadCount } : null,
    /** 调试桥扩展的版本（没装时是 null）：有它时 cpu-profile、mouse --trusted 在任何 Chrome 里都能用。 */
    devtoolsBridge: devtoolsBridgeVersion() ?? null,
    /** 页面看得见没有：hidden 时（标签在后台、窗口最小化）requestAnimationFrame 不走，游戏不出帧；stride front 切到前面。 */
    visibility: document.visibilityState,
    entities: game.entities.count,
    counters: debug.counters(),
    watches: debug.watches(),
  };
}

function adapterInfo(info: GPUAdapterInfo): Record<string, string> {
  return { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description };
}

function entities(game: Game, { name, with: having, limit = 200 }: Args): unknown {
  const filter = typeof name === 'string' ? name.toLowerCase() : undefined;
  const result: unknown[] = [];
  let matched = 0;
  for (const id of game.entities.ids()) {
    const entity = game.entities.entity(id);
    if (filter !== undefined && !entity.name.toLowerCase().includes(filter)) continue;
    const components = game.entities.componentTypes(id).map((type) => type.name);
    const scripts = [...entity.scripts.keys()].map(scriptName);
    if (typeof having === 'string' && ![...components, ...scripts].some((n) => nameMatches(n, having))) continue;
    if (matched++ < Number(limit)) result.push({ id, name: entity.name, parent: parentOf(entity), components, scripts });
  }
  return { count: matched, entities: result };
}

function parentOf(entity: Entity): unknown {
  const transform = [...entity.manager.componentTypes(entity.id)].find((type) => type.name === 'Transform');
  const parent = transform ? (entity.get(transform) as { parent?: Entity } | undefined)?.parent : undefined;
  return parent ? { entity: parent.id, name: parent.name } : null;
}

function inspect(game: Game, entity: Entity): unknown {
  const components: Record<string, unknown> = {};
  for (const type of game.entities.componentTypes(entity.id)) components[type.name] = describe(entity.get(type));
  const scripts: Record<string, unknown> = {};
  for (const [type, script] of entity.scripts) scripts[scriptName(type)] = scriptProps(type, script);
  return { id: entity.id, name: entity.name, parent: parentOf(entity), components, scripts };
}

/** 脚本的属性（schema 里的字段）和 enabled，不展开 entity、game 这些引用。 */
function scriptProps(type: ScriptConstructor, script: ScriptComponent): unknown {
  const values: Record<string, unknown> = {};
  for (const field of type.schema.fields) values[field.name] = (script as unknown as Record<string, unknown>)[field.name];
  if ('enabled' in script) values['enabled'] = (script as { enabled: unknown }).enabled;
  return describe(values);
}

function set(game: Game, args: Args): unknown {
  const entity = entityArg(game, args);
  const path = String(args['path'] ?? '');
  const [owner, ...keys] = path.split('.');
  if (!owner || keys.length === 0) throw new Error(`path must be 'Component.field' or 'Script.prop', got '${path}'`);
  const target = findOwner(game, entity, owner);
  let object = target as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) {
    const next = object[key];
    if (typeof next !== 'object' || next === null) throw new Error(`'${key}' in ${path} is not an object`);
    object = next as Record<string, unknown>;
  }
  const last = keys.at(-1)!;
  if (!(last in object)) throw new Error(`${owner} has no '${last}' (it has ${Object.keys(object).join(', ')})`);
  object[last] = args['value'];
  return { [path]: describe(object[last]) };
}

/** 实体上名字对得上的数据组件的视图或脚本实例。 */
function findOwner(game: Game, entity: Entity, name: string): object {
  const types: { name: string; get: () => object }[] = [
    ...game.entities.componentTypes(entity.id).map((type: ComponentType<any>) => ({ name: type.name, get: () => entity.get(type) as object })),
    ...[...entity.scripts].map(([type, script]) => ({ name: scriptName(type), get: () => script })),
  ];
  const found = types.filter((t) => nameMatches(t.name, name));
  if (found.length !== 1) {
    throw new Error(`${found.length === 0 ? 'no' : 'more than one'} component or script '${name}' on '${entity.name}' (it has ${types.map((t) => t.name).join(', ')})`);
  }
  return found[0]!.get();
}

/** 全名，或 `路径#导出名` 里 # 后面的部分。 */
function nameMatches(registered: string, name: string): boolean {
  return registered === name || registered.slice(registered.lastIndexOf('#') + 1) === name;
}

function entityArg(game: Game, args: Args): Entity {
  const ref = args['entity'];
  if (typeof ref === 'number' || (typeof ref === 'string' && /^\d+$/.test(ref))) {
    const id = Number(ref) as EntityId;
    if (!game.entities.isAlive(id)) throw new Error(`entity ${id} does not exist`);
    return game.entities.entity(id);
  }
  if (typeof ref !== 'string' || ref === '') throw new Error('entity must be an id or a name');
  // 编辑状态的页面里也认场景文件里的 id（编辑器、MCP 说的都是它）
  const fromScene = game.editor?.live?.entity(ref);
  if (fromScene) return fromScene;
  const all = game.entities.ids().map((id) => game.entities.entity(id));
  const exact = all.filter((e) => e.name === ref);
  const found = exact.length > 0 ? exact : all.filter((e) => e.name.toLowerCase().includes(ref.toLowerCase()));
  if (found.length === 1) return found[0]!;
  if (found.length === 0) throw new Error(`no entity named '${ref}'`);
  throw new Error(`'${ref}' matches ${found.length} entities: ${found.slice(0, 20).map((e) => `${e.name} (${e.id})`).join(', ')}`);
}

function time(game: Game, args: Args): unknown {
  if (args['pause'] === true) game.paused = true;
  if (args['resume'] === true) game.paused = false;
  if (typeof args['timeScale'] === 'number') game.timeScale = args['timeScale'];
  if ('fixedTimeStep' in args) game.fixedTimeStep = typeof args['fixedTimeStep'] === 'number' ? args['fixedTimeStep'] : undefined;
  // 把游戏时钟拨到这个秒数（比对截图：按时间动的着色器两边在同一个时间截）
  if (typeof args['total'] === 'number') game.updateTime.total = args['total'];
  if (typeof args['step'] === 'number') {
    if (!game.paused) throw new Error('step needs a paused game: pause first');
    game.step(args['step']);
  }
  return { frame: game.frames, total: game.updateTime.total, paused: game.paused, timeScale: game.timeScale, fixedTimeStep: game.fixedTimeStep ?? null };
}

const MOUSE_BUTTONS: Record<MouseButton, number> = { left: 0, middle: 1, right: 2 };
/** 合成的鼠标指针的 pointerId（浏览器真实鼠标的是 1，用别的值不和它混在一起）。 */
const SYNTHETIC_POINTER = 1000;
/** 上一次合成的指针位置（client 坐标）。 */
let syntheticPointer: [number, number] | undefined;

/**
 * 派发合成的 DOM 事件，走和真实输入一样的路径（InputManager 的监听器）。press 按下后等游戏跑过一帧再松开，
 * 这样脚本一定能看到这次按下；hold 按住 ms 毫秒的真实时间。合成事件拿不到指针锁定。
 */
async function input(game: Game, args: Args): Promise<unknown> {
  const action = String(args['action'] ?? 'press');
  const canvas = game.graphicsDevice.canvas;
  if (Array.isArray(args['mouse'])) {
    const [dx = 0, dy = 0] = args['mouse'] as number[];
    const rect = canvas.getBoundingClientRect();
    // 指针从上一次合成的位置（第一次从画布中心）移过去；先在起点发一个，没见过这个指针的 InputManager 也能算出移动量
    const [x, y] = (syntheticPointer ??= [rect.left + rect.width / 2, rect.top + rect.height / 2]);
    syntheticPointer = [x + dx, y + dy];
    canvas.dispatchEvent(new PointerEvent('pointermove', { pointerId: SYNTHETIC_POINTER, pointerType: 'mouse', clientX: x, clientY: y }));
    canvas.dispatchEvent(new PointerEvent('pointermove', { pointerId: SYNTHETIC_POINTER, pointerType: 'mouse', clientX: x + dx, clientY: y + dy }));
    window.dispatchEvent(new MouseEvent('mousemove', { movementX: dx, movementY: dy, clientX: x + dx, clientY: y + dy }));
  }
  let down: () => void, up: () => void;
  if (typeof args['key'] === 'string') {
    // Stride 的键名（'W'、'Left'）也认，派发的事件用浏览器的 code
    const code = keyCode(args['key']);
    down = () => window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code }));
    up = () => window.dispatchEvent(new KeyboardEvent('keyup', { code, key: code }));
  } else if (typeof args['button'] === 'string') {
    const button = MOUSE_BUTTONS[args['button'] as MouseButton];
    if (button === undefined) throw new Error(`button must be left, middle or right, got '${args['button']}'`);
    const rect = canvas.getBoundingClientRect();
    const [clientX, clientY] = syntheticPointer ?? [rect.left + rect.width / 2, rect.top + rect.height / 2];
    const pointer = { pointerId: SYNTHETIC_POINTER, pointerType: 'mouse', clientX, clientY, button };
    down = () => {
      canvas.dispatchEvent(new PointerEvent('pointerdown', pointer));
      canvas.dispatchEvent(new MouseEvent('mousedown', { button, bubbles: true }));
    };
    up = () => {
      window.dispatchEvent(new PointerEvent('pointerup', pointer));
      window.dispatchEvent(new MouseEvent('mouseup', { button }));
    };
  } else {
    return { frame: game.frames };
  }
  if (action === 'down') down();
  else if (action === 'up') up();
  else if (action === 'press') {
    down();
    await framesPassed(game, 2);
    up();
  } else if (action === 'hold') {
    down();
    await new Promise((resolve) => setTimeout(resolve, Number(args['ms'] ?? 500)));
    up();
  } else throw new Error(`action must be press, down, up or hold, got '${action}'`);
  return { frame: game.frames };
}

/** 等游戏的帧号前进 n（暂停时不前进：最多等 2 秒）。 */
async function framesPassed(game: Game, n: number): Promise<void> {
  const target = game.frames + n;
  const deadline = performance.now() + 2000;
  while (game.frames < target && performance.now() < deadline) await new Promise((resolve) => requestAnimationFrame(resolve));
}

async function screenshot(debug: Debug, game: Game, exact: boolean): Promise<unknown> {
  const canvas = game.graphicsDevice.canvas;
  // 逐像素比对（和桌面 Stride、和以前的截图）时那一帧不加输出的抖动：抖动是每个像素 ±半个色阶的噪声，平均差会多零点几
  const toneMap = game.graphicsCompositor.postEffects.toneMap;
  const dither = toneMap.dither;
  if (exact) toneMap.dither = false;
  // 画完的同一个任务里拿画布内容（WebGPU 画布的当前纹理在呈现之后就失效）
  const bitmap = await debug.afterNextDraw(() => createImageBitmap(canvas)).finally(() => {
    toneMap.dither = dither;
  });
  const image = await bitmap;
  const offscreen = new OffscreenCanvas(image.width, image.height);
  offscreen.getContext('2d')!.drawImage(image, 0, 0);
  image.close();
  const blob = await offscreen.convertToBlob({ type: 'image/png' });
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  return { width: offscreen.width, height: offscreen.height, frame: game.frames, png: dataUrl.slice(dataUrl.indexOf(',') + 1) };
}

async function perf(debug: Debug, game: Game, args: Args): Promise<unknown> {
  const seconds = Number(args['seconds'] ?? 3);
  const profiler = game.graphicsDevice.profiler;
  const gpu = args['gpu'] !== false && profiler.supported;
  const wasProfiling = profiler.enabled;
  const timings = new Map<string, number>();
  game.entities.timings = timings;
  if (gpu) {
    profiler.enabled = true;
    // 打开后第一帧的读回还没回来：等一帧再清零
    await framesPassed(game, 1);
    profiler.reset();
  }
  game.native.resetDebugTimings();
  const firstFrame = debug.frames.total;
  const firstUpdate = game.frames;
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  const frames = Math.min(debug.frames.total - firstFrame, debug.frames.interval.length);
  const updates = Math.max(1, game.frames - firstUpdate);
  game.entities.timings = undefined;
  const gpuReport = gpu ? profiler.report() : [];
  const native = game.native.debugSnapshot();
  if (!wasProfiling) profiler.enabled = false;
  const intervals = debug.frames.last(frames, debug.frames.interval);
  const perFrame = (total: number) => total / updates;
  return {
    seconds,
    frames,
    fps: frames / seconds,
    frameMs: summary(intervals),
    updateMs: summary(debug.frames.last(frames, debug.frames.update)),
    drawMs: summary(debug.frames.last(frames, debug.frames.draw)),
    cpuMsPerUpdate: Object.fromEntries([...timings].sort((a, b) => b[1] - a[1]).map(([label, ms]) => [label, round(perFrame(ms))])),
    nativeMsPerUpdate: Object.fromEntries(Object.entries(native.timings).sort((a, b) => b[1].ms - a[1].ms).map(([label, t]) => [label, round(perFrame(t.ms))])),
    gpu: gpu ? { totalMs: round(gpuReport.reduce((sum, [, t]) => sum + t.milliseconds, 0)), passes: Object.fromEntries(gpuReport.map(([label, t]) => [label, round(t.milliseconds)])) } : 'timestamp-query is not available',
    render: Object.fromEntries(game.renderSystem.features.map((feature) => [feature.name, feature.stats()])),
    graph: game.graphicsCompositor.graphStats,
  };
}

function summary(values: readonly number[]): unknown {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!);
  return { mean: round(values.reduce((sum, v) => sum + v, 0) / values.length), p50: at(0.5), p95: at(0.95), p99: at(0.99), max: round(sorted.at(-1)!) };
}

const round = (value: number) => Math.round(value * 1000) / 1000;

function nativeStats(game: Game, { reset }: Args): unknown {
  const snapshot = game.native.debugSnapshot();
  if (reset === true) game.native.resetDebugTimings();
  return { workerThreads: game.native.workerThreadCount, collecting: game.native.debugCollecting, ...snapshot };
}

function raycast(game: Game, args: Args): unknown {
  if (!game.simulation) throw new Error('the game has no physics (nativeFeatures has no physics)');
  const origin = vector(args['origin'], 'origin');
  const direction = vector(args['direction'], 'direction');
  const hit = game.simulation.rayCast(origin, direction, Number(args['maxDistance'] ?? 1000), typeof args['mask'] === 'number' ? { mask: args['mask'] } : {});
  if (!hit) return { hit: null };
  return { hit: { distance: hit.distance, point: Array.from(hit.point), normal: Array.from(hit.normal), entity: describe(game.entities.entity(hit.entity)) } };
}

function vector(value: unknown, name: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3 || value.some((v) => typeof v !== 'number')) throw new Error(`${name} must be [x, y, z]`);
  return value as [number, number, number];
}

/**
 * 页面里跑一段代码（`stride eval`），结果等到 Promise 落定。能用的名字：game、engine（样例的 main.ts 挂的 strideEngine，
 * 引擎的全部导出），加上 pageHelpers 的那些（entity、named、frames、seconds、until、tap、click……，见 debug/pageHelpers.ts）。
 * - 一个表达式：结果是它的值，能直接 await。
 * - 几条语句：包进一个块里间接 eval（块里先声明上面那些名字），结果是最后一条语句的值；块里的 const、let 不留到下一次。
 *   语句里有顶层 await 时间接 eval 不支持，改成异步函数体跑，结果要用 return 给。
 * 页面自己有同名全局变量的帮手用页面的（样例的冒烟会换掉其中几个）；game 不用页面的：画布的 id 常是 game，浏览器会把它挂成
 * 全局的 window.game。
 */
async function evaluate(game: Game, { code }: Args): Promise<unknown> {
  if (typeof code !== 'string') throw new Error('code must be a string');
  // 页面自己有同名全局变量的帮手用页面的：样例的冒烟会换掉其中几个（比如按坐标点的 uiClick），不能被这里的盖住
  // 只认函数：浏览器自己的同名全局（window.frames 是窗口列表）不算，不然 frames(n) 调的是它
  const helpers = Object.fromEntries(Object.entries(pageHelpers(game)).filter(([name]) => typeof (globalThis as Record<string, unknown>)[name] !== 'function'));
  const scope: Record<string, unknown> = { game, engine: (globalThis as { strideEngine?: unknown }).strideEngine, ...helpers };
  const names = Object.keys(scope);
  const values = names.map((name) => scope[name]);
  const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<unknown>;
  try {
    return await new AsyncFunction(...names, `return (${code}\n);`)(...values);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  const global = globalThis as { __strideEval?: Record<string, unknown> };
  global.__strideEval = scope;
  try {
    return await (0, eval)(`{ const { ${names.join(', ')} } = globalThis.__strideEval;\n${code}\n}`);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  } finally {
    delete global.__strideEval;
  }
  // 多半是顶层 await：当异步函数体跑
  return await new AsyncFunction(...names, code)(...values);
}

/**
 * 所有粒子发射器（`stride particles`）：在哪模拟、粒子池多大、活着几个、活着的粒子在世界里的范围（GPU 上的读回来数）。
 * 粒子看不见时先看这个：没生成、全死了，还是跑到了别处。
 */
async function particles(game: Game, { name }: Args): Promise<unknown> {
  const rows = [];
  for (const component of game.particles.components) {
    const owner = component.entity;
    if (typeof name === 'string' && !(owner.name ?? '').includes(name)) continue;
    for (const emitter of component.particleSystem.emitters) {
      const gpu = emitter.onGpu ? game.particles.gpuEmitter(emitter) : undefined;
      let positions: ArrayLike<number> = [], stride = 3, lifeAt = -1, count = 0;
      if (gpu) {
        positions = await gpu.read();
        stride = PARTICLE_BYTES / 4;
        lifeAt = 3;
        count = gpu.capacity;
      } else {
        positions = emitter.pool.field('position') ?? [];
        count = emitter.pool.living;
      }
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      let alive = 0;
      for (let i = 0; i < count; i++) {
        if (lifeAt >= 0 && !(positions[i * stride + lifeAt]! > 0)) continue;
        alive++;
        for (let c = 0; c < 3; c++) {
          const v = positions[i * stride + c]!;
          min[c] = Math.min(min[c]!, v);
          max[c] = Math.max(max[c]!, v);
        }
      }
      const round = (v: number[]) => v.map((x) => Math.round(x * 100) / 100);
      const at = owner.get(Transform)?.position;
      rows.push({
        entity: describe(owner), emitter: emitter.name, enabled: emitter.enabled, simulation: emitter.onGpu ? 'gpu' : 'cpu', space: emitter.simulationSpace,
        ...(at ? { position: round([at.x, at.y, at.z]) } : {}),
        capacity: gpu ? gpu.capacity : emitter.pool.capacity, alive,
        ...(alive > 0 ? { min: round(min), max: round(max) } : {}),
      });
    }
  }
  return rows;
}

/** 试贴花用的程序生成的贴图（`stride call decal`）：ring 是一个带 alpha 遮罩的橙色圆环，bumps 是一片圆凸起的法线贴图。 */
const testDecalTextures = new Map<string, Texture>();
function testDecalTexture(kind: 'ring' | 'bumps'): Texture {
  let texture = testDecalTextures.get(kind);
  if (texture) return texture;
  const size = 256, pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = (x + 0.5) / size * 2 - 1, v = (y + 0.5) / size * 2 - 1;
    if (kind === 'ring') {
      const r = Math.hypot(u, v);
      const alpha = Math.max(0, Math.min(1, (0.12 - Math.abs(r - 0.7)) * 40));
      pixels.set([240, 120, 30, Math.round(alpha * 255)], (y * size + x) * 4);
    } else {
      // 4x4 个半球形的凸起：法线 = 球面的法线，切线空间（绿色朝上，所以 y 取反）
      const cu = ((u + 1) * 2) % 1 * 2 - 1, cv = ((v + 1) * 2) % 1 * 2 - 1;
      const d = Math.hypot(cu, cv);
      const [nx, ny, nz] = d < 0.8 ? [cu / 0.8 * 0.7, -cv / 0.8 * 0.7, 0] : [0, 0, 1];
      const z = d < 0.8 ? Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny)) : nz;
      pixels.set([(nx * 0.5 + 0.5) * 255, (ny * 0.5 + 0.5) * 255, (z * 0.5 + 0.5) * 255, 255].map(Math.round), (y * size + x) * 4);
    }
  }
  texture = new Texture(`test decal ${kind}`, { format: kind === 'ring' ? 'rgba8unorm-srgb' : 'rgba8unorm', width: size, height: size, levels: [pixels] });
  testDecalTextures.set(kind, texture);
  return texture;
}

/**
 * 开关类命令的 on 参数：true、false 设成它，"toggle" 翻过来，没给时不变（只报告现在的状态）。以前没给时翻转，加别的参数、
 * 只想看状态时会把功能悄悄关掉。
 */
function switchArg(args: Readonly<Record<string, unknown>>, current: boolean): boolean {
  if (args['on'] === 'toggle') return !current;
  return typeof args['on'] === 'boolean' ? args['on'] : current;
}
