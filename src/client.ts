/**
 * `Govern`: the client, `guard`, and hold resolution.
 */

import { randomId, sha256Hex } from "./crypto";
import { GovernAbortError, GovernApiError, GovernConfigError } from "./errors";
import { send, type TransportConfig } from "./http";
import type {
  AckOptions,
  Audience,
  Channel,
  Decision,
  DecisionVerdict,
  Disclosure,
  Draft,
  EvaluateInput,
  GovernEvent,
  GuardContext,
  GuardResult,
  Handoff,
  HandoffActionInput,
  HandoffContactInput,
  HandoffDetail,
  HandoffList,
  HandoffListQuery,
  HandoffRef,
  HandoffResolveInput,
  HandoffResumeInput,
  InboundFlag,
  Mode,
  Outcome,
  PatientConsentInput,
  PatientOptOutInput,
  RecordDisclosureInput,
  ReleaseResult,
  ReportOutcomeInput,
  StopClass,
  SubmitTranscriptsInput,
  TranscriptJob,
  WaitForReleaseOptions,
  WebhookDeliveryQuery,
  WireConsentRequest,
  WireDecision,
  WireDisclosure,
  WireDisclosureRequest,
  WireEvaluateRequest,
  WireOptOutRequest,
  WireOutcomeRequest,
  WirePatientState,
  WireTranscriptBatch,
  WireTranscriptJob,
  WireTranscriptTurnView,
  WireWebhookDelivery,
} from "./types";
import { REASONS, isInSessionChannel } from "./types";
import { handleWebhook as verifyAndParseWebhook, type HeadersLike, type WebhookEvent, type WebhookOptions } from "./webhook";

export const DEFAULT_BASE_URL = "https://api.anybio.io";
export const DEFAULT_TIMEOUT_MS = 5_000;
export const DEFAULT_MAX_RETRIES = 2;
/** What a patient sees on hold or block when the policy does not supply its own text. */
export const DEFAULT_HOLD_MESSAGE =
  "Thanks for your message. A person from our team will review it and follow up with you shortly.";

/**
 * Turn ids starting with this are the API's own; a caller's `turnId` or
 * `Idempotency-Key` that starts with it is refused with a 400.
 */
export const RESERVED_TURN_ID_PREFIX = "govern:";
/**
 * Longest `conversationId` the API accepts, in code points. The conversation's
 * disclosure evidence reference is composed from it and the stored reference
 * column is bounded, so the limit is on the identifier rather than discovered
 * at the write.
 */
export const MAX_CONVERSATION_ID_CHARS = 187;
/** Longest `turnId` the API accepts, in code points. Same reason, shorter fixed part. */
export const MAX_TURN_ID_CHARS = 206;

/**
 * The two 4xx that mean "later" rather than "no". Everything else in the 4xx
 * range is the same answer however many times it is asked.
 *
 * 429 is rate limiting, which the transport already retries with the server's
 * `Retry-After`; reaching `guard` with one means the retries were spent, which
 * is back-pressure, not a misconfiguration. 408 is the server saying it gave
 * up waiting for the request, which is the same class of event as a client-side
 * timeout.
 */
export const TRANSIENT_HTTP_STATUSES: ReadonlySet<number> = new Set([408, 429]);

/**
 * True when the API refused the call and would refuse it again (a 4xx other
 * than 408 and 429). Such a failure does not heal; alert on it separately
 * from `gate_unavailable`.
 *
 * A revoked application key and an unreachable API both arrive at `guard` as
 * "no decision" and both hold in enforce; this tells them apart. Anything that
 * is not a recognised API answer (a timeout, a dropped connection, an error
 * class this version does not know) is reported as `gate_unavailable`.
 */
export function isClientMisconfiguration(error: unknown): boolean {
  if (!(error instanceof GovernApiError)) return false;
  if (error.status < 400 || error.status >= 500) return false;
  return !TRANSIENT_HTTP_STATUSES.has(error.status);
}

export const GOVERN_PATHS = {
  evaluate: "/api/v1/govern/evaluate",
  decision: (id: string) => `/api/v1/govern/decisions/${encodeURIComponent(id)}`,
  outcome: (id: string) => `/api/v1/govern/decisions/${encodeURIComponent(id)}/outcome`,
  disclosures: "/api/v1/govern/disclosures",
  transcripts: "/api/v1/govern/transcripts",
  transcriptJob: (id: string) => `/api/v1/govern/transcripts/${encodeURIComponent(id)}`,
  transcriptTurns: (id: string) => `/api/v1/govern/transcripts/${encodeURIComponent(id)}/turns`,
  patientConsent: "/api/v1/govern/patients/consent",
  patientOptOut: "/api/v1/govern/patients/opt-out",
  patientState: "/api/v1/govern/patients/state",
  webhookDeliveries: "/api/v1/govern/webhook-deliveries",
  handoffs: "/api/v1/govern/handoffs",
  handoff: (id: string) => `/api/v1/govern/handoffs/${encodeURIComponent(id)}`,
  handoffClaim: (id: string) => `/api/v1/govern/handoffs/${encodeURIComponent(id)}/claim`,
  handoffContact: (id: string) => `/api/v1/govern/handoffs/${encodeURIComponent(id)}/contact-attempt`,
  handoffResolve: (id: string) => `/api/v1/govern/handoffs/${encodeURIComponent(id)}/resolve`,
  handoffResume: (id: string) => `/api/v1/govern/handoffs/${encodeURIComponent(id)}/resume`,
} as const;

const KNOWN_VERDICTS: ReadonlySet<string> = new Set(["allow", "hold", "block", "route_to_human"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface GovernOptions {
  /** The application key (`gk_...`). A server-side secret. */
  apiKey: string;
  /**
   * The application this key belongs to: its id (a UUID, sent as
   * `application_id`) or a label of your choosing (used only in events).
   */
  application: string;
  /** Default `https://api.anybio.io`. */
  baseUrl?: string;
  /** A `fetch` implementation; default the global one. */
  fetch?: typeof fetch;
  /** Per-attempt timeout. Default 5000 ms. */
  timeoutMs?: number;
  /** Retries after the first attempt, on 429, 5xx, timeouts and network failures. Default 2. */
  maxRetries?: number;
  /**
   * Observability hook. Events never carry message content.
   *
   * Telemetry, and only telemetry: every call is isolated, so a callback that
   * throws can never change a verdict or fail a request. The throw is reported
   * back as an `error` event with `operation: "on_event"`.
   */
  onEvent?: (event: GovernEvent) => void;
  /** What `guard` returns on hold or block. Default `DEFAULT_HOLD_MESSAGE`. */
  holdMessage?: string;
  /**
   * The mode `guard` assumes for a channel before the first successful
   * response has taught it the real one. `enforce` (the default) fails closed.
   */
  assumeMode?: "enforce" | "observe";
  /**
   * The constructor refuses to run where a `window` global exists, because an
   * application key must never ship to a browser. Set this only in a server
   * test runner that defines `window`.
   */
  dangerouslyAllowBrowser?: boolean;
}

interface PendingAck {
  decisionId: string;
  /** What the automatic report says went out: `text`, unless the turn was held and `showHoldText` was false. */
  delivered: boolean;
  contentHash: string | undefined;
  at: string;
}

/** Construct a client; the same as `new Govern(options)`. */
export function createGovern(options: GovernOptions): Govern {
  return new Govern(options);
}

export class Govern {
  readonly application: string;
  readonly applicationId: string | null;
  readonly baseUrl: string;
  readonly holdMessage: string;
  readonly assumeMode: "enforce" | "observe";
  /** Hand-offs on your team. */
  readonly handoffs: GovernHandoffs;

  private readonly transport: TransportConfig;
  private readonly onEvent: ((event: GovernEvent) => void) | undefined;
  private readonly modes = new Map<Channel, Mode>();
  private readonly disclosureRefs = new BoundedMap<string, string>(10_000);
  private readonly pendingAcks = new BoundedMap<string, PendingAck>(10_000);
  private readonly reportedDecisions = new BoundedMap<string, true>(10_000);
  /** Decision ids whose holding line this instance has already armed. */
  private readonly holdingLines = new BoundedMap<string, true>(10_000);
  private readonly releaseWaiters = new Map<string, Set<() => void>>();

  constructor(options: GovernOptions) {
    if (!options.dangerouslyAllowBrowser && runningInBrowser()) {
      throw new GovernConfigError(
        "Govern must not run in a browser: the application key is a server-side secret. Call the API from your server, or from an edge or serverless function.",
      );
    }
    if (typeof options.apiKey !== "string" || options.apiKey.trim() === "") {
      throw new GovernConfigError("Govern requires apiKey (the application key from the console).");
    }
    if (typeof options.application !== "string" || options.application.trim() === "") {
      throw new GovernConfigError("Govern requires application (the application id or a label).");
    }
    const fetchImpl = options.fetch ?? (typeof fetch === "function" ? fetch : undefined);
    if (!fetchImpl) {
      throw new GovernConfigError("No fetch implementation found. Pass one as `fetch` or run on Node 18+.");
    }
    this.application = options.application.trim();
    this.applicationId = UUID.test(this.application) ? this.application.toLowerCase() : null;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.holdMessage = options.holdMessage ?? DEFAULT_HOLD_MESSAGE;
    this.assumeMode = options.assumeMode ?? "enforce";
    // Wrapped once, here, so every emitter in the SDK and the transport gets
    // the isolated callback and no call site can forget.
    this.onEvent = isolateEvents(options.onEvent);
    this.transport = {
      baseUrl: this.baseUrl,
      apiKey: options.apiKey.trim(),
      fetch: fetchImpl,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
      onEvent: this.onEvent,
    };
    this.handoffs = new GovernHandoffs(this.transport);
  }

  // -------------------------------------------------------------------------
  // The contract
  // -------------------------------------------------------------------------

  /**
   * Evaluate one turn. Enforce answers inline (200). Observe answers 202 at
   * once with `decision: "allow"` and a decision id; the gate runs after the
   * response and its verdict lands on the record as `wouldHave`. A replay of
   * the same `turnId` returns the stored decision.
   */
  async evaluate(input: EvaluateInput): Promise<Decision> {
    requireConversationId(input.conversationId);
    requireTurnId(input.turnId);
    requireText(input.content, "content");
    const disclosure = input.disclosure ?? this.disclosureAttachment(input.conversationId);
    const body: WireEvaluateRequest = {
      conversation_id: input.conversationId,
      turn_id: input.turnId,
      channel: input.channel,
      audience: input.audience,
      content: input.content,
    };
    if (this.applicationId) body.application_id = this.applicationId;
    if (input.patientRef !== undefined) body.patient_ref = input.patientRef;
    if (disclosure) {
      body.disclosure = {};
      if (disclosure.established !== undefined) body.disclosure.established = disclosure.established;
      if (disclosure.ref !== undefined) body.disclosure.ref = disclosure.ref;
    }
    if (input.metadata !== undefined) body.metadata = input.metadata;
    if (input.modeHint !== undefined) body.mode_hint = input.modeHint;
    if (input.inbound) {
      body.inbound = {
        content: input.inbound.content,
        received_at: isoString(input.inbound.receivedAt),
      };
    }
    // Blank is absent: the API refuses a blank identifier with a 400, and a
    // model name is never worth a refused turn.
    const model = input.model?.trim();
    if (model) body.model = model;
    const modelVersion = input.modelVersion?.trim();
    if (modelVersion) body.model_version = modelVersion;
    const response = await send<WireDecision>(this.transport, {
      method: "POST",
      path: GOVERN_PATHS.evaluate,
      body,
      idempotencyKey: input.turnId,
      signal: input.signal,
    });
    const decision = this.read(toDecision(response.body, response.status === 202));
    this.onEvent?.({
      type: "decision",
      decisionId: decision.id,
      conversationId: decision.conversationId,
      turnId: decision.turnId,
      channel: decision.channel,
      audience: decision.audience,
      decision: decision.decision,
      mode: decision.mode,
      status: decision.status,
      accepted: decision.accepted,
      reasons: decision.reasons,
    });
    return decision;
  }

  /** The decision with its current review state; the first hold-resolution path. */
  async getDecision(decisionId: string, options: { signal?: AbortSignal } = {}): Promise<Decision> {
    requireText(decisionId, "decisionId");
    const response = await send<WireDecision>(this.transport, {
      method: "GET",
      path: GOVERN_PATHS.decision(decisionId),
      signal: options.signal,
    });
    return this.read(toDecision(response.body, false));
  }

  /**
   * Report what went out. The text is hashed here with SHA-256 and only the
   * hash is sent. One outcome per decision: the same report again is
   * accepted; a different one is refused with 409.
   */
  async reportOutcome(decisionId: string, input: ReportOutcomeInput): Promise<Decision> {
    requireText(decisionId, "decisionId");
    // Blank is treated as absent, so a blank hash is never recorded as the
    // hash of a delivered message.
    const given = input.contentHash?.trim().toLowerCase();
    let hash: string | undefined = given === "" ? undefined : given;
    if (hash === undefined && input.content !== undefined) hash = await sha256Hex(input.content);
    if (input.delivered && hash === undefined) {
      throw new GovernConfigError(
        "reportOutcome: pass `content` (hashed locally) or `contentHash` when delivered is true.",
      );
    }
    const decision = await this.postOutcome(decisionId, {
      delivered: input.delivered,
      deliveredAt: isoString(input.deliveredAt ?? new Date()),
      contentHash: hash,
      deliveryRef: input.deliveryRef,
      signal: input.signal,
    });
    this.reportedDecisions.set(decisionId, true);
    this.onEvent?.({ type: "outcome", decisionId, delivered: input.delivered, auto: false });
    return decision;
  }

  /**
   * Record the AI-identity disclosure shown at the start of a conversation.
   * Once per conversation; the returned `ref` is attached to every later
   * `evaluate` for the conversation automatically.
   */
  async recordDisclosure(input: RecordDisclosureInput): Promise<Disclosure> {
    requireConversationId(input.conversationId);
    requireText(input.textShown, "textShown");
    const body: WireDisclosureRequest = {
      conversation_id: input.conversationId,
      channel: input.channel,
      text_shown: input.textShown,
      at: isoString(input.at ?? new Date()),
    };
    if (this.applicationId) body.application_id = this.applicationId;
    const response = await send<WireDisclosure>(this.transport, {
      method: "POST",
      path: GOVERN_PATHS.disclosures,
      body,
      signal: input.signal,
    });
    const view = response.body;
    this.disclosureRefs.set(input.conversationId, view.ref);
    return {
      ref: view.ref,
      applicationId: view.application_id,
      conversationId: view.conversation_id,
      channel: view.channel,
      evidenceId: view.evidence_id,
      recordedAt: view.recorded_at,
      created: response.status === 201,
      raw: view,
    };
  }

  /**
   * Poll a held decision with backoff until a reviewer releases or rejects
   * it. Resolves `null` on timeout; throws `GovernAbortError` if `signal`
   * fires. A webhook handled through `handleWebhook` wakes the poll early.
   */
  async waitForRelease(decisionId: string, options: WaitForReleaseOptions = {}): Promise<ReleaseResult | null> {
    requireText(decisionId, "decisionId");
    const timeoutMs = options.timeoutMs ?? 15 * 60_000;
    const maxIntervalMs = options.maxIntervalMs ?? 15_000;
    let intervalMs = options.intervalMs ?? 1_000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const decision = await this.getDecision(decisionId, { signal: options.signal });
      const settled = settle(decision);
      if (settled) return settled;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      await this.sleepOrWake(decisionId, Math.min(intervalMs, remaining), options.signal);
      intervalMs = Math.min(intervalMs * 2, maxIntervalMs);
    }
  }

  /**
   * Verify a webhook delivery and return the typed event. When the event
   * resolves a held decision, any `waitForRelease` on it is woken at once.
   */
  async handleWebhook(
    rawBody: string | Uint8Array | ArrayBuffer,
    headers: HeadersLike,
    secret: string,
    options?: WebhookOptions,
  ): Promise<WebhookEvent> {
    const event = await verifyAndParseWebhook(rawBody, headers, secret, options);
    if (event.type === "decision.released" || event.type === "decision.rejected") {
      this.wake(event.decisionId);
    }
    return event;
  }

  // -------------------------------------------------------------------------
  // guard
  // -------------------------------------------------------------------------

  /**
   * Run `fn` to get the draft, evaluate it, and return what to deliver.
   *
   * - allow: the draft (or, for a clinician audience, the gate's substitution when it returns one)
   * - hold or block: the hold message when `showHoldText`, else the empty string
   * - API unreachable: a hold, as above, when the channel's last known mode is
   *   enforce (or unknown), the draft flagged `degraded` when it is observe or off
   *
   * On a hold, `sendHoldingLine` says whether a holding line is owed to the
   * patient now: at most once per decision in this instance, and never where
   * the contract says another message is the wrong thing. `showHoldText`
   * applies the channel: true on every hold in an in-session channel
   * (`web_chat`, `app_message`), where the patient is waiting for the reply,
   * and exactly `sendHoldingLine` on an outbound or unknown channel.
   *
   * Never returns rewritten text for a patient audience.
   */
  async guard(fn: () => Draft | Promise<Draft>, ctx: GuardContext): Promise<GuardResult> {
    // Before `fn`, so a draft is never generated for a turn the API would
    // refuse on its identifiers.
    requireConversationId(ctx.conversationId);
    if (ctx.turnId !== undefined) requireTurnId(ctx.turnId);
    void this.flushPendingAck(ctx.conversationId);

    const produced = await fn();
    const draft = typeof produced === "string" ? produced : produced?.text;
    if (typeof draft !== "string") {
      throw new GovernConfigError("guard: the draft function must return a string or { text: string }.");
    }
    const turnId = ctx.turnId ?? randomId();
    const holdMessage = ctx.holdMessage ?? this.holdMessage;

    let record: Decision | null = null;
    let mode: Mode;
    let degraded = false;
    let degradeCause: "gate_unavailable" | "client_misconfigured" = "gate_unavailable";
    let routeToHuman = false;
    let handoff: HandoffRef | null = null;
    let inboundFlags: InboundFlag[] = [];
    try {
      const input: EvaluateInput = {
        conversationId: ctx.conversationId,
        turnId,
        channel: ctx.channel,
        audience: ctx.audience,
        content: draft,
      };
      if (ctx.patientRef !== undefined) input.patientRef = ctx.patientRef;
      if (ctx.disclosure !== undefined) input.disclosure = ctx.disclosure;
      if (ctx.metadata !== undefined) input.metadata = ctx.metadata;
      if (ctx.inbound !== undefined) input.inbound = ctx.inbound;
      if (ctx.model !== undefined) input.model = ctx.model;
      if (ctx.modelVersion !== undefined) input.modelVersion = ctx.modelVersion;
      if (ctx.signal !== undefined) input.signal = ctx.signal;
      record = await this.evaluate(input);
      mode = record.mode;
      degraded = record.degraded;
      routeToHuman = record.routeToHuman || record.decision === "route_to_human";
      handoff = record.handoff;
      inboundFlags = record.inboundFlags;
    } catch (error) {
      if (error instanceof GovernAbortError || error instanceof GovernConfigError) throw error;
      degraded = true;
      // The hold is the same either way. What differs is who has work to do,
      // and an operator cannot act on a signal that will not say which.
      degradeCause = isClientMisconfiguration(error)
        ? REASONS.clientMisconfigured
        : REASONS.gateUnavailable;
      const learned = this.modes.get(ctx.channel);
      mode = learned ?? this.assumeMode;
      this.onEvent?.({
        type: "degraded",
        conversationId: ctx.conversationId,
        turnId,
        channel: ctx.channel,
        mode,
        modeSource: learned ? "learned" : "assumed",
        cause: degradeCause,
        status: error instanceof GovernApiError ? error.status : null,
        error: describe(error),
      });
    }

    let decision: DecisionVerdict;
    let text: string;
    let reasons: string[];
    if (record) {
      decision = record.decision;
      reasons = record.unknownDecision ? [...record.reasons, REASONS.unknownDecision] : record.reasons;
      if (decision === "allow") {
        text = record.audience === "clinician" && record.deliverableContent ? record.deliverableContent : draft;
      } else {
        // hold, block, route_to_human as a decision value, or an unknown value
        // normalised to hold: nothing but the hold message goes out.
        text = holdMessage;
      }
    } else if (mode === "enforce") {
      // Fail closed.
      decision = "hold";
      text = holdMessage;
      reasons = [degradeCause];
    } else {
      decision = "allow";
      text = draft;
      reasons = [degradeCause];
    }

    const held = decision !== "allow";
    // Only the API can say a holding line is owed, because only the API read
    // the patient's state. An SDK-side fail-closed hold (the API unreachable)
    // knows nothing about an opt-out or a revoked consent, which is the
    // contract's `patient_state_unavailable` case, and there the answer is no.
    const sendHoldingLine = held && record !== null && record.sendHoldingLine;
    // The channel rule is about contacting the patient (consent and patient
    // state), so it applies to the patient audience only; a clinician hold
    // always shows its notice. For a patient: in a session the patient opened
    // and is waiting in, the hold text is the reply, and consent does not
    // govern a reply there: it is shown on every hold, the fail-closed one
    // included. On an outbound channel, and on any channel this version does
    // not know, a message goes out only when a holding line is owed;
    // otherwise the caller is handed nothing to send.
    const showHoldText = held && (ctx.audience !== "patient" || isInSessionChannel(ctx.channel) || sendHoldingLine);
    if (held && !showHoldText) text = "";
    const stopClass = record?.stopClass ?? null;
    const owed = !held || showHoldText;

    const decisionId = record?.id ?? null;
    if (decisionId) {
      // The automatic report follows the instruction this result gives: a
      // hold that showed nothing is reported as nothing sent, and a hold
      // shown in session as delivered with that text, since the patient saw it.
      const delivered = owed;
      this.pendingAcks.set(ctx.conversationId, {
        decisionId,
        delivered,
        contentHash: delivered ? await sha256Hex(text) : undefined,
        at: new Date().toISOString(),
      });
    }

    let acked = false;
    const ack = async (options: AckOptions = {}): Promise<void> => {
      if (acked) return;
      acked = true;
      if (!decisionId) return;
      const pending = this.pendingAcks.get(ctx.conversationId);
      if (pending?.decisionId === decisionId) this.pendingAcks.delete(ctx.conversationId);
      if (this.reportedDecisions.has(decisionId)) return;
      const delivered = options.delivered ?? owed;
      const outcome: ReportOutcomeInput = { delivered };
      if (options.content !== undefined) outcome.content = options.content;
      else if (delivered) outcome.content = text;
      if (options.deliveredAt !== undefined) outcome.deliveredAt = options.deliveredAt;
      if (options.deliveryRef !== undefined) outcome.deliveryRef = options.deliveryRef;
      await this.reportOutcome(decisionId, outcome);
    };

    return {
      text,
      decisionId,
      decision,
      mode,
      degraded,
      reasons,
      held,
      sendHoldingLine,
      showHoldText,
      stopClass,
      routeToHuman,
      handoff,
      inboundFlags,
      record,
      ack,
    };
  }

  /** Report every outcome `guard` is still holding as delivered. Call on shutdown. */
  async flushPendingAcks(): Promise<void> {
    const conversations = [...this.pendingAcks.keys()];
    await Promise.all(conversations.map((c) => this.flushPendingAck(c)));
  }

  // -------------------------------------------------------------------------
  // Memory the caller may read or seed
  // -------------------------------------------------------------------------

  /** The mode last seen for a channel, learned from responses. */
  lastKnownMode(channel: Channel): Mode | undefined {
    return this.modes.get(channel);
  }

  /** Seed the mode memory, for example from a value persisted across processes. */
  rememberMode(channel: Channel, mode: Mode): void {
    this.modes.set(channel, mode);
  }

  /** The disclosure `ref` recorded for a conversation in this process, if any. */
  disclosureRef(conversationId: string): string | undefined {
    return this.disclosureRefs.get(conversationId);
  }

  /** Seed a disclosure `ref` recorded elsewhere so it is attached to later evaluates. */
  rememberDisclosure(conversationId: string, ref: string): void {
    this.disclosureRefs.set(conversationId, ref);
  }

  // -------------------------------------------------------------------------
  // Transcripts, patient state and webhook deliveries
  // -------------------------------------------------------------------------

  /** Observe only: a batch of past turns, each evaluated and recorded as would-have. */
  async submitTranscripts(input: SubmitTranscriptsInput): Promise<TranscriptJob> {
    if (!Array.isArray(input.turns) || input.turns.length === 0) {
      throw new GovernConfigError("submitTranscripts: turns must be a non-empty array.");
    }
    input.turns.forEach((turn, index) => {
      requireConversationId(turn.conversationId, `turns[${index}].conversationId`);
      requireTurnId(turn.turnId, `turns[${index}].turnId`);
    });
    const body: WireTranscriptBatch = {
      turns: input.turns.map((turn) => ({
        conversation_id: turn.conversationId,
        turn_id: turn.turnId,
        channel: turn.channel,
        audience: turn.audience,
        content: turn.content,
        sent_at: isoString(turn.sentAt),
      })),
    };
    if (this.applicationId) body.application_id = this.applicationId;
    const response = await send<WireTranscriptJob>(this.transport, {
      method: "POST",
      path: GOVERN_PATHS.transcripts,
      body,
      signal: input.signal,
      // The transport retries a 500, and the API replays a batch by this key.
      // Without one, a 500-then-success opens a second job. Defaulted per call, so every attempt of this call is the one
      // write and a genuinely new batch is still a new job.
      idempotencyKey: idempotencyKey(input.idempotencyKey),
    });
    return toTranscriptJob(response.body, response.status === 202);
  }

  async getTranscriptJob(jobId: string, options: { signal?: AbortSignal } = {}): Promise<TranscriptJob> {
    requireText(jobId, "jobId");
    const response = await send<WireTranscriptJob>(this.transport, {
      method: "GET",
      path: GOVERN_PATHS.transcriptJob(jobId),
      signal: options.signal,
    });
    return toTranscriptJob(response.body, false);
  }

  async getTranscriptJobTurns(
    jobId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<WireTranscriptTurnView[]> {
    requireText(jobId, "jobId");
    const response = await send<WireTranscriptTurnView[]>(this.transport, {
      method: "GET",
      path: GOVERN_PATHS.transcriptTurns(jobId),
      signal: options.signal,
    });
    return response.body;
  }

  /** Record that the patient granted or revoked consent to be contacted. The reference travels in the body, never a URL. */
  async recordPatientConsent(input: PatientConsentInput): Promise<WirePatientState> {
    requireText(input.patientRef, "patientRef");
    const body: WireConsentRequest = { patient_ref: input.patientRef, state: input.state };
    if (input.channel !== undefined) body.channel = input.channel;
    if (input.at !== undefined) body.at = isoString(input.at);
    const response = await send<WirePatientState>(this.transport, {
      method: "POST",
      path: GOVERN_PATHS.patientConsent,
      body,
      signal: input.signal,
      idempotencyKey: idempotencyKey(input.idempotencyKey),
    });
    return response.body;
  }

  /** Record an opt-out (or, for an opt-out you recorded yourself, an opt back in). */
  async recordPatientOptOut(input: PatientOptOutInput): Promise<WirePatientState> {
    requireText(input.patientRef, "patientRef");
    const body: WireOptOutRequest = { patient_ref: input.patientRef, opted_out: input.optedOut };
    if (input.channel !== undefined) body.channel = input.channel;
    if (input.at !== undefined) body.at = isoString(input.at);
    const response = await send<WirePatientState>(this.transport, {
      method: "POST",
      path: GOVERN_PATHS.patientOptOut,
      body,
      signal: input.signal,
      idempotencyKey: idempotencyKey(input.idempotencyKey),
    });
    return response.body;
  }

  /** The patient's consent, opt-out and frequency state. A POST so the reference stays out of the URL. */
  async getPatientState(patientRef: string, options: { signal?: AbortSignal } = {}): Promise<WirePatientState> {
    requireText(patientRef, "patientRef");
    const response = await send<WirePatientState>(this.transport, {
      method: "POST",
      path: GOVERN_PATHS.patientState,
      body: { patient_ref: patientRef },
      signal: options.signal,
    });
    return response.body;
  }

  /** The webhook delivery log for the application: counts and codes, never a body. */
  async listWebhookDeliveries(query: WebhookDeliveryQuery = {}): Promise<WireWebhookDelivery[]> {
    const response = await send<WireWebhookDelivery[]>(this.transport, {
      method: "GET",
      path: GOVERN_PATHS.webhookDeliveries,
      query: {
        decision_id: query.decisionId,
        handoff_id: query.handoffId,
        status: query.status,
      },
      signal: query.signal,
    });
    return response.body;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async postOutcome(
    decisionId: string,
    input: {
      delivered: boolean;
      deliveredAt: string;
      contentHash: string | undefined;
      deliveryRef: string | undefined;
      signal: AbortSignal | undefined;
    },
  ): Promise<Decision> {
    const body: WireOutcomeRequest = {
      delivered: input.delivered,
      delivered_at: input.deliveredAt,
    };
    if (input.contentHash !== undefined) body.delivered_content_hash = input.contentHash;
    if (input.deliveryRef !== undefined) body.delivery_ref = input.deliveryRef;
    const response = await send<WireDecision>(this.transport, {
      method: "POST",
      path: GOVERN_PATHS.outcome(decisionId),
      body,
      signal: input.signal,
    });
    // An outcome is reported after something went out, so it never arms a
    // holding line; it does count as having seen the decision.
    return this.read(toDecision(response.body, false), { arm: false });
  }

  private async flushPendingAck(conversationId: string): Promise<void> {
    const pending = this.pendingAcks.get(conversationId);
    if (!pending) return;
    this.pendingAcks.delete(conversationId);
    if (this.reportedDecisions.has(pending.decisionId)) return;
    try {
      await this.postOutcome(pending.decisionId, {
        delivered: pending.delivered,
        deliveredAt: pending.at,
        contentHash: pending.contentHash,
        deliveryRef: undefined,
        signal: undefined,
      });
      // Marked only after the write succeeds, so a transient failure leaves
      // the outcome owed and the caller's own later `ack()` still reports it.
      this.reportedDecisions.set(pending.decisionId, true);
      this.onEvent?.({ type: "outcome", decisionId: pending.decisionId, delivered: pending.delivered, auto: true });
    } catch (error) {
      // Still owed, and the slot is where it waits: a later flush, a shutdown
      // flush, or the caller's `ack()` reports it. A newer turn on the
      // conversation has the better claim to that slot, so when one has taken
      // it this outcome is dropped rather than queued behind it. One pending
      // outcome per conversation is the bound this map exists to keep, and a
      // queue would grow during exactly the outage that fills it. What that
      // costs is a row in the audit trail, never a verdict and never a word of
      // returned text, and `ack()` still reports it. Pinned by "drops an
      // auto-ack that failed while a newer turn held the slot".
      if (!this.pendingAcks.has(conversationId)) this.pendingAcks.set(conversationId, pending);
      this.onEvent?.({ type: "error", operation: "auto_ack", error: describe(error) });
    }
  }

  private disclosureAttachment(conversationId: string): { established: boolean; ref: string } | undefined {
    const ref = this.disclosureRefs.get(conversationId);
    return ref ? { established: true, ref } : undefined;
  }

  /**
   * Every decision the API returns passes through here: the channel's mode is
   * learned, and the holding line is armed at most once per decision id.
   *
   * The API's `send_holding_line` is a property of the decision, returned on
   * every read of it, and the contract asks the caller to send at most one
   * holding line per decision. Handing that flag through unfiltered would put
   * the dedup on every integration, and the obvious integration (send the
   * holding line whenever the flag is set) would send it again on a retried
   * turn. So the first read that carries it arms it and every later read in
   * this instance answers false. The API's own value stays on `raw`.
   *
   * The conditions the API already applies are applied again here, so a
   * server that disagrees with its own contract cannot make this SDK tell a
   * caller to message a patient who opted out.
   */
  private read(decision: Decision, options: { arm: boolean } = { arm: true }): Decision {
    this.modes.set(decision.channel, decision.mode);
    const id = decision.id;
    if (!decision.sendHoldingLine || !id) return decision;
    const eligible = options.arm && holdingLineApplies(decision) && !this.holdingLines.has(id);
    this.holdingLines.set(id, true);
    return eligible ? decision : { ...decision, sendHoldingLine: false };
  }

  private sleepOrWake(decisionId: string, ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new GovernAbortError(signal.reason));
        return;
      }
      const waiters = this.releaseWaiters.get(decisionId) ?? new Set<() => void>();
      this.releaseWaiters.set(decisionId, waiters);
      const done = (): void => {
        clearTimeout(timer);
        waiters.delete(wake);
        if (waiters.size === 0) this.releaseWaiters.delete(decisionId);
        signal?.removeEventListener("abort", onAbort);
      };
      const wake = (): void => {
        done();
        resolve();
      };
      const onAbort = (): void => {
        done();
        reject(new GovernAbortError(signal?.reason));
      };
      const timer = setTimeout(wake, ms);
      waiters.add(wake);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private wake(decisionId: string): void {
    const waiters = this.releaseWaiters.get(decisionId);
    if (!waiters) return;
    for (const wake of [...waiters]) wake();
  }
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

export function toDecision(wire: WireDecision, accepted: boolean): Decision {
  const rawVerdict = String(wire.decision);
  const known = KNOWN_VERDICTS.has(rawVerdict);
  const failOpen = wire.mode === "observe" || wire.mode === "off";
  const decision: DecisionVerdict = known ? (rawVerdict as DecisionVerdict) : failOpen ? "allow" : "hold";
  return {
    id: wire.decision_id ?? null,
    status: wire.status,
    decision,
    mode: wire.mode,
    channel: wire.channel,
    audience: wire.audience,
    conversationId: wire.conversation_id,
    turnId: wire.turn_id,
    wouldHave: wire.would_have ?? null,
    policy: wire.policy ? { id: wire.policy.id, name: wire.policy.name, version: wire.policy.version } : null,
    reasons: Array.isArray(wire.reasons) ? [...wire.reasons] : [],
    rationale: wire.rationale ?? null,
    detectedClaims: Array.isArray(wire.detected_claims) ? [...wire.detected_claims] : [],
    disclosureRequired: wire.disclosure_required === true,
    reviewUrl: wire.review_url ?? null,
    reviewState: wire.review_state ?? null,
    // A patient audience never receives text from this field, whatever the server sends.
    deliverableContent: wire.audience === "clinician" ? (wire.deliverable_content ?? null) : null,
    releasedContent: wire.released_content ?? null,
    stopClass: toStopClass(wire.stop_class),
    // The API's value. `Govern` narrows it to at most once per decision id on
    // the way out (see `Govern.read`); `raw.send_holding_line` keeps the original.
    sendHoldingLine: wire.send_holding_line === true,
    model: typeof wire.model === "string" ? wire.model : null,
    modelVersion: typeof wire.model_version === "string" ? wire.model_version : null,
    createdAt: wire.created_at ?? null,
    decidedAt: wire.decided_at ?? null,
    reviewedAt: wire.reviewed_at ?? null,
    outcome: wire.outcome ? toOutcome(wire.outcome) : null,
    // Read from the typed wire. Absent means false.
    routeToHuman: wire.route_to_human === true,
    wouldHaveRouted: wire.would_have_routed === true,
    inboundFlags: toInboundFlags(wire.inbound_flags),
    handoff: toHandoffRef(wire.handoff),
    webhookDeliveries: Array.isArray(wire.webhook_deliveries) ? [...wire.webhook_deliveries] : [],
    unknownDecision: known ? null : rawVerdict,
    accepted,
    degraded: !known,
    raw: wire,
  };
}

/**
 * A class this version does not know reads as `uncertain`, the releasable
 * one: that is what the API itself answers for a stop that predates the
 * class, and it claims less than `never_sendable` does.
 */
function toStopClass(value: unknown): StopClass | null {
  if (value === null || value === undefined) return null;
  return value === "never_sendable" ? "never_sendable" : "uncertain";
}

/** Reasons on which the contract says another message is the wrong thing, not merely an unnecessary one. */
const NO_HOLDING_LINE: ReadonlySet<string> = new Set([
  REASONS.optedOut,
  REASONS.consentMissing,
  REASONS.consentRevoked,
  REASONS.frequencyCap,
  REASONS.patientStateUnavailable,
]);

/** The API's conditions for a holding line, checked again on this side. */
function holdingLineApplies(decision: Decision): boolean {
  if (decision.decision === "allow") return false;
  if (decision.audience !== "patient") return false;
  if (decision.reviewState === "released" || decision.reviewState === "rejected") return false;
  return !decision.reasons.some((reason) => NO_HOLDING_LINE.has(reason));
}

function toInboundFlags(value: unknown): InboundFlag[] {
  if (!Array.isArray(value)) return [];
  const out: InboundFlag[] = [];
  for (const item of value) {
    if (item && typeof item === "object") {
      const flag = item as Record<string, unknown>;
      out.push({
        ruleId: typeof flag.rule_id === "string" ? flag.rule_id : "",
        category: typeof flag.category === "string" ? flag.category : "",
      });
    }
  }
  return out;
}

function toHandoffRef(value: unknown): HandoffRef | null {
  if (!value || typeof value !== "object") return null;
  const h = value as Record<string, unknown>;
  if (typeof h.id !== "string") return null;
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return {
    id: h.id,
    state: str(h.state) ?? "",
    version: typeof h.version === "number" ? h.version : 0,
    queueLabel: str(h.queue_label) ?? "",
    assignedTo: str(h.assigned_to),
    dueAt: str(h.due_at),
    escalationDueAt: str(h.escalation_due_at),
    resolvedAt: str(h.resolved_at),
    automationResumedAt: str(h.automation_resumed_at),
    // Absent only from a server that predates the field, where every open
    // hand-off paused automation; read it that way rather than as "not paused".
    pausesAutomation: h.pauses_automation !== false,
  };
}

// ---------------------------------------------------------------------------
// Hand-offs
// ---------------------------------------------------------------------------

/**
 * Hand-offs on your team: the tasks opened when the inbound screen routes a
 * patient to a person. `list` and `get` work with the application key and
 * see only this application's hand-offs. `claim`, `contactAttempt`, `resolve`
 * and `resume` are staff actions: the API refuses an application key on them
 * with 403; they are here for a server that presents a staff credential. Each
 * action carries `expectedVersion`; a stale one is refused with
 * `GovernConflictError`, and the actions are never retried.
 */
export class GovernHandoffs {
  constructor(private readonly transport: TransportConfig) {}

  async list(query: HandoffListQuery = {}): Promise<HandoffList> {
    const response = await send<HandoffList["raw"]>(this.transport, {
      method: "GET",
      path: GOVERN_PATHS.handoffs,
      query: {
        application_id: query.applicationId,
        status: query.status,
        assigned_to: query.assignedTo,
        overdue: query.overdue === undefined ? undefined : String(query.overdue),
        sort: query.sort,
        limit: query.limit === undefined ? undefined : String(query.limit),
        offset: query.offset === undefined ? undefined : String(query.offset),
      },
      signal: query.signal,
    });
    return {
      items: response.body.items,
      total: response.body.total,
      patientNames: { ...response.body.patient_names },
      awaitingReply: Array.isArray(response.body.awaiting_reply) ? [...response.body.awaiting_reply] : [],
      raw: response.body,
    };
  }

  async get(handoffId: string, options: { signal?: AbortSignal } = {}): Promise<HandoffDetail> {
    requireText(handoffId, "handoffId");
    const response = await send<HandoffDetail>(this.transport, {
      method: "GET",
      path: GOVERN_PATHS.handoff(handoffId),
      signal: options.signal,
    });
    return response.body;
  }

  /** Take the hand-off. */
  claim(handoffId: string, input: HandoffActionInput): Promise<Handoff> {
    return this.act(GOVERN_PATHS.handoffClaim, handoffId, input, { expected_version: input.expectedVersion });
  }

  /** Record an attempt to reach the patient on a claimed hand-off. */
  contactAttempt(handoffId: string, input: HandoffContactInput): Promise<Handoff> {
    const body: Record<string, unknown> = {
      expected_version: input.expectedVersion,
      outcome: input.outcome,
      note: input.note,
    };
    if (input.nextDueAt !== undefined) body.next_due_at = isoString(input.nextDueAt);
    return this.act(GOVERN_PATHS.handoffContact, handoffId, input, body);
  }

  /** Resolve a claimed hand-off. */
  resolve(handoffId: string, input: HandoffResolveInput): Promise<Handoff> {
    return this.act(GOVERN_PATHS.handoffResolve, handoffId, input, {
      expected_version: input.expectedVersion,
      disposition: input.disposition,
      note: input.note,
      resume_automation: input.resumeAutomation,
    });
  }

  /** Release the hold on automation for the patient of a resolved hand-off. */
  resume(handoffId: string, input: HandoffResumeInput): Promise<Handoff> {
    return this.act(GOVERN_PATHS.handoffResume, handoffId, input, {
      expected_version: input.expectedVersion,
      note: input.note,
    });
  }

  private async act(
    path: (id: string) => string,
    handoffId: string,
    input: HandoffActionInput,
    body: Record<string, unknown>,
  ): Promise<Handoff> {
    requireText(handoffId, "handoffId");
    if (!Number.isInteger(input.expectedVersion)) {
      throw new GovernConfigError("expectedVersion is required and must be the integer version you last read.");
    }
    const response = await send<Handoff>(this.transport, {
      method: "POST",
      path: path(handoffId),
      body,
      signal: input.signal,
      retry: false,
    });
    return response.body;
  }
}

function toOutcome(wire: NonNullable<WireDecision["outcome"]>): Outcome {
  return {
    delivered: wire.delivered,
    deliveredAt: wire.delivered_at,
    deliveredContentHash: wire.delivered_content_hash ?? null,
    deliveryRef: wire.delivery_ref ?? null,
    recordedAt: wire.recorded_at,
    hashMatchesRelease: wire.hash_matches_release ?? null,
    raw: wire,
  };
}

function toTranscriptJob(wire: WireTranscriptJob, created: boolean): TranscriptJob {
  return {
    jobId: wire.job_id,
    applicationId: wire.application_id,
    status: wire.status,
    total: wire.total,
    processed: wire.processed,
    evaluated: wire.evaluated,
    duplicate: wire.duplicate,
    unavailable: wire.unavailable,
    abandoned: wire.abandoned,
    wouldHave: { ...wire.would_have },
    created,
    raw: wire,
  };
}

function settle(decision: Decision): ReleaseResult | null {
  if (decision.reviewState === "released") {
    return { state: "released", content: decision.releasedContent, decision };
  }
  if (decision.reviewState === "rejected") return { state: "rejected", decision };
  if (decision.decision === "allow") return { state: "not_held", decision };
  if (decision.decision === "block" && decision.reviewState === null) return { state: "blocked", decision };
  return null;
}

function runningInBrowser(): boolean {
  const w = (globalThis as { window?: { document?: unknown } }).window;
  return typeof w !== "undefined" && typeof w.document !== "undefined";
}

function requireText(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new GovernConfigError(`${name} is required and must be a non-empty string.`);
  }
}

/** Code points, as the API counts them; `"a".length` and `[..."a"].length` differ on astral characters. */
function codePoints(value: string): number {
  return [...value].length;
}

/**
 * A `conversationId` the API will accept: non-empty and inside
 * `MAX_CONVERSATION_ID_CHARS`.
 *
 * Checked here rather than left to the 400. `guard` degrades on a refused
 * call, so in enforce an identifier the API will not accept holds every turn
 * of the conversation; `isClientMisconfiguration` at least says that is the
 * caller's to fix, but it cannot say which field. A `GovernConfigError` names
 * the field, is re-thrown by `guard` rather than degraded, and arrives before
 * the draft is generated.
 */
function requireConversationId(value: unknown, name = "conversationId"): asserts value is string {
  requireText(value, name);
  if (codePoints(value.trim()) > MAX_CONVERSATION_ID_CHARS) {
    throw new GovernConfigError(
      `${name} must be at most ${MAX_CONVERSATION_ID_CHARS} characters. The API composes the conversation's disclosure reference from it, and that reference is bounded.`,
    );
  }
}

/**
 * A `turnId` the API will accept: non-empty, outside the reserved prefix, and
 * inside `MAX_TURN_ID_CHARS`. Same reasoning as `requireConversationId`; the
 * value is also sent as `Idempotency-Key`, which carries the same rules.
 */
function requireTurnId(value: unknown, name = "turnId"): asserts value is string {
  requireText(value, name);
  const trimmed = value.trim();
  if (trimmed.startsWith(RESERVED_TURN_ID_PREFIX)) {
    throw new GovernConfigError(
      `${name} must not start with "${RESERVED_TURN_ID_PREFIX}", which is reserved for the rows the API writes itself.`,
    );
  }
  if (codePoints(trimmed) > MAX_TURN_ID_CHARS) {
    throw new GovernConfigError(
      `${name} must be at most ${MAX_TURN_ID_CHARS} characters. The API composes the turn's reference from it, and that reference is bounded.`,
    );
  }
}

/**
 * The key a retried POST is replayed by: the caller's, or one for this call.
 *
 * The transport retries 5xx and timeouts, so a write without a key can land
 * twice from one call. A per-call default makes
 * every attempt of one call the same write, and leaves two deliberate calls
 * two writes. Blank is treated as absent, and the value is never in the API's
 * reserved `govern:` range.
 */
function idempotencyKey(given: string | undefined): string {
  return given?.trim() || randomId();
}

function isoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * Wrap a caller's `onEvent` so a throw from it can never reach the code that
 * decided what to deliver.
 *
 * The decision event is emitted from inside `evaluate`, and the degraded event
 * from inside `guard`'s own catch. An escaping throw therefore lands in
 * `guard`'s catch or at the caller, and the caller's obvious shape is
 * `try { send((await guard(...)).text) } catch { send(draft) }`: a logging bug
 * would fail open, which is the one outcome this package exists to prevent.
 *
 * A throw is swallowed and reported back on the one channel that cannot change
 * a verdict: an `error` event with `operation: "on_event"`, carrying the
 * callback's own error text and nothing of the message. A callback that throws
 * on that report too gets silence rather than recursion; no telemetry is worth
 * turning a hold into a thrown error at the caller.
 */
export function isolateEvents(
  onEvent: ((event: GovernEvent) => void) | undefined,
): ((event: GovernEvent) => void) | undefined {
  if (!onEvent) return undefined;
  let reporting = false;
  return (event: GovernEvent): void => {
    try {
      onEvent(event);
    } catch (error) {
      if (reporting) return;
      reporting = true;
      try {
        onEvent({ type: "error", operation: "on_event", error: describe(error) });
      } catch {
        // Nothing left to tell, and nowhere safe to tell it.
      } finally {
        reporting = false;
      }
    }
  };
}

/** An insertion-ordered map that evicts its oldest entry past `max`. */
class BoundedMap<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly max: number) {}

  get(key: K): V | undefined {
    return this.map.get(key);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }
}

export type { Audience, Channel, Mode };
