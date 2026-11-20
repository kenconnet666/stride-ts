#!/usr/bin/env node
/**
 * stride-editor：不开开发服务器也能用的几件事。
 *   stride-editor new <apps/目录> [--port <端口>]  新建工程：能跑的空游戏，主场景里有相机、太阳、天空、地面（template.ts）
 *   stride-editor assets-types [工程目录]   按内容目录生成资源句柄（src/assets.gen.ts）；typecheck、build 之前跑
 *   stride-editor assets [工程目录]         列出资源和指向不存在的资源的引用
 *   stride-editor move <工程目录> <种类> <路径> <新路径>     移动、改名一个资源，引用它的文件跟着改写
 *   stride-editor move-folder <工程目录> <文件夹> <新文件夹>  把文件夹下面的资源整个挪走
 *   stride-editor delete <工程目录> <种类> <路径> [--force]   删掉一个资源（有别的资源引用它时不删，除非 --force）
 *   stride-editor mcp [工程目录]            用 stdio 起编辑器的 MCP 服务（../mcp/server.ts），agent 工具按工具调用编辑工程
 */
import path from 'node:path';
import type { AssetKind } from '@stride-ts/engine/content-references';
import type { MoveResult } from '../protocol.ts';
import { AssetDatabase } from './AssetDatabase.ts';
import { writeAssetTypes } from './assetTypes.ts';
import { EditorBackend } from './EditorBackend.ts';
import { loadProject } from './project.ts';
import { createProject } from './template.ts';
import { realpathSync, watch } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createEditorMcpServer } from '../mcp/server.ts';

const [command, directory = '.', ...rest] = process.argv.slice(2);
if (command === 'new') {
  const portAt = rest.indexOf('--port');
  const created = await createProject(path.resolve(directory), portAt >= 0 ? { port: Number(rest[portAt + 1]) } : {});
  for (const file of created.files) console.log(`created ${path.join(directory, file)}`);
  console.log(`next: pnpm install, then pnpm --filter ${path.basename(created.root)} dev and open http://localhost:${created.port}/__stride/editor/`);
  process.exit(0);
}
const project = await loadProject(path.resolve(directory));
const database = new AssetDatabase(project.contentDir);
await database.scan();
const backend = () => EditorBackend.open(project.root, path.join(project.root, 'public'));

if (command === 'assets-types') {
  const written = await writeAssetTypes(project.assetTypesFile, database.list(), project.manifest.content);
  console.log(`${project.manifest.assetTypes}: ${written ? 'written' : 'up to date'} (${database.list().filter((asset) => asset.handle).length} assets)`);
} else if (command === 'assets') {
  for (const asset of database.list()) console.log(`${asset.kind.padEnd(12)} ${asset.path}${asset.error ? `  ERROR ${asset.error}` : ''}`);
  const missing = database.missing();
  for (const { from, to } of missing) console.log(`missing: ${from.kind} ${from.path} -> ${to.kind} ${to.path}`);
  console.log(`${database.size} assets, ${missing.length} missing references`);
} else if (command === 'move' && rest.length === 3) {
  const [kind, from, to] = rest as [AssetKind, string, string];
  const result = await (await backend()).moveAssets({ assets: [{ kind, from, to }] });
  printMove(result);
} else if (command === 'move-folder' && rest.length === 2) {
  printMove(await (await backend()).moveAssets({ folder: rest[0]!, to: rest[1]! }));
} else if (command === 'delete' && (rest.length === 2 || (rest.length === 3 && rest[2] === '--force'))) {
  const result = await (await backend()).deleteAsset(rest[0] as AssetKind, rest[1]!, { force: rest[2] === '--force' });
  for (const asset of result.removed) console.log(`removed ${asset.kind} ${asset.path}`);
  for (const asset of result.broken) console.log(`broken reference in ${asset.kind} ${asset.path}`);
} else if (command === 'mcp') {
  await serveMcp(await backend());
} else {
  console.error(`usage: stride-editor new <apps/folder> [--port <port>]
       stride-editor <assets-types|assets> [project directory]
       stride-editor move <project> <kind> <path> <new path>
       stride-editor move-folder <project> <folder> <new folder>
       stride-editor delete <project> <kind> <path> [--force]
       stride-editor mcp [project]`);
  process.exitCode = 1;
}

/** 用 stdio 起 MCP 服务，stdin 关了就退出。stdout 是 MCP 的通道：这里不能往 stdout 打印。 */
async function serveMcp(editor: EditorBackend): Promise<void> {
  // 别的程序（编辑器、手改）改了内容目录，数据库跟上（开发服务器里是 Vite 的监视器报进来）
  // 监视按真实的长路径（Windows 的 8.3 短路径，比如临时目录的 LIONHE~1，fs.watch 的递归监视会让进程崩掉）
  const contentDir = realpathSync.native(editor.project.contentDir);
  const watcher = watch(contentDir, { recursive: true }, (_event, file) => file && editor.fileChanged(path.join(editor.project.contentDir, file)));
  await createEditorMcpServer(editor).connect(new StdioServerTransport());
  // stdin 关了（agent 退出）：停监视、放掉原生工具，事件循环空了进程自己退（Windows 上 process.exit 和正在关的监视器撞上会断言失败）
  process.stdin.on('close', () => {
    watcher.close();
    void editor.close();
  });
}

function printMove({ moved, rewritten }: MoveResult): void {
  for (const asset of moved) console.log(`moved     ${asset.kind} ${asset.path}`);
  for (const asset of rewritten) console.log(`rewritten ${asset.kind} ${asset.path}`);
}
