// SpaceEscape 的冒烟测试：对着正在运行的页面（开发服务器或 preview），用调试 CLI 走一遍。
//   pnpm --filter @stride-ts/space-escape smoke [-- --hub <中枢名的一部分>]
// 检查：主菜单（标志、开始按钮）；点开始后距离在涨、关卡往相机这边移、天空板的 UV 在滚；左键换到左边的道、下键滑铲；把一个
// 障碍物挪到角色身上，角色倒下、结束页面出来；Retry 后距离清零、角色回到中间道；没有错误日志（finish 检查）。
import { PAGE_HELPERS, startSmoke } from '../../../tools/lib/smoke.ts';

const { stride, sleep, check, finish } = startSmoke('space-escape');

/** 页面里的帮手：seClick(x, y)（画布的比例）、seRoot()、seScripts()（角色、关卡、UI 脚本）、seKey(code)。 */
const HELPERS = `(() => {
  const canvas = document.querySelector('canvas');
  // 这里的坐标是画布的 0..1
  const at = (type, x, y, target) => pointerAt(type, x * canvas.clientWidth, y * canvas.clientHeight, target);
  globalThis.seClick = async (x, y) => { at('pointermove', x, y); await frame(); at('pointerdown', x, y); await frame(); await frame(); at('pointerup', x, y, window); await frames(3); };
  globalThis.seKey = async (code) => { window.dispatchEvent(new KeyboardEvent('keydown', { code })); await frame(); window.dispatchEvent(new KeyboardEvent('keyup', { code })); await frames(2); };
  // 在画布上横着划：按下，挪几下，抬起
  globalThis.seSwipe = async (y, xs) => {
    at('pointerdown', xs[0], y); await frames(2);
    for (const x of xs.slice(1)) { at('pointermove', x, y); await frame(); }
    at('pointerup', xs.at(-1), y, window); await seconds(0.7);
  };
  globalThis.seRoot = () => strideGame.ui.components[0].page.rootElement;
  globalThis.seEntities = () => strideGame.entities.ids().map((id) => strideGame.entities.entity(id));
  globalThis.seScripts = () => {
    const script = (entity, name) => seEntities().find((e) => e.name === entity).get(strideGame.registry.scriptsNamed(name)[0]);
    return { character: script('Character', 'CharacterScript'), background: script('Background', 'BackgroundScript') };
  };
  globalThis.seState = () => {
    const { character } = seScripts();
    const t = character.entity.require(strideEngine.Transform).position;
    const root = seRoot();
    const sections = seEntities().filter((e) => e.name === 'Section').map((e) => e.require(strideEngine.Transform).position.z);
    const sky = seEntities().find((e) => e.name === 'Skyplane');
    const skyMesh = sky && strideEngine.Mesh.byId(sky.get(strideEngine.Model).mesh);
    return {
      page: root.constructor.name, distance: root.constructor.name === 'Canvas' ? [...root.children][0].content.text : null,
      x: t.x, y: t.y, lane: character.currentLane, dead: character.isDead, sections, skyU: skyMesh?.effectParameters?.[8] ?? null,
      animations: character.entity.get(strideEngine.AnimationComponent).playingAnimations.map((a) => a.name),
    };
  };
  return 1;
})()`;

stride('eval', 'location.reload()');
await sleep(1500);
stride('wait');
await sleep(1500);
const status = stride('status') as { status: string; error: string | null };
check('在跑', status.status === 'running' && status.error === null, status);
stride('eval', PAGE_HELPERS);
stride('eval', HELPERS);

type State = { page: string; distance: string | null; x: number; y: number; lane: number; dead: boolean; sections: number[]; skyU: number | null; animations: string[] };
// 关卡在加载后的头几帧里生成；慢的机器（CI 的软件 WebGPU）上那几帧很长，等它生成完，最多 10 秒游戏时间
const menu = stride('eval', `(async () => {
  const end = strideGame.updateTime.total + 10;
  while (seState().sections.length < 6 && strideGame.updateTime.total < end) await frame();
  return seState();
})()`) as State;
check('主菜单：模态层，关卡已经生成（6 段）', menu.page === 'ModalElement' && menu.sections.length === 6, menu);

// 开始后的一段放在页面里一次跑完（CLI 一条命令要几百毫秒）。等待都按游戏时间和游戏状态：帧率随机器变，CI 的软件 WebGPU 上一帧
// 要几百毫秒，按墙钟等可能一帧都没走。关卡是随机的，跑得越久越可能撞上、掉进洞里：看过关卡在滚就让它停下，再测换道
type Play = { started: State; later: State; left: State };
const play = stride('eval', `(async () => {
  const distance = () => Number(seState().distance?.split(':')[1] ?? NaN);
  await seClick(0.5, 0.8);
  const started = seState();
  // 距离显示取整，等它涨了（最多 3 秒游戏时间）
  const from = distance(), end = strideGame.updateTime.total + 3;
  do await frame(); while (distance() <= from && strideGame.updateTime.total < end);
  const later = seState();
  seScripts().background.stopScrolling();
  await seKey('ArrowLeft');
  await seconds(0.6);
  const left = seState();
  return { started, later, left };
})()`) as Play;
check('点开始：游戏中的页面', play.started.page === 'Canvas', play.started);
const number = (text: string | null) => Number(text?.split(':')[1] ?? NaN);
check('距离在涨、关卡往相机这边移、天空板的 UV 在滚', number(play.later.distance) > number(play.started.distance) && play.later.sections[0]! < play.started.sections[0]! && (play.later.skyU ?? 0) < (play.started.skyU ?? 0), play);
check('左键：换到左边的道（x = 5）', play.left.lane === 0 && Math.abs(play.left.x - 5) < 1e-3, play.left);
// 正常跑的时候（不是滑铲，横着的管子滑铲能过）把最近一段里的一个障碍物挪到角色身上（障碍物的本地位置 = 角色的世界位置 - 段的位置；关卡停着也照样判碰撞）
const crashed = stride('eval', `(async () => {
  const { character } = seScripts();
  const target = character.entity.require(strideEngine.Transform).position;
  const obstacle = seEntities().find((e) => /^Obstacle/.test(e.name));
  if (!obstacle) return { error: 'no obstacle' };
  const section = obstacle.require(strideEngine.Transform).parent.require(strideEngine.Transform).position;
  // 等到判出碰撞，最多 3 秒游戏时间
  const end = strideGame.updateTime.total + 3;
  while (!character.isDead && strideGame.updateTime.total < end) {
    Object.assign(obstacle.require(strideEngine.Transform).position, { x: target.x - section.x, y: 0, z: target.z - section.z });
    await frame();
  }
  await frames(3);
  return seState();
})()`) as State;
check('撞上障碍物：角色倒下（Crash），结束页面', crashed.dead && crashed.page === 'ModalElement' && crashed.animations.includes('Crash'), crashed);

const retried = stride('eval', `(async () => { await seClick(0.3, 0.7); return seState(); })()`) as State;
check('Retry：重新开始，角色回到中间道，距离从头算', retried.page === 'Canvas' && !retried.dead && retried.lane === 1 && number(retried.distance) <= 1, retried);
// 关卡是随机生成的：接下来这两步要跑两三秒，让关卡停下不再往前滚，免得中途撞上障碍物、掉进洞里（死了就换不了道了）。
// 滑铲、换道是角色自己的动作，和关卡滚不滚无关
const slide = stride('eval', `(async () => {
  seScripts().background.stopScrolling();
  await seKey('ArrowDown');
  return seState();
})()`) as State;
check('下键：滑铲', slide.animations.includes('Slide'), slide);
// 拖动手势（Input.Gestures）：等滑铲放完，在画布上往右划一下，换到右边的道
const swiped = stride('eval', `(async () => {
  await seconds(1.5);
  await seSwipe(0.5, [0.5, 0.52, 0.56, 0.62]);
  return seState();
})()`) as State;
check('往右划：换到右边的道', swiped.lane === 2, swiped);

finish();
