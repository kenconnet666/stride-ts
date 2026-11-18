#!/usr/bin/env node
/**
 * 资源管线的命令行（Node 22.18+ 直接运行 .ts）。
 *
 *   node packages/pipeline/src/cli.ts import-stride \
 *     --package ThirdPersonPlatformer=<Stride 工程>/Assets \
 *     --package PrototypingBlocks=<Stride 仓库>/samples/Templates/Packs/PrototypingBlocks/Assets \
 *     --scene ThirdPersonPlatformer/MainScene --out apps/platformer/public/content
 *
 * --package 是"包名=资源目录"，可以给多个；--scene 是场景的内容路径（包名/相对路径）。
 */
import { parseArgs } from 'node:util';
import { createStrideTools } from '@stride-ts/native/tools';
import { StrideImporter } from './stride/importer.ts';
import { StrideProject, type AssetRoot } from './stride/project.ts';

const USAGE = 'usage: cli.ts import-stride --package <name>=<assets dir> [...] --scene <package>/<path> --out <content dir>';

async function importStride(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      package: { type: 'string', multiple: true },
      scene: { type: 'string' },
      out: { type: 'string' },
    },
  });
  if (!values.package?.length || !values.scene || !values.out) throw new Error(USAGE);
  const roots: AssetRoot[] = values.package.map((spec) => {
    const equals = spec.indexOf('=');
    if (equals <= 0) throw new Error(`--package ${spec}: expected <name>=<assets dir>`);
    return { package: spec.slice(0, equals), dir: spec.slice(equals + 1) };
  });

  const started = performance.now();
  const project = await StrideProject.open(roots);
  const scene = project.byPath(values.scene);
  if (!scene) throw new Error(`no asset at ${values.scene} (indexed ${project.size} assets)`);
  const tools = await createStrideTools();
  try {
    const result = await new StrideImporter(project, tools, values.out).importScene(scene);
    console.log(`imported ${result.scene}: ${result.entities} entities, ${result.models.length} models, ${result.materials.length} materials, ${result.textures.length} textures, ${result.skyboxes.length} skyboxes in ${((performance.now() - started) / 1000).toFixed(1)} s -> ${values.out}`);
    if (result.skipped.size > 0) console.log(`skipped components: ${[...result.skipped].map(([type, count]) => `${type} x${count}`).join(', ')}`);
    for (const warning of result.warnings) console.warn(`warning: ${warning}`);
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
