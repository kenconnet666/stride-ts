/** 调试命令：渲染效果的开关和调试：光追、AO、模糊、镜头、接触阴影、SSGI、次表面、探针、天空、SSR、云、雾、贴花、材质、灯、分簇、抖动、TAA、剔除、路径追踪、GI、线框。 */
import { Camera, Decal, Light, Model, ReflectionProbe, SkyAtmosphere, VolumetricClouds, VolumetricFog } from '../../rendering/components';
import { cameraVerticalFieldOfView } from '../../rendering/cameraRays';
import { DayNightCycle, lightRotationTowards } from '../../rendering/sky/DayNightCycle';
import { Material, type MaterialTransmission } from '../../rendering/mesh/Material';
import { Transform } from '../../engine/transform';
import { Texture, type TextureId } from '../../graphics/Texture';
import type { Entity } from '../../engine/Entity';
import type { Game } from '../../engine/Game';
import { describe, type Debug } from '../Debug';
import { readTexture } from '../../graphics/readTexture';
import { type Args, entityArg, pngBase64 } from './shared.ts';

/** 调试命令 raytrace：光追场景跟上这一帧（BVH 没建好就等几帧），从主相机光追一张图，编成 PNG。 */
async function rayTraceCommand(game: Game, args: Args): Promise<unknown> {
  const view = game.graphicsCompositor.mainView;
  if (!view) throw new Error('raytrace: no main camera');
  const scene = game.renderSystem.rayTracing;
  const start = performance.now();
  for (let i = 0; i < 600 && !(scene.ready && scene.bindGroup); i++) {
    scene.update(game);
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  scene.update(game);
  const buildMs = performance.now() - start;
  const canvas = game.graphicsDevice.canvas;
  const width = Number(args['width'] ?? canvas.width), height = Number(args['height'] ?? canvas.height);
  const lighting = game.renderSystem.lighting;
  const sun = lighting.directionalCount > 0 ? lighting.directionals[Math.max(lighting.shadowLight, 0)]!.direction : { x: 0, y: -1, z: 0 };
  const length = Math.hypot(sun.x, sun.y, sun.z) || 1;
  const { rayTraceView } = await import('../../rendering/raytracing/RayTracingDebug');
  const traceStart = performance.now();
  const pixels = await rayTraceView(game.renderSystem.device, scene, view, [-sun.x / length, -sun.y / length, -sun.z / length], width, height);
  const traceMs = performance.now() - traceStart;
  const offscreen = new OffscreenCanvas(width, height);
  offscreen.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
  return { width, height, instances: scene.instanceCount, buildMs: Math.round(buildMs), traceMs: Math.round(traceMs), png: await pngBase64(offscreen) };
}
/** 试贴花用的程序生成的贴图（`stride call decal`）：ring 是一个带 alpha 遮罩的橙色圆环，bumps 是一片圆凸起的法线贴图。 */
const testDecalTextures = new Map<string, Texture>();
/** 第 i 个测试贴花自己的贴图（512x512 的环，色相按 i 变）：decal 命令的 distinct，把图集撑到多页。 */
function distinctDecalTexture(i: number): Texture {
  let texture = distinctDecalTextures.get(i);
  if (texture) return texture;
  const size = 512, pixels = new Uint8Array(size * size * 4);
  const hue = (i * 0.618034) % 1;
  const channel = (offset: number) => Math.round(255 * Math.max(0, Math.min(1, Math.abs(((hue + offset) % 1) * 6 - 3) - 1)));
  const [r, g, b] = [channel(0), channel(2 / 3), channel(1 / 3)];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const radius = Math.hypot((x + 0.5) / size * 2 - 1, (y + 0.5) / size * 2 - 1);
    const alpha = Math.max(0, Math.min(1, (0.2 - Math.abs(radius - 0.6)) * 20));
    pixels.set([r, g, b, Math.round(alpha * 255)], (y * size + x) * 4);
  }
  texture = new Texture(`test decal ${i}`, { format: 'rgba8unorm-srgb', width: size, height: size, levels: [pixels] });
  distinctDecalTextures.set(i, texture);
  return texture;
}
const distinctDecalTextures = new Map<number, Texture>();
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

export function registerRenderingCommands(debug: Debug, game: Game): void {
  // 离线渲染的几个模块（编码、封装、混音）用到时才加载，不进每个游戏页面
  debug.command('raytrace', 'Render the main camera by ray tracing (the RayTracingScene: two-level BVH traversed in a compute shader; base color times the sun, sky where nothing is hit) and return it as a PNG (base64), to check the ray tracing scene against the rasterized frame. Builds the BVHs first if needed. args: width, height (default the canvas size).', (args) => rayTraceCommand(game, args));
  debug.command('ao', 'Screen-space ambient occlusion (GTAO) of the main view. args: on (true/false, or "toggle"; omitted keeps it and just reports), radius (world units), power, dump (true: also return the last occlusion buffer as a grayscale PNG, base64, half resolution; white is open; save it with stride call ao \'{"dump":true}\' --out ao.png).', async (args) => {
    const ao = game.graphicsCompositor.ambientOcclusion;
    ao.enabled = switchArg(args, ao.enabled);
    if (typeof args['radius'] === 'number') ao.radius = args['radius'];
    if (typeof args['power'] === 'number') ao.power = args['power'];
    const state = { enabled: ao.enabled, radius: ao.radius, power: ao.power };
    if (args['dump'] !== true) return state;
    const texture = ao.result;
    if (!texture) throw new Error('ao: no occlusion buffer yet (GTAO is off or has not run)');
    const gray = await readTexture(game.graphicsDevice.device, texture, 1);
    const rgba = new Uint8Array(gray.length * 4);
    for (let i = 0; i < gray.length; i++) rgba.set([gray[i]!, gray[i]!, gray[i]!, 255], i * 4);
    const { encodePng } = await import('../../offline/png');
    return { ...state, width: texture.width, height: texture.height, png: (await encodePng(rgba, texture.width, texture.height)).toBase64() };
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
  debug.command('decal', 'Decals (Decal). args: on (true adds test decals, false removes them); at [x, y, z] (default: in front of the camera on the ground); size [x, y, z] (m); count (n: an n x n grid of decals 3 m apart, to measure the cost); color [r, g, b]; opacity; albedoMix; normalFade; pattern ("ring" draws a ring with an alpha mask, "none" a solid box); bumps (true adds a normal map of round bumps); distinct (true: every test decal gets its own 512x512 ring texture in a different hue, to fill the atlas past one page). Without on, changes the test decals. Reports the atlas size and its array layers (color pages first, then normal pages).', (args) => {
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
      if (args['distinct'] === true) decal.albedo = distinctDecalTexture(tests().indexOf(entity)).id;
      if (args['pattern'] === 'none') decal.albedo = 0 as TextureId;
      if (args['bumps'] === true) decal.normal = testDecalTexture('bumps').id;
      if (args['bumps'] === false) decal.normal = 0 as TextureId;
    }
    const atlas = game.renderSystem.decals.atlas;
    return { decals: tests().length, drawn: game.renderSystem.decals.count, atlas: { size: atlas.width, layers: atlas.depthOrArrayLayers } };
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
  debug.command('dither', 'Dithering of the 8-bit output in the tone mapping pass (hides the banding of dark gradients). args: on (true/false, or "toggle"; omitted keeps it and just reports). Turn it off to compare screenshots pixel by pixel with desktop Stride.', (args) => {
    const toneMap = game.graphicsCompositor.postEffects.toneMap;
    toneMap.dither = switchArg(args, toneMap.dither);
    return { dither: toneMap.dither };
  });
  debug.command('taa', 'Temporal anti-aliasing of the main view instead of FXAA. args: on (true/false, or "toggle"; omitted keeps it and just reports).', (args) => {
    const taa = game.graphicsCompositor.temporalAntialiasing;
    taa.enabled = switchArg(args, taa.enabled);
    return { enabled: taa.enabled, feedback: taa.feedback, clipSigma: taa.clipSigma, sharpness: taa.sharpness };
  });
  debug.command('culling', 'Mesh culling: opaque batches culled on the GPU (compute shader, indirect draws; needs indirect-first-instance) or all on the CPU (native frustum culling). args: on (GPU culling true/false, or "toggle"; omitted keeps it and just reports).', (args) => {
    const meshes = game.meshes;
    meshes.gpuCulling = switchArg(args, meshes.gpuCulling);
    return { gpu: meshes.gpuCulling, supported: game.renderSystem.graphicsDevice.indirectFirstInstance, wireframeFallsBackToCpu: game.graphicsCompositor.wireframe, stats: meshes.stats() };
  });
  debug.command('raytrace-check', 'Read back the ray tracing scene from the GPU and walk every BVH the way the shaders do: reports out-of-range indices, cycles and leaves past the triangle buffer (empty list = sound).', () => game.renderSystem.rayTracing.check());
  debug.command('pathtrace', 'Path traced diffuse indirect light (RenderSystem.pathTracing: replaces the irradiance volume, sky and ambient diffuse; accumulates while the camera stands still). args: on (true/false/"toggle"), paths (per pixel per frame), bounces, reset (true). Reports whether it is active and how many frames it accumulated.', (args) => {
    const tracing = game.renderSystem.pathTracing;
    tracing.enabled = switchArg(args, tracing.enabled);
    if (typeof args['paths'] === 'number') tracing.paths = args['paths'];
    if (typeof args['bounces'] === 'number') tracing.bounces = args['bounces'];
    if (args['reset'] === true) tracing.reset();
    return { enabled: tracing.enabled, active: tracing.active, samples: tracing.samples, paths: tracing.paths, bounces: tracing.bounces };
  });
  debug.command('gi', 'Irradiance volume (DDGI: ray traced probes give the diffuse ambient light inside the IrradianceVolume box). args: on (true/false, or "toggle"; omitted keeps it and just reports). Reports the probe count, probes and rays updated per frame, the ray tracing scene instances, and how many ray traversals hit the step cap (should be 0; otherwise the BVH is broken).', async (args) => {
    const volumes = game.renderSystem.irradianceVolumes;
    volumes.enabled = switchArg(args, volumes.enabled);
    return { enabled: volumes.enabled, active: volumes.active, ...volumes.stats, instances: game.renderSystem.rayTracing.instanceCount, traversal: await volumes.traversalStats() };
  });
  debug.command('wireframe', 'Overlay the wireframe of the meshes on the main view. args: on (true/false, or "toggle"; omitted keeps it and just reports).', (args) => {
    const compositor = game.graphicsCompositor;
    compositor.wireframe = switchArg(args, compositor.wireframe);
    return { wireframe: compositor.wireframe };
  });
}
