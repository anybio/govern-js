/**
 * Public types. The wire shapes come from `src/generated/openapi.ts`, which is
 * generated from `spec/openapi.json`; the ergonomic shapes here are
 * hand-authored on top and carry the wire object as `raw`. The generated
 * shapes follow the current API document. Where the document requires a
 * field that a server predating it omits, the exported wire type marks it
 * optional (see `MaybeAbsent` below), and the mapped fields tolerate its
 * absence.
 */

import type { components } from "./generated/openapi";

export type Schemas = components["schemas"];

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** `sms` | `app_message` | `web_chat` | `voice` | `email` */
export type Channel = Schemas["GovernChannel"];
/** `patient` | `clinician` */
export type Audience = Schemas["GovernAudience"];
/** `off` | `observe` | `enforce` */
export type Mode = Schemas["GovernMode"];
/**
 * `allow` | `hold` | `block`, plus `route_to_human` should a server ever send
 * it as the decision value itself. Routing to a person is reported on
 * `routeToHuman`, beside `decision`. Any other value is normalised fail
 * closed (see `Decision.unknownDecision`).
 */
export type DecisionVerdict = Schemas["GovernDecision"] | "route_to_human";
/** `pending` | `decided` | `unavailable` | `not_evaluated` */
export type DecisionStatus = Schemas["DecisionStatus"];
/** `pending` | `released` | `rejected` */
export type ReviewState = Schemas["ReviewState"];
/**
 * What kind of stop a stopped draft is. `never_sendable`: a deterministic rule
 * matched the message itself (a prohibited claim from your policy, or the
 * medication-instruction floor), and no reviewer can release it.
 * `uncertain`: held because nobody has read it yet, and a reviewer can release
 * it. Null when nothing was stopped, and only then.
 */
export type StopClass = "never_sendable" | "uncertain";

export const CHANNELS: readonly Channel[] = ["sms", "app_message", "web_chat", "voice", "email"];

/**
 * The in-session channels: the patient is in the session and waiting in it
 * for the reply, so a reply there answers them. `web_chat` and `app_message`:
 * the patient opened the chat or the app thread. `voice`: an in-call turn has
 * the patient on the line, whoever dialed. On any hold or block the hold text
 * is shown there (`showHoldText` true), including when the API could not be
 * reached. `sms` and `email` are outbound: each message is a new contact.
 *
 * This split is about replying inside a channel that is already open. It is
 * not the consent split: `voice` requires a consent by default, because an
 * unsolicited call is a new contact, and is in-session here, because a turn
 * in a connected call is not.
 */
export const IN_SESSION_CHANNELS: readonly Channel[] = ["web_chat", "app_message", "voice"];

/**
 * Whether a channel is in-session (`web_chat`, `app_message`, `voice`).
 * `sms`, `email` and any value this version does not know are outbound: for a
 * patient audience a hold there shows nothing unless `sendHoldingLine` says a
 * holding line is owed. An unknown channel fails closed that way. A clinician
 * hold shows its notice on every channel.
 *
 * The one place the SDK classifies a channel: `guard`, the `Decision` mapping
 * and every adapter read it, and the known outbound set is derived from it.
 * The API applies the same classification, and says so on every decision as
 * `show_hold_text`, which wins when it is sent (see
 * `GuardResult.showHoldText`).
 */
export function isInSessionChannel(channel: unknown): boolean {
  return typeof channel === "string" && (IN_SESSION_CHANNELS as readonly string[]).includes(channel);
}

/**
 * The outbound channels this version knows (`sms`, `email`): every channel in
 * `CHANNELS` that is not in `IN_SESSION_CHANNELS`, derived here so the
 * classification has one source. A value this version does not know is in
 * neither list and is treated as outbound. Not exported from the package.
 */
export const OUTBOUND_CHANNELS: readonly Channel[] = CHANNELS.filter((channel) => !IN_SESSION_CHANNELS.includes(channel));

/** Whether a channel is one of the outbound channels this version knows. Not exported from the package. */
export function isOutboundChannel(channel: unknown): boolean {
  return typeof channel === "string" && (OUTBOUND_CHANNELS as readonly string[]).includes(channel);
}
export const AUDIENCES: readonly Audience[] = ["patient", "clinician"];

/** Reason codes the API returns. Safe to log; never patient text. */
export const REASONS = {
  policyMissing: "policy_missing",
  gateUnavailable: "gate_unavailable",
  prohibitedClaim: "prohibited_claim",
  /**
   * The draft told a patient to start, stop or change a medication or a dose.
   * A deterministic floor: the stop is `never_sendable`.
   */
  medicationInstruction: "medication_instruction",
  missingDisclaimer: "missing_disclaimer",
  clinicalClaim: "clinical_claim",
  reviewRequired: "review_required",
  patientRewriteWithheld: "patient_rewrite_withheld",
  disclosureMissing: "disclosure_missing",
  heldForReview: "held_for_review",
  rewritten: "rewritten",
  notEvaluated: "not_evaluated",
  /** The patient opted out: `block`, on every channel. */
  optedOut: "opted_out",
  /**
   * No `granted` consent on record, on a channel that requires one, for a turn
   * that answers nothing the patient sent: `block`. A turn that carries the
   * patient's `inbound` proceeds.
   */
  consentMissing: "consent_missing",
  /** The consent on record was revoked: `block`, on every outbound channel. */
  consentRevoked: "consent_revoked",
  /** The patient is over the application's cap in the current window: `hold`. */
  frequencyCap: "frequency_cap",
  /**
   * The patient-state store (opt-out, consent, the cap) could not be read, so
   * nothing is known about whether this patient may be messaged. Always beside
   * `gate_unavailable`. `sendHoldingLine` is false on it: another message could
   * be the wrong thing, not merely an unnecessary one.
   */
  patientStateUnavailable: "patient_state_unavailable",
  /**
   * SDK-only: the API answered and refused the call, and would refuse it again.
   * A revoked or wrong application key, a key not bound to the application, a
   * request the server will not accept. `guard` still holds in enforce, so
   * nothing reaches a patient, but the thing to check is the integration's own
   * configuration, not the API's availability: this does not heal on its own.
   */
  clientMisconfigured: "client_misconfigured",
  /**
   * SDK-only: the API refused the turn with 409 because the record moved
   * under it: the decision a `retryOf` names was already superseded,
   * retried or delivered, or a reviewer acted on it first, or one a
   * `supersedes` names was an enforce decision still being decided, or was
   * delivered, reviewed, superseded or retried. A race on shared state, not
   * a misconfiguration.
   * `guard` still holds in enforce; refresh the decision and decide again.
   */
  turnConflict: "turn_conflict",
  /** SDK-only: the server sent a decision value this version does not know. */
  unknownDecision: "unknown_decision",
} as const;

/**
 * What became of a decision's reply, as one event of its outcome trail and
 * as the trail's derived `state`:
 *
 * - `released`: your application wrote the reply to its channel (sent the
 *   SMS, started speaking it, posted it to the chat).
 * - `delivered`: the channel confirmed the reply reached the person (a
 *   delivery receipt, a read receipt, playback that finished).
 * - `discarded`: the reply was dropped before it reached anyone (the person
 *   spoke over it, the session ended, nothing was sent).
 * - `failed`: an attempt to deliver it failed (a bounce, a carrier
 *   rejection, a speech synthesis error).
 * - `superseded`: a later turn replaced it (a retry, or `supersedes`).
 *   Written by the API only.
 */
export type OutcomeKind = Schemas["OutcomeKind"];
/** The kinds a caller records: every `OutcomeKind` but `superseded`, which only the API writes. */
export type ReportedOutcomeKind = Exclude<OutcomeKind, "superseded">;
/**
 * Who recorded an event: `caller` (your application, through
 * `reportOutcome` or an adapter), `retry` (the API, when it accepted a retry
 * of the decision), `supersedes` (the API, when a later turn named the
 * decision in `supersedes`), `channel` (the channel's own delivery receipt).
 */
export type OutcomeSource = Schemas["OutcomeSource"];

/**
 * The reason codes the SDK writes on the `discarded` events the adapters
 * record. Safe to log; never message text.
 */
export const OUTCOME_REASONS = {
  /** A `deliveredText` hook answered `null` or empty text: nothing of the reply went out. */
  nothingDelivered: "nothing_delivered",
  /** The adapter handed over no text: a hold whose hold text is not shown (`showHoldText` false). */
  nothingToSend: "nothing_to_send",
  /** The caller cancelled the stream or the run while the gate decided, so the reply reached no one. */
  cancelled: "cancelled",
  /** Handing the reply over failed: the stream could not be closed with it. */
  notHandedOver: "not_handed_over",
} as const;

// ---------------------------------------------------------------------------
// Wire types (as generated, with the fields an older server omits optional)
// ---------------------------------------------------------------------------

/**
 * `T` with the fields `K` optional: fields the current API document marks
 * required that a server predating them omits. The generated types follow
 * the document; the exported ones say what a caller can count on.
 */
type MaybeAbsent<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

/**
 * The decision view. `flagged`, `matches`, `show_hold_text`, `retryable` and
 * `supersedes` are optional here although the API document requires them: a
 * server that predates them omits them. The mapped fields on `Decision`
 * already default the first four (`showHoldText` falls back to the channel
 * rule, `retryable` to false). `supersedes`, `turn_ref` and `superseded_by`
 * are not mapped: read them on `Decision.raw`.
 */
export type WireDecision = MaybeAbsent<
  Schemas["DecisionView"],
  "flagged" | "matches" | "show_hold_text" | "retryable" | "supersedes"
>;
/** The evaluate request, as generated. `EvaluateInput.turnRef` and `EvaluateInput.supersedes` are sent as its `turn_ref` and `supersedes`. */
export type WireEvaluateRequest = Schemas["EvaluateRequest"];
/** One outcome event: `{ kind, at, content_hash?, delivery_ref?, reason? }`. */
export type WireOutcomeRequest = Schemas["OutcomeRequest"];
/** A decision's outcome on the wire: `{ state, events }`. */
export type WireOutcome = Schemas["OutcomeView"];
/** One event of the outcome trail, on the wire. */
export type WireOutcomeEvent = Schemas["OutcomeEvent"];
export type WireDisclosureRequest = Schemas["RecordDisclosureRequest"];
export type WireDisclosure = Schemas["DisclosureView"];
export type WirePolicyRef = Schemas["PolicyRef"];

export type WireTranscriptBatch = Schemas["TranscriptBatch"];
export type WireTranscriptTurn = Schemas["TranscriptTurn"];
export type WireTranscriptJob = Schemas["TranscriptJobView"];
export type WireTranscriptTurnView = Schemas["TranscriptTurnView"];
export type WirePatientState = Schemas["PatientStateView"];
export type WireConsentRequest = Schemas["ConsentRequest"];
export type WireOptOutRequest = Schemas["OptOutRequest"];
export type WireWebhookDelivery = Schemas["WebhookDeliveryView"];
export type WireHandoffRef = Schemas["HandoffRef"];
export type WireInboundFlag = Schemas["InboundFlag"];
/**
 * A hand-off row. `kind` is optional here although the API document requires
 * it: a server that predates it omits it.
 */
export type WireCareHandoff = MaybeAbsent<Schemas["CareHandoff"], "kind">;
/** One hand-off with its events and decisions; its `handoff` is a `WireCareHandoff`. */
export type WireHandoffDetail = Omit<Schemas["ExternalHandoffDetail"], "handoff"> & { handoff: WireCareHandoff };
/** A page of hand-offs; its `items` are `WireCareHandoff` rows. */
export type WireHandoffList = Omit<Schemas["HandoffList"], "items"> & { items: WireCareHandoff[] };

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface DisclosureAttachment {
  /** Your own assertion that the disclosure was shown; informational. */
  established?: boolean;
  /** The `ref` returned by `recordDisclosure`. */
  ref?: string;
}

export interface InboundMessage {
  /** The patient's message this turn answers. */
  content: string;
  receivedAt: Date | string;
}

/** One red-flag rule the inbound matched. Rule id and category only; never the text. */
export interface InboundFlag {
  ruleId: string;
  category: string;
}

/** The hand-off task a decision opened or joined, as the decision shows it. */
export interface HandoffRef {
  id: string;
  /** `queued` | `claimed` | `resolved` */
  state: string;
  version: number;
  queueLabel: string;
  assignedTo: string | null;
  dueAt: string | null;
  escalationDueAt: string | null;
  resolvedAt: string | null;
  /**
   * When a person released the hold on automation for this patient. Null
   * says only that a person owns the item; whether automation is paused
   * meanwhile is `pausesAutomation`. Read the two together, or call
   * `isAutomationPaused`.
   */
  automationResumedAt: string | null;
  /**
   * Whether this hand-off also pauses automated messaging to the patient
   * while a person works it. A red flag, an exhausted budget, a missing
   * policy, an unknown wire outcome and the route-to-human path all pause;
   * an item that only owes the patient a reply does not. Automation is
   * paused while `pausesAutomation` is true and `automationResumedAt` is
   * null: see `isAutomationPaused`. A server that predates the field reads
   * as true, which is what every open hand-off meant before it existed.
   */
  pausesAutomation: boolean;
}

/**
 * Whether automated messaging to this hand-off's patient is paused now: the
 * API's rule, `pauses_automation && automation_resumed_at == null`. A person
 * owning the item is not enough; an item that only owes the patient a reply
 * leaves automation running. Takes a `HandoffRef` (as on `Decision.handoff`
 * and `GuardResult.handoff`) or a wire hand-off row (`Handoff`, the items of
 * `govern.handoffs.list`, `HandoffDetail.handoff`). A row from a server that
 * predates `pauses_automation` reads as paused while it is not resumed,
 * which is what it meant then. Null or undefined is not paused: there is no
 * hand-off.
 */
export function isAutomationPaused(
  handoff: HandoffRef | WireCareHandoff | WireHandoffRef | null | undefined,
): boolean {
  if (!handoff) return false;
  if ("pausesAutomation" in handoff) {
    return handoff.pausesAutomation && handoff.automationResumedAt == null;
  }
  const wire = handoff as { pauses_automation?: unknown; automation_resumed_at?: unknown };
  return wire.pauses_automation !== false && wire.automation_resumed_at == null;
}

export interface EvaluateInput {
  /** Your identifier for the thread. */
  conversationId: string;
  /** Your identifier for this message; the idempotency key. A replay returns the stored decision. */
  turnId: string;
  channel: Channel;
  audience: Audience;
  /** The draft your AI produced. */
  content: string;
  /** Your opaque patient identifier. The API stores only its SHA-256. */
  patientRef?: string;
  disclosure?: DisclosureAttachment;
  /** Free JSON, stored and never evaluated. Keep patient text out of it. */
  metadata?: Record<string, unknown>;
  /** Advisory; the application's configured mode decides. */
  modeHint?: Mode;
  /** The patient's inbound message, for the red-flag screen. */
  inbound?: InboundMessage;
  /**
   * The model your application ran for this turn, as you would want a
   * reviewer to read a period by (for example `gpt-4o`). Recorded as sent and
   * counted in the observe report's `by_model`; never checked against anything.
   */
  model?: string;
  /** That model's version: the resolved snapshot the provider reported, when it reports one. Either may be sent without the other. */
  modelVersion?: string;
  /**
   * The decision this turn retries, sent as `retry_of`: the `id` of a stopped
   * turn whose decision came back `retryable`, answered with a new draft under
   * a new `turnId` in the same conversation, for the same patient. The new
   * draft is judged as any other turn. Must be a decision id (a UUID); any
   * other value is refused with `GovernConfigError` before anything is sent.
   *
   * The named decision must be recorded for this turn's `patientRef`: the
   * same value, or neither has one. If you set `patientRef` per call, keep it
   * on the retry. The API refuses with `400` a value that does not name a
   * decision that was ever retryable in this conversation, and one recorded
   * for another `patientRef`:
   * `retry_of must name a decision for the same patient_ref`.
   * It refuses with `409` a retry of a decision another turn named in
   * `supersedes`, a second retry of the same decision, a retry of a decision
   * with a `delivered` event on record
   * (`retry_of names a decision that was delivered`), and a retry of a
   * decision a reviewer released or rejected while it was retryable.
   *
   * The retried decision keeps its own report: what you did with it (nothing
   * was shown, so `discarded`, or no report). The API adds its own
   * `superseded` event (source `retry`) when it applies the retry, and the
   * derived state puts `superseded` above `discarded`, `failed` and
   * `released`. A refused retry changes nothing. `null` is no retry, as
   * `undefined` is.
   */
  retryOf?: string | null;
  /**
   * Your stable reference for the patient turn, sent as `turn_ref`: the same
   * on every draft written for that turn, a speculative re-send and a retry
   * included, where `turnId` differs per draft. At most `MAX_TURN_REF_CHARS`
   * (128) characters; a blank or longer value is refused with
   * `GovernConfigError` before anything is sent. A retry sent without one
   * takes its parent's. `null` is none, as `undefined` is.
   */
  turnRef?: string | null;
  /**
   * The decisions this turn replaces, sent as `supersedes`: earlier drafts of
   * the same patient turn that will not be spoken or sent, such as a
   * speculative reply the channel discarded. At most `MAX_SUPERSEDES` (8)
   * decision ids (UUIDs); anything else is refused with `GovernConfigError`
   * before the request is built. The API would refuse a list over 8 with
   * `400` too; the SDK refuses it first, with `GovernConfigError`.
   *
   * The named decisions must be recorded for this turn's `patientRef`: the
   * same value, or neither has one. The API refuses with `400` an id named
   * twice, the decision in `retryOf`, a decision of another application or
   * conversation, and one recorded for another `patientRef`:
   * `supersedes must name decisions for the same patient_ref`.
   * It refuses with `409` an enforce decision still being decided, a
   * decision with a `delivered` event on record, one a reviewer already
   * released or rejected, and one another turn already superseded or
   * retried. A refused turn records nothing, for any decision in the list.
   *
   * Where the API applies it, each named decision leaves the review queue and
   * gets a `superseded` event (source `supersedes`) beside its own report,
   * which stays yours to make: what was written of it, or `discarded`. When
   * this turn is an enforce `allow`, the hand-off a named stopped turn opened
   * is resolved with the disposition `resolved_by_supersession`
   * (`resolved_by_retry` when the decision in `retryOf` is on it), provided
   * nothing else on it is owed and nobody has claimed it or acted on it;
   * otherwise it stays open, with a note naming this decision. An API that
   * does not take the field ignores it. An empty list is none; `null` is
   * none, as `undefined` is.
   */
  supersedes?: readonly string[] | null;
  signal?: AbortSignal;
}

/**
 * One outcome event for `reportOutcome`. The API keeps one event per kind
 * per decision, `failed` excepted: the same event again (the same `kind`,
 * `at`, hash, `deliveryRef` and `reason`) is accepted and records nothing,
 * and a different event of a kind already on record is refused with 409
 * (`GovernConflictError`). A delivery can fail more than once, so `failed`
 * repeats.
 */
export interface ReportOutcomeInput {
  /**
   * `released` when your application wrote the reply to its channel,
   * `delivered` when the channel confirmed it reached the person,
   * `discarded` when it was dropped before it reached anyone, `failed` when
   * an attempt to deliver it failed. `superseded` is written by the API only
   * and is refused with `GovernConfigError`, as is any other value.
   */
  kind: ReportedOutcomeKind;
  /**
   * When it happened: a Date, or an RFC 3339 date-time string
   * (`2026-09-16T10:00:00Z`). Required, so that sending the same report
   * again is the same event: the API reads a different `at` as a different
   * event, which is a 409 for every kind but `failed`.
   */
  at: Date | string;
  /**
   * The text released or delivered. Hashed locally with SHA-256; the text
   * itself is never sent. `released` and `delivered` require it or
   * `contentHash`; `discarded` and `failed` refuse both. Empty text, like
   * `null`, is no text.
   */
  content?: string | null;
  /**
   * A precomputed SHA-256 of the text, in place of `content`: 64 hex
   * characters, either case; anything else is refused with
   * `GovernConfigError`. Blank, like `null`, is absent.
   */
  contentHash?: string | null;
  /**
   * Your own reference for the delivery (a message id on your channel).
   * Trimmed as the API trims it (Unicode white space at either end), it must
   * not be blank, must be at most 256 characters and must carry no control
   * character; anything else is refused with `GovernConfigError`. Sent
   * trimmed. `null` is none.
   */
  deliveryRef?: string | null;
  /**
   * A short reason code, such as why a reply was discarded or why an
   * attempt failed. Never message text. Bounded as `deliveryRef` is, and
   * sent trimmed. `null` is none.
   */
  reason?: string | null;
  signal?: AbortSignal;
}

export interface RecordDisclosureInput {
  conversationId: string;
  channel: Channel;
  /** The disclosure text the patient was shown, verbatim. */
  textShown: string;
  /** When it was shown. Default: now. */
  at?: Date | string;
  signal?: AbortSignal;
}

export interface WaitForReleaseOptions {
  /** Give up after this long and resolve `null`. Default fifteen minutes. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** First poll interval. Default 1000 ms; doubles up to `maxIntervalMs`. */
  intervalMs?: number;
  /** Default 15000 ms. */
  maxIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export interface PolicyRef {
  id: string;
  name: string;
  version: number;
}

/** One event of a decision's outcome trail. */
export interface OutcomeEvent {
  kind: OutcomeKind;
  source: OutcomeSource;
  /** When it happened, as the writer said. */
  at: string;
  /** When the API recorded it. */
  recordedAt: string;
  /** The SHA-256 hex of the text, on `released` and `delivered` only. */
  contentHash: string | null;
  deliveryRef: string | null;
  reason: string | null;
  /** Whether `contentHash` matches the content the record says was deliverable; `null` with no hash, or when there was nothing to compare. */
  hashMatchesRelease: boolean | null;
  /** The decision that replaced this one, on `superseded` only. */
  supersededBy: string | null;
  raw: WireOutcomeEvent;
}

/**
 * What became of a decision's reply: the events on record, in the order the
 * API recorded them, and the `state` they add up to, which the API derives
 * and never stores: `delivered` if a delivered event exists, else
 * `superseded`, else `discarded`, else `failed`, else `released`.
 */
export interface Outcome {
  state: OutcomeKind;
  events: OutcomeEvent[];
  raw: WireOutcome;
}

/** A decision as the SDK presents it: camelCase, with the wire object on `raw`. */
export interface Decision {
  /** Absent only when the channel is `off` (nothing was evaluated or recorded). */
  id: string | null;
  status: DecisionStatus;
  decision: DecisionVerdict;
  mode: Mode;
  channel: Channel;
  audience: Audience;
  conversationId: string;
  turnId: string;
  /**
   * Observe only: the raw gate decision (`allow` | `flag` | `block_and_review`
   * | `policy_missing`) or `unavailable`. Decisions recorded before `flag`
   * replaced `rewrite` keep `rewrite`.
   */
  wouldHave: string | null;
  policy: PolicyRef | null;
  /** Reason codes, safe to log. */
  reasons: string[];
  rationale: string | null;
  detectedClaims: string[];
  /** The policy requires the AI-identity disclosure and none is on record for the conversation. */
  disclosureRequired: boolean;
  /** Console deep link for your own reviewers, present when the decision is or was in the review queue. */
  reviewUrl: string | null;
  reviewState: ReviewState | null;
  /** Clinician audience only: the gate's term substitution, when there is one to deliver. Never present for a patient audience. */
  deliverableContent: string | null;
  /** Present once a reviewer released the held message: what to deliver. */
  releasedContent: string | null;
  /**
   * What kind of stop this is, when the draft was stopped: `never_sendable`
   * (never released, in either form) or `uncertain` (a reviewer may release
   * it). In observe it describes the stop that would have been, read beside
   * `wouldHave`. Null when nothing was stopped.
   */
  stopClass: StopClass | null;
  /**
   * Send your holding line now: the fixed text your clinical owner wrote in
   * advance, saying a person will reply, when, and what to do if it is
   * urgent. The API says when; the text is yours and is never model-written.
   *
   * True at most once per `id` per `Govern` instance. The API returns the same
   * flag on every read of a decision (a replayed `turnId`, `getDecision`,
   * `waitForRelease`), so the SDK arms it on the first read that carries it
   * and returns false on every later one. It is never true on an allow, on a
   * released or rejected hold, or when the stop is `opted_out`,
   * `consent_missing`, `consent_revoked`, `frequency_cap` or
   * `patient_state_unavailable`: there, another message is the wrong thing.
   * The API also answers false in observe, where nothing was stopped.
   * The memory is in process and bounded; an application that runs more than
   * one process records the send itself, keyed on the decision id.
   * `raw.send_holding_line` is the API's own value, unfiltered.
   */
  sendHoldingLine: boolean;
  /**
   * Whether the hold text is to be shown or sent for this decision: the same
   * rule as `GuardResult.showHoldText`, from the same function. The API's
   * `show_hold_text` when it sends one, else the SDK's channel rule; on an
   * outbound channel it is never true where `sendHoldingLine` is false, so a
   * replayed read does not hand out the holding line twice. Always false on
   * an allow. `raw.show_hold_text` is the API's own value, unfiltered.
   */
  showHoldText: boolean;
  /**
   * The API says your application may write ONE new draft for this stopped
   * turn and evaluate it with `retryOf` set to this `id`: a patient turn held
   * in enforce for the draft's own content (a clinical claim, a missing
   * disclaimer), `uncertain`, and still pending review. False for everything
   * else, and once the retry was accepted or a reviewer acted. On a retryable
   * hold, evaluate the retry before showing anything, and show the hold text
   * only if the retry is stopped too, by the retry's own `showHoldText`.
   * False from a server that predates the field.
   */
  retryable: boolean;
  /** The decision this turn retried, when it was a retry (`EvaluateInput.retryOf`). */
  retryOf: string | null;
  /** The model you named for this turn, as recorded. */
  model: string | null;
  /** Its version, as recorded. */
  modelVersion: string | null;
  createdAt: string | null;
  decidedAt: string | null;
  reviewedAt: string | null;
  /**
   * What became of the reply: the outcome events on record and their
   * `state`. Null until the first event. A decision whose `outcome.state` is
   * set when `evaluate` answers was decided for an earlier draft of the turn.
   */
  outcome: Outcome | null;
  /**
   * A person is being routed to the patient because the inbound matched a
   * red-flag rule. Distinct from
   * `decision`: a clean draft can be `allow` with `routeToHuman: true`, and a
   * held draft can be both held and routed.
   */
  routeToHuman: boolean;
  /** Observe only: the screen would have routed. */
  wouldHaveRouted: boolean;
  /** The red-flag rules the inbound matched. Codes only; never text. */
  inboundFlags: InboundFlag[];
  /** The hand-off task opened or joined for this patient, when there is one. */
  handoff: HandoffRef | null;
  /** The signed webhook deliveries about this decision: the delivery log, never the body. Empty when there are none. */
  webhookDeliveries: WireWebhookDelivery[];
  /**
   * Set when the server sent a decision value this SDK version does not know.
   * `decision` was then normalised fail closed (`hold` in enforce, `allow` in
   * observe or off), `degraded` is true, and the original value is here and on
   * `raw.decision`.
   */
  unknownDecision: string | null;
  /** True when the server answered 202: observe mode, evaluated off the request path. */
  accepted: boolean;
  /**
   * True when the SDK applied a fallback: the API could not be reached (then
   * there is no `id` and nothing was recorded), or the decision value was not
   * one this version knows (see `unknownDecision`).
   */
  degraded: boolean;
  /**
   * The decision as the API sent it. `WireDecision` marks `flagged`,
   * `matches`, `show_hold_text`, `retryable` and `supersedes` optional,
   * because a server that predates them omits them, although the API
   * document requires them. The mapped fields above already treat an absent
   * field as its documented default. `raw.turn_ref`, `raw.supersedes` and
   * `raw.superseded_by` say which patient turn this decision answered, which
   * decisions it named in `supersedes` and replaced, and which decision
   * replaced it. A retry also replaces its parent, which is `raw.retry_of`
   * and is never listed in `supersedes`. `turn_ref` and `superseded_by` are
   * not in the document's required list: each is `null` when there is none
   * and absent (`undefined`) from a server that predates it, so check them
   * with `== null`, not `=== null`. `supersedes` is a list, `[]` when the
   * turn named nothing in `supersedes` and `undefined` only from a server
   * that predates it, so "replaced nothing" is
   * `raw.retry_of == null && !raw.supersedes?.length`.
   */
  raw: WireDecision;
}

export interface Disclosure {
  /** Attach as `disclosure.ref` on every evaluate for the conversation. The SDK does this for you. */
  ref: string;
  applicationId: string;
  conversationId: string;
  channel: Channel;
  evidenceId: string;
  recordedAt: string;
  /** True when this call created the evidence; false when the conversation already had it. */
  created: boolean;
  raw: WireDisclosure;
}

export type ReleaseResult =
  | { state: "released"; content: string | null; decision: Decision }
  | { state: "rejected"; decision: Decision }
  /** The decision was never held; nothing to wait for. */
  | { state: "not_held"; decision: Decision }
  /** A block that no reviewer will lift (for example the patient opted out). */
  | { state: "blocked"; decision: Decision };

// ---------------------------------------------------------------------------
// guard
// ---------------------------------------------------------------------------

export interface GuardContext {
  conversationId: string;
  /** Default: a random id. Supply your own message id so a retry replays the same decision. */
  turnId?: string;
  channel: Channel;
  audience: Audience;
  patientRef?: string;
  disclosure?: DisclosureAttachment;
  metadata?: Record<string, unknown>;
  /** The patient's inbound message, for the red-flag screen. Requires `patientRef`. */
  inbound?: InboundMessage;
  /** Overrides the client's hold message for this turn. Empty or blank is refused with `GovernConfigError`. */
  holdMessage?: string;
  /** The model that produced the draft, for callers not using an adapter. See `EvaluateInput.model`. */
  model?: string;
  /** Its version. See `EvaluateInput.modelVersion`. */
  modelVersion?: string;
  /**
   * The decision this turn retries. See `EvaluateInput.retryOf`; a value that
   * is not a decision id is refused with `GovernConfigError` before the draft
   * function runs. It must name a decision recorded for this turn's
   * `patientRef` (the same value, or neither has one): if you set
   * `patientRef` per call, keep it on the retry. The API refuses a decision
   * recorded for another `patientRef` with `400`:
   * `retry_of must name a decision for the same patient_ref`.
   * A value the API refuses is a refused call: `guard` applies its fail
   * semantics, so the turn holds in enforce.
   *
   * A retry the API accepts is your word that the retried decision's hold
   * text was not shown, which is the API's order (evaluate the retry before
   * showing anything): record the retried decision as `discarded`, and the
   * API adds `superseded` when it applies the retry. `null` is no retry, as
   * `undefined` is.
   */
  retryOf?: string | null;
  /** Your stable reference for the patient turn. See `EvaluateInput.turnRef`; checked before the draft function runs. */
  turnRef?: string | null;
  /**
   * The decisions this turn replaces. See `EvaluateInput.supersedes`; checked
   * before the draft function runs. Each must be recorded for this turn's
   * `patientRef` (the same value, or neither has one). The API refuses a
   * decision recorded for another `patientRef` with `400`:
   * `supersedes must name decisions for the same patient_ref`.
   */
  supersedes?: readonly string[] | null;
  /**
   * Cancels the call (`null` is none, as `undefined` is). When it fires,
   * before or during the gate call, `guard`
   * rethrows `GovernAbortError` and returns nothing: you own the delivery, so
   * what to send next is yours to decide. It wins over `gateSignal` when it
   * is the one that fired, or both did.
   */
  signal?: AbortSignal | null;
  /**
   * Bounds the gate call alone (`null` is no bound): the evaluate request and the waits between
   * its attempts, not the draft function. When it fires, no further attempt
   * is made and `guard` answers as it does when the API cannot be reached:
   * in enforce a hold (the hold message where `showHoldText` is true), in
   * observe the draft flagged `degraded`, with `reasons: ["gate_unavailable"]`,
   * no decision id, and the `degraded` event with `cause: "gate_unavailable"`.
   * The adapters pass their per-call bound here.
   */
  gateSignal?: AbortSignal | null;
}

export type Draft = string | { text: string };

export interface GuardResult {
  /**
   * What to deliver. On allow: the draft (or the clinician-deliverable
   * substitution); when `routeToHuman` is true beside an allow, `text` is
   * still the draft, the message goes out and a person is routed beside it.
   *
   * On hold, block, `route_to_human` as a decision value, an unknown decision
   * value in enforce, or the API unreachable in enforce: the hold message when
   * `showHoldText` is true, and the empty string when it is false. The empty
   * string is the one "send nothing" value: nothing is owed to the patient on
   * this turn, so there is nothing to hand you.
   */
  text: string;
  /** Null when the channel is off or the SDK degraded because the API was unreachable. */
  decisionId: string | null;
  decision: DecisionVerdict;
  /** The mode that applied. When degraded, the last mode learned for the channel, or the assumed default. */
  mode: Mode;
  /** True when the API could not be reached and the SDK applied its fail semantics. */
  degraded: boolean;
  reasons: string[];
  /** Convenience: `decision !== "allow"`. */
  held: boolean;
  /**
   * On a hold, a holding line is owed to the patient now. On an outbound
   * channel the hold text is the holding line, and `showHoldText` equals this
   * in every case but one: once the API has accepted a retry of a stopped
   * turn, or a turn that supersedes it, the stopped turn keeps
   * `sendHoldingLine` and reads `showHoldText` false, because that turn's own
   * decision answers. On an in-session channel `showHoldText` is true on every
   * hold and the hold text shown in the session is the holding line: do not
   * send a separate one there. True at most once per decision per `Govern`
   * instance: a replayed `turnId`
   * does not re-arm it, and it is false on a released or rejected hold, on a
   * stop that means this patient should not be messaged (`opted_out`,
   * `consent_missing`, `consent_revoked`, `frequency_cap`), on
   * `patient_state_unavailable`, and when the API could not be reached at all
   * (no patient state was read then either). Always false on an allow, where
   * `text` is the reply itself. See `Decision.sendHoldingLine`.
   */
  sendHoldingLine: boolean;
  /**
   * On a hold, whether `text` is the hold message and is to be shown or sent
   * now. For a clinician audience: true on every hold or block, on every
   * channel; the channel rule is about contacting the patient and does not
   * apply. For a patient audience, decided by the channel (see
   * `isInSessionChannel`):
   *
   * - in-session (`web_chat`, `app_message`, `voice`): true on every hold or
   *   block, including a fail-closed hold because the API could not be
   *   reached. The patient is waiting in the session or on the line; the hold
   *   text is the reply there. Not deduplicated: a replayed turn shows the
   *   same reply again.
   * - outbound (`sms`, `email`, and any channel value this version does not
   *   know): `sendHoldingLine`. When that is false, `text` is empty and
   *   nothing goes out.
   *
   * The API states the same rule on every decision as `show_hold_text`. When
   * it sends one, the API's value wins: it is false on a hold a reviewer has
   * released or rejected, on a stopped turn once a retry of it or a turn
   * that supersedes it was accepted, and on a decision the API can no longer
   * read, and it is true on a channel this version does not know when the
   * API knows it to be in-session. Two limits
   * stay on this side: on `sms` and `email` it is never true where
   * `sendHoldingLine` is false, and on an unknown channel it is false where
   * the SDK withheld a holding line the API offered, so a replayed turn never
   * sends the holding line twice. A server that predates the field gets the
   * channel rule above, and false on a hold a reviewer has released or
   * rejected (`review_state`).
   *
   * Always false on an allow, where `text` is the reply itself.
   */
  showHoldText: boolean;
  /** The kind of stop, when there was one. See `Decision.stopClass`. */
  stopClass: StopClass | null;
  /** A person is being routed to the patient. Show it ("a member of the care team will contact you") and record your own signal. */
  routeToHuman: boolean;
  /** The hand-off task opened or joined, when there is one. */
  handoff: HandoffRef | null;
  /** The red-flag rules the inbound matched. */
  inboundFlags: InboundFlag[];
  /**
   * The full decision when the API answered; null when the API could not be
   * reached. A decision whose `record.outcome.state` is already set was
   * decided for an earlier draft of this turn; do not deliver new text under
   * it.
   *
   * `guard` reports no outcome itself. Once you write `text` to the channel,
   * record it with `govern.reportOutcome(decisionId, { kind: "released",
   * at, content: text })`, and later events (`delivered`, `discarded`,
   * `failed`) as your channel reports them. The adapters do this for you.
   */
  record: Decision | null;
}

// ---------------------------------------------------------------------------
// Transcripts, patient state and hand-offs
// ---------------------------------------------------------------------------

export interface TranscriptTurnInput {
  conversationId: string;
  turnId: string;
  channel: Channel;
  audience: Audience;
  content: string;
  sentAt: Date | string;
}

export interface SubmitTranscriptsInput {
  turns: TranscriptTurnInput[];
  /**
   * Replays a previous submission instead of opening a second job. Defaulted
   * per call, so the transport's retries are one job; pass your own to make a
   * resubmission from your own code one too.
   */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface TranscriptJob {
  jobId: string;
  applicationId: string;
  status: Schemas["TranscriptJobStatus"];
  total: number;
  processed: number;
  evaluated: number;
  duplicate: number;
  unavailable: number;
  /** Turns a failed job gave up on: never evaluated, no decision, their text cleared with the job. Only ever non-zero when `status` is `failed`. */
  abandoned: number;
  wouldHave: Record<string, number>;
  /** True when this call opened the job (202); false when it replayed (200). */
  created: boolean;
  raw: WireTranscriptJob;
}

export interface PatientConsentInput {
  patientRef: string;
  state: "granted" | "revoked";
  channel?: Channel;
  at?: Date | string;
  /**
   * Replays this write instead of recording a second one. Defaulted per call,
   * so the transport's retries are one write; pass your own to make a retry
   * from your own code one too.
   */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface PatientOptOutInput {
  patientRef: string;
  optedOut: boolean;
  channel?: Channel;
  at?: Date | string;
  /**
   * Replays this write instead of recording a second one. Defaulted per call,
   * so the transport's retries are one write; pass your own to make a retry
   * from your own code one too.
   */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

/**
 * A hand-off row as the API returns it. `kind` is optional in this type,
 * because a server that predates it omits it, although the API document
 * requires it. There is no mapped layer for hand-offs: this is the row.
 */
export type Handoff = WireCareHandoff;
/** One hand-off with its events and the decisions that opened or joined it. */
export type HandoffDetail = WireHandoffDetail;

export interface HandoffListQuery {
  /** Staff may narrow to one application; an application key always sees only its own. */
  applicationId?: string;
  status?: "queued" | "claimed" | "resolved";
  assignedTo?: string;
  overdue?: boolean;
  /** `created` (default) or `due`. */
  sort?: "created" | "due";
  limit?: number;
  offset?: number;
  signal?: AbortSignal;
}

export interface HandoffList {
  items: Handoff[];
  total: number;
  /** Display names keyed by patient record id; empty for hand-offs about a third party's patient. */
  patientNames: Record<string, string>;
  /**
   * The ids of the hand-offs on this page that carry a stopped draft nobody
   * has answered yet: a reply is still owed. A patient has one open item, so
   * a stop joins whatever the patient already has, and the item keeps the
   * reason it was opened for; this says what it now also owes. Empty from a
   * server that predates the field.
   */
  awaitingReply: WireHandoffList["awaiting_reply"];
  raw: WireHandoffList;
}

export interface HandoffActionInput {
  /** The version you last read. A stale value is refused with `GovernConflictError`; refresh and decide again. */
  expectedVersion: number;
  signal?: AbortSignal;
}

export interface HandoffContactInput extends HandoffActionInput {
  outcome: string;
  note: string;
  nextDueAt?: Date | string;
}

export interface HandoffResolveInput extends HandoffActionInput {
  disposition: string;
  note: string;
  /** Release the hold on automation for this patient as part of resolving. */
  resumeAutomation: boolean;
}

export interface HandoffResumeInput extends HandoffActionInput {
  note: string;
}

export interface WebhookDeliveryQuery {
  decisionId?: string;
  handoffId?: string;
  status?: "pending" | "delivered" | "exhausted" | "skipped";
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Events (never content)
// ---------------------------------------------------------------------------

export type GovernEvent =
  | {
      type: "request";
      method: string;
      path: string;
      attempt: number;
    }
  | {
      type: "response";
      method: string;
      path: string;
      status: number;
      attempt: number;
      durationMs: number;
    }
  | {
      type: "retry";
      method: string;
      path: string;
      attempt: number;
      status: number | null;
      delayMs: number;
      reason: "rate_limited" | "server_error" | "network" | "timeout";
    }
  | {
      type: "decision";
      decisionId: string | null;
      conversationId: string;
      turnId: string;
      channel: Channel;
      audience: Audience;
      decision: DecisionVerdict;
      mode: Mode;
      status: DecisionStatus;
      accepted: boolean;
      reasons: string[];
    }
  | {
      type: "degraded";
      conversationId: string;
      turnId: string;
      channel: Channel;
      /** The mode the SDK applied: enforce fails closed, observe or off fails open. */
      mode: Mode;
      /** Whether the mode was learned from a previous response or assumed. */
      modeSource: "learned" | "assumed";
      /**
       * Which kind of failure this was, in the same words as the reason code
       * on the result. `gate_unavailable` may heal on its own;
       * `client_misconfigured` does not heal and is fixed in the integration's
       * configuration; `turn_conflict` is a 409 on this turn alone, the
       * record having moved under a `retryOf` or a `supersedes`. Alert on
       * them separately: `client_misconfigured` holds every message until
       * someone acts.
       */
      cause: "gate_unavailable" | "client_misconfigured" | "turn_conflict";
      /** The HTTP status when the API answered; null for a timeout or a transport failure. */
      status: number | null;
      error: string;
    }
  | {
      /** An outcome event the API accepted: recorded, or the same event already on record. */
      type: "outcome";
      decisionId: string;
      kind: ReportedOutcomeKind;
    }
  | {
      type: "error";
      operation: string;
      error: string;
    };
