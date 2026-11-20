// 从 Stride 仓库导入 Third Person Platformer 的场景和它用到的资源包，写进 public/content（不提交）。
// content-overrides/ 里是代替源图片的文件（棋盘格贴图的 SVG 版，每张不到 1 KB）；其余贴图复制 PNG 源文件。
// Stride 仓库默认在 ~/IdeaProjects/stride，可以用 STRIDE_REPO 改。
//   pnpm --filter @stride-ts/platformer import:stride
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stride = process.env.STRIDE_REPO ?? path.join(os.homedir(), 'IdeaProjects', 'stride');
const templates = path.join(stride, 'samples', 'Templates');
const cli = path.resolve(app, '..', '..', 'packages', 'pipeline', 'src', 'cli.ts');

execFileSync(process.execPath, [
  cli, 'import-stride',
  '--package', `ThirdPersonPlatformer=${path.join(templates, 'ThirdPersonPlatformer', 'ThirdPersonPlatformer', 'Assets')}`,
  '--package', `PrototypingBlocks=${path.join(templates, 'Packs', 'PrototypingBlocks', 'Assets')}`,
  '--package', `mannequinModel=${path.join(templates, 'Packs', 'mannequinModel', 'Assets')}`,
  '--scene', 'ThirdPersonPlatformer/MainScene',
  '--out', path.join(app, 'public', 'content'),
  '--overrides', path.join(app, 'content-overrides'),
  // 没有覆盖文件的贴图（人物的两张法线贴图）复制 PNG 源文件，由浏览器解码：编成 KTX2 只省 83 KB，却要多下载
  // 339 KB（brotli）的贴图转码侧模块
  '--textures', 'source',
], { stdio: 'inherit' });
