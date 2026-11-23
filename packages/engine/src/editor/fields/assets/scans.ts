/** 扫描场景的资源（高斯泼溅的编辑）的字段描述。 */
import type { SplatEditFile } from '../../../content/formats/format';
import { fields, number, integer, string, vector, asset, list, object } from '../builders.ts';

const splatBox = object(fields<NonNullable<SplatEditFile['keep']>[number]>({
  center: { type: vector(3, 'm'), description: 'center of the box in the source splats\' own coordinates' },
  size: { type: vector(3, 'm'), description: 'edge lengths of the box' },
  rotation: { type: vector(4), optional: true, description: 'rotation of the box (quaternion xyzw)' },
}));

/** 扫描场景的编辑（SplatEditFile）：后端照它从源泼溅生成同名的泼溅。 */
export const SPLAT_EDIT_FIELDS = fields<SplatEditFile>({
  name: string,
  source: { type: asset('splats'), description: 'the scanned splats this is made from (left unchanged)' },
  merge: {
    type: list(object(fields<NonNullable<SplatEditFile['merge']>[number]>({
      source: { type: asset('splats'), description: 'another scan merged in' },
      position: { type: vector(3, 'm'), optional: true, default: [0, 0, 0], description: 'where it goes in the source splats\' coordinates' },
      rotation: { type: vector(4), optional: true, default: [0, 0, 0, 1], description: 'its rotation (quaternion xyzw)' },
      scale: { type: number({ min: 0.0001, step: 0.01 }), optional: true, default: 1, description: 'its uniform scale (phone scans often differ in scale)' },
    }))),
    optional: true,
    description: 'other scans merged in first (place them roughly, then auto-align); crop, erase and floaters apply to the merged result',
  },
  keep: { type: list(splatBox), optional: true, description: 'crop boxes: only splats inside one of them are kept; nothing is cropped when missing' },
  remove: { type: list(splatBox), optional: true, description: 'splats inside these boxes are removed' },
  erase: {
    type: list(object(fields<NonNullable<SplatEditFile['erase']>[number]>({
      center: { type: vector(3, 'm'), description: 'center of the sphere in the source splats\' own coordinates' },
      radius: { type: number({ min: 0, step: 0.01, unit: 'm' }), description: 'radius of the sphere' },
    }))),
    optional: true,
    description: 'brush strokes: splats whose centers fall in these spheres are removed',
  },
  floaters: {
    type: object(fields<NonNullable<SplatEditFile['floaters']>>({
      cell: { type: number({ min: 0.01, step: 0.05, unit: 'm' }), optional: true, default: 0.25, description: 'grid cell size for counting neighbors' },
      neighbors: { type: integer(0, 1000), optional: true, default: 4, description: 'splats with fewer than this many others in their own and the 26 surrounding cells float alone and are removed' },
      minOpacity: { type: number({ min: 0, max: 1, step: 0.01 }), optional: true, default: 0, description: 'splats more transparent than this are removed (off by default: many faint ones together are the soft light on floors and walls)' },
    })),
    optional: true,
    description: 'remove floaters: lone splats hanging in the air and nearly invisible ones; off when missing',
  },
});
