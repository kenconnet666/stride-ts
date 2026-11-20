// 照编辑器的字段描述（engine 的 editor/fields.ts 的 checkEntity）检查每个样例的全部场景、预制体文件：属性面板照这份描述画控件，
// 描述和文件对不上时面板会显示不了或者改出坏文件。不开浏览器。
//   node tools/editor-accept/check-fields.ts [样例...]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkEntity } from '../../packages/engine/src/editor/fields.ts';
import type { SceneEntityFile } from '../../packages/engine/src/content/format.ts';

const apps = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../apps');
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const full = path.join(dir, name);
  return statSync(full).isDirectory() ? walk(full) : /\.(scene|prefab)\.json$/.test(name) ? [full] : [];
});

const wanted = process.argv.slice(2);
let failed = false;
for (const app of readdirSync(apps)) {
  if (wanted.length > 0 && !wanted.includes(app)) continue;
  const content = path.join(apps, app, 'public', 'content');
  try {
    statSync(content);
  } catch {
    continue;
  }
  const files = walk(content);
  const issues: string[] = [];
  let entities = 0;
  for (const file of files) {
    for (const entity of (JSON.parse(readFileSync(file, 'utf8')) as { entities: SceneEntityFile[] }).entities) {
      entities++;
      for (const issue of checkEntity(entity)) issues.push(`${path.relative(content, file)}: ${issue}`);
    }
  }
  console.log(`${app}: ${files.length} files, ${entities} entities, ${issues.length} issues`);
  for (const issue of issues.slice(0, 20)) console.log(`  ${issue}`);
  if (issues.length > 0) failed = true;
}
process.exit(failed ? 1 : 0);
