/**
 * Reading a caller's time value, shared by the client and the adapters.
 * Internal; nothing here is exported from an entry point.
 */

/**
 * An RFC 3339 date-time, the API's `format: date-time`: a full date, a time
 * with seconds, and a zone (`T`, `Z` and the zone letter in either case, as
 * RFC 3339 allows). A date alone, a time without a zone, or any other text
 * `Date.parse` happens to accept is not one.
 */
const RFC3339_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/;

/** Days in a month of the proleptic Gregorian calendar. */
function daysIn(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/**
 * Whether a string is a valid RFC 3339 date-time, decided from its fields
 * and not by `Date.parse`, which rolls an impossible date over (the 30th of
 * February becomes the 2nd of March), refuses a leap second, and reads the
 * lower-case letters RFC 3339 allows differently from one engine to the next.
 */
function isRfc3339DateTime(value: string): boolean {
  const m = RFC3339_DATE_TIME.exec(value);
  if (!m) return false;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysIn(year, month)) return false;
  // 60 is a leap second, which RFC 3339 allows.
  if (hour > 23 || minute > 59 || second > 60) return false;
  if (m[7] !== undefined && (Number(m[7]) > 23 || Number(m[8]) > 59)) return false;
  return true;
}

/**
 * A time as an outcome report sends it, or `undefined` when the value does
 * not name one. A Date is recognised by its tag, so one from another realm
 * counts, and becomes its ISO string. A string must be a valid RFC 3339
 * date-time and is sent as given; anything looser is refused, since the API
 * would answer it with 400 after the report had left its slot.
 */
export function timeValue(value: unknown): string | undefined {
  if (typeof value === "string") return isRfc3339DateTime(value) ? value : undefined;
  if (Object.prototype.toString.call(value) === "[object Date]") {
    const time = Date.prototype.getTime.call(value);
    return Number.isNaN(time) ? undefined : new Date(time).toISOString();
  }
  return undefined;
}
