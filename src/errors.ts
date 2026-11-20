/**
 * Error classes. No error message ever carries message content: they are built
 * from HTTP status codes and the server's machine-readable `kind`, both of
 * which this SDK knows the shape of.
 *
 * The server's own error text is not in that set. The evaluate 400 is
 * documented as covering invalid *content*, and the document declares no
 * schema for the body, so what is in it is the server's business and may
 * change without this package moving. It is kept off `.message` and out of
 * every event, and parked on `GovernApiError.serverMessage`, where reading it
 * is a decision the caller makes for one error, not a property of every
 * string the SDK hands to a log.
 */

import type { ReportedOutcomeKind } from "./types";

const MAX_SERVER_MESSAGE_CHARS = 300;

export class GovernError extends Error {
  override readonly name: string = "GovernError";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The SDK was constructed or called in a way it cannot honour. */
export class GovernConfigError extends GovernError {
  override readonly name = "GovernConfigError";
}

/** The API answered with a non-2xx status. */
export class GovernApiError extends GovernError {
  override readonly name: string = "GovernApiError";
  readonly status: number;
  /** The server's machine-readable error kind (for example `BAD_REQUEST_ERROR`), when it sent one. */
  readonly kind: string | null;
  /** Whether the SDK considered the failure retryable (429 and 5xx). */
  readonly retryable: boolean;
  /** Milliseconds the server asked us to wait, from `Retry-After`, when it sent one. */
  readonly retryAfterMs: number | null;
  /**
   * The server's own error text, collapsed to one line and bounded, or `null`.
   *
   * Deliberately not part of `.message`: an error message is the string that
   * ends up in a log line, an alert and a bug report, and the SDK cannot
   * promise what a server put in this one. Read it when you are debugging a
   * call, and treat what comes back the way you treat the message it was
   * about.
   */
  readonly serverMessage: string | null;

  constructor(input: {
    status: number;
    kind: string | null;
    serverMessage: string | null;
    retryable: boolean;
    retryAfterMs: number | null;
  }) {
    super(`AnyBio Govern API responded ${input.status}${input.kind ? ` (${input.kind})` : ""}`);
    this.status = input.status;
    this.kind = input.kind;
    this.retryable = input.retryable;
    this.retryAfterMs = input.retryAfterMs;
    this.serverMessage = input.serverMessage === null ? null : truncate(input.serverMessage);
  }
}

/**
 * 409: the resource changed under you (a stale `expectedVersion` on a
 * hand-off action, a `retryOf` or `supersedes` naming a decision that moved
 * on) or a different outcome event of the same kind is already recorded.
 * Refresh and decide again; the SDK does not retry it.
 */
export class GovernConflictError extends GovernApiError {
  override readonly name = "GovernConflictError";
}

/**
 * An outcome report an adapter made failed: the error the adapters pass to
 * `onError` for a report that did not land. It carries the event exactly as
 * it was sent, so the caller can send the identical event again with
 * `reportOutcome`:
 *
 *   govern.reportOutcome(error.decisionId, { kind: error.kind, at: error.at, contentHash: error.contentHash, deliveryRef: error.deliveryRef, reason: error.reason }).catch(log)
 *
 * The same `at` makes it the same event: the API answers a resend of an event
 * that did land with 200 and records nothing, where a resend with a new `at`
 * would be a different event (a 409, or a second row for `failed`). The
 * failure itself is `cause`: a `GovernConflictError` when a different event
 * of that kind is already on record (resending changes nothing), a
 * `GovernApiError`, `GovernNetworkError` or `GovernTimeoutError` when the
 * transport gave up, a `GovernConfigError` when a field was refused before
 * anything was sent. Never message text: the hash, not the content.
 */
export class GovernReportError extends GovernError {
  override readonly name = "GovernReportError";
  readonly decisionId: string;
  /** The kind the event had: from an adapter, `released` or `discarded`. */
  readonly kind: ReportedOutcomeKind;
  /** The event's `at`, as it was sent. */
  readonly at: string;
  /** The SHA-256 hex the event carried, on `released` and `delivered`; null otherwise, and when nothing was sent. */
  readonly contentHash: string | null;
  /** The reference as sent, or as given when nothing was sent; trimmed as the API trims it either way. Null when there was none. */
  readonly deliveryRef: string | null;
  /** The reason code, as `deliveryRef` is. Null when there was none. */
  readonly reason: string | null;

  constructor(input: {
    decisionId: string;
    kind: ReportedOutcomeKind;
    at: string;
    contentHash: string | null;
    deliveryRef: string | null;
    reason: string | null;
    cause: unknown;
  }) {
    const why = input.cause instanceof Error ? `${input.cause.name}: ${input.cause.message}` : String(input.cause);
    super(`AnyBio Govern could not record the ${input.kind} outcome of decision ${input.decisionId}: ${why}`, { cause: input.cause });
    this.decisionId = input.decisionId;
    this.kind = input.kind;
    this.at = input.at;
    this.contentHash = input.contentHash;
    this.deliveryRef = input.deliveryRef;
    this.reason = input.reason;
  }
}

/** The request could not be sent or no response arrived. */
export class GovernNetworkError extends GovernError {
  override readonly name = "GovernNetworkError";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** One attempt exceeded `timeoutMs`. */
export class GovernTimeoutError extends GovernError {
  override readonly name = "GovernTimeoutError";
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`AnyBio Govern request timed out after ${timeoutMs} ms`);
    this.timeoutMs = timeoutMs;
  }
}

/** The caller's `AbortSignal` fired. */
export class GovernAbortError extends GovernError {
  override readonly name = "GovernAbortError";

  constructor(reason?: unknown) {
    super("AnyBio Govern request aborted", reason === undefined ? undefined : { cause: reason });
  }
}

/** A webhook delivery failed verification or could not be parsed. */
export class GovernWebhookError extends GovernError {
  override readonly name = "GovernWebhookError";
}

/** The API surface called is not available to this application. */
export class GovernNotAvailableError extends GovernError {
  override readonly name = "GovernNotAvailableError";
}

function truncate(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_SERVER_MESSAGE_CHARS
    ? `${oneLine.slice(0, MAX_SERVER_MESSAGE_CHARS)}...`
    : oneLine;
}

export function isGovernError(error: unknown): error is GovernError {
  return error instanceof GovernError;
}
