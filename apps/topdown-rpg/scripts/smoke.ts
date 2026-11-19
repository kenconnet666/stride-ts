// TopDownRPG 的冒烟测试：对着正在运行的页面（开发服务器或 preview，`stride open` 打开的，1280x720），用调试 CLI 玩一遍。
//   pnpm --filter @stride-ts/topdown-rpg smoke [-- --hub <中枢名的一部分>]
// 检查：场景在跑、导航网格建好；点地面角色寻路走过去；鼠标指着箱子时高亮；点箱子走过去出拳，箱子碎掉、掉出金币；
// 掉落的金币和场景里的金币都能拾取（3 秒后移除）；背景音乐在放，箱子碎的时候有音效和粒子特效；出拳的碰撞体挂在右手上。DynamicScene：一开始加载中央的分块，走到东边的
// 触发器里加载东边的分块、离开中央时卸载它，角色一直站在地面上，导航网格跟着重建。
import { startSmoke } from '../../../tools/smoke.ts';

const { stride, sleep, check, finish } = startSmoke('topdown-rpg');

stride('eval', 'location.reload()');
await sleep(1500);
stride('wait');
await sleep(2500);
const status = stride('status') as { status: string; error: string | null; entities: number };
check('场景在跑', status.status === 'running' && status.error === null && status.entities > 300, status);
check('导航网格建好', stride('eval', 'strideGame.navigation.ready') === true, null);
/** 页面里的表达式：这个类名的脚本的所有实例。 */
const SCRIPTS = (name: string) => `(() => { const g = strideGame, type = g.registry.scriptsNamed('${name}')[0]; return g.entities.ids().map((i) => g.entities.entity(i).get(type)).filter(Boolean); })()`;
const music = stride('eval', `${SCRIPTS('MusicScript')}.map((s) => [s.music.playState, s.music.isLooping])`) as [string, boolean][];
check('背景音乐循环播放', music.length === 1 && music[0]![0] === 'playing' && music[0]![1], music);

const BY = `const g = strideGame; const by = (n) => g.entities.ids().map((i) => g.entities.entity(i)).filter((e) => e.name === n);
  const at = (e) => { const w = e.require(strideEngine.Transform).world; return [w[12], w[13], w[14]]; };`;
const PLAYER = `${BY} at(by('PlayerCharacter')[0])`;
const COUNTS = `${BY} [by('LootBox').length, by('LootGoldCoin').length, by('CoinGold').length]`;
type Vec = [number, number, number];

// 点地面：画面中心偏右下（鼠标位置相对上一次，第一次从画布中心算）
const start = stride('eval', PLAYER) as Vec;
stride('mouse', 'move', '250', '120');
stride('mouse', 'left');
await sleep(3000);
const walked = stride('eval', PLAYER) as Vec;
check('点地面：角色寻路走过去', Math.hypot(walked[0] - start[0], walked[2] - start[2]) > 2, { start, walked });

// 指着右下角的箱子：高亮实体换成箱子的模型、摆到箱子上
stride('mouse', 'move', '325', '105');
await sleep(300);
const highlight = stride('eval', `${BY} by('Highlight')[0].require(strideEngine.Transform).scale.x`) as number;
check('鼠标指着箱子时高亮', highlight > 0.5, highlight);

const [crates, loot] = stride('eval', COUNTS) as Vec;
stride('eval', `globalThis.crateScripts = ${SCRIPTS('CrateScript')}; crateScripts.length`);
stride('mouse', 'left');
// 箱子一碎就数金币：金币掉在角色脚边，可能马上被捡起、3 秒后移除，隔久了数就少了
const afterPunch = stride('eval', `new Promise((resolve) => {
  const started = performance.now();
  // 箱子被打到后 1.5 秒才移除，那时音效已经放完了：轮询的时候记着同时在响的最多有几个
  let sounding = 0, effects = 0;
  const live = () => strideGame.particles.components.reduce((sum, c) => sum + c.particleSystem.livingParticles, 0);
  const poll = () => { ${BY} sounding = Math.max(sounding, crateScripts.filter((s) => s.sfxInstance?.playState === 'playing').length);
    effects = Math.max(effects, live());
    const counts = [by('LootBox').length, by('LootGoldCoin').length, by('CoinGold').length, sounding, effects];
    if (counts[0] < ${crates} || performance.now() - started > 6000) resolve(counts); else requestAnimationFrame(poll); };
  poll();
})`) as [crates: number, loot: number, coins: number, sounds: number, particles: number];
check('点箱子：走过去出拳，箱子碎掉、掉出金币', afterPunch[0] < crates && afterPunch[1] >= loot + 3, { before: [crates, loot], afterPunch });
check('箱子碎的时候放了音效', afterPunch[3] >= 1, afterPunch);
check('点击和箱子碎的时候有粒子特效', afterPunch[4] > 0, afterPunch);

// 走到金币上（瞬移过去）：拾取后 3 秒移除。箱子被角色碰到也会碎（同 Stride），所以只看这一枚金币
const TELEPORT = (target: string) => `${BY} const e = ${target}; const w = at(e); g.simulation.body(by('PlayerCharacter')[0]).teleport({ x: w[0], y: 0.05, z: w[2] }, { x: 0, y: 0, z: 0, w: 1 }); e.id`;
const lootCoin = stride('eval', TELEPORT(`by('LootGoldCoin')[0]`)) as number;
await sleep(3800);
check('拾取掉落的金币', stride('eval', `strideGame.entities.isAlive(${lootCoin})`) === false, lootCoin);

// 场景里的金币（静态的触发器）
const sceneCoin = stride('eval', TELEPORT(`by('CoinGold').find((e) => e.require(strideEngine.Transform).parent?.name !== 'LootGoldCoin')`)) as number;
await sleep(3800);
check('拾取场景里的金币', stride('eval', `strideGame.entities.isAlive(${sceneCoin})`) === false, sceneCoin);

const punch = stride('eval', `${BY} const p = at(by('PunchCollision')[0]), m = at(by('MannequinModel')[0]); [p[1] - m[1], Math.hypot(p[0] - m[0], p[2] - m[2])]`) as [number, number];
check('出拳的碰撞体挂在右手上', punch[0] > 0.8 && punch[0] < 1.6 && punch[1] < 0.8, punch);

// DynamicScene：分块按触发器里的深度流式加载
stride('eval', `location.href = location.origin + '/?scene=DynamicScene'`);
await sleep(1500);
stride('wait');
await sleep(3000);
const CHUNKS = `${BY} const [S] = g.registry.scriptsNamed('SceneStreaming');
  [g.entities.ids().map((i) => g.entities.entity(i)).filter((e) => e.get(S)?.instance).map((e) => e.get(S).instance.name).sort().join(','), at(by('PlayerCharacter')[0])[1], g.navigation.ready]`;
type Chunks = [string, number, boolean];
const initial = stride('eval', CHUNKS) as Chunks;
check('DynamicScene：一开始加载中央的分块，角色站在地上', initial[0] === 'CentralChunk' && initial[1] > -0.5 && initial[2], initial);
const MOVE = (x: number) => `${BY} g.simulation.body(by('PlayerCharacter')[0]).teleport({ x: ${x}, y: 0.1, z: 0 }, { x: 0, y: 0, z: 0, w: 1 }); 1`;
stride('eval', MOVE(-10));
await sleep(2000);
const both = stride('eval', CHUNKS) as Chunks;
check('走到两块的交界：东边的分块也加载', both[0] === 'CentralChunk,EasternChunk', both);
stride('eval', MOVE(-18));
await sleep(2000);
const east = stride('eval', CHUNKS) as Chunks;
check('走进东边：中央的分块卸载，角色站在东边的地面上', east[0] === 'EasternChunk' && east[1] > -0.5, east);

finish();
