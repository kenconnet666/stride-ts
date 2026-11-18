import { afterEach, describe, expect, test, vi } from 'vitest';
import { prop } from '../src/data/prop';
import { createColumn, createSchema } from '../src/data/schema';

const none = new Set<string>();

describe('schema', () => {
  test('assigns init values over defaults, literals included', () => {
    const schema = createSchema({ speed: prop.number().default(10), jump: 1.2, name: 'hero', on: true }, 'number', none, 'Player');
    const target: Record<string, unknown> = {};
    schema.assign(target, { speed: 12 });
    expect(target).toEqual({ speed: 12, jump: 1.2, name: 'hero', on: true });
  });

  test('a required prop must be given', () => {
    const schema = createSchema({ team: prop.int() }, 'number', none, 'Player');
    expect(() => schema.assign({}, {})).toThrow('Player.team is required');
    const target: Record<string, unknown> = {};
    schema.assign(target, { team: 2 });
    expect(target.team).toBe(2);
  });

  test('defaults and values are checked against the declaration', () => {
    expect(() => createSchema({ hp: prop.f32().min(0).default(-1) }, 'f32', none, 'Health')).toThrow('Health.hp: default -1 is below the minimum 0');
    expect(() => createSchema({ mode: prop.enum(['a', 'b']).default('c' as 'a') }, 'number', none, 'X')).toThrow("'c' is not one of 'a', 'b'");
    expect(() => createSchema({ n: prop.u8().default(300) }, 'number', none, 'X')).toThrow('300 is not a u8');
    const schema = createSchema({ hp: prop.f32().max(100).default(50) }, 'f32', none, 'Health');
    expect(() => schema.assign({}, { hp: 101 })).toThrow('Health.hp: 101 is above the maximum 100');
    expect(() => schema.assign({}, { mana: 1 })).toThrow("Health: 'mana' is not a property");
  });

  test('reserved names and optional data fields are rejected', () => {
    expect(() => createSchema({ update: 1 }, 'number', new Set(['update']), 'Script')).toThrow("'update' is reserved");
    expect(() => createSchema({ target: prop.f32().optional() }, 'f32', none, 'Aim')).toThrow('cannot be optional');
  });

  test('rows go into typed columns, booleans as 0 and 1', () => {
    const schema = createSchema({ hp: 100, alive: true, tag: prop.string().default('x') }, 'f32', none, 'C');
    const columns = schema.fields.map((f) => createColumn(f.options.kind, 4));
    schema.writeRow(columns, 2, { hp: 7, alive: false });
    expect(columns[0]).toBeInstanceOf(Float32Array);
    expect([columns[0]![2], columns[1]![2], columns[2]![2]]).toEqual([7, 0, 'x']);
  });

  describe('without code generation (a CSP without unsafe-eval)', () => {
    afterEach(() => vi.unstubAllGlobals());

    test('the fallback initializers behave the same', () => {
      vi.stubGlobal('Function', function () {
        throw new EvalError('code generation from strings disallowed');
      });
      const schema = createSchema({ hp: 100, alive: true, team: prop.int() }, 'f32', none, 'C');
      const columns = schema.fields.map((f) => createColumn(f.options.kind, 2));
      schema.writeRow(columns, 1, { team: 3, alive: false });
      expect([columns[0]![1], columns[1]![1], columns[2]![1]]).toEqual([100, 0, 3]);
      expect(() => schema.writeRow(columns, 0, {})).toThrow('C.team is required');
    });
  });
});
