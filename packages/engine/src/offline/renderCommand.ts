/**
 * 调试命令 `render`（`stride call render`、编辑器的 MCP 工具 render、时间轴面板的"导出"）：离线渲染成 MP4 或 PNG 序列，
 * 经编辑器后端（`POST /__stride/editor/api/export`，见 @stride-ts/editor 的 EditorBackend）存进工程的 exports 文件夹。
 *
 * 编辑状态的页面（game.editing：脚本不挂、仿真不走）自己不能出片：在页面里开一个看不见的 iframe，用试玩的地址（去掉
 * ?stride-edit）打开同一个游戏，在那里跑这条命令，跑完关掉。
 */
import { textOf } from '../data/text.ts';
import type { Game } from '../engine/Game';
import { TimelinePlayer } from '../animation/TimelinePlayer';
import { saveExport } from '../editor/backendApi';
import { exportImages, exportVideo, RENDER_PRESETS, type RenderPreset } from './VideoExport';

type Args = Readonly<Record<string, unknown>>;

/** 游戏跑过的帧比这少时，出片前先跑够（见 warmUp）。 */
const WARM_UP_FRAMES = 30;

export interface RenderResult {
  /** 存在哪（工程里的相对路径；PNG 序列是文件夹）。 */
  readonly path: string;
  readonly frames: number;
  readonly seconds: number;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly bytes: number;
  /** 渲染花了多久（秒，墙上的时钟）。 */
  readonly elapsed: number;
}


export async function renderCommand(game: Game, args: Args): Promise<RenderResult> {
  if (game.editing) return renderInPlayPage(args);
  // 刚打开的页面（或者窗口被挡住、一直没跑帧的页面）：先跑几帧，脚本开始了、后台算的东西就位了再出片
  if (game.frames < WARM_UP_FRAMES) await warmUp(game);
  const preset = args['preset'] === undefined ? undefined : RENDER_PRESETS[args['preset'] as RenderPreset];
  if (args['preset'] !== undefined && !preset) throw new Error(`unknown preset ${JSON.stringify(args['preset'])}; presets: ${Object.keys(RENDER_PRESETS).join(', ')}`);
  const width = numberArg(args, 'width') ?? preset?.width ?? 1920;
  const height = numberArg(args, 'height') ?? preset?.height ?? 1080;
  const fps = numberArg(args, 'fps') ?? preset?.fps ?? 30;
  const player = args['timeline'] === undefined ? undefined : timelinePlayer(game, textOf(args['timeline']));
  const seconds = numberArg(args, 'seconds') ?? player?.timeline.duration;
  if (!(seconds !== undefined && seconds > 0)) throw new Error('seconds is required (or a timeline whose length is used)');
  const format = args['format'] ?? 'mp4';
  if (format !== 'mp4' && format !== 'png') throw new Error(`format must be mp4 or png, got ${JSON.stringify(format)}`);
  const name = typeof args['name'] === 'string' && args['name'] !== '' ? args['name'] : 'render';
  const options = {
    width, height, fps, seconds,
    samples: numberArg(args, 'samples') ?? 8,
    shutter: numberArg(args, 'shutter') ?? 0.5,
    // 过场从头放：跳回开头再放（时间轴的声音、事件从这里开始经过）
    prepare: player ? () => { player.seek(0); player.play(); } : undefined,
  };
  const started = performance.now();
  let path: string, bytes = 0;
  if (format === 'mp4') {
    const mp4 = await exportVideo(game, { ...options, bitrate: numberArg(args, 'bitrate'), audio: args['audio'] !== false });
    bytes = mp4.length;
    path = await saveExport(`${name}.mp4`, mp4);
  } else {
    let last = '';
    await exportImages(game, options, async (index, png) => {
      bytes += png.length;
      last = await saveExport(`${name}/${String(index).padStart(5, '0')}.png`, png);
    });
    path = last.slice(0, last.lastIndexOf('/'));
  }
  return { path, frames: Math.round(seconds * fps), seconds, width, height, fps, bytes, elapsed: (performance.now() - started) / 1000 };
}


/** 放时间轴的播放器：按实体名（先全名再包含）或时间轴的名字找。 */
function timelinePlayer(game: Game, name: string): TimelinePlayer {
  const players = game.entities.ids().flatMap((id) => {
    const entity = game.entities.entity(id);
    const player = entity.script(TimelinePlayer);
    return player instanceof TimelinePlayer ? [{ entity, player }] : [];
  });
  const found = players.find(({ entity }) => entity.name === name) ?? players.find(({ player }) => player.timeline.name === name)
    ?? players.find(({ entity }) => entity.name.toLowerCase().includes(name.toLowerCase()));
  if (!found) throw new Error(`no TimelinePlayer on an entity named '${name}' or playing a timeline named '${name}'; players: ${players.map(({ entity }) => entity.name).join(', ') || 'none'}`);
  return found.player;
}

function numberArg(args: Args, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${key} must be a number, got ${JSON.stringify(value)}`);
  return number;
}

/** 编辑状态：开一个看不见的试玩页面（同一个地址去掉 ?stride-edit），等游戏跑起来，在那里出片。 */
async function renderInPlayPage(args: Args): Promise<RenderResult> {
  const url = new URL(location.href);
  url.searchParams.delete('stride-edit');
  const frame = document.createElement('iframe');
  // 屏幕外的 iframe 里 requestAnimationFrame 不走，没关系：离线渲染自己一帧帧地跑（Game.takeOverFrames）
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:640px;height:360px;border:0;';
  frame.src = url.href;
  document.body.append(frame);
  try {
    const game = await playingGame(frame);
    return await game.debug.run('render', args) as RenderResult;
  } finally {
    frame.remove();
  }
}

/** 等 iframe 里的游戏加载完（status 是 running：内容加载好了，帧由离线渲染来跑）；30 秒没起来就报错。 */
async function playingGame(frame: HTMLIFrameElement): Promise<Game> {
  const deadline = performance.now() + 30_000;
  for (;;) {
    const game = (frame.contentWindow as (Window & { strideGame?: Game }) | null)?.strideGame;
    if (game?.status === 'failed') throw new Error('the play-mode page failed to start');
    if (game?.status === 'running') return game;
    if (performance.now() > deadline) throw new Error('the play-mode page did not start within 30 seconds');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * 刚打开的页面一帧都还没跑过：脚本没开始、天空光这类第一次用到时在后台算的东西还没好。先跑到 WARM_UP_FRAMES 帧（每帧 1/60 秒
 * 游戏时间），每帧之后等 GPU 做完，后台的编译、计算有机会完成。
 */
async function warmUp(game: Game): Promise<void> {
  const release = await game.takeOverFrames();
  try {
    while (game.frames < WARM_UP_FRAMES) {
      await game.runFrame(1 / 60);
      await game.graphicsDevice.device.queue.onSubmittedWorkDone();
    }
  } finally {
    release();
  }
}
