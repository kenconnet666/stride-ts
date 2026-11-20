// 从 Stride 仓库导入 SpaceEscape 样例：游戏设置、主场景 Scene 和关卡块的场景 LevelBlocks（BackgroundScript 运行时加载它，
// 取出各段关卡的实体），连同它们引用的模型、骨架、动画、材质、贴图、精灵表、字体，写进 public/content（不提交）。
// Stride 仓库默认在 ~/IdeaProjects/stride，可以用 STRIDE_REPO 改。
//   pnpm --filter @stride-ts/space-escape import:stride
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stride = process.env.STRIDE_REPO ?? path.join(os.homedir(), 'IdeaProjects', 'stride');
const cli = path.resolve(app, '..', '..', 'packages', 'pipeline', 'src', 'cli.ts');

execFileSync(process.execPath, [
  cli, 'import-stride',
  '--package', `SpaceEscape=${path.join(stride, 'samples', 'Games', 'SpaceEscape', 'Assets')}`,
  '--asset', 'SpaceEscape/Shared/GameSettings',
  '--scene', 'SpaceEscape/Shared/Scene',
  '--scene', 'SpaceEscape/Shared/LevelBlocks',
  '--out', path.join(app, 'public', 'content'),
], { stdio: 'inherit' });
