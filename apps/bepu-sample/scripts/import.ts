// 从 Stride 仓库导入 BepuSample 的主场景、七个演示场景和资源（加上 UI 用到的 Stride 自带的精灵表和字体），写进 public/content（不提交）。
// Stride 仓库默认在 ~/IdeaProjects/stride（和 ~/WebstormProjects 并列），可以用 STRIDE_REPO 改。
//   pnpm --filter @stride-ts/bepu-sample import:stride
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stride = process.env.STRIDE_REPO ?? path.resolve(app, '..', '..', '..', '..', 'IdeaProjects', 'stride');
const cli = path.resolve(app, '..', '..', 'packages', 'pipeline', 'src', 'cli.ts');

const SCENES = ['MainScene', 'Colliders', 'Constraint', 'Convex And Mesh Collider', 'Cube Fountain', 'Cube Mixer', 'Material Properties', 'Ropes'];
execFileSync(process.execPath, [
  cli, 'import-stride',
  '--package', `BepuSample=${path.join(stride, 'samples', 'Physics', 'BepuSample', 'Assets', 'Shared')}`,
  // UI 库用 Stride 自带的精灵表和默认字体
  '--stride', stride,
  ...SCENES.flatMap((scene) => ['--scene', `BepuSample/Scenes/${scene}`]),
  '--out', path.join(app, 'public', 'content'),
  '--textures', 'source',
], { stdio: 'inherit' });
