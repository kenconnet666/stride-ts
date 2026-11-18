import { expect, test } from 'vitest';
import { component, prop, Registry, SyncScript, system } from '../src/index';
import { modulePath } from '../src/engine/registry';

test('模块路径变成名字的前缀', () => {
  expect(modulePath('./gameplay/health.ts')).toBe('gameplay/health');
  expect(modulePath('/src/levels/castle/boss.tsx')).toBe('levels/castle/boss');
});

test('组件、脚本、系统按模块路径和导出名命名', () => {
  const Health = component({ max: 100 });
  const Engine = component('Stride.Physics.RigidBody', { mass: 1 });
  class Player extends SyncScript.props({ speed: 1 }) {}
  class Boss extends SyncScript.props('Gameplay.Boss', { phase: prop.int().default(1) }) {}
  const regen = system({ with: { health: Health }, update: () => {} });

  const registry = new Registry();
  registry.registerModules({
    './gameplay/health.ts': { Health, regen, Engine, notAComponent: 42 },
    './gameplay/player.ts': { Player, Boss, default: Player },
  });

  expect(Health.name).toBe('gameplay/health#Health');
  expect(regen.name).toBe('gameplay/health#regen');
  expect(Engine.name).toBe('Stride.Physics.RigidBody');
  expect(Player.scriptName).toBe('gameplay/player#Player');
  expect(Boss.scriptName).toBe('Gameplay.Boss');
  expect(registry.get('gameplay/player#Player')).toBe(Player);
  // 用别的名字再导出时，保留第一次的名字
  expect(registry.get('gameplay/player#default')).toBeUndefined();
  expect([...registry.names].sort()).toEqual(['Gameplay.Boss', 'Stride.Physics.RigidBody', 'gameplay/health#Health', 'gameplay/health#regen', 'gameplay/player#Player']);
});

test('两个不同的东西同名会报错', () => {
  const registry = new Registry();
  registry.register(component('Shared.Name', {}));
  expect(() => registry.register(component('Shared.Name', {}))).toThrow("two different things are named 'Shared.Name'");
});
