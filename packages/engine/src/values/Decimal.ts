/**
 * 定点小数：一个 bigint 的“单位数”加上小数位数，值 = units / 10^scale。不经过浮点，加减乘除都精确
 * （除法和缩小位数时按给定方式舍入）。
 *
 * 和 wasm 互通：数据组件里按属性声明的位数存成 int64 的单位数（同 Apache Arrow 的 decimal64，最多 18 位有效数字），
 * C 侧见 StrideNative/Values.h 的 sn_decimal64。线上写成不带科学计数法的文字，种类是 json-wire 的 `decimal`。
 */

/** 舍入方式：half-even 是银行家舍入（默认），half-up 是四舍五入，down 向零截断，floor、ceiling 向负、正无穷。 */
export type Rounding = 'half-even' | 'half-up' | 'down' | 'floor' | 'ceiling';

const DECIMAL_TEXT = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

export class Decimal {
  /** 单位数：值乘以 10^scale 之后的整数。 */
  readonly units: bigint;
  /** 小数位数，0 到 30。 */
  readonly scale: number;

  constructor(units: bigint, scale = 0) {
    if (!Number.isInteger(scale) || scale < 0 || scale > 30) throw new RangeError(`decimal scale must be an integer 0..30, got ${scale}`);
    this.units = units;
    this.scale = scale;
  }

  static readonly ZERO = new Decimal(0n);

  /**
   * 从文字、数字或 bigint 得到小数。文字可以带指数（"1e-7"）；数字按它最短的十进制写法（0.1 就是 0.1，不是
   * 0.1000000000000000055…）。给了 scale 时换算到这个位数，多出的位按 rounding 舍入。
   */
  static from(value: Decimal | string | number | bigint, scale?: number, rounding: Rounding = 'half-even'): Decimal {
    let result: Decimal;
    if (value instanceof Decimal) result = value;
    else if (typeof value === 'bigint') result = new Decimal(value);
    else if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new RangeError(`${value} is not a finite number`);
      result = Decimal.parse(String(value));
    } else result = Decimal.parse(value);
    return scale === undefined ? result : result.rescale(scale, rounding);
  }

  /** 读文字："12.50"、"-0.5"、".5"、"1e-7"。读不出时抛错。 */
  static parse(text: string): Decimal {
    const match = DECIMAL_TEXT.exec(text.trim());
    if (!match || (match[2] === '' && (match[3] ?? '') === '')) throw new SyntaxError(`'${text}' is not a decimal number`);
    const [, sign, whole = '', fraction = '', exponentText] = match;
    const exponent = exponentText ? Number(exponentText) : 0;
    let digits = whole + fraction;
    let scale = fraction.length - exponent;
    if (scale < 0) {
      digits += '0'.repeat(-scale);
      scale = 0;
    }
    const units = BigInt(digits === '' ? '0' : digits);
    return new Decimal(sign === '-' ? -units : units, scale);
  }

  /** 换算到 scale 位小数；位数减少时按 rounding 舍入。 */
  rescale(scale: number, rounding: Rounding = 'half-even'): Decimal {
    if (scale === this.scale) return this;
    if (scale > this.scale) return new Decimal(this.units * 10n ** BigInt(scale - this.scale), scale);
    return new Decimal(divideRounded(this.units, 10n ** BigInt(this.scale - scale), rounding), scale);
  }

  /** 去掉末尾的零："12.50" 变成 "12.5"。 */
  normalize(): Decimal {
    let { units, scale } = this;
    while (scale > 0 && units % 10n === 0n) {
      units /= 10n;
      scale--;
    }
    return new Decimal(units, scale);
  }

  add(other: Decimal | string | number | bigint): Decimal {
    const [a, b] = aligned(this, Decimal.from(other));
    return new Decimal(a.units + b.units, a.scale);
  }

  subtract(other: Decimal | string | number | bigint): Decimal {
    const [a, b] = aligned(this, Decimal.from(other));
    return new Decimal(a.units - b.units, a.scale);
  }

  /** 精确相乘（位数相加）；给了 scale 时再换算过去。 */
  multiply(other: Decimal | string | number | bigint, scale?: number, rounding: Rounding = 'half-even'): Decimal {
    const b = Decimal.from(other);
    const product = new Decimal(this.units * b.units, this.scale + b.scale);
    return scale === undefined ? product : product.rescale(scale, rounding);
  }

  /** 相除，结果有 scale 位小数（默认取两边位数较大者），按 rounding 舍入。除以零抛错。 */
  divide(other: Decimal | string | number | bigint, scale = Math.max(this.scale, Decimal.from(other).scale), rounding: Rounding = 'half-even'): Decimal {
    const b = Decimal.from(other);
    if (b.units === 0n) throw new RangeError('division by zero');
    // units / 10^s1 ÷ (u2 / 10^s2) = units * 10^(s2 + scale - s1) / u2，结果的单位是 10^-scale
    const shift = b.scale + scale - this.scale;
    const numerator = shift >= 0 ? this.units * 10n ** BigInt(shift) : this.units;
    const denominator = shift >= 0 ? b.units : b.units * 10n ** BigInt(-shift);
    return new Decimal(divideRounded(numerator, denominator, rounding), scale);
  }

  negate(): Decimal {
    return new Decimal(-this.units, this.scale);
  }

  abs(): Decimal {
    return this.units < 0n ? this.negate() : this;
  }

  /** -1、0、1：小于、等于、大于 other。 */
  compare(other: Decimal | string | number | bigint): -1 | 0 | 1 {
    const [a, b] = aligned(this, Decimal.from(other));
    return a.units < b.units ? -1 : a.units > b.units ? 1 : 0;
  }

  /** 数值相等（12.5 等于 12.50）。 */
  equals(other: Decimal | string | number | bigint): boolean {
    return this.compare(other) === 0;
  }

  get sign(): -1 | 0 | 1 {
    return this.units < 0n ? -1 : this.units > 0n ? 1 : 0;
  }

  /** 转成浮点数，可能丢精度；只在需要和普通数字运算时用。 */
  toNumber(): number {
    return Number(this.toString());
  }

  /** 不带科学计数法的文字，保留 scale 位小数："12.50"、"-0.05"。 */
  toString(): string {
    const negative = this.units < 0n;
    const digits = (negative ? -this.units : this.units).toString().padStart(this.scale + 1, '0');
    const whole = digits.slice(0, digits.length - this.scale);
    const fraction = digits.slice(digits.length - this.scale);
    return `${negative ? '-' : ''}${whole}${this.scale > 0 ? `.${fraction}` : ''}`;
  }

  /** JSON.stringify 写成文字，不丢精度。 */
  toJSON(): string {
    return this.toString();
  }
}

/** 两个小数换算到相同的位数（取较大者），不丢精度。 */
function aligned(a: Decimal, b: Decimal): [Decimal, Decimal] {
  const scale = Math.max(a.scale, b.scale);
  return [a.rescale(scale), b.rescale(scale)];
}

/** 整数除法，按 rounding 处理余数。 */
function divideRounded(numerator: bigint, denominator: bigint, rounding: Rounding): bigint {
  if (denominator < 0n) {
    numerator = -numerator;
    denominator = -denominator;
  }
  const quotient = numerator / denominator; // 向零截断
  const remainder = numerator % denominator;
  if (remainder === 0n) return quotient;
  const negative = numerator < 0n;
  const twice = (remainder < 0n ? -remainder : remainder) * 2n;
  const away = negative ? quotient - 1n : quotient + 1n;
  switch (rounding) {
    case 'down':
      return quotient;
    case 'floor':
      return negative ? quotient - 1n : quotient;
    case 'ceiling':
      return negative ? quotient : quotient + 1n;
    case 'half-up':
      return twice >= denominator ? away : quotient;
    case 'half-even':
      if (twice > denominator) return away;
      if (twice < denominator) return quotient;
      return quotient % 2n === 0n ? quotient : away;
  }
}
