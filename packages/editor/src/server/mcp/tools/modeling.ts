/** 编辑器 MCP 服务的工具：建模：雕刻地形、编辑多边形网格、白盒导出成多边形网格。 */
import type { McpServer } from '@modelcontextprotocol/server';
import { applyPolyOperation, edgeLoop, faceLoop, POLY_OPERATIONS, type PolyOperation } from '@stride-ts/engine/modeling';
import type { PolyMeshFile, TerrainFeatureFile, TerrainFile, TerrainStrokeFile } from '@stride-ts/engine/content-format';
import * as z from 'zod';
import { assetPath, json, type McpProjects } from '../shared.ts';

export function registerModelingTools(server: McpServer, projects: McpProjects): void {
  server.registerTool('sculpt_terrain', {
    description: [
      'Sculpt a vector terrain asset (kind terrain, .terrain.json) and save it; viewports re-evaluate only the tiles the change covers.',
      'Coordinates are the terrain\'s local meters (x, z; the terrain entity\'s position is the origin), heights in meters.',
      'strokes are appended in order: raise / lower {x, z, radius, strength (m)}, flatten {x, z, radius, strength 0..1, height}, smooth {x, z, radius, strength 0..1}.',
      'features are appended: flatten {points: [[x, z], ...] polygon, height, falloff (m), strength 0..1} for roads, plazas, foundations.',
      'undo removes that many of the last strokes first. Returns the stroke and feature counts.',
      'To move, reshape or delete existing features, read_asset the terrain and write_asset it back with the edited features list.',
    ].join(' '),
    inputSchema: z.object({
      path: assetPath,
      strokes: z.array(z.object({
        op: z.enum(['raise', 'lower', 'flatten', 'smooth']),
        x: z.number(), z: z.number(), radius: z.number().positive(), strength: z.number(), height: z.number().optional(),
      })).optional(),
      features: z.array(z.object({
        type: z.literal('flatten'), name: z.string().optional(),
        points: z.array(z.tuple([z.number(), z.number()])).min(3), height: z.number(), falloff: z.number().min(0).optional(), strength: z.number().min(0).max(1).optional(),
      })).optional(),
      undo: z.number().int().min(0).optional(),
    }),
  }, async ({ path, strokes = [], features = [], undo = 0 }) => {
    const file = await projects.current.readAsset('terrain', path) as TerrainFile;
    const kept = (file.strokes ?? []).slice(0, Math.max(0, (file.strokes?.length ?? 0) - undo));
    // zod 的可选字段带 undefined，文件的类型不带：JSON 存盘时 undefined 的字段本来就不写
    const next: TerrainFile = { ...file, strokes: [...kept, ...(strokes as TerrainStrokeFile[])], features: [...(file.features ?? []), ...(features as TerrainFeatureFile[])] };
    await projects.current.saveAsset('terrain', path, next);
    return json({ strokes: next.strokes!.length, features: next.features!.length });
  });

  server.registerTool('edit_poly', {
    description: [
      'Edit a poly mesh asset (kind poly, .poly.json) with one modeling operation and save it (the backend bakes its model; editors hot reload).',
      'Vertices and faces are indices into the file (read_asset); an edge is a vertex pair [a, b]. Operations:',
      'extrude {faces, distance} pushes the faces out along their normals and adds side faces;',
      'inset {faces, amount 0..1} shrinks each face toward its center with a ring of quads around it;',
      'bevel {edges, distance} cuts a slanted face along edges whose ends have three faces each;',
      'merge {vertices} collapses them to their center; split {edge, t} adds a vertex on an edge; connect {face, a, b} splits a face between two of its vertices;',
      'move {delta:[x,y,z], vertices|faces|edges}; delete {faces}; flip {faces}; material {faces, material}.',
      'The result tells what is selected after the operation (the extruded faces, the new vertex, ...) so operations chain.',
    ].join(' '),
    inputSchema: z.object({
      path: assetPath,
      op: z.enum(POLY_OPERATIONS),
      faces: z.array(z.number().int()).optional(),
      edges: z.array(z.tuple([z.number().int(), z.number().int()])).optional(),
      vertices: z.array(z.number().int()).optional(),
      edge: z.tuple([z.number().int(), z.number().int()]).optional(),
      face: z.number().int().optional(),
      a: z.number().int().optional(),
      b: z.number().int().optional(),
      distance: z.number().optional(),
      amount: z.number().optional(),
      t: z.number().optional(),
      delta: z.tuple([z.number(), z.number(), z.number()]).optional(),
      material: z.number().int().optional(),
    }),
  }, async ({ path, ...operation }) => {
    const mesh = await projects.current.readAsset('poly', path) as PolyMeshFile;
    const result = applyPolyOperation(mesh, operation as unknown as PolyOperation);
    await projects.current.saveAsset('poly', path, result.mesh);
    return json({ saved: `poly ${path}`, vertexCount: result.mesh.vertices.length, faceCount: result.mesh.faces.length, selected: { faces: result.faces, edges: result.edges, vertices: result.vertices } });
  });

  server.registerTool('poly_loop', {
    description: [
      'Select a loop on a poly mesh asset (like double-clicking in the viewport), to feed edit_poly: with edge [a, b] the edge loop through it',
      '(it continues straight through vertices with exactly four edges and stops elsewhere or at the border); with face and edge the face loop',
      'that goes from the quad face across that edge and on through the opposite edges of quads. Nothing is saved.',
    ].join(' '),
    inputSchema: z.object({ path: assetPath, edge: z.tuple([z.number().int(), z.number().int()]), face: z.number().int().optional() }),
  }, async ({ path, edge, face }) => {
    const mesh = await projects.current.readAsset('poly', path) as PolyMeshFile;
    return json(face === undefined ? { edges: edgeLoop(mesh, edge) } : { faces: faceLoop(mesh, face, edge) });
  });

  server.registerTool('brush_to_poly', {
    description: [
      'Export a greybox (kind brush, .brush.json) as an editable poly mesh (kind poly, .poly.json): the CSG result welded, coplanar triangles of one material slot merged into n-gon faces (concave allowed; faces with holes stay triangles), hard edges.',
      'Saved as a new asset (default <greybox path>Poly, numbered if taken) whose baked model has the same path; the greybox is left as is.',
      'Point a model component at the new path (edit_scene) and refine it with edit_poly.',
    ].join(' '),
    inputSchema: z.object({ path: assetPath, target: assetPath.optional() }),
  }, async ({ path, target }) => json(await projects.current.exportBrushToPoly(path, target)));
}
