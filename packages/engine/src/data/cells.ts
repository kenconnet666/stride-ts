/**
 * bigint、小数、日期时间这几种属性在三个地方的样子：init 里传的写法、脚本拿到的值对象、数据组件列里的原始值
 * （int64 或 int32，和 wasm 那边 StrideNative/Values.h 的布局相同）。这里负责它们之间的检查和换算。
 */
import { Decimal } from './Decimal';
import { Instant, LocalDate, LocalDateTime, LocalTime } from './temporal';
import type { PropKind, PropOptions } from './prop';

/** 在列里要编码存放的种类：脚本和视图看到值对象，系统看到原始的 int64 / int32。 */
export const ENCODED_KINDS: ReadonlySet<PropKind> = new Set(['i64', 'u64', 'decimal', 'date', 'time', 'datetime', 'instant']);

const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;
const U64_MAX = 2n ** 64n - 1n;

/** 值哪里不对；没问题时是 undefined。 */
export function cellIssue(options: PropOptions, value: unknown): string | undefined {
  try {
    toValue(options, value);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** init 或默认值 → 脚本里的值（bigint、Decimal、LocalDate……）；不合法时抛错。 */
export function toValue(options: PropOptions, value: unknown): unknown {
  switch (options.kind) {
    case 'i64':
    case 'u64': {
      const big = toBigInt(value);
      const [min, max] = options.kind === 'i64' ? [I64_MIN, I64_MAX] : [0n, U64_MAX];
      if (big < min || big > max) throw new RangeError(`${big} is outside the ${options.kind} range`);
      return big;
    }
    case 'decimal':
      return toDecimal(options, value);
    case 'date':
      if (value instanceof LocalDate) return value;
      if (typeof value === 'string') return LocalDate.parse(value);
      throw new TypeError(`${describe(value)} is not a date (LocalDate or 'YYYY-MM-DD')`);
    case 'time':
      if (value instanceof LocalTime) return value;
      if (typeof value === 'string') return LocalTime.parse(value);
      throw new TypeError(`${describe(value)} is not a time (LocalTime or 'HH:MM:SS')`);
    case 'datetime':
      if (value instanceof LocalDateTime) return value;
      if (typeof value === 'string') return LocalDateTime.parse(value);
      throw new TypeError(`${describe(value)} is not a date-time (LocalDateTime or 'YYYY-MM-DDTHH:MM:SS')`);
    case 'instant':
      if (value instanceof Instant) return value;
      if (value instanceof Date) return Instant.fromDate(value);
      if (typeof value === 'string') return Instant.parse(value);
      throw new TypeError(`${describe(value)} is not an instant (Instant, Date, or ISO text with an offset)`);
    case 'bytes':
      if (value instanceof Uint8Array) return new Uint8Array(value);
      throw new TypeError(`${describe(value)} is not a Uint8Array`);
    default:
      return value;
  }
}

/** 值 → 列里存的原始值。 */
export function toCell(options: PropOptions, value: unknown): number | bigint {
  const v = toValue(options, value);
  switch (options.kind) {
    case 'decimal':
      return (v as Decimal).units;
    case 'date':
      return (v as LocalDate).epochDay;
    case 'time':
      return (v as LocalTime).nanoOfDay;
    case 'datetime':
    case 'instant':
      return (v as LocalDateTime | Instant).epochNanos;
    default:
      return v as bigint;
  }
}

/** 列里存的原始值 → 值对象（视图读字段时用）。 */
export function fromCell(options: PropOptions, raw: number | bigint): unknown {
  switch (options.kind) {
    case 'decimal':
      return new Decimal(raw as bigint, options.scale ?? 0);
    case 'date':
      return new LocalDate(raw as number);
    case 'time':
      return new LocalTime(raw as bigint);
    case 'datetime':
      return new LocalDateTime(raw as bigint);
    case 'instant':
      return new Instant(raw as bigint);
    default:
      return raw;
  }
}

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())) return BigInt(value.trim());
  throw new TypeError(`${describe(value)} is not an integer (bigint, safe integer, or integer text)`);
}

/** 换算到属性声明的位数；多出的小数位、超过有效数字位数都报错，不悄悄舍入。 */
function toDecimal(options: PropOptions, value: unknown): Decimal {
  if (!(value instanceof Decimal) && !['string', 'number', 'bigint'].includes(typeof value)) {
    throw new TypeError(`${describe(value)} is not a decimal (Decimal, text, number or bigint)`);
  }
  const scale = options.scale ?? 0;
  const given = Decimal.from(value as Decimal | string | number | bigint);
  const normalized = given.normalize();
  if (normalized.scale > scale) throw new RangeError(`${given} has more than ${scale} decimal places`);
  const result = given.rescale(scale);
  const digits = (result.units < 0n ? -result.units : result.units).toString().length;
  const precision = options.precision ?? 18;
  if (digits > precision) throw new RangeError(`${given} has more than ${precision} significant digits`);
  return result;
}

function describe(value: unknown): string {
  return typeof value === 'object' && value !== null ? `a ${value.constructor?.name ?? 'object'}` : String(value);
}
