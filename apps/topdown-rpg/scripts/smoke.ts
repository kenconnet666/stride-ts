// TopDownRPG 的冒烟测试：对着正在运行的页面（开发服务器或 preview，`stride open` 打开的，1280x720），用调试 CLI 玩一遍。
//   pnpm --filter @stride-ts/topdown-rpg smoke [-- --hub <中枢名的一部分>]
// 检查：场景在跑、导航网格建好；点地面角色寻路走过去；鼠标指着箱子时高亮；点箱子走过去出拳，箱子碎掉、掉出金币；
// 掉落的金币和场景里的金币都能拾取（3 秒后移除）；背景音乐在放，箱子碎的时候有音效和粒子特效；出拳的碰撞体挂在右手上。DynamicScene：一开始加载中央的分块，走到东边的
// 触发器里加载东边的分块、离开中央时卸载它，角色一直站在地面上，导航网格跟着重建。
import { PAGE_HELPERS, startSmoke } from '../../../tools/smoke.ts';

const { stride, sleep, check, finish } = startSmoke('topdown-rpg');

stride('eval', 'location.reload()');
await sleep(1500);
stride('wait');
// 等待都按游戏时间和状态（tools/smoke.ts 的 until、seconds）：CI 的软件 WebGPU 上一帧要几百毫秒
stride('eval', PAGE_HELPERS);
stride('eval', 'until(() => strideGame.navigation.ready, 10)');
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
const walked = stride('eval', `(async () => { const start = ${JSON.stringify(start)}, now = () => (0, eval)(${JSON.stringify(PLAYER)});
  await until(() => Math.hypot(now()[0] - start[0], now()[2] - start[2]) > 2, 6); return now(); })()`) as Vec;
check('点地面：角色寻路走过去', Math.hypot(walked[0] - start[0], walked[2] - start[2]) > 2, { start, walked });

// 指着右下角的箱子：高亮实体换成箱子的模型、摆到箱子上
stride('mouse', 'move', '325', '105');
const highlight = stride('eval', `(() => { const scale = () => { ${BY} return by('Highlight')[0].require(strideEngine.Transform).scale.x; };
  return until(() => scale() > 0.5, 2).then(scale); })()`) as number;
check('鼠标指着箱子时高亮', highlight > 0.5, highlight);

const [crates, loot] = stride('eval', COUNTS) as Vec;
stride('eval', `globalThis.crateScripts = ${SCRIPTS('CrateScript')}; crateScripts.length`);
stride('mouse', 'left');
// 箱子一碎就数金币：金币掉在角色脚边，可能马上被捡起、3 秒后移除，隔久了数就少了
const afterPunch = stride('eval', `new Promise((resolve) => {
  const started = strideGame.updateTime.total;
  // 箱子被打到后 1.5 秒才移除，那时音效已经放完了：轮询的时候记着同时在响的最多有几个
  let sounding = 0, effects = 0;
  const live = () => strideGame.particles.components.reduce((sum, c) => sum + c.particleSystem.livingParticles, 0);
  const poll = () => { ${BY} sounding = Math.max(sounding, crateScripts.filter((s) => s.sfxInstance?.playState === 'playing').length);
    effects = Math.max(effects, live());
    const counts = [by('LootBox').length, by('LootGoldCoin').length, by('CoinGold').length, sounding, effects];
    if (counts[0] < ${crates} || strideGame.updateTime.total - started > 6) resolve(counts); else requestAnimationFrame(poll); };
  poll();
})`) as [crates: number, loot: number, coins: number, sounds: number, particles: number];
check('点箱子：走过去出拳，箱子碎掉、掉出金币', afterPunch[0] < crates && afterPunch[1] >= loot + 3, { before: [crates, loot], afterPunch });
check('箱子碎的时候放了音效', afterPunch[3] >= 1, afterPunch);
check('点击和箱子碎的时候有粒子特效', afterPunch[4] > 0, afterPunch);

// 走到金币上（瞬移过去）：拾取后 3 秒移除。箱子被角色碰到也会碎（同 Stride），所以只看这一枚金币
const TELEPORT = (target: string) => `${BY} const e = ${target}; const w = at(e); g.simulation.body(by('PlayerCharacter')[0]).teleport({ x: w[0], y: 0.05, z: w[2] }, { x: 0, y: 0, z: 0, w: 1 }); e.id`;
// 金币带着冲量飞出来，要等它停稳了再过去：还在滚的时候瞬移到它当时的位置会扑空。金币要是正好掉在角色脚边，等的时候就被
// 拾走、移除了（那也是拾到了）
const rested = stride('eval', `(async () => { ${BY} const coin = by('LootGoldCoin')[0];
  for (let i = 0, last = at(coin); i < 30; i++) {
    await seconds(0.1);
    if (!g.entities.isAlive(coin.id)) return 'picked';
    const now = at(coin);
    if (Math.hypot(now[0] - last[0], now[1] - last[1], now[2] - last[2]) < 0.005) break;
    last = now;
  }
  return 'resting'; })()`) as 'picked' | 'resting';
if (rested === 'picked') {
  check('拾取掉落的金币', true, rested);
} else {
  const lootCoin = stride('eval', TELEPORT(`by('LootGoldCoin')[0]`)) as number;
  stride('eval', `until(() => !strideGame.entities.isAlive(${lootCoin}), 6)`);
  check('拾取掉落的金币', stride('eval', `strideGame.entities.isAlive(${lootCoin})`) === false,
    // 没拾到时看角色和这枚金币各在哪
    stride('eval', `${BY} const e = g.entities.isAlive(${lootCoin}) ? g.entities.entity(${lootCoin}) : undefined;
      ({ player: at(by('PlayerCharacter')[0]).map((v) => +v.toFixed(2)), coin: e ? at(e).map((v) => +v.toFixed(2)) : null, children: e ? e.require(strideEngine.Transform).children.map((c) => [c.name, ...at(c).map((v) => +v.toFixed(2)), c.require(strideEngine.Transform).scale.x]) : null })`));
}

// 场景里的金币（静态的触发器）
const sceneCoin = stride('eval', TELEPORT(`by('CoinGold').find((e) => e.require(strideEngine.Transform).parent?.name !== 'LootGoldCoin')`)) as number;
stride('eval', `until(() => !strideGame.entities.isAlive(${sceneCoin}), 6)`);
check('拾取场景里的金币', stride('eval', `strideGame.entities.isAlive(${sceneCoin})`) === false, sceneCoin);

const punch = stride('eval', `${BY} const p = at(by('PunchCollision')[0]), m = at(by('MannequinModel')[0]); [p[1] - m[1], Math.hypot(p[0] - m[0], p[2] - m[2])]`) as [number, number];
check('出拳的碰撞体挂在右手上', punch[0] > 0.8 && punch[0] < 1.6 && punch[1] < 0.8, punch);

// DynamicScene：分块按触发器里的深度流式加载
stride('eval', `location.href = location.origin + '/?scene=DynamicScene'`);
await sleep(1500);
stride('wait');
stride('eval', PAGE_HELPERS);
const CHUNKS = `${BY} const [S] = g.registry.scriptsNamed('SceneStreaming');
  [g.entities.ids().map((i) => g.entities.entity(i)).filter((e) => e.get(S)?.instance).map((e) => e.get(S).instance.name).sort().join(','), at(by('PlayerCharacter')[0])[1], g.navigation.ready]`;
type Chunks = [string, number, boolean];
/** 等到分块是 expected（流式加载、卸载要几帧到几秒），再看一会儿角色站稳了没有。 */
const chunksBecome = (expected: string) => stride('eval', `(async () => { const chunks = () => (0, eval)(${JSON.stringify(CHUNKS)});
  await until(() => chunks()[0] === '${expected}' && chunks()[2], 20); await seconds(0.5); return chunks(); })()`) as Chunks;
const initial = chunksBecome('CentralChunk');
check('DynamicScene：一开始加载中央的分块，角色站在地上', initial[0] === 'CentralChunk' && initial[1] > -0.5 && initial[2], initial);
const MOVE = (x: number) => `${BY} g.simulation.body(by('PlayerCharacter')[0]).teleport({ x: ${x}, y: 0.1, z: 0 }, { x: 0, y: 0, z: 0, w: 1 }); 1`;
stride('eval', MOVE(-10));
const both = chunksBecome('CentralChunk,EasternChunk');
check('走到两块的交界：东边的分块也加载', both[0] === 'CentralChunk,EasternChunk', both);
stride('eval', MOVE(-18));
const east = chunksBecome('EasternChunk');
check('走进东边：中央的分块卸载，角色站在东边的地面上', east[0] === 'EasternChunk' && east[1] > -0.5, east);

finish();
