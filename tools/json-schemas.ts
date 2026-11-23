/**
 * 把内容文件的 JSON Schema（引擎的字段描述、有类型的模式换的，editor/fields/jsonSchema.ts 的 contentFileSchemas）导出到 schemas/，
 * 并按文件名关联给 IDE：人手写 `.json`、`.jsonc`（`*.shelf.json`、`*.shelf.jsonc`……）时补全字段名和枚举、写错标红、悬停看说明。
 * - VS Code：.vscode/settings.json 的 json.schemas（只改这一项，别的设置留着）；
 * - JetBrains（WebStorm、IDEA、CLion）：.idea/jsonSchemas.xml（.idea 不进仓库，有这个目录才写）。
 * 字段描述改了以后重跑；`--check` 只比不写，过期了退出码 1（单测里跑）。
 *   node tools/json-schemas.ts [--check]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTENSIONS, parseJsonc } from '@stride-ts/engine/content-format';
import { contentFileSchemas } from '@stride-ts/engine/editor-field-schema';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
const dir = path.join(root, 'schemas');

/** 种类 → 文件名的扩展名（`.shelf.json`）；`.model` 也可能是二进制的，不关联。 */
const extensions = EXTENSIONS as Readonly<Record<string, string>>;
const schemas = Object.entries(contentFileSchemas()).filter(([kind]) => extensions[kind]?.endsWith('.json'));

const files = new Map<string, string>(schemas.map(([kind, schema]) => [`${kind}.schema.json`, `${JSON.stringify(schema, null, 2)}\n`]));
const stale: string[] = [];
for (const [name, text] of files) {
  const file = path.join(dir, name);
  if (existsSync(file) && readFileSync(file, 'utf8') === text) continue;
  stale.push(`schemas/${name}`);
  if (!check) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, text);
  }
}
// 不再有的种类的旧文件
for (const name of existsSync(dir) ? readdirSync(dir) : []) if (!files.has(name)) stale.push(`schemas/${name} (no longer generated; delete it)`);

// VS Code：json.schemas 整项换成生成的
const vscodeFile = path.join(root, '.vscode', 'settings.json');
const settings = (existsSync(vscodeFile) ? parseJsonc(readFileSync(vscodeFile, 'utf8'), vscodeFile) : {}) as Record<string, unknown>;
const associations = schemas.map(([kind]) => ({ fileMatch: [`*${extensions[kind]}`, `*${extensions[kind]}c`], url: `./schemas/${kind}.schema.json` }));
const vscodeText = `${JSON.stringify({ ...settings, 'json.schemas': associations }, null, 2)}\n`;
if (!existsSync(vscodeFile) || readFileSync(vscodeFile, 'utf8') !== vscodeText) {
  stale.push('.vscode/settings.json');
  if (!check) {
    mkdirSync(path.dirname(vscodeFile), { recursive: true });
    writeFileSync(vscodeFile, vscodeText);
  }
}

// JetBrains：只在本机有 .idea 时写（不进仓库，不算过期）
if (!check && existsSync(path.join(root, '.idea'))) {
  const entries = schemas.map(([kind]) => `      <entry key="${kind}">
        <value>
          <SchemaInfo>
            <option name="name" value="${kind}" />
            <option name="relativePathToSchema" value="schemas/${kind}.schema.json" />
            <option name="applicationDefined" value="true" />
            <option name="patterns">
              <list>
                <Item>
                  <option name="pattern" value="true" />
                  <option name="path" value="*${extensions[kind]}" />
                  <option name="mappingKind" value="Pattern" />
                </Item>
                <Item>
                  <option name="pattern" value="true" />
                  <option name="path" value="*${extensions[kind]}c" />
                  <option name="mappingKind" value="Pattern" />
                </Item>
              </list>
            </option>
          </SchemaInfo>
        </value>
      </entry>`).join('\n');
  writeFileSync(path.join(root, '.idea', 'jsonSchemas.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<project version="4">
  <component name="JsonSchemaMappingsProjectConfiguration">
    <state>
      <map>
${entries}
      </map>
    </state>
  </component>
</project>
`);
}

if (check && stale.length > 0) {
  console.error(`JSON schemas are out of date (run node tools/json-schemas.ts):\n  ${stale.join('\n  ')}`);
  process.exit(1);
}
console.log(check ? `JSON schemas up to date (${files.size} kinds)` : `wrote ${stale.length} file(s), ${files.size} kinds`);
