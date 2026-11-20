/**
 * `Govern`: the client, `guard`, and hold resolution.
 */

import { randomId, sha256Hex } from "./crypto";
import { GovernAbortError, GovernApiError, GovernConfigError, GovernConflictError, GovernReportError } from "./errors";
import { send, type TransportConfig } from "./http";
import { requireAbortSignal } from "./signal";
import { MAX_SHORT_TEXT_CHARS, codePoints, shortTextFault, trimAsApi } from "./text";
import { timeValue } from "./time";
import type {
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
  OutcomeEvent,
  PatientConsentInput,
  PatientOptOutInput,
  RecordDisclosureInput,
  ReleaseResult,
  ReportedOutcomeKind,
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
  WireOutcome,
  WireOutcomeEvent,
  WireOutcomeRequest,
  WirePatientState,
  WireTranscriptBatch,
  WireTranscriptJob,
  WireTranscriptTurnView,
  WireWebhookDelivery,
} from "./types";
import { REASONS, isInSessionChannel, isOutboundChannel } from "./types";
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
 * column is bounded, so the limit is on the identifier, checked before the
 * write and not discovered at it.
 */
export const MAX_CONVERSATION_ID_CHARS = 187;
/** Longest `turnId` the API accepts, in code points. Same reason, shorter fixed part. */
export const MAX_TURN_ID_CHARS = 206;
/** Longest `turnRef` the API accepts, in code points. */
export const MAX_TURN_REF_CHARS = 128;
/** Most decision ids one turn's `supersedes` may name. */
export const MAX_SUPERSEDES = 8;

/**
 * The two 4xx that mean "later", not "no". Everything else in the 4xx
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
 * than 408, 409 and 429). Such a failure does not heal; alert on it
 * separately from `gate_unavailable`.
 *
 * A revoked application key and an unreachable API both arrive at `guard` as
 * "no decision" and both hold in enforce; this tells them apart. Anything that
 * is not a recognised API answer (a timeout, a dropped connection, an error
 * class this version does not know) is reported as `gate_unavailable`.
 *
 * A 409 is not a misconfiguration: it is the record's state moving under the
 * call (a `retryOf` naming a decision already superseded, retried or
 * delivered, or one a reviewer acted on first; a `supersedes` naming an
 * enforce decision still being decided, or one delivered, reviewed,
 * superseded or retried), and `guard` reports it as `turn_conflict`.
 */
export function isClientMisconfiguration(error: unknown): boolean {
  if (!(error instanceof GovernApiError)) return false;
  if (error.status < 400 || error.status >= 500 || error.status === 409) return false;
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
  /** Decision ids whose holding line this instance has already armed. */
  private readonly holdingLines = new BoundedMap<string, true>(10_000);
  /**
   * Outcome reports on the wire, each settling (never rejecting) when its
   * write is done. A report joins before anything of it is awaited, its hash
   * included, so `flushReports` waits for every report started before it.
   */
  private readonly reportsInFlight = new Set<Promise<void>>();
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
    if (options.holdMessage !== undefined) requireHoldMessage(options.holdMessage, "Govern: `holdMessage`");
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
    // `null` is none, as `undefined` is, for all three.
    const retryOf = input.retryOf ?? undefined;
    if (retryOf !== undefined) requireRetryOf(retryOf);
    const turnRef = input.turnRef ?? undefined;
    if (turnRef !== undefined) requireTurnRef(turnRef);
    const supersedes = supersedesOf(input.supersedes);
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
    if (retryOf !== undefined) body.retry_of = retryOf;
    if (turnRef !== undefined) body.turn_ref = turnRef;
    if (supersedes !== undefined) body.supersedes = [...supersedes];
    const response = await send<WireDecision>(this.transport, {
      method: "POST",
      path: GOVERN_PATHS.evaluate,
      body,
      idempotencyKey: input.turnId,
      signal: input.signal,
    });
    // A replayed turn whose outcome is already on record is closed: its
    // holding line, if one was owed, went out with that outcome.
    const decision = this.read(toDecision(response.body, response.status === 202), { arm: outcomeStateOf(response.body) === null });
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
   * Record one outcome event for a decision: `released` when you wrote the
   * reply to its channel, `delivered` when the channel confirmed it reached
   * the person, `discarded` when it was dropped before it reached anyone,
   * `failed` when an attempt to deliver it failed. The text of `released`
   * and `delivered` is hashed here with SHA-256 and only the hash is sent.
   *
   * One event per kind per decision, `failed` excepted: the same event again
   * is accepted and resolves with the decision as recorded; a different
   * event of a kind already on record is refused with 409
   * (`GovernConflictError`). The fields are checked before anything is sent
   * (`GovernConfigError` naming the field). The report is tracked from the
   * moment this is called, so `flushReports` waits for it.
   */
  async reportOutcome(decisionId: string, input: ReportOutcomeInput): Promise<Decision> {
    requireText(decisionId, "decisionId");
    checkOutcome(input);
    return this.track(this.writeOutcome(decisionId, input));
  }

  /**
   * Internal: the report the adapters make. Not part of the supported
   * surface; call `reportOutcome`.
   *
   * Records one outcome event as `reportOutcome` does, and never rejects:
   * when the event does not land, `onFailure` is called with a
   * `GovernReportError` built from the body as it was sent (the `at`, the
   * hash and the trimmed texts the request carried; nothing is hashed
   * again), or, when the fields were refused before anything was sent, from
   * the fields as given, trimmed as the API trims them. A `kind` outside the
   * four a caller reports has no event to name: `onFailure` gets the
   * `GovernConfigError` itself. The whole of it, the fields' check, the hash,
   * the request and the call to `onFailure`, is one promise in
   * `reportsInFlight` from the moment this is called, so `flushReports`
   * resolves only after `onFailure` has run. A field refused before sending
   * reaches `onFailure` at once, with nothing awaited.
   *
   * @internal
   */
  reportForAdapter(
    decisionId: string,
    input: ReportOutcomeInput,
    onFailure: (error: GovernReportError | GovernConfigError) => void,
  ): Promise<void> {
    let body: WireOutcomeRequest | undefined;
    const done = (async (): Promise<void> => {
      try {
        requireText(decisionId, "decisionId");
        checkOutcome(input);
        body = await outcomeBody(input);
        await this.postOutcome(decisionId, body, input.signal);
      } catch (cause) {
        let error: GovernReportError | GovernConfigError;
        const kind: unknown = input.kind;
        if (typeof kind === "string" && REPORTED_KINDS.has(kind)) {
          const given = (value: unknown): string | null => (typeof value === "string" ? trimAsApi(value) : null);
          error = new GovernReportError({
            decisionId: String(decisionId),
            kind: kind as ReportedOutcomeKind,
            at: body?.at ?? timeValue(input.at) ?? String(input.at),
            contentHash: body ? (body.content_hash ?? null) : null,
            deliveryRef: body ? (body.delivery_ref ?? null) : given(input.deliveryRef),
            reason: body ? (body.reason ?? null) : given(input.reason),
            cause,
          });
        } else {
          // Refused before anything was built: there is no event to resend.
          error = cause instanceof GovernConfigError ? cause : new GovernConfigError(String(cause));
        }
        try {
          onFailure(error);
        } catch {
          // The adapters pass an isolated handler; nothing escapes a report.
        }
      }
    })();
    this.track(done);
    return done;
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
   * - API unreachable, or `ctx.gateSignal` fired: a hold, as above, when the
   *   channel's last known mode is enforce (or unknown), the draft flagged
   *   `degraded` when it is observe or off
   *
   * `ctx.signal` cancels the call instead: its abort is rethrown as
   * `GovernAbortError`, and it wins when both signals fired.
   *
   * On a hold, `sendHoldingLine` says whether a holding line is owed to the
   * patient now: at most once per decision in this instance, and never where
   * the contract says another message is the wrong thing. `showHoldText`
   * applies the channel: true on every hold in an in-session channel
   * (`web_chat`, `app_message`, `voice`), where the patient is waiting for
   * the reply, and `sendHoldingLine` on an outbound or unknown channel. The
   * API's `show_hold_text` wins when the decision carries it (see
   * `GuardResult.showHoldText`).
   *
   * Never returns rewritten text for a patient audience. Reports no outcome:
   * once you write `text`, record it with `reportOutcome` (see
   * `GuardResult.record`).
   */
  async guard(fn: () => Draft | Promise<Draft>, ctx: GuardContext): Promise<GuardResult> {
    // Before `fn`, so a draft is never generated for a turn the API would
    // refuse on its identifiers. `null` is none, as `undefined` is, for
    // `retryOf`, `turnRef`, `supersedes` and both signals.
    requireConversationId(ctx.conversationId);
    if (ctx.turnId !== undefined) requireTurnId(ctx.turnId);
    const retryOf = ctx.retryOf ?? undefined;
    if (retryOf !== undefined) requireRetryOf(retryOf);
    const turnRef = ctx.turnRef ?? undefined;
    if (turnRef !== undefined) requireTurnRef(turnRef);
    const supersedes = supersedesOf(ctx.supersedes);
    if (ctx.holdMessage !== undefined) requireHoldMessage(ctx.holdMessage, "guard: `ctx.holdMessage`");
    const callSignal = requireAbortSignal(ctx.signal, "guard: `ctx.signal`");
    const gateSignal = requireAbortSignal(ctx.gateSignal, "guard: `ctx.gateSignal`");

    const produced = await fn();
    const producedText = typeof produced === "string" ? produced : produced?.text;
    if (typeof producedText !== "string") {
      throw new GovernConfigError("guard: the draft function must return a string or { text: string }.");
    }
    const draft: string = producedText;
    const turnId = ctx.turnId ?? randomId();
    const holdMessage = ctx.holdMessage ?? this.holdMessage;

    let record: Decision | null = null;
    let mode: Mode;
    let degraded = false;
    let degradeCause: "gate_unavailable" | "client_misconfigured" | "turn_conflict" = "gate_unavailable";
    let routeToHuman = false;
    let handoff: HandoffRef | null = null;
    let inboundFlags: InboundFlag[] = [];
    // The transport takes one signal: the request runs under whichever of the
    // caller's cancel and the gate bound fires first, and the catch below
    // reads which one did.
    const requestSignal = eitherSignal(callSignal, gateSignal);
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
      if (retryOf !== undefined) input.retryOf = retryOf;
      if (turnRef !== undefined) input.turnRef = turnRef;
      if (supersedes !== undefined) input.supersedes = supersedes;
      if (requestSignal.signal !== undefined) input.signal = requestSignal.signal;
      record = await this.evaluate(input);
      mode = record.mode;
      degraded = record.degraded;
      routeToHuman = record.routeToHuman || record.decision === "route_to_human";
      handoff = record.handoff;
      inboundFlags = record.inboundFlags;
    } catch (error) {
      if (error instanceof GovernConfigError) throw error;
      // The caller's cancel is rethrown, and wins when both fired. The gate
      // bound alone is an unreachable gate, and falls through to that rule.
      if (error instanceof GovernAbortError && !gateBoundFired(callSignal, gateSignal)) throw error;
      degraded = true;
      // The hold is the same every way. What differs is who has work to do,
      // and an operator cannot act on a signal that will not say which: a
      // 409 is a race on the record's state, not a key to fix.
      degradeCause =
        error instanceof GovernConflictError
          ? REASONS.turnConflict
          : isClientMisconfiguration(error)
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
    } finally {
      requestSignal.dispose();
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
    // The same derivation as `Decision.showHoldText`: the API's answer when
    // the decision carries one, else the channel rule. An SDK-side fail-closed
    // hold has no decision, so the channel rule decides it.
    const showHoldText = holdTextShown({
      held,
      audience: ctx.audience,
      channel: ctx.channel,
      sendHoldingLine,
      wire: record?.raw ?? null,
    });
    if (held && !showHoldText) text = "";
    const stopClass = record?.stopClass ?? null;

    return {
      text,
      decisionId: record?.id ?? null,
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
    };
  }

  /**
   * Wait for every outcome report already on the wire: those `reportOutcome`
   * was called for and those an adapter made. Resolves once each has
   * settled, whether it was recorded or failed (a failure reaches the caller
   * of `reportOutcome`, or an adapter's `onError`). Call it on shutdown: a
   * report still in flight when the process exits is lost. A
   * `deliveredText` hook that has not answered yet has no report on the wire,
   * so it is not waited for.
   */
  async flushReports(): Promise<void> {
    while (this.reportsInFlight.size > 0) await Promise.all([...this.reportsInFlight]);
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

  /**
   * Hash the text (when no hash is given) and post the event. The caller has
   * checked the fields. An outcome is recorded after something happened to
   * the reply, so the answer never arms a holding line; it does count as
   * having seen the decision.
   */
  private async writeOutcome(decisionId: string, input: ReportOutcomeInput): Promise<Decision> {
    return this.postOutcome(decisionId, await outcomeBody(input), input.signal);
  }

  /** Post a built outcome body. */
  private async postOutcome(decisionId: string, body: WireOutcomeRequest, signal: AbortSignal | undefined): Promise<Decision> {
    const response = await send<WireDecision>(this.transport, {
      method: "POST",
      path: GOVERN_PATHS.outcome(decisionId),
      body,
      signal,
    });
    this.onEvent?.({ type: "outcome", decisionId, kind: body.kind as ReportedOutcomeKind });
    return this.read(toDecision(response.body, false), { arm: false });
  }

  /** Keep `work` in `reportsInFlight` until it settles, and hand it back unchanged. */
  private track<T>(work: Promise<T>): Promise<T> {
    const settled: Promise<void> = work.then(
      () => undefined,
      () => undefined,
    );
    this.reportsInFlight.add(settled);
    void settled.then(() => this.reportsInFlight.delete(settled));
    return work;
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
    const eligible = options.arm && holdingLineApplies(decision) && !this.holdingLines.has(decisionKey(id));
    this.holdingLines.set(decisionKey(id), true);
    if (eligible) return decision;
    // On an outbound channel the hold text is the holding line, so it is
    // withheld with it.
    const narrowed = { ...decision, sendHoldingLine: false };
    return { ...narrowed, showHoldText: decisionShowsHoldText(narrowed) };
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
  const mapped: Decision = {
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
    // Set below, from the rest of the mapped decision.
    showHoldText: false,
    // Absent from a server that predates the fields: not retryable, not a retry.
    retryable: wire.retryable === true,
    retryOf: typeof wire.retry_of === "string" ? wire.retry_of : null,
    model: typeof wire.model === "string" ? wire.model : null,
    modelVersion: typeof wire.model_version === "string" ? wire.model_version : null,
    createdAt: wire.created_at ?? null,
    decidedAt: wire.decided_at ?? null,
    reviewedAt: wire.reviewed_at ?? null,
    outcome: toOutcome(wire.outcome),
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
  mapped.showHoldText = decisionShowsHoldText(mapped);
  return mapped;
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

/**
 * `showHoldText`, the one derivation of it: `toDecision` and `Govern.read`
 * call it for `Decision`, and `guard` for `GuardResult`.
 *
 * Nothing is shown where nothing was held. Otherwise the API's
 * `show_hold_text` decides when the decision carries one: the API knows an
 * accepted retry and a channel this version may not. A server that predates
 * the field, and a fail-closed hold with no decision at all, get the channel
 * rule: nothing once a reviewer has released or rejected the hold (the
 * released text is the reply, or a person decided the turn); otherwise a
 * clinician is shown the hold notice on every stop, a patient in session on
 * every stop, and a patient on an outbound or unknown channel only when a
 * holding line is owed.
 *
 * Two limits hold whichever answered, because on an outbound channel the
 * hold text IS the holding line, and the at-most-once memory and the second
 * check of the API's conditions for it live in `Govern.read`:
 * - on `sms` and `email`, a patient's hold text is shown only where
 *   `sendHoldingLine` (as narrowed) is true;
 * - on a channel this version does not know, it is not shown where the SDK
 *   withheld a holding line the API offered.
 */
function holdTextShown(input: {
  held: boolean;
  audience: unknown;
  channel: unknown;
  /** As `Govern.read` narrowed it. */
  sendHoldingLine: boolean;
  /** The decision as the API sent it; null when there is none. */
  wire: { show_hold_text?: unknown; send_holding_line?: unknown; review_state?: unknown } | null;
}): boolean {
  const { held, audience, channel, sendHoldingLine, wire } = input;
  if (!held) return false;
  const inSession = isInSessionChannel(channel);
  let shown: boolean;
  if (typeof wire?.show_hold_text === "boolean") shown = wire.show_hold_text;
  else if (wire?.review_state === "released" || wire?.review_state === "rejected") shown = false;
  else shown = audience !== "patient" || inSession || sendHoldingLine;
  if (!shown || audience !== "patient" || inSession) return shown;
  if (isOutboundChannel(channel)) return sendHoldingLine;
  return sendHoldingLine || wire?.send_holding_line !== true;
}

function decisionShowsHoldText(decision: Decision): boolean {
  return holdTextShown({
    held: decision.decision !== "allow",
    audience: decision.audience,
    channel: decision.channel,
    sendHoldingLine: decision.sendHoldingLine,
    wire: decision.raw,
  });
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
    // hand-off paused automation; read it that way, never as "not paused".
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

/**
 * The outcome trail, or null when there is none. An outcome without a
 * `state` is not one this version can read (a server that predates the
 * event trail): it maps to null, and `raw.outcome` keeps it.
 */
function toOutcome(wire: WireDecision["outcome"]): Outcome | null {
  if (!wire || typeof wire !== "object" || typeof wire.state !== "string") return null;
  return {
    state: wire.state,
    events: Array.isArray(wire.events) ? wire.events.map(toOutcomeEvent) : [],
    raw: wire as WireOutcome,
  };
}

function toOutcomeEvent(wire: WireOutcomeEvent): OutcomeEvent {
  return {
    kind: wire.kind,
    source: wire.source,
    at: wire.at,
    recordedAt: wire.recorded_at,
    contentHash: wire.content_hash ?? null,
    deliveryRef: wire.delivery_ref ?? null,
    reason: wire.reason ?? null,
    hashMatchesRelease: wire.hash_matches_release ?? null,
    supersededBy: wire.superseded_by ?? null,
    raw: wire,
  };
}

/** The state of a decision's outcome trail on the wire, or null when it has none. */
function outcomeStateOf(wire: WireDecision): string | null {
  const state: unknown = wire.outcome?.state;
  return typeof state === "string" ? state : null;
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

/**
 * A `conversationId` the API will accept: non-empty and inside
 * `MAX_CONVERSATION_ID_CHARS`.
 *
 * Checked here, not left to the 400. `guard` degrades on a refused call, so
 * in enforce an identifier the API will not accept holds every turn of the
 * conversation; `isClientMisconfiguration` at least says that is the
 * caller's to fix, but it cannot say which field. A `GovernConfigError` names
 * the field, is re-thrown by `guard` and never degraded, and arrives before
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
 * A `retryOf` the API can read: the `id` of a decision, which is a UUID. Any
 * other value is a 400 from the API, so it is refused here, before a draft is
 * generated for a turn the API would refuse. Exported for the adapters, which
 * check a per-call `retryOf` before the model runs. Callers pass `null` as
 * absent before they get here.
 */
export function requireRetryOf(value: unknown, name = "retryOf"): asserts value is string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new GovernConfigError(`${name} must be the id of the decision this turn retries (a UUID).`);
  }
}

/**
 * A `turnRef` the API will accept: non-empty and inside
 * `MAX_TURN_REF_CHARS`. Refused here, before a draft is generated, for the
 * same reason as `requireConversationId`. Exported for the adapters, which
 * check a per-call value before the model runs. Callers pass `null` as
 * absent before they get here.
 */
export function requireTurnRef(value: unknown, name = "turnRef"): asserts value is string {
  requireText(value, name);
  if (codePoints(value) > MAX_TURN_REF_CHARS) {
    throw new GovernConfigError(`${name} must be at most ${MAX_TURN_REF_CHARS} characters.`);
  }
}

/**
 * A `supersedes` list the API can read, as it will be sent: undefined for
 * none (`undefined`, `null` or an empty list), else a copy of at most
 * `MAX_SUPERSEDES` decision ids, each a UUID. Anything else is refused here,
 * before a draft is generated. Exported for the adapters, which check a
 * per-call value before the model runs.
 */
export function supersedesOf(value: unknown, name = "supersedes"): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new GovernConfigError(`${name} must be a list of the decision ids this turn replaces.`);
  }
  if (value.length > MAX_SUPERSEDES) {
    throw new GovernConfigError(`${name} may name at most ${MAX_SUPERSEDES} decisions.`);
  }
  for (const id of value) {
    if (typeof id !== "string" || !UUID.test(id)) {
      throw new GovernConfigError(`${name} must hold only decision ids (UUIDs).`);
    }
  }
  return value.length === 0 ? undefined : [...(value as string[])];
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

/**
 * One signal that fires when either does, for a transport that takes one.
 * `AbortSignal.any` is not on every runtime this package supports, so the
 * listeners are added here and removed by `dispose` once the call is over.
 */
function eitherSignal(
  first: AbortSignal | undefined,
  second: AbortSignal | undefined,
): { signal: AbortSignal | undefined; dispose: () => void } {
  const none = (): void => {};
  if (first === undefined || second === undefined) return { signal: first ?? second, dispose: none };
  if (first.aborted) return { signal: first, dispose: none };
  if (second.aborted) return { signal: second, dispose: none };
  const controller = new AbortController();
  const onFirst = (): void => controller.abort(first.reason);
  const onSecond = (): void => controller.abort(second.reason);
  first.addEventListener("abort", onFirst, { once: true });
  second.addEventListener("abort", onSecond, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      first.removeEventListener("abort", onFirst);
      second.removeEventListener("abort", onSecond);
    },
  };
}

/**
 * A hold message is the text a held patient sees in place of the reply, and
 * an empty one would be shown as nothing while every report said it was
 * delivered. Refused when empty or blank.
 */
function requireHoldMessage(value: unknown, where: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new GovernConfigError(`${where} must be a non-empty string: it is the text a held patient sees in place of the reply.`);
  }
}

/** Decision ids are UUIDs, compared without case: the key of every per-decision map. */
function decisionKey(decisionId: string): string {
  return decisionId.toLowerCase();
}

/** The outcome kinds a caller records. `superseded` is the API's own. */
const REPORTED_KINDS: ReadonlySet<string> = new Set(["released", "delivered", "discarded", "failed"]);
/** The kinds that carry the hash of the text. */
const HASHED_KINDS: ReadonlySet<string> = new Set(["released", "delivered"]);

/**
 * The outcome body for checked fields, as it will be sent. Blank or `null`
 * is absent, so a blank hash is never recorded as the hash of a message,
 * and empty content is nothing went out. Only the kinds that carry a hash
 * get one, computed here and nowhere else. The hash and the short texts are
 * trimmed once, here, as the API trims them.
 */
async function outcomeBody(input: ReportOutcomeInput): Promise<WireOutcomeRequest> {
  let hash: string | undefined;
  if (HASHED_KINDS.has(input.kind)) {
    const given = trimAsApi(input.contentHash ?? "").toLowerCase();
    hash = given === "" ? undefined : given;
    if (hash === undefined && typeof input.content === "string" && input.content !== "") hash = await sha256Hex(input.content);
  }
  const body: WireOutcomeRequest = { kind: input.kind, at: timeValue(input.at) as string };
  if (hash !== undefined) body.content_hash = hash;
  if (typeof input.deliveryRef === "string") body.delivery_ref = trimAsApi(input.deliveryRef);
  if (typeof input.reason === "string") body.reason = trimAsApi(input.reason);
  return body;
}

/** SHA-256 hex, either case, as the API takes it. */
const SHA256_HEX = /^[0-9a-f]{64}$/i;

/**
 * A `deliveryRef` or `reason` the API will take: absent (`undefined` or
 * `null`), or a string that, trimmed as the API trims it, is not blank, is
 * at most 256 characters and carries no control character. Sent trimmed.
 */
function checkShortText(value: unknown, name: string): void {
  if (value === undefined || value === null) return;
  const fault = shortTextFault(value);
  if (fault === "is not a string") throw new GovernConfigError(`reportOutcome: \`${name}\` must be a string.`);
  if (fault !== undefined) {
    throw new GovernConfigError(`reportOutcome: \`${name}\` must not be blank, must be at most ${MAX_SHORT_TEXT_CHARS} characters, and must carry no control characters; it ${fault}.`);
  }
}

/**
 * An outcome report's fields, checked before anything is posted, so a slip
 * is a `GovernConfigError` naming the field and not a body the API refuses
 * (or a `RangeError` from deep in the report). The API's own rules are
 * mirrored: `released` and `delivered` carry the hash of the text,
 * `discarded` and `failed` carry none; a hash is 64 hex characters; a
 * reference or a reason is bounded. Empty `content` is no text, the SDK's
 * one "nothing went out" value. JavaScript callers are the reason for the
 * type checks: `content: 123` would record the hash of "123".
 */
function checkOutcome(input: {
  kind?: unknown;
  at?: unknown;
  content?: unknown;
  contentHash?: unknown;
  deliveryRef?: unknown;
  reason?: unknown;
}): void {
  const kind = input.kind;
  if (kind === "superseded") {
    throw new GovernConfigError("reportOutcome: `superseded` is recorded by the API itself, when it accepts a turn that replaces the decision; report released, delivered, discarded or failed.");
  }
  if (typeof kind !== "string" || !REPORTED_KINDS.has(kind)) {
    throw new GovernConfigError("reportOutcome: `kind` must be released, delivered, discarded or failed.");
  }
  if (timeValue(input.at) === undefined) {
    throw new GovernConfigError("reportOutcome: `at` is required and must be a valid Date or an RFC 3339 date-time string, such as 2026-09-16T10:00:00Z.");
  }
  // `null` is absent for every optional field, as it is across the SDK.
  if (input.content !== undefined && input.content !== null && typeof input.content !== "string") {
    throw new GovernConfigError("reportOutcome: `content` must be a string.");
  }
  if (input.contentHash !== undefined && input.contentHash !== null && typeof input.contentHash !== "string") {
    throw new GovernConfigError("reportOutcome: `contentHash` must be a string (the SHA-256 hex of the text).");
  }
  // Blank is absent, for the hash and for the text.
  const givenHash = typeof input.contentHash === "string" ? trimAsApi(input.contentHash) : "";
  if (givenHash !== "" && !SHA256_HEX.test(givenHash)) {
    throw new GovernConfigError("reportOutcome: `contentHash` must be the SHA-256 of the UTF-8 text, as 64 hex characters.");
  }
  const hasText = (typeof input.content === "string" && input.content !== "") || givenHash !== "";
  if (HASHED_KINDS.has(kind) && !hasText) {
    throw new GovernConfigError(`reportOutcome: \`${kind}\` carries the hash of the text: pass \`content\` (hashed locally) or \`contentHash\`.`);
  }
  if (!HASHED_KINDS.has(kind) && hasText) {
    throw new GovernConfigError(`reportOutcome: \`${kind}\` carries no text; pass neither \`content\` nor \`contentHash\`.`);
  }
  checkShortText(input.deliveryRef, "deliveryRef");
  checkShortText(input.reason, "reason");
}

/** The gate bound fired and the caller's own cancel did not. */
function gateBoundFired(callSignal: AbortSignal | undefined, gateSignal: AbortSignal | undefined): boolean {
  return gateSignal?.aborted === true && callSignal?.aborted !== true;
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
 * on that report too gets silence, not recursion; no telemetry is worth
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
