import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import type { SceneEntityFile } from '../src/content/format';
import { checkEntity, checkFields, COMPONENT_FIELDS, SCENE_FIELDS, scriptFields } from '../src/editor/fields';
import { prop, SyncScript } from '../src/index';

// 属性面板要的字段描述，和照着它做的检查。

const entity = (components: SceneEntityFile['components']): SceneEntityFile =>
  ({ id: 'e', name: 'E', parent: null, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], components });

describe('字段描述（editor/fields）', () => {
  test('"添加组件"放进文件的值都合它自己的描述', () => {
    for (const [key, { type, initial }] of Object.entries(COMPONENT_FIELDS)) expect([key, checkFields(initial, type, key)]).toEqual([key, []]);
  });

  test('检查一个实体：缺字段、多字段、种类不对、超出范围、枚举和种类里没有的值；可以是 null 的、可以不写的不报', () => {
    expect(checkEntity(entity({
      model: { model: 'Game/Wall', materials: ['Game/Red', null], renderGroup: 3 },
      light: { type: 'spot', color: [1, 1, 1], intensity: 2, range: 10, angleInner: 30, angleOuter: 45, shadow: { size: 'small', filter: 'pcf3x3', depthBias: 0.01, normalOffsetScale: 10 } },
      static: { shapes: [{ type: 'convexHull', model: 'Game/Wall', hull: { scale: [1, 1, 1], rotation: [0, 0, 0, 1], offset: [0, 0, 0] }, position: [0, 0, 0], rotation: [0, 0, 0, 1], mass: 1 }], layer: 0, friction: 1 },
      nodeLink: { target: null, nodeName: 'hand_r' },
      background: { type: '2d', image: { texture: 'Game/Sky', encoding: 'png' }, intensity: 1 },
      scripts: [{ type: 'Game.Anything', props: { whatever: 1 } }],
    }))).toEqual([]);

    const broken = entity({
      model: { model: 3, materials: 'Game/Red', castShadows: true } as never,
      light: { type: 'laser', color: [1, 1, 1], intensity: 1 } as never,
      camera: { verticalFieldOfView: 200, nearClipPlane: 0.1, slot: 1.5 } as never,
      static: { shapes: [{ type: 'sphere', radius: -1, position: [0, 0], rotation: [0, 0, 0, 1], mass: 1 }], layer: 0, friction: 1 } as never,
      ui: { page: null, resolution: [1280, 720, 1000], size: [1, 1, 1], resolutionStretch: 'stretch' } as never,
      wheel: {},
    } as never);
    expect(checkEntity({ ...broken, rotation: [0, 0, 0] as never })).toEqual([
      'entity E.rotation: expected a quaternion (4 numbers), got [0,0,0]',
      'entity E.components.model.model: expected a model asset, got 3',
      'entity E.components.model.materials: expected a list, got "Game/Red"',
      'entity E.components.model.castShadows: not a field of this component',
      'entity E.components.light.type: expected one of directional, ambient, skybox, point, spot, got "laser"',
      'entity E.components.camera.verticalFieldOfView: expected a number in 1..179, got 200',
      'entity E.components.camera.farClipPlane: missing',
      'entity E.components.camera.slot: expected an integer, got 1.5',
      'entity E.components.static.shapes[0].radius: expected a number in 0..inf, got -1',
      'entity E.components.static.shapes[0].position: expected 3 numbers, got [0,0]',
      'entity E.components.ui.resolutionStretch: expected one of fixedWidthFixedHeight, fixedWidthAdaptableHeight, fixedHeightAdaptableWidth, got "stretch"',
      'entity E.components.wheel: not a component',
    ]);
  });

  test('脚本的字段从 prop 的声明来：范围、单位、枚举、引用的写法、嵌套；运行时状态和藏起来的不算', () => {
    class Turret extends SyncScript.props({
      speed: prop.number().default(2).min(0).max(10).step(0.5).unit('rad/s').label('Turn speed').group('Aim'),
      burst: prop.int().default(3),
      mode: prop.enum(['idle', 'track']).default('idle'),
      muzzle: prop.vec3(),
      target: prop.entity(),
      bullet: prop.asset('prefab'),
      hud: prop.asset('uiPage'),
      waypoints: prop.list(prop.vec3()),
      limits: prop.object({ min: prop.f32().default(-1), max: 1 }),
      heat: prop.number().default(0).transient(),
      secret: prop.number().default(0).hidden(),
    }) {}
    const fields = scriptFields(Turret);
    expect(fields.map((field) => field.name)).toEqual(['speed', 'burst', 'mode', 'muzzle', 'target', 'bullet', 'hud', 'waypoints', 'limits']);
    const byName = Object.fromEntries(fields.map((field) => [field.name, field]));
    expect(byName['speed']).toEqual({ name: 'speed', type: { kind: 'number', min: 0, max: 10, step: 0.5, unit: 'rad/s' }, optional: true, default: 2, label: 'Turn speed', group: 'Aim' });
    expect(byName['burst']!.type).toEqual({ kind: 'number', integer: true });
    expect(byName['mode']!.type).toEqual({ kind: 'enum', values: ['idle', 'track'] });
    expect([byName['target']!.type, byName['target']!.optional]).toEqual([{ kind: 'entity', form: 'ref' }, undefined]);
    expect(byName['bullet']!.type).toEqual({ kind: 'asset', asset: 'prefab', form: 'ref', refKind: 'prefab' });
    // UI 页面和 UI 库是同一种文件
    expect(byName['hud']!.type).toEqual({ kind: 'asset', asset: 'ui', form: 'ref', refKind: 'uiPage' });
    expect(byName['waypoints']!.type).toEqual({ kind: 'list', item: { kind: 'vector', size: 3 } });
    expect(byName['limits']!.type).toEqual({ kind: 'object', fields: [{ name: 'min', type: { kind: 'number' }, optional: true, default: -1 }, { name: 'max', type: { kind: 'number' }, optional: true, default: 1 }] });
    // 场景文件里脚本属性的值照这些描述检查
    const type = { kind: 'object', fields } as const;
    expect(checkFields({ speed: 3, target: { $entity: 'abc' }, bullet: { $asset: 'Game/Bullet', kind: 'prefab' }, hud: { $asset: 'Game/Hud', kind: 'uiPage' }, waypoints: [[0, 1, 2]] }, type, 'Turret')).toEqual([]);
    expect(checkFields({ speed: 11, target: 'abc', bullet: 'Game/Bullet', hud: { $asset: 'x', kind: 'uiPage' } }, type, 'Turret')).toEqual([
      'Turret.speed: expected a number in 0..10, got 11',
      'Turret.target: expected an entity, got "abc"',
      'Turret.bullet: expected a prefab asset, got "Game/Bullet"',
    ]);
  });

  test('各个样例导入的场景和预制体都合描述（内容目录不在仓库里：没导入时跳过）', () => {
    const apps = path.resolve(import.meta.dirname, '..', '..', '..', 'apps');
    let files = 0, entities = 0;
    const issues: string[] = [];
    for (const app of readdirSync(apps)) {
      const content = path.join(apps, app, 'public', 'content');
      if (!existsSync(content)) continue;
      for (const entry of readdirSync(content, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile() || !/\.(scene|prefab)\.json$/.test(entry.name)) continue;
        const file = JSON.parse(readFileSync(path.join(entry.parentPath, entry.name), 'utf8')) as { entities: SceneEntityFile[] };
        files++;
        for (const item of file.entities) {
          entities++;
          issues.push(...checkEntity(item).map((issue) => `${app}/${entry.name}: ${issue}`));
        }
      }
    }
    expect(issues.slice(0, 20)).toEqual([]);
    console.info(`checked ${entities} entities in ${files} scene and prefab files`);
  });
});

test('场景自己的设置的字段描述（SCENE_FIELDS）：添加时放进去的值照描述没问题；格式里删掉的字段报出来', () => {
  for (const [key, description] of Object.entries(SCENE_FIELDS)) expect(checkFields(description.initial, description.type, key)).toEqual([]);
  const stale = { gravity: [0, -40, 0], linearDamping: 0.05, angularDamping: 0.05, fixedTimeStep: 1 / 60, maxStepsPerFrame: 3 };
  expect(checkFields(stale, SCENE_FIELDS.physics.type, 'physics')).toEqual(['physics.maxStepsPerFrame: not a field of this component']);
});

test('组件之间的依赖（COMPONENT_FIELDS 的 requires）指的都是存在的组件，不指自己；日夜循环要天空', () => {
  for (const [key, description] of Object.entries(COMPONENT_FIELDS) as [string, { requires?: readonly string[] }][]) {
    for (const needed of description.requires ?? []) expect([key, needed in COMPONENT_FIELDS && needed !== key]).toEqual([key, true]);
  }
  expect(COMPONENT_FIELDS.dayNightCycle.requires).toEqual(['skyAtmosphere']);
});
