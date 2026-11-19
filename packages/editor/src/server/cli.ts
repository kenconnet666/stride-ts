#!/usr/bin/env node
/**
 * stride-editor：不开开发服务器也能用的几件事。
 *   stride-editor assets-types [工程目录]   按内容目录生成资源句柄（src/assets.gen.ts）；typecheck、build 之前跑
 *   stride-editor assets [工程目录]         列出资源和指向不存在的资源的引用
 */
import path from 'node:path';
import { AssetDatabase } from './AssetDatabase.ts';
import { writeAssetTypes } from './assetTypes.ts';
import { loadProject } from './project.ts';

const [command, directory = '.'] = process.argv.slice(2);
const project = await loadProject(path.resolve(directory));
const database = new AssetDatabase(project.contentDir);
await database.scan();

if (command === 'assets-types') {
  const written = await writeAssetTypes(project.assetTypesFile, database.list(), project.manifest.content);
  console.log(`${project.manifest.assetTypes}: ${written ? 'written' : 'up to date'} (${database.list().filter((asset) => asset.handle).length} assets)`);
} else if (command === 'assets') {
  for (const asset of database.list()) console.log(`${asset.kind.padEnd(12)} ${asset.path}${asset.error ? `  ERROR ${asset.error}` : ''}`);
  const missing = database.missing();
  for (const { from, to } of missing) console.log(`missing: ${from.kind} ${from.path} -> ${to.kind} ${to.path}`);
  console.log(`${database.size} assets, ${missing.length} missing references`);
} else {
  console.error('usage: stride-editor <assets-types|assets> [project directory]');
  process.exitCode = 1;
}
