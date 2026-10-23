/**
 * Webhook verification and parsing.
 *
 * The recipe, from the sender: `X-Govern-Timestamp` is the unix time of the
 * attempt in seconds; `X-Govern-Signature` is `v1=` followed by the lowercase
 * hex of `HMAC-SHA256(secret, "{timestamp}.{body}")` where `body` is the exact
 * bytes of the request body. `X-Govern-Event` names the event and
 * `X-Govern-Delivery` is the delivery id (the same id is `id` in the body).
 *
 * Verify the raw body before parsing it. A body that has been through
 * `JSON.parse` and `JSON.stringify` is not the bytes that were signed.
 */

import { hmacSha256Hex, timingSafeEqual } from "./crypto";
import { GovernConfigError, GovernWebhookError } from "./errors";
import type { StopClass } from "./types";

export const WEBHOOK_HEADERS = {
  timestamp: "x-govern-timestamp",
  signature: "x-govern-signature",
  event: "x-govern-event",
  delivery: "x-govern-delivery",
} as const;

export const WEBHOOK_EVENTS = {
  decisionReleased: "decision.released",
  decisionRejected: "decision.rejected",
  handoffOpened: "handoff.opened",
  handoffClaimed: "handoff.claimed",
  handoffResolved: "handoff.resolved",
  handoffResumed: "handoff.resumed",
} as const;

export type HeadersLike =
  | Headers
  | Record<string, string | string[] | undefined>
  | { get(name: string): string | null | undefined };

export interface WebhookOptions {
  /**
   * Reject deliveries whose timestamp is further than this from now. Default
   * 300 seconds; 0 disables the check, which is the only way to ask for that.
   * Anything else that is not a finite count of seconds (a negative, a NaN,
   * an Infinity) is refused with `GovernConfigError`.
   */
  toleranceSeconds?: number;
  /**
   * Current unix time in seconds; for tests. Must return a finite number:
   * anything else cannot be compared with a delivery's timestamp, and is
   * refused with `GovernConfigError` rather than read as "inside the window".
   */
  now?: () => number;
}

interface EnvelopeFields {
  /** The delivery id. */
  id: string;
  attempt: number;
  createdAt: string;
  applicationId: string;
  /** When the event happened. */
  at: string;
  raw: Record<string, unknown>;
}

export type DecisionWebhookEvent = EnvelopeFields & {
  type: "decision.released" | "decision.rejected";
  decisionId: string;
  conversationId: string;
  turnId: string;
  channel: string;
  reviewState: "released" | "rejected";
  reviewer: { role: string | null };
  /** Present on `decision.released`: the text to deliver. */
  releasedContent: string | null;
  releasedWith: string | null;
  /** The model named for the turn, as the decision recorded it. Null when none was named. */
  model: string | null;
  modelVersion: string | null;
  /**
   * Which kind of stop the draft was. On a rejection it tells a reviewer's
   * judgement (`uncertain`) from a draft that was never releasable
   * (`never_sendable`). A class this version does not know reads as
   * `uncertain`, as on `Decision.stopClass`; null from a server that predates it.
   */
  stopClass: StopClass | null;
};

export type HandoffWebhookEvent = EnvelopeFields & {
  type: "handoff.opened" | "handoff.claimed" | "handoff.resolved" | "handoff.resumed";
  handoffId: string;
  decisionId: string | null;
  patientRefHash: string | null;
  state: string;
  version: number;
  queueLabel: string | null;
  assigned: boolean;
  dueAt: string | null;
  resolvedAt: string | null;
  /**
   * Whether this hand-off pauses automated messaging to the patient while a
   * person works it; an item that only owes a reply does not. The event does
   * not carry `automation_resumed_at`: the pause ends at `handoff.resumed`,
   * and `govern.handoffs.get` with `isAutomationPaused` answers for the
   * current state. A server that predates the field reads as true.
   */
  pausesAutomation: boolean;
};

export type UnknownWebhookEvent = EnvelopeFields & {
  type: "unknown";
  /** The event name the sender used. */
  event: string;
};

export type WebhookEvent = DecisionWebhookEvent | HandoffWebhookEvent | UnknownWebhookEvent;

export interface VerifiedWebhook {
  timestamp: number;
  event: string | null;
  deliveryId: string | null;
  /** The body as text, once verified. */
  body: string;
}

/**
 * Produce the signature header value for a body; the sender's recipe, for
 * tests and mock servers. Throws `GovernConfigError` without a secret, for
 * the same reason verification does.
 */
export async function signWebhookPayload(
  secret: string,
  timestamp: number,
  body: string | Uint8Array,
): Promise<string> {
  requireSecret(secret, "signWebhookPayload");
  return `v1=${await hmacSha256Hex(secret, signedMessage(timestamp, body))}`;
}

/**
 * Verify the signature and timestamp. Throws `GovernWebhookError` when the
 * delivery fails to verify, and `GovernConfigError` when the options cannot be
 * honoured: a handler that answers 400 to a `GovernWebhookError` should not
 * answer 400 to its own configuration.
 */
export async function verifyWebhookSignature(
  rawBody: string | Uint8Array | ArrayBuffer,
  headers: HeadersLike,
  secret: string,
  options: WebhookOptions = {},
): Promise<VerifiedWebhook> {
  // Both checks come before anything about the delivery: a call that cannot
  // be made correctly is answered the same way every time, rather than on the
  // calls that happen to reach the check.
  requireSecret(secret, "verifyWebhookSignature");
  const tolerance = options.toleranceSeconds ?? 300;
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new GovernConfigError(
      "verifyWebhookSignature: toleranceSeconds must be a finite number of seconds, zero or more. Pass 0 to accept a delivery of any age on purpose; a negative or non-finite value did that silently, which is a replay window left open by accident.",
    );
  }
  const bodyBytes = toBytes(rawBody);
  const timestampHeader = header(headers, WEBHOOK_HEADERS.timestamp);
  const signatureHeader = header(headers, WEBHOOK_HEADERS.signature);
  if (!timestampHeader || !signatureHeader) {
    throw new GovernWebhookError("missing X-Govern-Timestamp or X-Govern-Signature header");
  }
  const timestamp = Number(timestampHeader.trim());
  if (!Number.isInteger(timestamp)) {
    throw new GovernWebhookError("X-Govern-Timestamp is not an integer");
  }
  if (tolerance > 0) {
    const now = options.now ? options.now() : Math.floor(Date.now() / 1000);
    // `Math.abs(NaN - timestamp) > tolerance` is false, so a clock that does
    // not answer with a time would read as "inside the window" and let a
    // delivery of any age through. It is refused as a configuration error,
    // like a tolerance that is not a window.
    if (!Number.isFinite(now)) {
      throw new GovernConfigError(
        "verifyWebhookSignature: the `now` option must return the current unix time in seconds as a finite number. A value that is not one cannot be compared with the delivery's timestamp, which leaves the replay window open.",
      );
    }
    if (Math.abs(now - timestamp) > tolerance) {
      throw new GovernWebhookError("X-Govern-Timestamp is outside the accepted window");
    }
  }
  const expected = await signWebhookPayload(secret, timestamp, bodyBytes);
  const candidates = signatureHeader
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.startsWith("v1="));
  const matched = candidates.some((candidate) => timingSafeEqual(candidate, expected));
  if (!matched) throw new GovernWebhookError("webhook signature does not match");
  return {
    timestamp,
    event: header(headers, WEBHOOK_HEADERS.event),
    deliveryId: header(headers, WEBHOOK_HEADERS.delivery),
    body: new TextDecoder().decode(bodyBytes),
  };
}

/** Verify a delivery and return the typed event. */
export async function handleWebhook(
  rawBody: string | Uint8Array | ArrayBuffer,
  headers: HeadersLike,
  secret: string,
  options: WebhookOptions = {},
): Promise<WebhookEvent> {
  const verified = await verifyWebhookSignature(rawBody, headers, secret, options);
  let parsed: unknown;
  try {
    parsed = JSON.parse(verified.body);
  } catch {
    throw new GovernWebhookError("webhook body is not JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new GovernWebhookError("webhook body is not a JSON object");
  }
  return parseEvent(parsed as Record<string, unknown>, verified.event);
}

export function parseEvent(raw: Record<string, unknown>, headerEvent: string | null): WebhookEvent {
  const event = str(raw.event) ?? headerEvent ?? "unknown";
  const envelope: EnvelopeFields = {
    id: str(raw.id) ?? "",
    attempt: num(raw.attempt) ?? 1,
    createdAt: str(raw.created_at) ?? "",
    applicationId: str(raw.application_id) ?? "",
    at: str(raw.at) ?? "",
    raw,
  };
  switch (event) {
    case WEBHOOK_EVENTS.decisionReleased:
    case WEBHOOK_EVENTS.decisionRejected: {
      const reviewer = raw.reviewer && typeof raw.reviewer === "object" ? (raw.reviewer as Record<string, unknown>) : {};
      return {
        ...envelope,
        type: event,
        decisionId: str(raw.decision_id) ?? "",
        conversationId: str(raw.conversation_id) ?? "",
        turnId: str(raw.turn_id) ?? "",
        channel: str(raw.channel) ?? "",
        reviewState: event === WEBHOOK_EVENTS.decisionReleased ? "released" : "rejected",
        reviewer: { role: str(reviewer.role) },
        releasedContent: event === WEBHOOK_EVENTS.decisionReleased ? str(raw.released_content) : null,
        releasedWith: str(raw.released_with),
        model: str(raw.model),
        modelVersion: str(raw.model_version),
        stopClass: raw.stop_class === undefined || raw.stop_class === null ? null : raw.stop_class === "never_sendable" ? "never_sendable" : "uncertain",
      };
    }
    case WEBHOOK_EVENTS.handoffOpened:
    case WEBHOOK_EVENTS.handoffClaimed:
    case WEBHOOK_EVENTS.handoffResolved:
    case WEBHOOK_EVENTS.handoffResumed:
      return {
        ...envelope,
        type: event,
        handoffId: str(raw.handoff_id) ?? "",
        decisionId: str(raw.decision_id),
        patientRefHash: str(raw.patient_ref_hash),
        state: str(raw.state) ?? "",
        version: num(raw.version) ?? 0,
        queueLabel: str(raw.queue_label),
        assigned: raw.assigned === true,
        dueAt: str(raw.due_at),
        resolvedAt: str(raw.resolved_at),
        pausesAutomation: raw.pauses_automation !== false,
      };
    default:
      return { ...envelope, type: "unknown", event };
  }
}

/**
 * A missing secret is a configuration error, not a failed verification: there
 * is no secret to check the signature against, so it is reported as a
 * `GovernConfigError` rather than a `GovernWebhookError`.
 */
function requireSecret(secret: string, fn: string): void {
  if (typeof secret !== "string" || secret.trim() === "") {
    throw new GovernConfigError(
      `${fn}: a webhook secret is required. Pass the application's signing secret (\`whsec_...\`); an empty or blank one cannot verify anything.`,
    );
  }
}

function signedMessage(timestamp: number, body: string | Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode(`${timestamp}.`);
  const bodyBytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const out = new Uint8Array(prefix.length + bodyBytes.length);
  out.set(prefix, 0);
  out.set(bodyBytes, prefix.length);
  return out;
}

function toBytes(body: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  // `new Uint8Array(aParsedBody)` is zero bytes, which would verify as an
  // empty body and answer "signature does not match". A parsed body is the
  // mistake this module's doc comment warns about, so it is named here.
  throw new GovernConfigError(
    "verifyWebhookSignature: the body must be the raw request body, as a string, a Uint8Array (a Node Buffer is one) or an ArrayBuffer. A body that has been through JSON.parse, or no body at all, is not the bytes that were signed, so there is nothing a signature can be checked against.",
  );
}

function header(headers: HeadersLike, name: string): string | null {
  if (typeof (headers as { get?: unknown }).get === "function") {
    const value = (headers as { get(name: string): string | null | undefined }).get(name);
    return value ?? null;
  }
  const record = headers as Record<string, string | string[] | undefined>;
  const key = Object.keys(record).find((k) => k.toLowerCase() === name);
  if (!key) return null;
  const value = record[key];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
