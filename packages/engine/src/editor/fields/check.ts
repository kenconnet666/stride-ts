/** 检查一个实体文件（checkEntity）：保存前、读别人写的文件时；单个值照描述查用 fieldValues.ts 的 checkFields。 */
import type { SceneEntityFile } from '../../content/formats/format';
import { COMPONENT_FIELDS, ENTITY_FIELDS, type ComponentDescription } from './components.ts';
import { checkObject, checkValue } from '../../content/schema/fieldValues.ts';

export { checkFields } from '../../content/schema/fieldValues.ts';

/** 场景文件里一个实体能有的键（SceneEntityFile）。 */
const ENTITY_KEYS: ReadonlySet<string> = new Set(['id', 'name', 'parent', 'prefab', 'position', 'rotation', 'scale', 'components'] satisfies (keyof SceneEntityFile)[]);

/** 检查一个实体文件：名字、变换和每种组件（脚本不查，要脚本的类）。 */
export function checkEntity(entity: SceneEntityFile): string[] {
  const where = `entity ${entity.name}`;
  const issues: string[] = [];
  // 实体自己的字段以外的键：写错了地方的（比如脚本写在实体上，应该在 components.scripts 里）加载时会被悄悄忽略
  for (const key of Object.keys(entity)) {
    if (!ENTITY_KEYS.has(key)) issues.push(`${where}.${key}: not an entity field${key === 'scripts' ? ' (scripts go in components.scripts)' : ''}`);
  }
  checkObject({ name: entity.name, position: entity.position, rotation: entity.rotation, scale: entity.scale }, ENTITY_FIELDS, where, issues);
  for (const [key, value] of Object.entries(entity.components ?? {})) {
    if (key === 'scripts') continue;
    const description = (COMPONENT_FIELDS as Readonly<Record<string, ComponentDescription | undefined>>)[key];
    if (!description) issues.push(`${where}.components.${key}: not a component`);
    else checkValue(value, description.type, `${where}.components.${key}`, issues);
  }
  return issues;
}
