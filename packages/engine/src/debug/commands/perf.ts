/** 调试命令：性能和统计：采样帧时间、原生侧的计数、绘制次数、统计量和预算、画质档位。 */
import { QUALITY_TIERS, type QualityTier } from '../../rendering/Quality';
import type { Game } from '../../engine/Game';
import type { Debug } from '../Debug';
import { type Args, throttled, framesPassed } from './shared.ts';

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
    throttled: throttled(debug, intervals.reduce((sum, ms) => sum + ms, 0) / Math.max(1, intervals.length)),
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

export function registerPerfCommands(debug: Debug, game: Game): void {
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
}
