// 编辑器验收（一个样例）：在 stride open 起的 Chrome 里开着的编辑器上，经 CDP 操作编辑器的会话——打开根场景、逐个实体画属性
// 面板、不改就保存（应逐字节不变）、改（移动、改名、加子实体和脚本、复制粘贴、撤销到底再重做）、保存、重新打开、打开其他场景、
// 试玩。没有场景的游戏（画面全是根渲染器的）只查打开后属性面板里是游戏设置、没有报错。结果写成 <out>/<样例>.json 和几张截图。一般经 run.ps1 跑（它管内容目录的备份、开发服务器和 Chrome），见 README.md。
//   node tools/editor-accept/accept.ts <样例> <开发服务器端口> <输出目录>
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CdpSession, pageTarget } from '../../packages/cli/src/chrome.ts';
import { readBrowser } from '../../packages/cli/src/state.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const [app, port, outDir] = process.argv.slice(2) as [string, string, string];
if (!app || !port || !outDir) throw new Error('usage: node tools/editor-accept/accept.ts <app> <port> <out dir>');
mkdirSync(outDir, { recursive: true });
const content = path.join(root, 'apps', app, 'public', 'content');
const browser = readBrowser();
if (!browser) throw new Error('no browser (stride open first)');
const cdp = await CdpSession.connect((await pageTarget(browser, `http://localhost:${port}/__stride/editor/`)).webSocketDebuggerUrl);

const problems: string[] = [];
let phase = 'start';
const IGNORE = /ResizeObserver loop|Download the Vue Devtools|\[vite\]|stride-ts native|WebGPU|powerPreference/;
cdp.on('Runtime.exceptionThrown', (params) => {
  const details = (params as { exceptionDetails: { text: string; exception?: { description?: string } } }).exceptionDetails;
  const text = details.exception?.description ?? details.text;
  if (!IGNORE.test(text)) problems.push(`[${phase}] exception: ${text.split('\n').slice(0, 3).join(' | ')}`);
});
cdp.on('Runtime.consoleAPICalled', (params) => {
  const { type, args } = params as { type: string; args: { value?: unknown; description?: string }[] };
  if (type !== 'error' && type !== 'warning') return;
  const text = args.map((arg) => String(arg.value ?? arg.description ?? '')).join(' ');
  if (!IGNORE.test(text)) problems.push(`[${phase}] ${type}: ${text.split('\n').slice(0, 2).join(' | ').slice(0, 400)}`);
});
await cdp.send('Runtime.enable');

async function evaluate<T>(expression: string, timeout = 120_000): Promise<T> {
  const result = (await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, Math.max(timeout, 240_000))) as { result: { value?: T }; exceptionDetails?: { exception?: { description?: string }; text: string } };
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value as T;
}
const shot = async (name: string) => {
  const { data } = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
  writeFileSync(path.join(outDir, `${app}-${name}.png`), Buffer.from(data, 'base64'));
};
const sha = (file: string) => createHash('sha1').update(readFileSync(file)).digest('hex');

// 页面里的帮手：会话、等待
const HELPERS = `
  const session = () => document.querySelector('#app')?.__vue_app__?._instance?.props?.session;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const ready = async (timeout = 180000) => {
    const end = Date.now() + timeout;
    for (;;) {
      const s = session();
      // 没有场景的游戏（sprite-fonts、custom-effect）：不开文档，属性面板里是游戏设置
      if (s?.agent.value && (s.opened.value || s.inspected.value?.kind === 'gameSettings')) return s;
      if (Date.now() > end) throw new Error('editor did not open a scene: ' + (document.querySelector('iframe') ? (document.body.innerText.match(/(the game[^\\n]*|no scene[^\\n]*|[^\\n]*Error[^\\n]*)/) ?? [''])[0] : 'no viewport'));
      await wait(200);
    }
  };
  /** 一个个选中实体，让属性面板画一遍（出错会进控制台）。 */
  const sweep = async (limit = 400) => {
    const s = session();
    const ids = s.expanded.map((e) => e.id).slice(0, limit);
    for (const id of ids) { s.select([id]); await wait(15); }
    // 多选全部顶层的
    s.select(s.expanded.filter((e) => e.parent === null).map((e) => e.id)); await wait(100);
    s.select([]);
    return ids.length;
  };
`;
const run = <T>(body: string, timeout?: number) => evaluate<T>(`(async () => { ${HELPERS} ${body} })()`, timeout);

const report: Record<string, unknown> = { app };
try {
  phase = 'open';
  await cdp.send('Page.reload');
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const sceneless = await run<{ settings: string; fields: number } | null>(`
    const s = await ready();
    if (s.opened.value) return null;
    await wait(1500);
    return { settings: s.inspected.value.path, fields: Object.keys(s.inspected.value.content ?? {}).length };`);
  if (sceneless) {
    // 没有场景的游戏：编辑器打开、属性面板显示游戏设置、没有报错就算过（场景的那几步不适用）
    Object.assign(report, { sceneless });
    await shot('open');
    report['problems'] = problems;
    report['passed'] = problems.length === 0 && sceneless.fields > 0;
    writeFileSync(path.join(outDir, `${app}.json`), JSON.stringify(report, null, 1));
    console.log(JSON.stringify(report, null, 1));
    process.exit(0);
  }
  const opened = await run<{ scene: string; entities: number; expanded: number; scenes: string[]; scripts: string[] }>(`
    const s = await ready();
    await wait(1500);
    return { scene: s.opened.value.path, entities: s.file.entities.length, expanded: s.expanded.length,
      // 世界的格子场景（几百上千个）经世界视图看，不在这里一个个打开
      scenes: (() => {
        const worlds = s.assets.value.filter((a) => a.kind === 'world').map((a) => a.path + '/');
        return s.assets.value.filter((a) => a.kind === 'scene' && !worlds.some((w) => a.path.startsWith(w))).map((a) => a.path);
      })(), scripts: s.agent.value.scriptTypes() };`);
  Object.assign(report, opened);
  const sceneFile = path.join(content, `${opened.scene}.scene.json`);
  const original = sha(sceneFile);
  await shot('open');

  phase = 'sweep';
  report['swept'] = await run<number>('await ready(); return await sweep();', 300_000);

  // 不改就保存：文件逐字节不变（编辑器写的格式和导入器的一样）
  phase = 'save-unchanged';
  await run('const s = await ready(); await s.save(); return true;');
  report['saveUnchangedIdentical'] = sha(sceneFile) === original;
  if (!report['saveUnchangedIdentical']) problems.push('[save-unchanged] saving the untouched scene changed the file');

  phase = 'edit';
  const edit = await run<{ target: string; added: string; pasted: string[]; script?: string; count: number; undoCount: number }>(`
    const s = await ready();
    const top = s.expanded.filter((e) => e.parent === null && !s.isMember(e.id));
    const target = top.find((e) => e.components.model) ?? top[0];
    s.select([target.id]); await wait(100);
    s.apply({ type: 'set', entity: target.id, path: ['position'], value: [target.position[0], target.position[1] + 1, target.position[2]] }); s.commit();
    s.apply({ type: 'set', entity: target.id, path: ['name'], value: target.name + ' (edited)' }); s.commit();
    await s.addEntity(target.id);
    const added = s.selection.value[0];
    s.apply({ type: 'set', entity: added, path: ['name'], value: 'Acceptance child' }); s.commit();
    s.select([target.id]); s.copySelection(); await s.paste();
    const pasted = [...s.selection.value];
    // 加的脚本挑没有必填属性、不要求别的组件的（加到空实体上不该报错）；没有这样的就不加
    const script = s.agent.value.scriptTypes().find((type) => s.agent.value.requiredComponents(type).length === 0 && (s.agent.value.scriptFields(type) ?? []).every((field) => field.optional));
    if (script) {
      const scripts = s.file.entities.find((e) => e.id === added).components.scripts ?? [];
      s.apply({ type: 'set', entity: added, path: ['components', 'scripts'], value: [...scripts, { type: script, props: {} }] }); s.commit();
    }
    await wait(800);
    // 撤销到底再重做到底：回得去、做得回来
    let undoCount = 0;
    while (s.canUndo && undoCount < 50) { s.undo(); undoCount++; }
    const back = s.file.entities.length;
    while (s.canRedo) s.redo();
    await wait(800);
    return { target: target.id, added, pasted, script, count: s.file.entities.length, undoCount, back };`);
  Object.assign(report, { edit });
  await shot('edited');
  report['saveNotice'] = await run<string>(`const s = await ready(); await s.save(); s.select([${JSON.stringify(edit.added)}]); await wait(500); return s.notice.value;`);
  await shot('required');
  const saved = JSON.parse(readFileSync(sceneFile, 'utf8')) as { entities: { id: string; name: string; parent: string | null; components: { scripts?: { type: string }[] } }[] };
  const savedTarget = saved.entities.find((entity) => entity.id === edit.target);
  const savedChild = saved.entities.find((entity) => entity.id === edit.added);
  report['savedOk'] = Boolean(savedTarget?.name.endsWith('(edited)') && savedChild?.parent === edit.target && edit.pasted.every((id) => saved.entities.some((entity) => entity.id === id)) && (!edit.script || savedChild?.components.scripts?.some((script) => script.type === edit.script)));
  if (!report['savedOk']) problems.push('[save] the saved file is missing the edits');

  phase = 'reopen';
  await cdp.send('Page.reload');
  await new Promise((resolve) => setTimeout(resolve, 3000));
  report['reopened'] = await run<{ count: number; child: boolean }>(`
    const s = await ready(); await wait(1500);
    return { count: s.file.entities.length, child: s.file.entities.some((e) => e.id === ${JSON.stringify(edit.added)} && e.parent === ${JSON.stringify(edit.target)}) };`);

  // 别的场景
  phase = 'other-scenes';
  // 别的场景最多开 12 个（每个要几秒）
  const others = opened.scenes.filter((scene) => scene !== opened.scene).slice(0, 12);
  report['otherScenes'] = [];
  for (const scene of others) {
    phase = `scene ${scene}`;
    try {
      const result = await run<{ entities: number; swept: number }>(`
        const s = await ready(); await s.openAsset({ kind: 'scene', path: ${JSON.stringify(scene)} }); await wait(2500);
        return { entities: s.file.entities.length, swept: await sweep(200) };`, 300_000);
      (report['otherScenes'] as unknown[]).push({ scene, ...result });
      await shot(`scene-${scene.replace(/[\\/]/g, '_')}`);
    } catch (error) {
      problems.push(`[${phase}] ${(error as Error).message.split('\n')[0]}`);
    }
  }
  if (others.length > 0) await run(`const s = await ready(); await s.openAsset({ kind: 'scene', path: ${JSON.stringify(opened.scene)} }); await wait(1500); return 1;`);

  phase = 'play';
  await run(`document.querySelector('button[aria-label="试玩"]').click(); return 1;`);
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  report['play'] = await run<{ running: boolean; hasEdit: boolean }>(`
    const win = document.querySelector('iframe').contentWindow; const g = win.strideGame;
    if (!g?.rootScene) return { running: false, hasEdit: false };
    const names = []; const visit = (scene) => { for (const e of scene.entities.values()) names.push(e.name); for (const child of scene.children ?? []) visit(child); };
    visit(g.rootScene);
    return { running: true, hasEdit: names.includes('Acceptance child') };`);
  await shot('play');
  phase = 'stop';
  await run(`document.querySelector('button[aria-label="停止试玩"]').click(); return 1;`);
  await new Promise((resolve) => setTimeout(resolve, 2000));
} catch (error) {
  problems.push(`[${phase}] FAILED: ${(error as Error).message.split('\n').slice(0, 3).join(' | ')}`);
}
report['problems'] = problems;
report['passed'] = problems.length === 0 && report['saveUnchangedIdentical'] === true && report['savedOk'] === true && (report['play'] as { running?: boolean; hasEdit?: boolean } | undefined)?.hasEdit === true;
writeFileSync(path.join(outDir, `${app}.json`), JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
process.exit(0);
