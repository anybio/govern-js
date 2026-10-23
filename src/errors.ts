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
 * is a decision the caller makes for one error rather than a property of every
 * string the SDK hands to a log.
 */

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
 * hand-off action) or a different report is already recorded (an outcome that
 * disagrees with the one on file). Refresh and decide again; the SDK does not
 * retry it.
 */
export class GovernConflictError extends GovernApiError {
  override readonly name = "GovernConflictError";
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
