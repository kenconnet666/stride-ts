/** 调试命令：大世界：天气、世界的格子、地形、车道图、城市、程序化摆放。 */
import { Transform } from '../../engine/transform';
import { Matrix } from '../../data/Matrix';
import type { DebugColor } from '../DebugDraw';
import { roadLanes } from '../../modeling/roadLanes';
import { StateTreeRunner } from '../../ai/StateTreeRunner';
import { DEFAULT_NAVIGATION_STREAMING } from '../../physics/NavigationSystem';
import { Precipitation } from '../../world/Precipitation';
import type { SaveData } from '../../world/Persistence';
import { Weather, WEATHER_PRESETS, type WeatherPreset, type WeatherTarget } from '../../world/Weather';
import type { Game } from '../../engine/Game';
import type { Debug } from '../Debug';
import { entityArg } from './shared.ts';

export function registerWorldCommands(debug: Debug, game: Game): void {
  debug.command('save', 'Saves and persistent world state (game.persistence): entities with Persistent keep their state when their scene unloads and reloads. No args: the recorded states (key: scene path#entity id). args: take (true) returns a whole save (JSON); load (a save) restores it; forget (true or a key) drops recorded states.', (args) => {
    const persistence = game.persistence;
    if (args['take'] === true) return persistence.save();
    if (args['load'] !== undefined) persistence.load(args['load'] as SaveData);
    if (args['forget'] === true) persistence.forget();
    else if (typeof args['forget'] === 'string') persistence.forget(args['forget']);
    return { records: Object.fromEntries(persistence.records) };
  });
  debug.command('events','Named game events (game.events): the recent ones (name, value, frame) and which names have receivers. args: emit (event name) sends one with value (any JSON, default null).', (args) => {
    if (typeof args['emit'] === 'string') game.events.emitUnchecked(args['emit'], args['value'] ?? null);
    return { recent: game.events.recent, listeners: game.events.listeners() };
  });
  debug.command('clock','World clock and calendar (game.clock): the day-night cycle follows it. args: hours (0-24), dayOfYear (1-365), year, rate (world seconds per game second; 0 stops it, 720 is a day in two minutes), time (world seconds). Reports the calendar and whether game code or a day-night cycle has set it.', (args) => {
    const clock = game.clock;
    const number = (key: string) => (typeof args[key] === 'number' ? args[key] : undefined);
    const change = { time: number('time'), year: number('year'), dayOfYear: number('dayOfYear'), hours: number('hours'), rate: number('rate') };
    if (Object.values(change).some((value) => value !== undefined)) clock.set(Object.fromEntries(Object.entries(change).filter(([, value]) => value !== undefined)));
    return { time: clock.time, rate: clock.rate, set: clock.isSet, year: clock.year, dayOfYear: clock.dayOfYear, timeOfDay: +clock.timeOfDay.toFixed(4), weekday: clock.weekday, running: !game.editing };
  });
  debug.command('physics-lod', 'Physics level of detail (simulation.lod): awake dynamic bodies and soft bodies farther than sleepDistance from the main camera are frozen, frozen ones within wakeDistance wake up; checked every interval seconds. args: sleepDistance (m, 0 turns it off), wakeDistance (m), interval (s). Reports the settings, the focus and how many bodies are frozen.', (args) => {
    const simulation = game.simulation;
    if (!simulation) throw new Error('the game has no physics (nativeFeatures has no physics)');
    for (const key of ['sleepDistance', 'wakeDistance', 'interval'] as const) if (typeof args[key] === 'number') simulation.lod[key] = args[key];
    return { ...simulation.lod, focus: simulation.focus, ...simulation.lodStats };
  });
  debug.command('navigation', 'Navigation mesh and crowd: streaming tiles (navigation.settings.streaming) are built around crowd agents and NavigationInvoker entities and rebuilt where static bodies change. args: tiles (true/false) draws built tiles (green) and tiles being built (yellow); streaming (true/false) turns tile streaming on with the default settings, or off; avoidance (0..3) crowd avoidance quality. Reports tile and crowd stats.', (args) => {
    const navigation = game.navigation;
    if (!navigation) throw new Error('the game has no navigation (nativeFeatures needs physics and navigation)');
    if (typeof args['tiles'] === 'boolean') navigation.showTiles = args['tiles'];
    if (args['streaming'] === true && !navigation.settings.streaming) navigation.settings = { ...navigation.settings, streaming: DEFAULT_NAVIGATION_STREAMING };
    if (args['streaming'] === false && navigation.settings.streaming) {
      const { streaming: _streaming, ...rest } = navigation.settings;
      navigation.settings = rest;
    }
    if (typeof args['avoidance'] === 'number') navigation.crowdAvoidance = Math.max(0, Math.min(3, Math.round(args['avoidance']))) as 0 | 1 | 2 | 3;
    return { streaming: navigation.settings.streaming ?? false, showTiles: navigation.showTiles, ...navigation.streamStats, crowd: navigation.crowdStats, avoidance: navigation.crowdAvoidance };
  });
  debug.command('perception', 'Perception (Perceiver sees and hears PerceptionStimulus entities and noises): reports how many perceivers and stimuli there are and the last frame cost. args: show (true/false) draws what each perceiver knows (green in sight, yellow remembered, blue heard); interval (s between looks per perceiver); entity (name) lists what it perceives; noise ({ position: [x, y, z], range, tag }) makes a sound.', (args) => {
    const perception = game.perception;
    if (typeof args['show'] === 'boolean') perception.show = args['show'];
    if (typeof args['interval'] === 'number') perception.interval = args['interval'];
    const noise = args['noise'] as { position?: number[]; range?: number; tag?: string } | undefined;
    if (noise?.position) perception.noise({ x: noise.position[0]!, y: noise.position[1]!, z: noise.position[2]! }, noise.range ?? 10, noise.tag ?? '');
    const name = typeof args['entity'] === 'string' ? args['entity'] : undefined;
    const entity = name === undefined ? undefined : game.entities.ids().map((id) => game.entities.entity(id)).find((e) => e.name === name);
    return {
      show: perception.show, interval: perception.interval, ...perception.stats,
      ...(entity ? { perceives: perception.of(entity).map((item) => ({ entity: item.entity?.name, tag: item.tag, sense: item.sense, seeing: item.seeing, position: [item.position.x, item.position.y, item.position.z].map((v) => +v.toFixed(2)), age: +(game.updateTime.total - item.time).toFixed(2) })) } : {}),
    };
  });
  debug.command('audio', 'Sound events (game.audio.events): how many play, how many have a real voice and how many are virtual (too far or over the voice limit), the listener position, and each instance (event, real/virtual, distance, gain, occluded). args: maxVoices (global voice limit), play ({ event: path, position: [x, y, z], parameters: {} } starts one), stopAll (true), limit (default 30).', async (args) => {
    const audio = game.audio;
    const events = audio.events;
    if (typeof args['maxVoices'] === 'number') events.maxVoices = args['maxVoices'];
    if (args['stopAll'] === true) events.stopAll();
    const play = args['play'] as { event?: string; position?: number[]; parameters?: Record<string, number | string> } | undefined;
    if (play?.event) {
      const event = await game.content.loadSoundEvent(play.event);
      const position = play.position ? { x: play.position[0]!, y: play.position[1]!, z: play.position[2]! } : undefined;
      events.play(event, { ...(position ? { position } : {}), ...(play.parameters ? { parameters: play.parameters } : {}) });
    }
    const limit = typeof args['limit'] === 'number' ? args['limit'] : 30;
    return {
      running: audio.isRunning, maxVoices: events.maxVoices, listener: audio.listenerPosition.map((v) => +v.toFixed(2)), ...events.stats,
      instances: events.instances.slice(0, limit).map((instance) => ({
        event: instance.event.path, real: instance.real, distance: +instance.distance.toFixed(2), gain: +instance.chain.gain.gain.value.toFixed(3),
        occluded: instance.occluded, entity: instance.entity?.name ?? null, sounds: instance.voices.map((voice) => voice.instance.sound.name),
      })),
    };
  });
  debug.command('simlod', 'Simulation LOD of massive crowds (SimulationLod: by distance to the main camera, level 0 full / 1 path, no avoidance / 2 straight, frozen animation / 3 off, hidden): reports how many are at each level and how many stepped this frame, and the crowd split. args: show (true/false) draws a dot over each (green 0, yellow 1, orange 2, red 3); distances ([3 numbers] m), maxHigh, intervals ([4 numbers] s), hysteresis.', (args) => {
    const lod = game.simulationLod;
    if (typeof args['show'] === 'boolean') lod.show = args['show'];
    const settings = lod.settings;
    if (Array.isArray(args['distances']) && args['distances'].length === 3) settings.distances = args['distances'] as [number, number, number];
    if (Array.isArray(args['intervals']) && args['intervals'].length === 4) settings.intervals = args['intervals'] as [number, number, number, number];
    if (typeof args['maxHigh'] === 'number') settings.maxHigh = args['maxHigh'];
    if (typeof args['hysteresis'] === 'number') settings.hysteresis = args['hysteresis'];
    return { show: lod.show, settings, ...lod.stats, crowd: game.navigation?.crowdStats ?? null };
  });
  debug.command('smartobjects', 'Smart objects (SmartObject: benches, counters with slots people claim and use): reports objects, slots and claims (who uses which slot). args: show (true/false) draws every slot (green free, red claimed) with its facing.', (args) => {
    const system = game.smartObjects;
    if (typeof args['show'] === 'boolean') system.show = args['show'];
    return {
      ...system.stats,
      claims: system.claims.map((claim) => ({ object: claim.object.entity.name, slot: claim.slot, activity: claim.activity, user: game.entities.isAlive(claim.user) ? game.entities.entity(claim.user).name : claim.user })),
    };
  });
  debug.command('statetree', 'State trees (StateTreeRunner): lists each running tree with its entity, active states (root to leaf), status and transition count. args: entity (name; default all), event (sends it to the trees), set ({ parameter: value } sets parameters), limit (default 20).', (args) => {
    const name = typeof args['entity'] === 'string' ? args['entity'] : undefined;
    const runners = game.entities.ids().map((id) => game.entities.entity(id))
      .filter((entity) => (name === undefined || entity.name === name))
      .flatMap((entity) => entity.get(StateTreeRunner) ?? []);
    const set = typeof args['set'] === 'object' && args['set'] !== null ? Object.entries(args['set'] as Record<string, number | boolean>) : [];
    for (const runner of runners) {
      if (typeof args['event'] === 'string') runner.send(args['event']);
      for (const [parameter, value] of set) runner.set(parameter, value);
    }
    const limit = typeof args['limit'] === 'number' ? args['limit'] : 20;
    return {
      count: runners.length,
      trees: runners.slice(0, limit).map((runner) => ({ entity: runner.entity.name, tree: runner.tree.path, path: runner.activePath, status: runner.status, transitions: runner.instance.transitions })),
    };
  });
  debug.command('animation-lod', 'Animation update rate by distance (animation.lod): skeletons within distances[0] m of the main camera evaluate every frame, then every 2nd, 4th and 8th frame. args: distances (array of metres, [] turns it off). Reports the distances, the focus and how many skeletons were evaluated and skipped last frame.', (args) => {
    const animation = game.animation;
    if (Array.isArray(args['distances'])) animation.lod.distances = (args['distances'] as unknown[]).map(Number);
    return { ...animation.lod, focus: animation.focus, ...animation.lodStats };
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
  debug.command('world', 'World streaming (game.world, .world.json): cells load around the main camera and StreamingSource entities. args: load (world content path) switches to that world; unload (true) drops its cells. Reports the world, cell size, loaded and loading cells (layer/x_z), the streaming sources and how many cell loads and unloads happened.', async (args) => {
    const world = game.world;
    if (typeof args['load'] === 'string') await world.load(args['load']);
    if (args['unload'] === true) world.unload();
    return {
      world: world.path ?? null, cellSize: world.file?.cellSize, layers: world.file?.layers,
      loaded: world.loaded, loading: world.loading, sources: world.sources.map((source) => [Math.round(source.x), Math.round(source.z)]),
      loads: world.loads, unloads: world.unloads, cancels: world.cancels, stats: world.stats,
      ...(args['cells'] === true ? { cells: world.cellStates.map((cell) => `${cell.state} ${cell.key} ${Math.round(cell.distance)}m`) } : {}),
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
  debug.command('city', 'Cities (game.city, City components): per city, how many buildings stand and how many of each model, and how many cities and buildings were placed since the start.', () => ({
    cities: game.city.stats(), built: game.city.built,
  }));
  debug.command('scatter', 'Procedural placement (game.scatter, Scatter components on terrains): per terrain, how many cells are scattered around the camera and how many instances they hold, how many cells and instances were built since the start, and at the last new version of a scatter file or terrain how many cells were kept, marked for re-scattering or dropped; impostorsBaking: how many far-tree cards (lods with impostor) are still being baked.', () => ({
    terrains: game.scatter.stats(), built: game.scatter.built, lastChange: game.scatter.carried, impostorsBaking: game.renderSystem.impostors.pending,
  }));
}
