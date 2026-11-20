/**
 * Recognising an `AbortSignal`, shared by the client and the adapters.
 * Internal; nothing here is exported from an entry point.
 */

import { GovernConfigError } from "./errors";

/** An `AbortSignal`, recognised by shape so one from another realm or a polyfill still counts. */
export function isAbortSignal(value: unknown): value is AbortSignal {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { aborted?: unknown; addEventListener?: unknown; removeEventListener?: unknown };
  return (
    typeof candidate.aborted === "boolean" &&
    typeof candidate.addEventListener === "function" &&
    typeof candidate.removeEventListener === "function"
  );
}

/**
 * A signal option as given: an `AbortSignal`, or no bound at all
 * (`undefined` or `null`, which a JavaScript caller writes as
 * `maybeSignal ?? null`). Anything else is refused: dropped in silence, it
 * would leave a bound the caller believes is in place unenforced. `where`
 * names the option in the error.
 */
export function requireAbortSignal(value: unknown, where: string): AbortSignal | undefined {
  if (value === undefined || value === null) return undefined;
  if (isAbortSignal(value)) return value;
  const slip = typeof value === "object" && "signal" in value ? " (pass `controller.signal`, not the controller)" : "";
  const kind = typeof value === "function" ? "a function" : typeof value === "object" ? "an object that is not a signal" : `a ${typeof value}`;
  throw new GovernConfigError(`${where} must be an AbortSignal${slip}; it was ${kind}.`);
}
