// 从 Stride 仓库导入 SpriteFonts 样例的字体，写进 public/content（不提交）。样例没有场景，字体是合成器里 FontRenderer 的属性。
// Stride 仓库默认在 ~/IdeaProjects/stride（和 ~/WebstormProjects 并列），可以用 STRIDE_REPO 改。
//   pnpm --filter @stride-ts/sprite-fonts import:stride
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stride = process.env.STRIDE_REPO ?? path.resolve(app, '..', '..', '..', '..', 'IdeaProjects', 'stride');
const cli = path.resolve(app, '..', '..', 'packages', 'pipeline', 'src', 'cli.ts');
export const FONTS = ['StaticFont', 'DynamicFont', 'BoldFont', 'ItalicFont', 'AliasedFont', 'AntialiasedFont', 'ClearTypeFont', 'JapaneseFont', 'TimesNewRoman', 'HeaderFont'];

execFileSync(process.execPath, [
  cli, 'import-stride',
  '--package', `SpriteFonts=${path.join(stride, 'samples', 'Graphics', 'SpriteFonts', 'Assets')}`,
  ...FONTS.flatMap((font) => ['--asset', `SpriteFonts/Shared/${font}`]),
  '--out', path.join(app, 'public', 'content'),
  '--textures', 'source',
], { stdio: 'inherit' });
