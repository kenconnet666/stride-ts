// 用法：node profile-callers.cjs <profile.json> <函数名正则> [层数]
// 对调用栈上有匹配函数的每个采样，找出最外层匹配的调用者：谁进入了它、占多少。
const fs = require('fs');
const [file, pattern, frames = '1'] = process.argv.slice(2);
const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
const re = new RegExp(pattern);
const nodes = new Map(profile.nodes.map(n => [n.id, n])), parent = new Map();
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const by = new Map();
profile.samples.forEach((id, i) => {
  const t = (profile.timeDeltas[i + 1] ?? 0) / 1000;
  let outer = null;
  for (let p = id; p !== undefined; p = parent.get(p)) if (re.test(nodes.get(p).callFrame.functionName)) outer = p;
  if (outer === null) return;
  const chain = []; for (let p = parent.get(outer); p !== undefined && chain.length < +(process.env.DEPTH ?? 3); p = parent.get(p)) chain.push(nodes.get(p).callFrame.functionName.slice(0, +(process.env.WIDTH ?? 110)));
  const k = chain.join(' <- ');
  by.set(k, (by.get(k) ?? 0) + t);
});
for (const [k, v] of [...by].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log((v / +frames).toFixed(2).padStart(7), k);
