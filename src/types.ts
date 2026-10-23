/**
 * Public types. The wire shapes come from `src/generated/openapi.ts`, which is
 * generated from `spec/openapi.json`; the ergonomic shapes here are
 * hand-authored on top and carry the wire object as `raw`.
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
 * The in-session channels: the patient opened the session and is waiting in
 * it, so a reply there answers them. Consent does not govern a reply in a
 * session the patient is in, and on any hold or block `guard` shows the hold
 * text there (`showHoldText` true), including when the API could not be
 * reached. Every other channel is outbound.
 */
export const IN_SESSION_CHANNELS: readonly Channel[] = ["web_chat", "app_message"];

/**
 * Whether a channel is in-session (`web_chat`, `app_message`). Everything
 * else, `sms`, `voice`, `email` and any value this version does not know, is
 * outbound: for a patient audience a hold there shows nothing unless
 * `sendHoldingLine` says a holding line is owed. An unknown channel fails
 * closed that way. A clinician hold shows its notice on every channel.
 *
 * The one place the SDK classifies a channel: `guard` and every adapter read
 * it. The API applies the same classification.
 */
export function isInSessionChannel(channel: unknown): boolean {
  return typeof channel === "string" && (IN_SESSION_CHANNELS as readonly string[]).includes(channel);
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
  /** SDK-only: the server sent a decision value this version does not know. */
  unknownDecision: "unknown_decision",
} as const;

// ---------------------------------------------------------------------------
// Wire types (as generated)
// ---------------------------------------------------------------------------

export type WireDecision = Schemas["DecisionView"];
export type WireEvaluateRequest = Schemas["EvaluateRequest"];
export type WireOutcomeRequest = Schemas["OutcomeRequest"];
export type WireOutcome = Schemas["OutcomeView"];
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
export type WireCareHandoff = Schemas["CareHandoff"];
export type WireHandoffDetail = Schemas["ExternalHandoffDetail"];
export type WireHandoffList = Schemas["HandoffList"];

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
  signal?: AbortSignal;
}

export interface ReportOutcomeInput {
  /** Whether a message went out for this turn. */
  delivered: boolean;
  /** Default: now. */
  deliveredAt?: Date | string;
  /** The text that went out. Hashed locally with SHA-256; the text itself is never sent. Required when `delivered` unless `contentHash` is given. */
  content?: string;
  /** A precomputed SHA-256 hex of the delivered text, if you would rather hash it yourself. */
  contentHash?: string;
  /** Your own reference for the delivery (a message id on your channel). */
  deliveryRef?: string;
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

export interface Outcome {
  delivered: boolean;
  deliveredAt: string;
  deliveredContentHash: string | null;
  deliveryRef: string | null;
  recordedAt: string;
  /** Whether the reported hash matches what the record says was deliverable; `null` when there was nothing to compare. */
  hashMatchesRelease: boolean | null;
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
  /** Observe only: the raw gate decision (`allow` | `rewrite` | `block_and_review` | `policy_missing`) or `unavailable`. */
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
  /** The model you named for this turn, as recorded. */
  model: string | null;
  /** Its version, as recorded. */
  modelVersion: string | null;
  createdAt: string | null;
  decidedAt: string | null;
  reviewedAt: string | null;
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
  inbound?: InboundMessage;
  /** Overrides the client's hold message for this turn. */
  holdMessage?: string;
  /** The model that produced the draft, for callers not using an adapter. See `EvaluateInput.model`. */
  model?: string;
  /** Its version. See `EvaluateInput.modelVersion`. */
  modelVersion?: string;
  signal?: AbortSignal;
}

export type Draft = string | { text: string };

export interface AckOptions {
  /**
   * Default: whether the result handed you something to deliver, which is
   * true on an allow and on a hold with `showHoldText`, and false on a hold
   * with nothing to show (`text` is empty then). Pass it to say otherwise.
   */
  delivered?: boolean;
  deliveredAt?: Date | string;
  deliveryRef?: string;
  /** What actually went out, if it differs from `reply.text`. Hashed locally; never sent. */
  content?: string;
}

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
   * channel this is the whole answer, and `showHoldText` equals it; on an
   * in-session channel `showHoldText` is true on every hold and the hold text
   * shown in the session is the holding line. True at most once per decision per `Govern` instance: a replayed `turnId`
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
   * - in-session (`web_chat`, `app_message`): true on every hold or block,
   *   including a fail-closed hold because the API could not be reached. The
   *   patient is waiting in the session; the hold text is the reply in it.
   *   Not deduplicated: a replayed turn shows the same reply again.
   * - outbound (`sms`, `voice`, `email`, and any channel value this version
   *   does not know): exactly `sendHoldingLine`. When that is false, `text`
   *   is empty and nothing goes out.
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
  /** The full decision when the API answered; null when the API could not be reached. */
  record: Decision | null;
  /**
   * Report what went out. If you never call it, the next `guard` for the same
   * conversation reports it for you: delivered with the hash of `text` on an
   * allow or when `showHoldText` is true, not delivered otherwise.
   */
  ack(options?: AckOptions): Promise<void>;
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

/** A hand-off row as the API returns it. */
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
       * configuration. Alert on them separately: the second one holds every
       * message until someone acts.
       */
      cause: "gate_unavailable" | "client_misconfigured";
      /** The HTTP status when the API answered; null for a timeout or a transport failure. */
      status: number | null;
      error: string;
    }
  | {
      type: "outcome";
      decisionId: string;
      delivered: boolean;
      auto: boolean;
    }
  | {
      type: "error";
      operation: string;
      error: string;
    };
