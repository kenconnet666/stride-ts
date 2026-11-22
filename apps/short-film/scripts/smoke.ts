// 冒烟测试：对着正在运行的页面（开发服务器或 preview，`stride open` 打开的），用调试 CLI 走一遍。
//   pnpm --filter @stride-ts/short-film smoke [-- --hub <中枢名的一部分>]
// 检查：主场景跑起来了；短片（时间轴 Films/Evening）在放，跳到各个时刻时机位、机器人放的剪辑、位置、字幕都是那一刻的；
// 没有错误日志（finish 检查）。
import { PAGE_HELPERS, startSmoke } from '@stride-ts/devkit/smoke';

const { stride, check, finish } = startSmoke('short-film');

stride('wait');
const status = stride('status') as { scene: string | null; error: string | null; entities: number };
check('主场景跑起来了，有实体', status.scene === 'MainScene' && status.error === null && status.entities > 0, status);

stride('eval', PAGE_HELPERS);
const playing = stride('eval', `(async () => {
  const player = entity('Film').get(strideEngine.TimelinePlayer);
  return await until(() => player.playing && player.time > 0, 5) && player.timeline.name;
})()`);
check('短片的时间轴在放', playing === 'Evening', playing);

// 跳到某一刻（时间轴是无状态求值的，跳到哪就是哪一刻的样子），读机位、剪辑、机器人的位置和字幕
const at = (time: number) => stride('eval', `(() => {
  const player = entity('Film').get(strideEngine.TimelinePlayer);
  player.pause();
  player.seek(${time});
  const camera = strideGame.graphicsCompositor.mainCamera;
  const animation = entity('Robot').get(strideEngine.AnimationComponent);
  const p = entity('Robot').get(strideEngine.Transform).position;
  return { camera: camera === undefined ? null : strideGame.entities.entity(camera).name, clips: animation.playingAnimations.map((a) => a.name), x: p.x, subtitle: player.subtitle };
})()`) as { camera: string | null; clips: string[]; x: number; subtitle: string };

const wave = at(6);
check('6 秒：远景机位，挥手，在起点，"Hello, sun!"', wave.camera === 'CamWide' && wave.clips.join() === 'Wave' && Math.abs(wave.x + 3) < 1e-3 && wave.subtitle === 'Hello, sun!', wave);
const walk = at(12.5);
check('12.5 秒：跟拍机位，走路，走到半路', walk.camera === 'CamTrack' && walk.clips.join() === 'Walking' && walk.x > -3 && walk.x < 1.5, walk);
const dance = at(20);
check('20 秒：环绕机位，跳舞，在终点', dance.camera === 'CamOrbit' && dance.clips.join() === 'Dance' && Math.abs(dance.x - 1.5) < 1e-3, dance);
const blend = at(24.4);
check('24.4 秒：特写机位，跳舞交叉淡化到竖大拇指', blend.camera === 'CamClose' && blend.clips.join() === 'Dance,ThumbsUp', blend);

finish();
