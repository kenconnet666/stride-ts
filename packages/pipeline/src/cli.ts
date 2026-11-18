#!/usr/bin/env node
/**
 * 资源管线的命令行（Node 22.18+ 直接运行 .ts）。
 *
 *   node packages/pipeline/src/cli.ts import-stride \
 *     --package ThirdPersonPlatformer=<Stride 工程>/Assets \
 *     --package PrototypingBlocks=<Stride 仓库>/samples/Templates/Packs/PrototypingBlocks/Assets \
 *     --scene ThirdPersonPlatformer/MainScene --out apps/platformer/public/content
 *
 * --package 是"包名=资源目录"，可以给多个；--scene 是场景的内容路径（包名/相对路径），也可以给多个（共用导入过的资源）。
 * --overrides 是覆盖目录：<目录>/<内容路径>.svg（或 .png、.jpg）代替资源的源图片，原样导出。
 * --textures 是没有覆盖文件的贴图怎么导出：ktx2（默认）、source（PNG/JPEG 原样复制）、smallest（取下载小的）。
 * --plain 导出不压缩的内容（float 顶点、不用 meshopt），方便查看和调试；默认量化加 meshopt。
 */
import { parseArgs } from 'node:util';
import { createStrideTools } from '@stride-ts/native/tools';
import { StrideImporter, type ImportResult } from './stride/importer.ts';
import { StrideProject, type AssetRoot } from './stride/project.ts';

const TEXTURE_POLICIES = ['ktx2', 'source', 'smallest'] as const;
const USAGE = 'usage: cli.ts import-stride --package <name>=<assets dir> [...] --scene <package>/<path> --out <content dir> [--overrides <dir>] [--textures ktx2|source|smallest] [--plain]';

async function importStride(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      package: { type: 'string', multiple: true },
      scene: { type: 'string', multiple: true },
      out: { type: 'string' },
      // 不压缩（float 顶点、不用 meshopt），方便查看和调试
      plain: { type: 'boolean' },
      overrides: { type: 'string' },
      textures: { type: 'string' },
    },
  });
  if (!values.package?.length || !values.scene?.length || !values.out) throw new Error(USAGE);
  const roots: AssetRoot[] = values.package.map((spec) => {
    const equals = spec.indexOf('=');
    if (equals <= 0) throw new Error(`--package ${spec}: expected <name>=<assets dir>`);
    return { package: spec.slice(0, equals), dir: spec.slice(equals + 1) };
  });

  const started = performance.now();
  const project = await StrideProject.open(roots);
  const scenes = values.scene.map((path) => {
    const scene = project.byPath(path);
    if (!scene) throw new Error(`no asset at ${path} (indexed ${project.size} assets)`);
    return scene;
  });
  const tools = await createStrideTools();
  try {
    const textureEncoding = TEXTURE_POLICIES.find((policy) => policy === (values.textures ?? 'ktx2'));
    if (!textureEncoding) throw new Error(`--textures ${values.textures}: expected ${TEXTURE_POLICIES.join(', ')}`);
    const options = { plain: values.plain ?? false, textureEncoding, ...(values.overrides ? { overrides: values.overrides } : {}) };
    const importer = new StrideImporter(project, tools, values.out, options);
    let result: ImportResult | undefined;
    for (const scene of scenes) {
      result = await importer.importScene(scene);
      console.log(`imported ${result.scene}: ${result.entities} entities, ${result.models.length} models, ${result.materials.length} materials, ${result.textures.length} textures, ${result.skyboxes.length} skyboxes in ${((performance.now() - started) / 1000).toFixed(1)} s -> ${values.out}`);
    }
    // 跳过的组件和警告是所有场景累计的
    const { skipped, warnings } = result!;
    if (skipped.size > 0) console.log(`skipped components: ${[...skipped].map(([type, count]) => `${type} x${count}`).join(', ')}`);
    for (const warning of warnings) console.warn(`warning: ${warning}`);
  } finally {
    tools.shutdown();
  }
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === 'import-stride') await importStride(rest);
  else throw new Error(USAGE);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
