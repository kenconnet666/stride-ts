import { describe, expect, test } from 'vitest';
import { ASSET_FIELDS, COMPONENT_FIELDS, ENTITY_FIELDS, SCENE_FIELDS, type Field, type FieldType } from '@stride-ts/engine/editor-fields';
import { fieldMessages } from '../src/ui/i18n/fieldMessages.ts';
import { pick } from '../src/ui/i18n/i18n.ts';

/** 引擎的字段描述里出现的全部标题、字段名、说明。 */
function collect() {
  const labels = new Set<string>(), names = new Set<string>(), descriptions = new Set<string>();
  const walkType = (type: FieldType | undefined): void => {
    if (!type) return;
    if (type.kind === 'object') type.fields.forEach(walk);
    if (type.kind === 'list') walkType(type.item);
    if (type.kind === 'union') {
      Object.values(type.variants).forEach((fields) => fields.forEach(walk));
      type.common?.forEach(walk);
    }
  };
  const walk = (field: Field): void => {
    names.add(field.name);
    if (field.label) labels.add(field.label);
    if (field.description) descriptions.add(field.description);
    walkType(field.type);
  };
  for (const group of [COMPONENT_FIELDS, SCENE_FIELDS] as const) {
    for (const entry of Object.values(group)) {
      labels.add(entry.label);
      walkType(entry.type);
    }
  }
  Object.values(ASSET_FIELDS).forEach((fields) => fields.forEach(walk));
  ENTITY_FIELDS.forEach(walk);
  return { labels, names, descriptions };
}

describe('编辑器的多语言', () => {
  test('中文的字段表盖住引擎字段描述里的每个标题、字段名、说明（加了字段要一起翻）', () => {
    const zh = fieldMessages['zh-CN']!;
    const { labels, names, descriptions } = collect();
    expect([...labels].filter((label) => zh.labels[label] === undefined)).toEqual([]);
    expect([...names].filter((name) => zh.names[name] === undefined)).toEqual([]);
    expect([...descriptions].filter((description) => zh.descriptions[description] === undefined)).toEqual([]);
  });

  test('找不到的语言先用同一语种的，再用英语', () => {
    const table = { 'en-US': 'en', 'zh-CN': 'zh' };
    expect([pick(table, 'zh-CN'), pick(table, 'zh-TW'), pick(table, 'ja-JP'), pick(table, 'en-GB')]).toEqual(['zh', 'zh', 'en', 'en']);
  });
});
