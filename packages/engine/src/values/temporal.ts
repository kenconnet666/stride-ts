/**
 * 日期和时间的值类型，不可变，命名同 java.time（json-wire 的 Java 一侧也用这些名字）。
 *
 * 和 wasm 互通：每种都有固定的二进制表示，同 Apache Arrow 的 date32 / time64[ns] / timestamp[ns]，
 * C 侧见 StrideNative/Values.h：
 *
 * | 类型 | 存成 | 线上（json-wire 的种类） |
 * |---|---|---|
 * | LocalDate | int32：1970-01-01 起的天数 | date：`2024-01-31` |
 * | LocalTime | int64：当天零点起的纳秒 | time：`13:45:00`，秒以下有值时带小数 |
 * | LocalDateTime | int64：1970-01-01T00:00 起的纳秒（不带时区的钟面时间） | timestamp：`2024-01-31T13:45:00.5` |
 * | Instant | int64：Unix 纪元起的纳秒（UTC 的时刻） | timestamptz：`2024-01-31T05:45:00Z` |
 *
 * 日期按公历外推，年份范围 -9999..9999。
 */

const NANOS_PER_SECOND = 1_000_000_000n;
const NANOS_PER_DAY = 86_400n * NANOS_PER_SECOND;
const NANOS_PER_MILLI = 1_000_000n;

const DATE_TEXT = /^([+-]?\d{4,})-(\d{2})-(\d{2})$/;
const TIME_TEXT = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/;
const OFFSET_TEXT = /(Z|[+-]\d{2}:\d{2})$/i;

/** 公历年月日 → 1970-01-01 起的天数（Howard Hinnant 的 days_from_civil，C 侧用同一个算法）。 */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/** 1970-01-01 起的天数 → 公历年月日（civil_from_days）。 */
export function civilFromDays(days: number): [year: number, month: number, day: number] {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const dayOfEra = z - era * 146097;
  const yearOfEra = Math.floor((dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365);
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const mp = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return [yearOfEra + era * 400 + (month <= 2 ? 1 : 0), month, day];
}

function daysInMonth(year: number, month: number): number {
  return month === 2 ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
}

const pad = (value: number | bigint, width: number) => String(value).padStart(width, '0');

/** 秒以下的小数：去掉末尾的零，没有时是空串。 */
function fractionText(nanos: bigint): string {
  if (nanos === 0n) return '';
  return `.${pad(nanos, 9).replace(/0+$/, '')}`;
}

/** 向下取整的 bigint 除法和余数（余数非负），负的纳秒数换算日期时要用。 */
function floorDivide(value: bigint, divisor: bigint): [bigint, bigint] {
  let quotient = value / divisor;
  let remainder = value % divisor;
  if (remainder < 0n) {
    quotient -= 1n;
    remainder += divisor;
  }
  return [quotient, remainder];
}

export class LocalDate {
  /** 1970-01-01 起的天数，存进 int32 列的就是它。 */
  readonly epochDay: number;

  constructor(epochDay: number) {
    if (!Number.isInteger(epochDay)) throw new RangeError(`epochDay must be an integer, got ${epochDay}`);
    this.epochDay = epochDay;
  }

  static of(year: number, month: number, day: number): LocalDate {
    if (!Number.isInteger(year) || year < -9999 || year > 9999) throw new RangeError(`year ${year} is outside -9999..9999`);
    if (!Number.isInteger(month) || month < 1 || month > 12) throw new RangeError(`month ${month} is outside 1..12`);
    if (!Number.isInteger(day) || day < 1 || day > daysInMonth(year, month)) throw new RangeError(`${year}-${pad(month, 2)} has no day ${day}`);
    return new LocalDate(daysFromCivil(year, month, day));
  }

  /** 读 `YYYY-MM-DD`。 */
  static parse(text: string): LocalDate {
    const match = DATE_TEXT.exec(text.trim());
    if (!match) throw new SyntaxError(`'${text}' is not a date (YYYY-MM-DD)`);
    return LocalDate.of(Number(match[1]), Number(match[2]), Number(match[3]));
  }

  get year(): number {
    return civilFromDays(this.epochDay)[0];
  }

  get month(): number {
    return civilFromDays(this.epochDay)[1];
  }

  get day(): number {
    return civilFromDays(this.epochDay)[2];
  }

  /** 1 是星期一，7 是星期日（同 ISO 8601）。 */
  get dayOfWeek(): number {
    return (((this.epochDay + 3) % 7) + 7) % 7 + 1;
  }

  plusDays(days: number): LocalDate {
    return new LocalDate(this.epochDay + days);
  }

  /** 这一天的零点。 */
  atStartOfDay(): LocalDateTime {
    return new LocalDateTime(BigInt(this.epochDay) * NANOS_PER_DAY);
  }

  compare(other: LocalDate): -1 | 0 | 1 {
    return Math.sign(this.epochDay - other.epochDay) as -1 | 0 | 1;
  }

  equals(other: LocalDate): boolean {
    return this.epochDay === other.epochDay;
  }

  toString(): string {
    const [year, month, day] = civilFromDays(this.epochDay);
    const yearText = year < 0 ? `-${pad(-year, 4)}` : pad(year, 4);
    return `${yearText}-${pad(month, 2)}-${pad(day, 2)}`;
  }

  toJSON(): string {
    return this.toString();
  }
}

export class LocalTime {
  /** 当天零点起的纳秒，0 到 86400 秒（不含），存进 int64 列的就是它。 */
  readonly nanoOfDay: bigint;

  constructor(nanoOfDay: bigint) {
    if (nanoOfDay < 0n || nanoOfDay >= NANOS_PER_DAY) throw new RangeError(`nanoOfDay ${nanoOfDay} is outside one day`);
    this.nanoOfDay = nanoOfDay;
  }

  static of(hour: number, minute: number, second = 0, nanosecond = 0): LocalTime {
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59 || nanosecond < 0 || nanosecond > 999_999_999) {
      throw new RangeError(`${hour}:${minute}:${second}.${nanosecond} is not a time of day`);
    }
    return new LocalTime((BigInt(hour) * 3600n + BigInt(minute) * 60n + BigInt(second)) * NANOS_PER_SECOND + BigInt(nanosecond));
  }

  /** 读 `HH:MM`、`HH:MM:SS`、`HH:MM:SS.fffffffff`。 */
  static parse(text: string): LocalTime {
    const match = TIME_TEXT.exec(text.trim());
    if (!match) throw new SyntaxError(`'${text}' is not a time (HH:MM[:SS[.fffffffff]])`);
    return LocalTime.of(Number(match[1]), Number(match[2]), Number(match[3] ?? 0), Number((match[4] ?? '').padEnd(9, '0')));
  }

  get hour(): number {
    return Number(this.nanoOfDay / (3600n * NANOS_PER_SECOND));
  }

  get minute(): number {
    return Number((this.nanoOfDay / (60n * NANOS_PER_SECOND)) % 60n);
  }

  get second(): number {
    return Number((this.nanoOfDay / NANOS_PER_SECOND) % 60n);
  }

  get nanosecond(): number {
    return Number(this.nanoOfDay % NANOS_PER_SECOND);
  }

  compare(other: LocalTime): -1 | 0 | 1 {
    return this.nanoOfDay < other.nanoOfDay ? -1 : this.nanoOfDay > other.nanoOfDay ? 1 : 0;
  }

  equals(other: LocalTime): boolean {
    return this.nanoOfDay === other.nanoOfDay;
  }

  /** 总有秒，秒以下有值时带小数并去掉末尾的零：`13:45:00`、`13:45:00.5`。 */
  toString(): string {
    return `${pad(this.hour, 2)}:${pad(this.minute, 2)}:${pad(this.second, 2)}${fractionText(this.nanoOfDay % NANOS_PER_SECOND)}`;
  }

  toJSON(): string {
    return this.toString();
  }
}

/** 不带时区的日期加时间（钟面上的时间），比如关卡里定好的开放时间。 */
export class LocalDateTime {
  /** 1970-01-01T00:00 起的纳秒（钟面时间，不对应某个时刻），存进 int64 列的就是它。 */
  readonly epochNanos: bigint;

  constructor(epochNanos: bigint) {
    this.epochNanos = epochNanos;
  }

  static of(date: LocalDate, time: LocalTime): LocalDateTime {
    return new LocalDateTime(BigInt(date.epochDay) * NANOS_PER_DAY + time.nanoOfDay);
  }

  /** 读 `YYYY-MM-DDTHH:MM[:SS[.f]]`，日期和时间之间也可以是空格。 */
  static parse(text: string): LocalDateTime {
    const [date, time] = text.trim().split(/[ T]/);
    if (!date || !time) throw new SyntaxError(`'${text}' is not a date-time (YYYY-MM-DDTHH:MM:SS)`);
    return LocalDateTime.of(LocalDate.parse(date), LocalTime.parse(time));
  }

  get date(): LocalDate {
    return new LocalDate(Number(floorDivide(this.epochNanos, NANOS_PER_DAY)[0]));
  }

  get time(): LocalTime {
    return new LocalTime(floorDivide(this.epochNanos, NANOS_PER_DAY)[1]);
  }

  /** 把钟面时间当成 UTC 时间对应的时刻。 */
  toInstantUtc(): Instant {
    return new Instant(this.epochNanos);
  }

  compare(other: LocalDateTime): -1 | 0 | 1 {
    return this.epochNanos < other.epochNanos ? -1 : this.epochNanos > other.epochNanos ? 1 : 0;
  }

  equals(other: LocalDateTime): boolean {
    return this.epochNanos === other.epochNanos;
  }

  toString(): string {
    return `${this.date}T${this.time}`;
  }

  toJSON(): string {
    return this.toString();
  }
}

/** 时间线上的一个时刻（UTC），比如存档时间。和 JS 的 Date 互转时只保留到毫秒。 */
export class Instant {
  /** Unix 纪元（1970-01-01T00:00:00Z）起的纳秒，存进 int64 列的就是它。 */
  readonly epochNanos: bigint;

  constructor(epochNanos: bigint) {
    this.epochNanos = epochNanos;
  }

  static now(): Instant {
    return Instant.fromEpochMilliseconds(Date.now());
  }

  static fromEpochMilliseconds(milliseconds: number): Instant {
    if (!Number.isFinite(milliseconds)) throw new RangeError(`${milliseconds} is not a time`);
    const whole = Math.floor(milliseconds);
    return new Instant(BigInt(whole) * NANOS_PER_MILLI + BigInt(Math.round((milliseconds - whole) * 1e6)));
  }

  static fromDate(date: Date): Instant {
    return Instant.fromEpochMilliseconds(date.getTime());
  }

  /** 读带时差的 ISO 时刻：`2024-01-31T05:45:00Z`、`2024-01-31T13:45:00+08:00`，换算成 UTC。 */
  static parse(text: string): Instant {
    const trimmed = text.trim();
    const offset = OFFSET_TEXT.exec(trimmed);
    if (!offset) throw new SyntaxError(`'${text}' has no time zone offset (Z or ±HH:MM)`);
    const local = LocalDateTime.parse(trimmed.slice(0, offset.index));
    const zone = offset[1]!.toUpperCase();
    const offsetMinutes = zone === 'Z' ? 0 : (zone.startsWith('-') ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)));
    return new Instant(local.epochNanos - BigInt(offsetMinutes) * 60n * NANOS_PER_SECOND);
  }

  get epochMilliseconds(): number {
    return Number(floorDivide(this.epochNanos, NANOS_PER_MILLI)[0]);
  }

  toDate(): Date {
    return new Date(this.epochMilliseconds);
  }

  plusSeconds(seconds: number): Instant {
    return new Instant(this.epochNanos + BigInt(Math.round(seconds * 1e9)));
  }

  compare(other: Instant): -1 | 0 | 1 {
    return this.epochNanos < other.epochNanos ? -1 : this.epochNanos > other.epochNanos ? 1 : 0;
  }

  equals(other: Instant): boolean {
    return this.epochNanos === other.epochNanos;
  }

  /** UTC 写法，总有秒，小数去掉末尾的零：`2024-01-31T05:45:00Z`。 */
  toString(): string {
    return `${new LocalDateTime(this.epochNanos)}Z`;
  }

  toJSON(): string {
    return this.toString();
  }
}
