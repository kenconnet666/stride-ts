import { describe, expect, test } from 'vitest';
import type { TimelineFile } from '../src/content/format';
import type { Entity } from '../src/engine/Entity';
import { Light } from '../src/rendering/components';
import { Transform } from '../src/engine/transform';
import { Timeline, type TimelineBinding } from '../src/timeline/Timeline';

/** 假的实体：get 返回一个普通对象当组件的视图，写进去的值能读出来。 */
function fakeEntity(name: string, views: Map<unknown, Record<string, unknown>>): Entity {
  return { name, get: (component: unknown) => views.get(component) } as unknown as Entity;
}

const FILE: TimelineFile = {
  name: 'Intro',
  duration: 4,
  tracks: [
    { type: 'property', entity: 'sun', component: 'Light', property: 'intensity', keys: [{ time: 0, value: 0 }, { time: 2, value: 8 }] },
    { type: 'property', entity: 'box', component: 'Transform', property: 'position', keys: [{ time: 1, value: [0, 0, 0] }, { time: 3, value: [4, 2, 0] }] },
    { type: 'camera', cuts: [{ time: 2, camera: 'close' }, { time: 0, camera: 'wide' }] },
    { type: 'subtitle', cues: [{ start: 0.5, end: 1.5, text: 'Hello' }, { start: 1, end: 2, text: 'World' }] },
    { type: 'sound', clips: [{ start: 1, sound: 'Sounds/Hit' }, { start: 3, sound: 'Sounds/Hit', volume: 0.5 }] },
    { type: 'event', events: [{ time: 2, name: 'door' }] },
    { type: 'animation', entity: 'hero', clips: [{ start: 0.5, clip: 'Run', speed: 2 }] },
  ],
};

describe('时间轴', () => {
  const light = { intensity: 1 };
  const box = { position: { x: 9, y: 9, z: 9 } };
  const entities = new Map<string, Entity>([
    ['sun', fakeEntity('Sun', new Map([[Light, light]]))],
    ['box', fakeEntity('Box', new Map([[Transform, box]]))],
    ['wide', fakeEntity('Wide', new Map())],
    ['close', fakeEntity('Close', new Map())],
  ]);
  const components = new Map<string, unknown>([['Light', Light], ['Transform', Transform]]);
  const binding: TimelineBinding = { entity: (id) => entities.get(id), component: (_entity, name) => components.get(name) as never };

  test('某一刻：属性按关键帧插值写到组件上，相机取最近的切点（切点不必排序），字幕是那一刻的所有字幕', () => {
    const timeline = new Timeline(FILE);
    expect([timeline.duration, timeline.frameRate]).toEqual([4, 30]);
    let state = timeline.evaluate(1, binding);
    expect(light.intensity).toBe(4);
    expect(box.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(state.camera?.name).toBe('Wide');
    expect(state.subtitle).toBe('Hello\nWorld');
    state = timeline.evaluate(2.5, binding);
    expect(light.intensity).toBe(8);
    expect(box.position).toEqual({ x: 3, y: 1.5, z: 0 });
    expect(state.camera?.name).toBe('Close');
    expect(state.subtitle).toBe('');
  });

  test('找不到的实体、组件跳过；组件没有那个属性、关键帧没排序时报错', () => {
    const missing = new Timeline({ name: 'Missing', duration: 1, tracks: [{ type: 'property', entity: 'nobody', component: 'Light', property: 'intensity', keys: [{ time: 0, value: 1 }] }] });
    expect(missing.evaluate(0, binding).camera).toBeUndefined();
    const wrong = new Timeline({ name: 'Wrong', duration: 1, tracks: [{ type: 'property', entity: 'sun', component: 'Light', property: 'brightness', keys: [{ time: 0, value: 1 }] }] });
    expect(() => wrong.evaluate(0, binding)).toThrow(/no property 'brightness'/);
    const unsorted = new Timeline({ name: 'Unsorted', duration: 1, tracks: [{ type: 'property', entity: 'sun', component: 'Light', property: 'intensity', keys: [{ time: 1, value: 1 }, { time: 0, value: 2 }] }] });
    expect(() => unsorted.evaluate(0, binding)).toThrow(/not sorted/);
  });

  test('经过的声音、事件、动画剪辑：不含起点、含终点，按时刻排；往回拖没有', () => {
    const timeline = new Timeline(FILE);
    expect(timeline.crossed(0, 2).map((cue) => `${cue.type}@${cue.time}`)).toEqual(['animation@0.5', 'sound@1', 'event@2']);
    expect(timeline.crossed(1, 3)).toEqual([
      { type: 'event', time: 2, name: 'door' },
      { type: 'sound', time: 3, sound: 'Sounds/Hit', volume: 0.5 },
    ]);
    expect(timeline.crossed(3, 1)).toEqual([]);
  });
});
