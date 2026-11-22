// CSharpIntermediate 的冒烟测试：对着正在运行的页面（开发服务器或 preview），用调试 CLI 走一遍。
//   pnpm --filter @stride-ts/csharp-intermediate smoke [-- --hub <中枢名的一部分>]
// 检查：在跑；菜单里两列各 11 个教程按钮；22 个教程场景（开始的、完成的）都能加载；每个主题完成版的交互（见各段）；
// 换一圈教程实体数不变；没有错误日志（finish 检查）。
// 按键和点击用合成的事件；两个相机教程要锁鼠标，用 `mouse --trusted`（DevTools 协议的真实点击）。
import { PAGE_HELPERS, startSmoke } from '../../../tools/lib/smoke.ts';

const { stride, sleep, check, finish } = startSmoke('csharp-intermediate');

/** 按钮上的字 → 完成版加载后应该打印出来的字（没有调试文字的教程是 undefined）。 */
const TUTORIALS: readonly (readonly [string, RegExp | undefined])[] = [
  ['UI interaction', undefined],
  ['Collision trigger', /^Press Space to teleport ball back in the air$/],
  ['Raycasting', /^Raycast penetration demo$/],
  ['Project & Unproject', /^Parent$/],
  ['Async Scripts', /^Press G to get Api data/],
  ['Scene loading', /^Scene-B, press: B$/],
  ['Animation basics', /^Q and E for speed 1\.0$/],
  ['Audio', /^Space to play\/pause\. Currently: Stopped$/],
  ['First person camera', /^Click to look around/],
  ['Third person camera', /^Click to look around/],
  ['Navigation', /^Left click to set Regular character target$/],
];

type Loaded = { scene: string; lines: string[] };
const evaluate = <T>(code: string) => stride('eval', code) as T;
const load = (label: string, stage: 'completed' | 'start' = 'completed'): Loaded => {
  const scene = stride('call', 'tutorial', JSON.stringify(stage === 'start' ? [label, 'start'] : label)) as string;
  return { scene, lines: evaluate<string[]>('frames(3).then(() => lines())') };
};
const count = () => evaluate<number>('strideGame.entities.count');

stride('eval', 'location.reload()');
await sleep(1500);
stride('wait');
await sleep(1000);
const status = stride('status') as { status: string; error: string | null };
check('在跑', status.status === 'running' && status.error === null, status);
stride('eval', PAGE_HELPERS);

// 菜单的按钮（和 tutorial 命令）在 TutorialUI 的 start 里才建
const buttons = evaluate<number[]>(`(async () => {
  const counts = () => ['ButtonsStart', 'ButtonsCompleted'].map((name) => uiFind(name)?.children.length ?? 0);
  for (let i = 0; i < 300 && counts()[0] < 2; i++) await frames(1);
  return counts();
})()`);
check('菜单里"开始""完成"两列各 11 个教程按钮', buttons[0] === 11 && buttons[1] === 11, buttons);

load('Raycasting');
const countBefore = count();

const broken: unknown[] = [];
for (const [label, marker] of TUTORIALS) {
  const start = load(label, 'start');
  if (!start.scene.includes('/Start-')) broken.push({ label, start });
  const completed = load(label);
  if (!completed.scene.includes('/Completed-') || (marker && !completed.lines.some((line) => marker.test(line)))) broken.push({ label, completed });
}
check('22 个教程场景都能加载，完成版的脚本打印出它的字', broken.length === 0, broken);

// —— UI：代码建的按钮写时间；编辑器做的输入框跟着改字、按钮清掉 ——
load('UI interaction');
type UI = { time: string; typed: string; cleared: string };
const ui = evaluate<UI>(`(async () => {
  for (let i = 0; i < 300 && !uiFind('ButtonByCode'); i++) await frames(1);
  await uiClick('ButtonByCode');
  const time = uiFind('TextBlockByCode').text;
  uiFind('MyEditText').text = 'Stride';
  await frames(2);
  const typed = uiFind('MyTextBlock').text;
  await uiClick('MyButton');
  return { time, typed, cleared: uiFind('MyTextBlock').text + '|' + uiFind('MyEditText').text };
})()`);
check('UI：点代码建的按钮显示时间；输入框的字写到文字上，按钮清掉', /^Date: \d\d:\d\d$/.test(ui.time) && ui.typed === 'My name is: Stride' && ui.cleared === '...|', ui);

// —— 碰撞触发器：球落进去、离开都有通知；空格把球送回空中再落一次 ——
load('Collision trigger');
const trigger = evaluate<string[]>(`tap('Space').then(async () => {
  const seen = new Set();
  // 按游戏时间等（最多 10 秒），不按帧数：无头 Chrome 的帧率随显卡的负载在 60 到 130 多之间变，球落地、睡着以后才报离开
  const start = strideGame.updateTime.total;
  while (strideGame.updateTime.total - start < 10 && !(seen.has('Ball entered CollisionTrigger') && seen.has('Ball left CollisionTrigger'))) { await frames(1); for (const l of lines()) seen.add(l); }
  return [...seen];
})`);
check('触发器：球进去、在里面、出来都打印', ['Ball entered CollisionTrigger', 'Inside the trigger: Ball', 'Ball left CollisionTrigger'].every((line) => trigger.includes(line)), trigger);

// —— 射线：两把"武器"左右各打一条，按层过滤；E 把武器抬高 ——
load('Raycasting');
type Rays = { single: string[]; all: string[]; raised: number; laser: number; distance: number };
const raysAt = (height: number) => evaluate<Rays>(`(async () => {
  const T = strideEngine.Transform, before = position('Raycast')[1];
  await hold('KeyE', 5);
  const raised = position('Raycast')[1] - before;
  for (const name of ['Raycast', 'RaycastPenetrating']) named(name)[0].require(T).position.y = ${height};
  await frames(3);
  return {
    single: lines().filter((l) => l.startsWith('Raycast hit entity')), all: lines().filter((l) => l.startsWith('- ') || l.includes('object(s)')), raised,
    laser: named('Raycast')[0].findChild('Laser').require(T).scale.z, distance: Number(lines().find((l) => l.startsWith('Raycast hit distance')).split(': ')[1]),
  };
})()`);
const top = raysAt(2.06), middle = raysAt(1.06);
check('射线：E 抬高武器；上排跳过触发器那一层打到后面的箱子，激光伸到命中的地方，穿透的射线两个都算',
  top.raised > 0 && top.single[0] === 'Raycast hit entity: LeftBox1 - Default' && Math.abs(top.laser - top.distance) < 1e-3 && top.distance > 2
  && top.all.join('|') === 'Raycast has hit 2 object(s)|- Raycast has hit: RightBox2 - Trigger|- Raycast has hit: RightBox1 - Default', top);
check('射线：中排普通的射线打到自定义层的箱子，穿透的射线排除了那一层',
  middle.single[0] === 'Raycast hit entity: LeftBox2 - Custom Filter' && middle.all.join('|') === 'Raycast has hit 1 object(s)|- Raycast has hit: RightBox1 - Default', middle);

// —— 投影和反投影：名字跟着球画在屏幕上；点地面克隆一个球 ——
load('Project & Unproject');
type Projected = { labels: [string, number[]][]; before: number; after: number };
const projected = evaluate<Projected>(`(async () => {
  const labels = strideGame.debugText.lines.map((l) => [l.text, [...l.position]]);
  const before = strideGame.entities.count;
  await click(640, 500);
  await frames(3);
  return { labels, before, after: strideGame.entities.count };
})()`);
const onScreen = projected.labels.length === 2 && projected.labels.every(([, [x, y]]) => x! > 0 && x! < 1280 && y! > 0 && y! < 720);
check('投影：Parent、Child 两个名字画在画面里；点地面多一个球', onScreen && projected.labels.map(([text]) => text).join() === 'Parent,Child' && projected.after === projected.before + 1, projected);

// —— 异步脚本：球进触发器变黄，出去变回来 ——
load('Async Scripts');
const yellow = evaluate<{ turned: number | null; back: number | null }>(`(async () => {
  const yellow = (await strideGame.content.loadMaterial('CSharpIntermediate/Materials/Yellow')).id;
  const isYellow = () => named('Ball')[0].require(strideEngine.Model).material === yellow;
  await tap('Space');
  let turned = null, back = null;
  for (let i = 0; i < 600 && back === null; i++) { await frames(1); if (turned === null) { if (isYellow()) turned = i; } else if (!isYellow()) back = i; }
  return { turned, back };
})()`);
check('异步脚本：球进触发器换成黄色的材质，出去换回来', yellow.turned !== null && yellow.back !== null, yellow);

// —— 场景：C 加载、卸载子场景；B 换到场景 B，A 换回来 ——
load('Scene loading');
type Scenes = { root: string; base: number; withChild: number; unloaded: number; childOffset: number[]; sceneB: string; linesB: string[]; back: string; backCount: number };
const scenes = evaluate<Scenes>(`(async () => {
  const root = () => strideGame.rootScene?.name, entities = () => strideGame.entities.count;
  const until = async (done) => { for (let i = 0; i < 300 && !done(); i++) await frames(1); await frames(3); };
  const r = { root: root(), base: entities() };
  await tap('KeyC'); await until(() => entities() !== r.base); r.withChild = entities();
  await tap('KeyC'); await frames(3); r.unloaded = entities();
  await tap('KeyC'); await until(() => entities() !== r.base);
  // 第二次加载的子场景往上抬 0.5：偏移在场景上，根实体的世界位置带着它，本地位置不带
  const moved = strideGame.entities.ids().map((i) => strideGame.entities.entity(i)).find((e) => e.ownScene && e.ownScene !== strideGame.rootScene && !e.require(strideEngine.Transform).parent);
  const t = moved.require(strideEngine.Transform);
  r.childOffset = [moved.ownScene.offset.y, +(t.world[13] - t.position.y).toFixed(4)];
  await tap('KeyB'); await until(() => root() !== r.root); r.sceneB = root(); r.linesB = lines();
  await tap('KeyA'); await until(() => root() !== r.sceneB); r.back = root(); r.backCount = entities();
  return r;
})()`);
check('场景：C 加载再卸载子场景；带着子场景换到场景 B、再换回 A，实体数回到原样',
  scenes.withChild > scenes.base && scenes.unloaded === scenes.base && scenes.childOffset.join() === '0.5,0.5' && scenes.sceneB === 'Completed-SceneB' && scenes.linesB.includes('Load scene-A, press: A')
  && scenes.back === scenes.root && scenes.backCount === scenes.base, scenes);

// —— 动画：E 加速，R 淡入跑步，P 出一拳后回到待机，S 暂停 ——
load('Animation basics');
type Playing = [name: string, weight: number, enabled: boolean, repeat: string][];
type Animation = { speed: string; fading: Playing; run: Playing; punch: Playing; paused: Playing; idle: Playing };
const animation = evaluate<Animation>(`(async () => {
  const component = named('AnimationBasics')[0].require(strideEngine.AnimationComponent);
  const playing = () => component.playingAnimations.map((p) => [p.name, p.weight, p.enabled, p.repeatMode]);
  // 按游戏时间等（seconds）：CI 的软件 WebGPU 上一帧几百毫秒，墙钟的 0.8 秒淡入还没走完。固定步长：帧慢时一帧走几百毫秒的
  // 游戏时间，淡入、出拳在一帧里就完了，看不到中间的状态（本机用 regress.ps1 -Slow 300 复现）。步长 1/30（出拳的淡入 0.1 秒
  // 还有三帧），等的都是"状态出现就往下走"：CI 上一帧几百毫秒，1/60 加固定的等待要三百多帧，超过 eval 的 120 秒
  const r = {};
  strideGame.fixedTimeStep = 1 / 30;
  try {
  await tap('KeyE'); r.speed = lines().find((l) => l.startsWith('Q and E'));
  // 淡入和出拳都是一会儿的状态：每帧看一次，记下第一次出现的那一刻（帧慢时隔几帧再看，淡入已经完了、拳已经出完了）
  const first = (want, s) => until(() => { const p = playing(); return p.map(([name]) => name).join() === want ? p : null; }, s).then((p) => p ?? playing());
  await tap('KeyR'); r.fading = await first('Idle,Run', 1);
  r.run = await first('Run', 1.5);
  await tap('KeyP'); r.punch = await first('Punch', 1);
  await tap('KeyS'); r.paused = playing(); await tap('KeyS');
  r.idle = await first('Idle', 3);
  } finally {
    strideGame.fixedTimeStep = undefined;
  }
  return r;
})()`);
const names = (playing: Playing) => playing.map(([name]) => name).join();
check('动画：E 加速到 1.1；R 从待机淡入跑步；P 出拳播一次；S 暂停；出完拳回到待机',
  animation.speed === 'Q and E for speed 1.1' && names(animation.fading) === 'Idle,Run' && names(animation.run) === 'Run'
  && names(animation.punch) === 'Punch' && animation.punch[0]![3] === 'playOnce' && animation.paused[0]![2] === false && names(animation.idle) === 'Idle', animation);

// —— 声音：空格放、停音乐，方向键调音量和声像；U 放尤克里里，右键放发射器上的枪声；听者跟着相机 ——
load('Audio');
type Audio = { playing: string; volume: string[]; paused: string; gun: string[]; listener: number[]; camera: number[] };
const audio = evaluate<Audio>(`(async () => {
  const find = (start) => lines().find((l) => l.startsWith(start));
  const r = {};
  // 等到显示 Playing：CI 的软件渲染上一帧几百毫秒，固定等 10 帧时有时还是 Stopped
  await tap('Space'); r.playing = await until(() => (find('Space')?.endsWith('Playing') ? find('Space') : null), 2) ?? \`\${find('Space')} (frame \${strideGame.frames})\`;
  // 放起来马上暂停，再调音量和声像：音乐只有 17 秒左右，CI 的软件渲染上一帧几百毫秒，先调音量再暂停时音乐已经放完（成了 Stopped）
  // 等到显示 Paused；没等到时结果里带上第几帧和音频上下文的状态
  await tap('Space'); r.paused = await until(() => (find('Space')?.endsWith('Paused') ? find('Space') : null), 2) ?? \`\${find('Space')} (frame \${strideGame.frames}, audio \${strideGame.audio.context.state})\`;
  await tap('ArrowUp'); await tap('ArrowLeft'); r.volume = [find('Up/Down'), find('Left/Right')];
  const gun = named('AudioDemo')[0].require(strideEngine.AudioEmitterComponent).controller('Gun');
  r.gun = [gun.playState];
  // 按着右键的时候看：帧慢时松开以后再看，枪声可能已经放完了
  r.gun.push(await click(640, 360, 2, () => until(() => gun.playState === 'playing', 1).then(() => gun.playState)));
  await tap('KeyU');
  const l = strideGame.audio.context.listener;
  r.listener = [l.positionX.value, l.positionY.value, l.positionZ.value];
  r.camera = position('Camera');
  return r;
})()`);
check('声音：音乐放、停，音量 1.1、声像 -0.1；右键放枪声；听者在相机的位置',
  audio.playing.endsWith('Playing') && audio.volume.join('|') === 'Up/Down to change volume: 1.1|Left/Right to change panning: -0.1' && audio.paused.endsWith('Paused')
  && audio.gun.join() === 'stopped,playing' && audio.listener.every((value, i) => Math.abs(value - audio.camera[i]!) < 1e-3), audio);

// —— 两个相机教程：角色绕 Y 的偏航、支点绕 X 的俯仰、角色的位置、第三人称相机的支点 ——
type Pose = { locked: boolean; yaw: number; pitch: number; position: number[]; camera: number[] };
const pose = (character: string, pivot: string) => evaluate<Pose>(`(() => {
  const angle = (q, axis) => 2 * Math.atan2(q[axis], q[3]);
  return {
    locked: strideGame.input.isMousePositionLocked, yaw: angle(rotation('${character}'), 1), pitch: angle(rotation('${pivot}'), 0),
    position: position('${character}'), camera: named('ThirdPersonPivot').length ? position('ThirdPersonPivot') : [],
  };
})()`);
// 锁鼠标、移动、按键都等游戏处理过（until、frames、holdFor 按游戏时间），不按墙钟等
const lock = async () => {
  stride('mouse', 'left', '--trusted');
  // 按游戏时间等：锁上了马上往下走，CI 上点击到锁定有时要好几帧
  stride('eval', 'until(() => strideGame.input.isMousePositionLocked, 10).then(() => frames(2)).then(() => 1)');
};
const move = async (dx: number, dy: number) => {
  stride('mouse', 'move', String(dx), String(dy));
  stride('eval', 'frames(3).then(() => 1)');
};
const hold = (code: string, s: number) => stride('eval', `holdFor('${code}', ${s}).then(() => 1)`);
const escape = () => stride('eval', `tap('Escape').then(() => 1)`);

// —— 第一人称相机：真实点击锁鼠标；鼠标转角色和相机的支点（灵敏度同 Stride），俯仰有上限；W 往看的方向走；Esc 解锁 ——
load('First person camera');
const first = () => pose('FirstPersonCharacter', 'CameraPivot');
const firstBefore = first();
await move(64, 0);
const unlocked = first();
await lock();
// 画布 1280×720：右移 64 像素是 0.05，乘 0.6 的速度，偏航 -0.03 弧度；下移 32 像素俯仰 +0.0267
await move(64, 32);
const looked = first();
check('第一人称：没锁鼠标时不转；真实点击锁定后鼠标转角色（偏航）和支点（俯仰）',
  !firstBefore.locked && Math.abs(unlocked.yaw - firstBefore.yaw) < 1e-5 && looked.locked
  && Math.abs(looked.yaw - firstBefore.yaw + 0.03) < 0.002 && Math.abs(looked.pitch - (32 / 720) * 0.6) < 0.002, { firstBefore, unlocked, looked });
hold('KeyW', 1);
const walked = first();
const dx = walked.position[0]! - looked.position[0]!, dz = walked.position[2]! - looked.position[2]!;
// 角色的前方是本地 +Z：偏航 θ 时朝 (sin θ, cos θ)，前进速度 4 米每秒
check('第一人称：W 往角色面对的方向走', Math.hypot(dx, dz) > 3 && Math.abs(Math.atan2(dx, dz) - looked.yaw) < 0.05, { dx, dz, yaw: looked.yaw });
await move(0, 3000);
const down = first();
check('第一人称：俯仰最多 50°', Math.abs(down.pitch - (50 * Math.PI) / 180) < 1e-3, down);
escape();
check('第一人称：Esc 解锁鼠标', !first().locked, first());

// —— 第三人称相机：相机在角色后面 3 米；退到墙边时不穿墙，退回第一人称的位置；离墙远一点时贴在墙前 ——
load('Third person camera');
const third = () => pose('ThirdPersonCharacter', 'FirstPersonPivot');
await lock();
await move(128, 0);
const turned = third();
check('第三人称：鼠标转角色，相机在后面 3 米', turned.locked && Math.abs(turned.yaw + 0.06) < 0.002 && turned.camera.join() === '0,0,-3', turned);
hold('KeyS', 2.5);
const atWall = third();
check('第三人称：退到墙边，相机退回第一人称的位置（Stride 的脚本在这里会穿墙）', atWall.position[2]! < -4 && atWall.camera.join() === '0,0,0', atWall);
hold('KeyW', 0.5);
const nearWall = third();
check('第三人称：往前走开一点，相机贴在墙前', nearWall.camera[2]! < -1.4 && nearWall.camera[2]! > -2.9, nearWall);
escape();

// —— 导航：点地面，角色沿寻到的路走过去，拐点上各放一个球，到了以后清掉 ——
load('Navigation');
type Navigation = { before: number; spheres: number; walking: string | undefined; start: number[]; end: number[]; after: number };
const navigation = evaluate<Navigation>(`(async () => {
  const r = { before: strideGame.entities.count, start: position('RegularCharacater') };
  // 导航网格在脚本启动时才开始建，建好之前点了找不到路
  // 次数和时长都按游戏时间算：帧慢时（CI 的软件 WebGPU）按帧数等会超过 eval 的两分钟
  for (const end = strideGame.updateTime.total + 20; strideGame.entities.count === r.before && strideGame.updateTime.total < end;) { await click(400, 420); await seconds(0.1); }
  r.spheres = strideGame.entities.count - r.before;
  r.walking = lines().find((l) => l.startsWith('Distance to waypoint'));
  // 等角色走到：按游戏时间最多 60 秒。物理每帧最多补 0.25 秒（maximumTimeToProcess），CI 上一帧要一秒左右时物理只有游戏时间的
  // 几分之一，15 秒不够（0c68a3f 的 CI 上走了 2 米就到点了）；快的机器上走到就返回
  await until(() => lines().includes('No target'), 60);
  return { ...r, end: position('RegularCharacater'), after: strideGame.entities.count };
})()`);
const travelled = Math.hypot(navigation.end[0]! - navigation.start[0]!, navigation.end[2]! - navigation.start[2]!);
check('导航：点地面后拐点上放了球，角色走到目标，球清掉', navigation.spheres >= 2 && navigation.walking !== undefined && travelled > 0.5 && navigation.after === navigation.before, navigation);

// 克隆出来的球、子场景、代码建的 UI 都跟着教程的场景销毁
load('Raycasting');
const countAfter = count();
check('换了一圈教程，实体数不变', countAfter === countBefore, { countBefore, countAfter });

finish();
