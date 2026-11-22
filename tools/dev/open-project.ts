// 用编辑器后端打开一个工程：同步资源包、补烘停着时改了的或者缺了的生成模型（包装、货架这类不进 git 的），生成资源句柄。
//   node tools/dev/open-project.ts apps/<工程>
import path from 'node:path';
import { EditorBackend } from '../../packages/editor/src/server/EditorBackend.ts';

const root = path.resolve(process.argv[2] ?? '.');
const start = performance.now();
await EditorBackend.open(root, path.join(root, 'public'));
console.log(`opened ${root} in ${Math.round(performance.now() - start)} ms`);
process.exit(0);
