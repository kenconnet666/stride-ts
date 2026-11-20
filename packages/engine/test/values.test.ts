// 值类型（Decimal、日期时间）、和 json-wire 兼容的线上格式，以及对应的属性和列。
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  civilFromDays,
  component,
  daysFromCivil,
  Decimal,
  fromWire,
  Game,
  Instant,
  LocalDate,
  LocalDateTime,
  LocalTime,
  prop,
  SyncScript,
  system,
  toWire,
  wireText,
} from '../src/index';

describe('Decimal', () => {
  test('读写文字不经过浮点，保留位数', () => {
    expect(Decimal.parse('12.50').toString()).toBe('12.50');
    expect(Decimal.parse('1e-7').toString()).toBe('0.0000001');
    expect(Decimal.parse('-.5').toString()).toBe('-0.5');
    expect(Decimal.from(0.1).add(0.2).toString()).toBe('0.3');
    expect(Decimal.parse('12.50').normalize().toString()).toBe('12.5');
    expect(() => Decimal.parse('1,5')).toThrow('is not a decimal');
  });

  test('乘除和换算位数按指定方式舍入', () => {
    expect(Decimal.parse('2.5').multiply('1.25').toString()).toBe('3.125');
    expect(Decimal.parse('10').divide(3, 4).toString()).toBe('3.3333');
    expect(Decimal.parse('12.25').rescale(1).toString()).toBe('12.2'); // 银行家舍入
    expect(Decimal.parse('12.35').rescale(1).toString()).toBe('12.4');
    expect(Decimal.parse('12.25').rescale(1, 'half-up').toString()).toBe('12.3');
    expect(Decimal.parse('-1.21').rescale(1, 'floor').toString()).toBe('-1.3');
    expect(Decimal.parse('12.5').equals('12.50')).toBe(true);
    expect(() => Decimal.from(1).divide(0)).toThrow('division by zero');
  });
});

describe('日期和时间', () => {
  // 和 Jolt 的 fork 里 StrideNative 的 RuntimeTests.cpp 用同一组对照值（由 JS 的 Date 独立算出），两边算法一致
  const cases: [number, number, number, number][] = [
    [1970, 1, 1, 0], [1969, 12, 31, -1], [2000, 3, 1, 11017], [2024, 1, 31, 19753], [2024, 2, 29, 19782],
    [1900, 3, 1, -25508], [1600, 2, 29, -135081], [-1, 12, 31, -719529], [9999, 12, 31, 2932896],
  ];

  test('年月日和 1970-01-01 起的天数互换，和 C 侧相同', () => {
    for (const [year, month, day, days] of cases) {
      expect(daysFromCivil(year, month, day)).toBe(days);
      expect(civilFromDays(days)).toEqual([year, month, day]);
    }
    expect(LocalDate.of(2024, 1, 31).dayOfWeek).toBe(3); // 星期三
    expect(() => LocalDate.of(2023, 2, 29)).toThrow('has no day 29');
  });

  test('文字写法同 json-wire：时间总有秒，小数去掉末尾的零，时刻换算成 UTC', () => {
    expect(LocalDate.parse('2024-01-31').toString()).toBe('2024-01-31');
    expect(LocalTime.parse('13:45').toString()).toBe('13:45:00');
    expect(LocalDateTime.parse('2024-01-31 13:45:00.500').toString()).toBe('2024-01-31T13:45:00.5');
    expect(Instant.parse('2024-01-31T13:45:00+08:00').toString()).toBe('2024-01-31T05:45:00Z');
    expect(Instant.fromDate(new Date(Date.UTC(1969, 11, 31, 23))).toString()).toBe('1969-12-31T23:00:00Z');
    expect(new LocalDateTime(-3_600_000_000_000n).date.toString()).toBe('1969-12-31');
    expect(Instant.parse('2024-01-31T05:45:00.123Z').toDate().toISOString()).toBe('2024-01-31T05:45:00.123Z');
  });
});

describe('线上格式（和 json-wire 兼容）', () => {
  const sample = readFileSync(new URL('./fixtures/json-wire-order.json', import.meta.url), 'utf8');

  test('读 json-wire 的样例 spec/order.json，再写回去，结果相同', () => {
    const order = fromWire<Record<string, any>>(JSON.parse(sample));
    expect(order.id).toBe(9007199254740993n);
    expect(order.ratio).toBeNaN();
    expect(order.amount).toBeInstanceOf(Decimal);
    expect(order.on).toBeInstanceOf(LocalDate);
    expect(order.at).toBeInstanceOf(LocalTime);
    expect(order.created).toBeInstanceOf(LocalDateTime);
    expect(order.sent).toBeInstanceOf(Instant);
    expect([...order.file]).toEqual([1, 2, 3, 255]);
    expect(order.lines[0].qty.toString()).toBe('2.75');
    expect(order.tags).toEqual([1n, 2n]);
    expect(order.byMonth['2024.01'].toString()).toBe('3.5');
    expect(toWire(order)).toEqual(JSON.parse(sample));
  });

  test('根不是对象时包成 $value；同一路径两种值报错', () => {
    expect(toWire([1n, 2n])).toEqual({ $value: ['1', '2'], $types: { $value: 'bigint' } });
    expect(fromWire({ $value: ['1'], $types: { $value: 'bigint' } })).toEqual([1n]);
    expect(() => toWire({ a: [Decimal.parse('1'), 'x'] })).toThrow('both decimal and text');
    expect(wireText(Decimal.parse('1e-7'))).toBe('0.0000001');
  });
});

describe('属性和列', () => {
  test('数据组件把它们存成 int64 / int32 列，视图和脚本看到值对象', () => {
    const Ledger = component({
      balance: prop.decimal(2).default('0'),
      id: prop.i64().default(0n),
      opened: prop.date().default('2024-01-01'),
      lastSeen: prop.instant().default('1970-01-01T00:00:00Z'),
    });
    const game = new Game();
    const e = game.entities.create({ components: [Ledger.with({ balance: '12.5', id: 2n ** 62n, opened: LocalDate.of(2024, 1, 31) })] });
    const ledger = e.require(Ledger);
    expect(ledger.balance.toString()).toBe('12.50');
    expect(ledger.id).toBe(2n ** 62n);
    expect(ledger.opened.toString()).toBe('2024-01-31');
    ledger.lastSeen = Instant.parse('2024-01-31T05:45:00Z');

    let raw: (number | bigint)[] = [];
    game.entities.addSystems(
      system({
        with: { ledger: Ledger },
        update({ ledger: columns }) {
          // 系统看到的是原始值：小数的单位数、天数、纳秒，和 C 侧的 sn_decimal64、sn_date、sn_instant 相同
          raw = [columns.balance[0]!, columns.opened[0]!, columns.lastSeen[0]!];
        },
      }),
    );
    game.updateTime.advance(1 / 60);
    game.entities.update(game.updateTime);
    expect(raw).toEqual([1250n, 19753, 1_706_679_900_000_000_000n]);
  });

  test('小数位数和有效数字超出声明时报错，不悄悄舍入', () => {
    const Price = component({ value: prop.decimal(2, 6).default('0') });
    const game = new Game();
    expect(() => game.entities.create({ components: [Price.with({ value: '1.005' })] })).toThrow('more than 2 decimal places');
    expect(() => game.entities.create({ components: [Price.with({ value: '12345.67' })] })).toThrow('more than 6 significant digits');
    expect(() => game.entities.create({ components: [Price.with({ value: 'abc' })] })).toThrow('is not a decimal');
  });

  test('脚本里同样是值对象，bytes 每个实例各有一份', () => {
    class Save extends SyncScript.props({ when: prop.instant().default('2024-01-31T05:45:00Z'), blob: prop.bytes(), seq: prop.u64().default(1) }) {}
    const game = new Game();
    const a = game.entities.create({ components: [Save] }).require(Save);
    const b = game.entities.create({ components: [Save.with({ when: new Date(0), seq: 7 })] }).require(Save);
    expect(a.when.toString()).toBe('2024-01-31T05:45:00Z');
    expect(b.when.epochNanos).toBe(0n);
    expect(b.seq).toBe(7n);
    expect(a.blob).not.toBe(b.blob);
    expect(() => game.entities.create({ components: [Save.with({ seq: -1 })] })).toThrow('outside the u64 range');
  });
});
