import { describe, expect, expectTypeOf, test } from 'vitest';
import { checkFields } from '../../src/editor/fields/fieldValues';
import { s, SchemaError, schemaFields, type Infer, type InputOf } from '../../src/editor/fields/schema';

const stock = s.object({
  products: s.list(s.asset('product')),
  variants: s.integer(1, 20).default(3),
  messiness: s.number({ min: 0, max: 1 }).default(0.5).describe('how messy'),
  levels: s.list(s.string()).optional(),
  tag: s.oneOf('paper', 'electronic').default('paper'),
  offset: s.vector(3).optional(),
});

describe('有类型的模式', () => {
  test('类型：解析以后有默认值的必有，文件里可以不写；optional 两边都可选；oneOf 是字面量的并集、vector 是定长的元组', () => {
    type Stock = Infer<typeof stock>;
    type StockFile = InputOf<typeof stock>;
    expectTypeOf<Stock['messiness']>().toEqualTypeOf<number>();
    expectTypeOf<Stock['tag']>().toEqualTypeOf<'paper' | 'electronic'>();
    expectTypeOf<Stock['products']>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<Stock>().toHaveProperty('levels');
    expectTypeOf<{ products: string[] }>().toExtend<StockFile>();
    expectTypeOf<{ variants: number }>().not.toExtend<StockFile>();
    expectTypeOf<NonNullable<Stock['offset']>>().toEqualTypeOf<readonly [number, number, number]>();
    const shape = s.union('kind', { box: { size: s.vector(3) }, sphere: { radius: s.number() } }, { name: s.string().optional() });
    type Shape = Infer<typeof shape>;
    expectTypeOf<Extract<Shape, { kind: 'sphere' }>['radius']>().toEqualTypeOf<number>();
    expectTypeOf<{ kind: 'box'; size: [1, 2, 3] }>().toExtend<InputOf<typeof shape>>();
  });

  test('parse：补默认值（深拷贝、不改原来的），写了的照旧；不对的一起报、带路径', () => {
    const file = { products: ['P/Oil'], levels: ['a'] };
    const parsed = stock.parse(file, 'Deli.shelf.json');
    expect(parsed).toEqual({ products: ['P/Oil'], levels: ['a'], variants: 3, messiness: 0.5, tag: 'paper' });
    expect(file).toEqual({ products: ['P/Oil'], levels: ['a'] });
    const error = (() => {
      try {
        stock.parse({ products: 'P/Oil', messiness: 2, extra: 1 }, 'X.shelf.json');
      } catch (e) {
        return e as SchemaError;
      }
    })();
    expect(error).toBeInstanceOf(SchemaError);
    expect(error!.issues).toEqual(expect.arrayContaining([
      expect.stringMatching(/^X\.shelf\.json\.products: expected a list/),
      expect.stringMatching(/^X\.shelf\.json\.messiness: expected a number in 0\.\.1/),
      expect.stringMatching(/^X\.shelf\.json\.extra: /),
    ]));
    expect(stock.safeParse({ products: [] })).toEqual({ value: { products: [], variants: 3, messiness: 0.5, tag: 'paper' } });
  });

  test('嵌套的对象、列表里的对象、几种形状之一里也补默认值', () => {
    const shelf = s.object({ stock: s.object({ messiness: s.number().default(0.5) }).default({ messiness: 0.5 }), parts: s.list(s.object({ n: s.number().default(1) })) });
    expect(shelf.parse({ stock: {}, parts: [{}, { n: 2 }] })).toEqual({ stock: { messiness: 0.5 }, parts: [{ n: 1 }, { n: 2 }] });
    expect(shelf.parse({ parts: [] })).toEqual({ stock: { messiness: 0.5 }, parts: [] });
    const shape = s.union('kind', { box: { size: s.number().default(1) } });
    expect(shape.parse({ kind: 'box' })).toEqual({ kind: 'box', size: 1 });
  });

  test('换成编辑器的字段描述：同一套检查，字段带上可选、默认值、说明', () => {
    const fields = schemaFields(stock);
    expect(fields.find((field) => field.name === 'messiness')).toEqual({ name: 'messiness', type: { kind: 'number', min: 0, max: 1 }, optional: true, default: 0.5, description: 'how messy' });
    expect(checkFields({ products: [] }, stock.type, 'v')).toEqual([]);
    expect(checkFields({}, stock.type, 'v')).toEqual(['v.products: missing']);
  });

  test('Standard Schema：~standard.validate 给 { value } 或 { issues }', () => {
    expect(stock['~standard'].validate({ products: [] })).toEqual({ value: { products: [], variants: 3, messiness: 0.5, tag: 'paper' } });
    const result = stock['~standard'].validate({});
    expect('issues' in result && result.issues?.[0]?.message).toMatch(/products: missing/);
  });
});
