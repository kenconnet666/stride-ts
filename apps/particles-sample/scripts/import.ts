// 从 Stride 仓库导入 ParticlesSample 样例的七个场景和资源，写进 public/content（不提交）。
// Stride 仓库默认在 ~/IdeaProjects/stride（和 ~/WebstormProjects 并列），可以用 STRIDE_REPO 改。
//   pnpm --filter @stride-ts/particles-sample import:stride
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stride = process.env.STRIDE_REPO ?? path.resolve(app, '..', '..', '..', '..', 'IdeaProjects', 'stride');
const cli = path.resolve(app, '..', '..', 'packages', 'pipeline', 'src', 'cli.ts');
const scenes = ['MainScene', 'AnimatedParticles', 'ChildParticles', 'CustomMaterials', 'CustomParticles', 'Lasers', 'RibbonParticles'];

execFileSync(process.execPath, [
  cli, 'import-stride',
  '--package', `ParticlesSample=${path.join(stride, 'samples', 'Particles', 'ParticlesSample', 'Assets')}`,
  ...scenes.flatMap((scene) => ['--scene', `ParticlesSample/Shared/${scene}`]),
  '--out', path.join(app, 'public', 'content'),
], { stdio: 'inherit' });
