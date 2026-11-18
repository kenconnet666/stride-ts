/**
 * 类型层面的检查：只有 tsc 读这个文件（pnpm typecheck），不运行。正例用 Equal 断言推导出的类型，
 * 负例用 @ts-expect-error 固定“必须编译失败”。
 */
import {
  component,
  Game,
  prop,
  ScriptComponent,
  SyncScript,
  system,
  tag,
  validator,
  type Chunk,
  type ColorLike,
  type EntityId,
  type GameTime,
  type InitOf,
  type Stat,
  type Vec3Like,
  type Vector3,
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

// init 对象：没有默认值的属性必填，其余可选
expect<Equal<InitOf<{ a: 1; b: ReturnType<typeof prop.int> }, 'data'>, { readonly b: number; readonly a?: number }>>();
Player.with({ required: 1 });
Player.with({ required: 1, maxRunSpeed: 12, mode: 'run' });
// @ts-expect-error 缺了必填的 required
Player.with({ maxRunSpeed: 12 });
// @ts-expect-error 值的类型不对
Player.with({ required: 1, maxRunSpeed: 'fast' });
// @ts-expect-error 不是枚举里的值
Player.with({ required: 1, mode: 'fly' });
// @ts-expect-error 没有这个属性
Player.with({ required: 1, mana: 3 });

const game = new Game();
// 只有全部属性都有默认值的组件和脚本才能直接列出
game.entities.create({ components: [Health, Dead, Unit.with({ team: 'red' }), Player.with({ required: 2 })] });
// @ts-expect-error Unit 有必填属性 team，要用 .with()
game.entities.create({ components: [Unit] });
// @ts-expect-error Player 有必填属性，要用 .with()
game.entities.create({ components: [Player] });
// @ts-expect-error 脚本不能批量生成
game.entities.spawn(10, [Health, Player.with({ required: 1 })]);

// 从实体取东西，类型由取的是什么决定
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

// 系统拿到带类型的列
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

// @ts-expect-error count 是 chunk 的行数，不能当查询键名
system({ with: { count: Health }, update: () => {} });
// @ts-expect-error writes 必须是查询里的组件
system({ with: { health: Health }, writes: [Unit], update: () => {} });

// 属性：修饰方法只能用在说得通的地方
// @ts-expect-error min 只给数字用
prop.string().min(1);
// @ts-expect-error transient 要先有默认值
prop.f32().transient();
prop.f32().default(0).transient();
// @ts-expect-error 默认值要和属性同类型
prop.f32().default('1');
// @ts-expect-error 枚举的默认值必须是其中之一
prop.enum(['a', 'b']).default('c');

// 带品牌的值不能混用
const Owner = component({ team: prop.u32().brand<'TeamId'>().default(0 as never) });
const owner = game.entities.create({ components: [Owner] }).require(Owner);
// @ts-expect-error 普通数字不是 TeamId
owner.team = 3;
owner.team = 3 as typeof owner.team;

// ---- 补充功能 ----

// 向量：脚本里是 Vector3，init 可以给元组或 {x,y,z}；数据组件的视图是活的 Vec3Like，列是 Float32Array
class Flyer extends SyncScript.props({
  offset: prop.vec3(),
  waypoints: prop.list(prop.vec3()),
  shape: prop.union('kind', { box: { size: prop.vec3() }, sphere: { radius: prop.number() } }),
  speed: prop.number().min(0).default(5).stat(),
  steer: prop.number().default(0).sealed(),
  volume: prop.number().default(1).inherit(),
  // 引用自己或互相引用的脚本：base 表达式里只要出现自己的类名就是循环（TS2506），
  // 所以先引用基类 ScriptComponent，再在类体里用 declare 收窄成真正的类型
  target: prop.component(() => ScriptComponent).optional(),
  health: prop.component(() => Health),
}, { variants: { fast: { speed: 9 } } }) {
  declare target: Flyer | undefined;

  override update(): void {
    expect<Equal<typeof this.offset, Vector3>>();
    expect<Equal<typeof this.waypoints, Vector3[]>>();
    expect<Equal<typeof this.shape, { kind: 'box'; size: Vector3 } | { kind: 'sphere'; radius: number }>>();
    const speed: Stat = this.stats.speed;
    // @ts-expect-error 只有标了 stat() 的属性才有 Stat
    void this.stats.volume;
    void speed;
    const target: Flyer | undefined = this.target; // declare 收窄后可以直接当 Flyer 用
    target?.update();
    expect<Equal<typeof this.health.current, number>>();
  }
}
const health0 = new Game().entities.create({ components: [Health] }).require(Health);
Flyer.with({ offset: [1, 2, 3], shape: { kind: 'sphere', radius: 1 }, health: health0 });
Flyer.with({ offset: { x: 1, y: 2, z: 3 }, shape: { kind: 'box' }, health: health0 });
// @ts-expect-error sealed 的属性不能给值
Flyer.with({ shape: { kind: 'box' }, health: health0, steer: 1 });
// @ts-expect-error union 的 kind 必须是已知的
Flyer.with({ shape: { kind: 'cone' }, health: health0 });
// @ts-expect-error 向量是三个数
Flyer.with({ offset: [1, 2], shape: { kind: 'box' }, health: health0 });
Flyer.variant('fast', { shape: { kind: 'box' }, health: health0 });
// @ts-expect-error 没有这个变体
Flyer.variant('slow');
// @ts-expect-error stat 要求有默认值的数字
prop.string().default('a').stat();

const Paint = component({ tint: prop.color(), position: prop.vec3(), gloss: prop.f32().default(0.5).inherit() });
const paint = new Game().entities.create({ components: [Paint] }).require(Paint);
expect<Equal<typeof paint.tint, ColorLike>>();
expect<Equal<typeof paint.position, Vec3Like>>();
expect<Equal<Chunk<{ p: typeof Paint }>['p']['position'], Float32Array>>();
// @ts-expect-error 数据组件只收能放进列的种类
component({ items: prop.list(prop.int()) });

// 作用域默认值只收 inherit() 的属性
const scoped = new Game();
scoped.defaults.set(Paint, { gloss: 0.2 });
scoped.defaults.set(Flyer, { volume: 0.3 });
// @ts-expect-error tint 没有标 inherit()
scoped.defaults.set(Paint, { tint: [1, 0, 0, 1] });

// 校验器的输出类型就是 init 的类型
const healthValidator = validator(Health);
expect<Equal<NonNullable<typeof healthValidator['~standard']['types']>['output'], Parameters<typeof Health.with>[0]>>();