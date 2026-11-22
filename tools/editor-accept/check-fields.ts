// 照编辑器的字段描述（engine 的 editor/fields/index.ts 的 checkEntity、SCENE_FIELDS）检查每个样例的全部场景、预制体文件（实体和场景的设置）：属性面板照这份描述画控件，
// 描述和文件对不上时面板会显示不了或者改出坏文件。不开浏览器。
//   node tools/editor-accept/check-fields.ts [样例...]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkEntity, checkFields, SCENE_FIELDS } from '../../packages/engine/src/editor/fields/index.ts';
import type { SceneEntityFile } from '../../packages/engine/src/content/formats/format.ts';
import { SCENE_SETTING_KEYS } from '../../packages/engine/src/editor/SceneDocument.ts';

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
    const json = JSON.parse(readFileSync(file, 'utf8')) as { entities: SceneEntityFile[] } & Record<string, unknown>;
    for (const entity of json.entities) {
      entities++;
      for (const issue of checkEntity(entity)) issues.push(`${path.relative(content, file)}: ${issue}`);
    }
    // 场景自己的设置（物理、导航、偏移、合成器）
    for (const key of SCENE_SETTING_KEYS) {
      if (json[key] !== undefined) for (const issue of checkFields(json[key], SCENE_FIELDS[key].type, key)) issues.push(`${path.relative(content, file)}: ${issue}`);
    }
  }
  console.log(`${app}: ${files.length} files, ${entities} entities, ${issues.length} issues`);
  for (const issue of issues.slice(0, 20)) console.log(`  ${issue}`);
  if (issues.length > 0) failed = true;
}
process.exit(failed ? 1 : 0);
