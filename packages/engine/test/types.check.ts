/**
 * Type-level checks: only tsc reads this file (pnpm typecheck), nothing runs it. Positive cases assert the
 * inferred types with Equal; negative cases pin "must not compile" with @ts-expect-error.
 */
import {
  component,
  Game,
  prop,
  SyncScript,
  system,
  tag,
  type Chunk,
  type EntityId,
  type GameTime,
  type InitOf,
  type View,
} from '../src/index';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function expect<T extends true>(): T | void {}

const Health = component({ max: prop.f32().min(0).default(100), current: 100 });
const Unit = component({
  team: prop.enum(['red', 'blue']),
  level: prop.int().default(1),
  flags: prop.u8().default(0),
  target: prop.entity().default(0 as EntityId),
  alive: prop.bool().default(true),
  label: prop.string().default(''),
});
const Dead = tag();

class Player extends SyncScript.props({
  maxRunSpeed: prop.number().min(0).default(10).unit('m/s'),
  jumpHeight: 1.2,
  name: 'hero',
  mode: prop.enum(['walk', 'run']).default('walk'),
  friend: prop.entity().optional(),
  required: prop.int(),
}) {
  override update(time: GameTime): void {
    expect<Equal<typeof this.maxRunSpeed, number>>();
    expect<Equal<typeof this.jumpHeight, number>>();
    expect<Equal<typeof this.name, string>>();
    expect<Equal<typeof this.mode, 'walk' | 'run'>>();
    expect<Equal<typeof this.friend, EntityId | undefined>>();
    expect<Equal<typeof time.elapsed, number>>();
  }
}

// Init objects: props without a default are required, the rest optional
expect<Equal<InitOf<{ a: 1; b: ReturnType<typeof prop.int> }, 'data'>, { b: number; a?: number }>>();
Player.with({ required: 1 });
Player.with({ required: 1, maxRunSpeed: 12, mode: 'run' });
// @ts-expect-error required is missing
Player.with({ maxRunSpeed: 12 });
// @ts-expect-error wrong value type
Player.with({ required: 1, maxRunSpeed: 'fast' });
// @ts-expect-error not one of the enum values
Player.with({ required: 1, mode: 'fly' });
// @ts-expect-error unknown property
Player.with({ required: 1, mana: 3 });

const game = new Game();
// Bare components and scripts only when everything has a default
game.entities.create({ components: [Health, Dead, Unit.with({ team: 'red' }), Player.with({ required: 2 })] });
// @ts-expect-error Unit has a required prop (team), so it needs .with()
game.entities.create({ components: [Unit] });
// @ts-expect-error Player has a required prop, so it needs .with()
game.entities.create({ components: [Player] });
// @ts-expect-error scripts cannot be spawned in bulk
game.entities.spawn(10, [Health, Player.with({ required: 1 })]);

// Entity access is typed by what is asked for
const e = game.entities.create({ components: [Health] });
const health = e.require(Health);
expect<Equal<typeof health, View<{ max: number; current: number }>>>();
expect<Equal<typeof health.current, number>>();
const maybeHealth = e.get(Health);
expect<Equal<typeof maybeHealth, View<{ max: number; current: number }> | undefined>>();
const player = e.get(Player);
expect<Equal<typeof player, Player | undefined>>();
const unit = e.require(Unit);
expect<Equal<typeof unit.team, 'red' | 'blue'>>();
expect<Equal<typeof unit.alive, boolean>>();

// Systems get typed columns
system({
  with: { health: Health, unit: Unit },
  without: [Dead],
  writes: [Health],
  update(chunk) {
    expect<Equal<typeof chunk.health.max, Float32Array>>();
    expect<Equal<typeof chunk.unit.level, Int32Array>>();
    expect<Equal<typeof chunk.unit.flags, Uint8Array>>();
    expect<Equal<typeof chunk.unit.alive, Uint8Array>>();
    expect<Equal<typeof chunk.unit.target, Float64Array>>();
    expect<Equal<typeof chunk.unit.team, ('red' | 'blue')[]>>();
    expect<Equal<typeof chunk.unit.label, string[]>>();
    expect<Equal<typeof chunk.count, number>>();
  },
});
expect<Equal<Chunk<{ h: typeof Health }>['h']['current'], Float32Array>>();

// @ts-expect-error count is the chunk's row count, not a query key
system({ with: { count: Health }, update: () => {} });
// @ts-expect-error writes must be one of the queried components
system({ with: { health: Health }, writes: [Unit], update: () => {} });

// Props: modifiers only where they make sense
// @ts-expect-error min is for numbers
prop.string().min(1);
// @ts-expect-error transient needs a default first
prop.f32().transient();
prop.f32().default(0).transient();
// @ts-expect-error the default must have the prop's type
prop.f32().default('1');
// @ts-expect-error enum defaults must be one of the values
prop.enum(['a', 'b']).default('c');

// Branded values cannot be mixed up
const Owner = component({ team: prop.u32().brand<'TeamId'>().default(0 as never) });
const owner = game.entities.create({ components: [Owner] }).require(Owner);
// @ts-expect-error a plain number is not a TeamId
owner.team = 3;
owner.team = 3 as typeof owner.team;
