/** 调试命令：大世界：天气、世界的格子、地形、车道图、城市、程序化摆放。 */
import { Transform } from '../../engine/transform';
import { Matrix } from '../../data/Matrix';
import type { DebugColor } from '../DebugDraw';
import { roadLanes } from '../../modeling/roadLanes';
import { Precipitation } from '../../world/Precipitation';
import { Weather, WEATHER_PRESETS, type WeatherPreset, type WeatherTarget } from '../../world/Weather';
import type { Game } from '../../engine/Game';
import type { Debug } from '../Debug';
import { entityArg } from './shared.ts';

export function registerWorldCommands(debug: Debug, game: Game): void {
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
