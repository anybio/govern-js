/**
 * Reading a caller's text as the API reads it: code points, and the short
 * texts (`deliveryRef`, `reason`) with the API's trim and bounds. Shared by
 * the client and the adapters. Internal; nothing here is exported from an
 * entry point.
 */

/**
 * The characters the API trims from either end: Unicode `White_Space`. Not
 * the set `String.prototype.trim` uses, which also drops U+FEFF and keeps
 * U+0085. All are in the Basic Multilingual Plane, so one UTF-16 unit each.
 */
const WHITE_SPACE: ReadonlySet<number> = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

/** Whether a UTF-16 unit is a control character (Unicode category Cc: U+0000 to U+001F, U+007F to U+009F), which the API refuses. */
function isControl(unit: number): boolean {
  return unit <= 0x1f || (unit >= 0x7f && unit <= 0x9f);
}

/** The API's bound on `delivery_ref` and `reason`, in characters. */
export const MAX_SHORT_TEXT_CHARS = 256;

/** Code points, as the API counts them; `"a".length` and `[..."a"].length` differ on astral characters. */
export function codePoints(value: string): number {
  return [...value].length;
}

/** `value` with the API's white space trimmed from both ends. */
export function trimAsApi(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && WHITE_SPACE.has(value.charCodeAt(start))) start++;
  while (end > start && WHITE_SPACE.has(value.charCodeAt(end - 1))) end--;
  return value.slice(start, end);
}

/**
 * Why the API would refuse `value` as a `delivery_ref` or a `reason`, or
 * undefined when it would take it: it must be a string that, trimmed as the
 * API trims, is not blank, is at most 256 characters, and carries no control
 * character.
 */
export function shortTextFault(value: unknown): string | undefined {
  if (typeof value !== "string") return "is not a string";
  const trimmed = trimAsApi(value);
  if (trimmed === "") return "is blank";
  if (codePoints(trimmed) > MAX_SHORT_TEXT_CHARS) return `is longer than ${MAX_SHORT_TEXT_CHARS} characters`;
  for (let i = 0; i < trimmed.length; i++) {
    if (isControl(trimmed.charCodeAt(i))) return "carries a control character";
  }
  return undefined;
}
