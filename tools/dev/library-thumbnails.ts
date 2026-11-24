// 编辑器材质库、特效库的缩略图（packages/editor/src/library/thumbnails/<id>.webp）：用引擎真的画出来。库里的预设变了重跑一遍。
//   node tools/dev/library-thumbnails.ts [--only <id>[,<id>]] [--size 128]
// 借 greybox 的开发服务器（没开就开一个，用完 pwsh tools/stop-dev.ps1 停）：库里的材质和一个球的模型临时写进它的内容目录
// （Materials/Library、Models/LibrarySphere，跑完删掉），在自己的无头 Chrome 里打开游戏页面，每个预设换一个现拼的根场景
// （相机、太阳、天空照 greybox 的主场景；材质是一个球（智能材质是斜放的方块），特效是原点上的粒子系统、暗背景），等画面稳下来用引擎的截图命令截一帧，
// 页面里缩小、存成 WebP。
import { execSync, spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { LIBRARY_EFFECTS, LIBRARY_MATERIALS, libraryAssetName, libraryMaterialPath } from '@stride-ts/editor/library';

process.env['STRIDE_BROWSER_DIR'] = path.join(homedir(), '.stride-ts', 'library-thumbnails');
const { CdpSession, closeBrowser, openUrl, pageTarget } = await import('@stride-ts/cli/chrome');

const root = path.resolve(import.meta.dirname, '..', '..');
const content = path.join(root, 'apps/greybox/public/content');
const out = path.join(root, 'packages/editor/src/library/thumbnails');
const PORT = 5228, URL_ = `http://localhost:${PORT}/`;
const option = (name: string) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
};
const only = option('--only')?.split(',');
const size = Number(option('--size') ?? 128);

interface SceneEntity { readonly name: string; readonly position: number[]; readonly rotation: number[]; readonly components: Record<string, unknown> }
const main = JSON.parse(await readFile(path.join(content, 'MainScene.scene.json'), 'utf8')) as { compositor: unknown; entities: SceneEntity[] };
const named = (name: string) => main.entities.find((candidate) => candidate.name === name)!;
const component = (entity: string, key: string) => named(entity).components[key];

let id = 0;
const entity = (name: string, position: number[], rotation: number[], components: Record<string, unknown>) => ({ id: `thumb-${++id}`, name, parent: null, position, rotation, scale: [1, 1, 1], components });
/** 绕 x 轴转 angle 弧度的四元数（相机往下看一点）。 */
const pitch = (angle: number) => [Math.sin(angle / 2), 0, 0, Math.cos(angle / 2)];

/** 绕 y 轴转 angle 弧度、再绕 x 轴转 tilt 弧度的四元数（智能材质的方块斜着放，三个面、棱都看得见）。 */
const turned = (angle: number, tilt: number) => {
  const [sy, cy, sx, cx] = [Math.sin(angle / 2), Math.cos(angle / 2), Math.sin(tilt / 2), Math.cos(tilt / 2)];
  return [cy * sx, sy * cx, -sy * sx, cy * cx];
};

/**
 * 材质：天空下一个球，相机正对着、略往下看。玻璃类的球后面摆三个彩色的方块，看得出透过去、折射的样子。智能材质（按棱边、缝、
 * 遮蔽长出磨损和脏污）换成斜放的方块、底下垫一块板，开着环境光遮蔽（规则读它）。
 */
const materialScene = (material: string, backdrop: boolean, smart: boolean) => ({
  name: 'LibraryThumbnail',
  compositor: smart ? { ...(main.compositor as { postEffects?: object }), postEffects: { ...(main.compositor as { postEffects?: object }).postEffects, ambientOcclusion: { radius: 0.3 } } } : main.compositor,
  entities: (() => {
    const sun = entity('Sun', named('Sun').position, named('Sun').rotation, { light: component('Sun', 'light') });
    return [
      entity('Camera', [0, 0.35, 1.55], pitch(-0.2), { camera: { ...(component('Camera', 'camera') as object), verticalFieldOfView: 40 } }),
      sun,
      // 物理天空按 id 认太阳
      entity('Sky', [0, 0, 0], [0, 0, 0, 1], { skyAtmosphere: { ...(component('Sky', 'skyAtmosphere') as object), sun: sun.id } }),
      ...(smart
        ? [
          entity('Block', [0, 0.02, 0], turned(0.6, 0.35), { model: { model: 'Models/LibraryCube', materials: [material] } }),
          entity('Plate', [0, -0.42, 0], [0, 0, 0, 1], { model: { model: 'Models/LibraryPlate', materials: [material] } }),
        ]
        : [entity('Ball', [0, 0, 0], [0, 0, 0, 1], { model: { model: 'Models/LibrarySphere', materials: [material] } })]),
      ...(backdrop ? (['carPaint', 'gold', 'glossyPlastic'] as const).map((behind, i) =>
        entity(`Backdrop ${i}`, [(i - 1) * 0.42, -0.05, -0.9], [0, 0, 0, 1], { model: { model: 'Models/LibraryBox', materials: [libraryMaterialPath(behind)] } })) : []),
    ];
  })(),
});

/** 特效：暗背景、原点上的粒子系统，相机看着它的中段。 */
const effectScene = (particleSystem: unknown) => ({
  name: 'LibraryThumbnail', compositor: { ...(main.compositor as object), clearColor: [0.04, 0.045, 0.06, 1] },
  entities: [
    entity('Camera', [0, 0.9, 2.4], pitch(-0.1), { camera: { ...(component('Camera', 'camera') as object), verticalFieldOfView: 45 } }),
    entity('Ambient', [0, 0, 0], [0, 0, 0, 1], { light: { type: 'ambient', color: [1, 1, 1], intensity: 0.3 } }),
    entity('Effect', [0, 0, 0], [0, 0, 0, 1], { particleSystem }),
  ],
});

/** 页面里：换根场景，等游戏时间走 wait 秒，截一帧，缩成 size² 的 WebP（base64）。 */
const capture = (scene: object, wait: number) => `(async () => {
  const game = globalThis.strideGame;
  await game.setRootScene(${JSON.stringify(scene)});
  const until = game.updateTime.total + ${wait};
  while (game.updateTime.total < until) await new Promise((resolve) => requestAnimationFrame(resolve));
  const { png } = await game.debug.run('screenshot');
  const bitmap = await createImageBitmap(await (await fetch('data:image/png;base64,' + png)).blob());
  // 截图是横的：取中间的正方形缩小
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = new OffscreenCanvas(${size}, ${size});
  const context = canvas.getContext('2d');
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, ${size}, ${size});
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.85 });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
})()`;

const portOpen = async () => fetch(URL_).then(() => true, () => false);
if (!(await portOpen())) {
  spawn('pnpm -F @stride-ts/greybox dev', { cwd: root, shell: true, detached: true, stdio: 'ignore', env: { ...process.env, STRIDE_BAKE_ON_OPEN: 'wait' } }).unref();
  for (let i = 0; i < 60 && !(await portOpen()); i++) await new Promise((resolve) => setTimeout(resolve, 1000));
}

const written: string[] = [];
const write = async (file: string, value: unknown) => {
  const absolute = path.join(content, file);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, JSON.stringify(value, null, 1));
  written.push(absolute);
};
await write('Models/LibrarySphere.model', { format: 1, procedural: { type: 'sphere', radius: 0.5, tessellation: 64 }, materials: [] });
await write('Models/LibraryBox.model', { format: 1, procedural: { type: 'cube', size: [0.36, 0.8, 0.36] }, materials: [] });
await write('Models/LibraryCube.model', { format: 1, procedural: { type: 'cube', size: [0.55, 0.55, 0.55] }, materials: [] });
await write('Models/LibraryPlate.model', { format: 1, procedural: { type: 'cube', size: [1.6, 0.08, 1.6] }, materials: [] });
for (const { id: itemId, material } of LIBRARY_MATERIALS) await write(`${libraryMaterialPath(itemId)}.material.json`, material);

await mkdir(out, { recursive: true });
await closeBrowser();
const browser = await openUrl(URL_, { headless: true, size: [480, 320], dpr: 1 });
try {
  const cdp = await CdpSession.connect((await pageTarget(browser, URL_)).webSocketDebuggerUrl);
  const evaluate = async (expression: string) => {
    const reply = (await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })) as { result: { value?: unknown }; exceptionDetails?: { exception?: { description?: string } } };
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? 'evaluation failed');
    return reply.result.value;
  };
  for (let i = 0; i < 120 && !(await evaluate('Boolean(globalThis.strideGame?.rootScene)')); i++) await new Promise((resolve) => setTimeout(resolve, 500));
  const items = [
    ...LIBRARY_MATERIALS.map((item) => ({ id: item.id, scene: materialScene(libraryMaterialPath(item.id), item.category === 'glass', item.category === 'smart'), wait: 0.5 })),
    ...LIBRARY_EFFECTS.map((item) => ({ id: item.id, scene: effectScene(item.particleSystem), wait: 2 })),
  ].filter((item) => !only || only.includes(item.id));
  for (const item of items) {
    const start = performance.now();
    const webp = Buffer.from(String(await evaluate(capture(item.scene, item.wait))), 'base64');
    await writeFile(path.join(out, `${item.id}.webp`), webp);
    console.log(`${item.id} (${libraryAssetName(item.id)}): ${webp.length} bytes, ${Math.round(performance.now() - start)} ms`);
  }
} finally {
  await closeBrowser();
  for (const file of written) await rm(file, { force: true });
  await rm(path.join(content, 'Materials/Library'), { recursive: true, force: true });
  execSync('git status --short apps/greybox', { cwd: root, stdio: 'inherit' });
}
process.exit(0);
