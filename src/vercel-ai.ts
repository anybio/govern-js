/**
 * `@anybio/govern/vercel-ai`: a language-model middleware for the Vercel AI
 * SDK (`ai` v7, provider specification v4).
 *
 *   const model = wrapLanguageModel({ model: openai("gpt-4o"), middleware: withGovern({ govern, channel: "web_chat", audience: "patient" }) });
 *
 * `wrapGenerate` evaluates the generated text before it is returned.
 * `wrapStream` depends on the audience:
 *
 * - patient: buffer and release. Every part of the source stream is held,
 *   the full text is evaluated, and then either the original parts are
 *   replayed (allow) or the draft is replaced (hold, block, or the API
 *   unreachable in enforce). No token reaches the caller before the decision.
 * - clinician: pass through with a trailing evaluation. Tokens stream as
 *   they arrive; after the stream ends the full text is evaluated and the
 *   text that went out recorded as `released`.
 *
 * What replaces a held draft follows `reply.showHoldText`, the same rule as
 * `guard`: on an in-session channel (`web_chat`, `app_message`, `voice`) a
 * single text block with the hold message; on an outbound channel (`sms`,
 * `email`, or one this version does not know) the hold message only when a
 * holding line is owed, and otherwise no text at all, so a caller that sends
 * whatever the model returns sends nothing.
 *
 * Per-call identifiers travel in `providerOptions.anybioGovern`:
 *
 *   streamText({ model, messages, providerOptions: { anybioGovern: { conversationId: chatId, turnId: messageId } } });
 *
 * Every evaluation names the model: `model` is the wrapped model's `modelId`
 * (what you asked for, for example `gpt-4o`), and `modelVersion` is the model
 * id the provider reported on the response (the resolved snapshot, for
 * example `gpt-4o-2024-08-06`) when it reports one. Either can be overridden
 * in the options.
 *
 * Two signals, kept apart on purpose. The generation's own `abortSignal` is
 * the caller's cancel, and it never becomes a hold: a turn cancelled before
 * the gate is not gated, and a stream cancelled while the gate decides is
 * recorded as `discarded`. `providerOptions.anybioGovern.signal` (or the
 * `signal` option) bounds only the gate call, and its abort is an answer:
 * the rule for an unreachable API decides what is delivered.
 *
 * The middleware imports only types from `ai`; there is no runtime coupling.
 */

import type { LanguageModelMiddleware } from "ai";

import {
  callSafely,
  deliveredOutcome,
  delivers,
  failureReporter,
  handedOver,
  hasOutcomeOnRecord,
  postReport,
  type AdapterReport,
  type DeliveredText,
} from "./adapters";
import { Govern, requireRetryOf, requireTurnRef, supersedesOf, type GovernOptions } from "./client";
import { randomId } from "./crypto";
import { GovernConfigError } from "./errors";
import { requireAbortSignal } from "./signal";
import { OUTCOME_REASONS, type Audience, type Channel, type GuardContext, type GuardResult, type InboundMessage } from "./types";

export type { DeliveredMessage, DeliveredText } from "./adapters";

type WrapGenerate = NonNullable<LanguageModelMiddleware["wrapGenerate"]>;
type WrapArgs = Parameters<WrapGenerate>[0];
export type LanguageModelCallOptions = WrapArgs["params"];
type GenerateResult = Awaited<ReturnType<WrapArgs["doGenerate"]>>;
type StreamResult = Awaited<ReturnType<WrapArgs["doStream"]>>;
export type StreamPart = StreamResult["stream"] extends ReadableStream<infer P> ? P : never;
type ContentPart = GenerateResult["content"][number];
type ProviderMetadata = NonNullable<GenerateResult["providerMetadata"]>;
type GovernMetadata = ProviderMetadata[string];

/** The key under `providerOptions` the middleware reads per-call identifiers from. */
export const PROVIDER_OPTIONS_KEY = "anybioGovern";
/** The key under `providerMetadata` the middleware writes the decision to. */
export const PROVIDER_METADATA_KEY = "anybioGovern";

/** What a caller may pass as `providerOptions.anybioGovern` on one call. */
export interface GovernCallOptions {
  conversationId?: string;
  turnId?: string;
  /** The decision this call's turn retries. See `EvaluateInput.retryOf`. `null` is no retry. */
  retryOf?: string | null;
  /** Your stable reference for the patient turn. See `EvaluateInput.turnRef`. `null` is none. */
  turnRef?: string | null;
  /** The decisions this call's turn replaces. See `EvaluateInput.supersedes`. `null` is none. */
  supersedes?: string[] | null;
  patientRef?: string;
  metadata?: Record<string, unknown>;
  /**
   * Bounds the gate call for this call; see the `signal` option for what an
   * abort does. The more specific bound, so it wins over the option. `ai`
   * types `providerOptions` as JSON, so a signal here needs a cast at the
   * call site. `null` is no bound. A value that is not a signal is refused
   * with `GovernConfigError` when the call starts, before the model runs,
   * on every audience: it is known then, so the call fails early.
   *
   * Its clock starts when you create it, not when the gate call starts: one
   * made before the call bounds the generation and the gate together, and on
   * a clinician stream it has run through the whole stream before the
   * trailing gate call begins. For a bound measured from the gate call, use
   * the `signal` option, `() => AbortSignal.timeout(ms)`, which is called
   * when the gate call starts.
   */
  signal?: AbortSignal | null;
}

type Resolvable<T> = T | ((params: LanguageModelCallOptions) => T | undefined);

export interface WithGovernOptions {
  /** A `Govern` client, or the options to construct one. */
  govern: Govern | GovernOptions;
  channel: Channel;
  audience: Audience;
  /** Your thread id. A string, a function of the call params, or per call via `providerOptions.anybioGovern.conversationId`. Required by one of those routes. */
  conversationId?: Resolvable<string>;
  /** Your message id. Default: `providerOptions.anybioGovern.turnId`, else a random id per call. */
  turnId?: Resolvable<string>;
  patientRef?: Resolvable<string>;
  metadata?: Resolvable<Record<string, unknown>>;
  /** The model name recorded on each decision. Default: the wrapped model's `modelId`. */
  model?: Resolvable<string>;
  /** The model version recorded on each decision. Default: the model id the provider reported on the response, when it reports one. */
  modelVersion?: Resolvable<string>;
  /**
   * The patient's inbound message, for the red-flag screen. Requires
   * `patientRef` (the option, or `providerOptions.anybioGovern.patientRef`).
   */
  inbound?: (params: LanguageModelCallOptions) => InboundMessage | undefined;
  /** Overrides the client's hold message. */
  holdMessage?: string;
  /**
   * Bounds the gate call: a function of the call params that returns a
   * signal for this call. It is called when the gate call starts, and only
   * when the call carries no `providerOptions.anybioGovern.signal`, which is
   * the more specific bound. A timeout made here, `() =>
   * AbortSignal.timeout(800)`, bounds the gate call alone. A function, never
   * a signal: one signal shared by every call would hold every call after it
   * fired, so a bare signal is refused at construction. It may return
   * `undefined` or `null` for no bound; a value it returns that is not a
   * signal is refused with `GovernConfigError` when the gate call starts,
   * which on a clinician stream is the trailing gate call after the text went
   * out, so there the error goes to `onError`.
   *
   * When it aborts, before or during the gate call, the call ends (no retry
   * follows) and the rule for an unreachable API applies: in enforce the draft
   * is held, with the hold message where `showHoldText` is true and no text
   * where it is false; in observe the draft goes out flagged `degraded`. The
   * reply carries `reasons: ["gate_unavailable"]` and no decision id, and the
   * client emits its `degraded` event. It travels to `guard` as
   * `gateSignal`, which answers this way; the call's own `signal` would be
   * rethrown instead, and the middleware owns the delivery.
   *
   * A clinician stream is the exception: its text has gone out before the
   * trailing gate call starts, so nothing can be withheld. An abort there
   * goes to `onError`, `onDecision` is not called, and nothing is recorded.
   *
   * Not the generation's `abortSignal`, which is the caller's cancel and is
   * never read here: wiring it in would turn a cancel into a hold.
   */
  signal?: (params: LanguageModelCallOptions) => AbortSignal | null | undefined;
  /**
   * Record the write-time outcome once per decision, as the reply is handed
   * over: `released` with the hash of the text the middleware let through,
   * or of what `deliveredText` says went out; `discarded` when nothing went
   * out. Default true.
   *
   * With false the middleware reports nothing, and the outcome is yours
   * alone to record with `govern.reportOutcome`. A decision you never report
   * stays without an outcome.
   */
  reportOutcome?: boolean;
  /**
   * What actually went out, for the outcome report. Without it the middleware
   * records `released` with the text it let through, or `discarded`
   * (`nothing_to_send`) when it let nothing through. With it, the middleware
   * asks: return the text you wrote to the channel (it is hashed locally;
   * only the hash is sent), `{ text, deliveredAt?, deliveryRef? }` to say
   * when it went out (for a voice line, when it started to be spoken) and
   * under which reference, or `null` when nothing went out. Text is recorded
   * as `released`, a shown hold message included; `null` and empty text as
   * `discarded` (`nothing_delivered`).
   *
   * Called once per decision with the same info `onDecision` receives, when
   * the middleware hands the reply over: as `wrapGenerate` returns, and after
   * a buffered stream closes or a clinician stream's trailing decision lands.
   * The middleware does not wait for it before delivering. Return a promise
   * to answer once you know; its answer is the decision's one report,
   * whenever it settles. A decision the hook fails to answer stays without
   * an outcome.
   *
   * A decision a retry or a later turn's `supersedes` replaced is recorded
   * like any other, from the hook's answer: on a retried hold nothing was
   * shown, so answer `null` and it is `discarded`. The API adds its own
   * `superseded` event when it applies the retry or the list. On a turn you
   * retry, settle the hook after the retry's gate call: what the stopped
   * turn's answer is (nothing, or the hold text after a refused retry) is
   * known only once the retry is accepted or refused, and the SDK cannot
   * order it for you.
   *
   * Never called with `reportOutcome: false`, for a reply with no decision id
   * (the API unreachable, or the channel off), for a replayed decision whose
   * outcome already has a state on record, or for a stream cancelled while
   * the gate was deciding (recorded as `discarded`, `cancelled`). A throw, a
   * rejection or any other value goes to `onError`, and nothing is recorded
   * for that decision.
   *
   * A later event (`delivered` once the channel confirms, `failed`) is
   * yours to record with `govern.reportOutcome`.
   */
  deliveredText?: (info: GovernDecisionInfo) => DeliveredText | Promise<DeliveredText>;
  /** Called with every decision, after the reply is determined. */
  onDecision?: (info: GovernDecisionInfo) => void;
  /**
   * Called when recording an outcome fails, and with a failing
   * `deliveredText`. Delivery is unaffected; nothing retries a failed report
   * after the transport's own retries. A report that did not land arrives as
   * a `GovernReportError`: the decision id and the event exactly as sent
   * (`kind`, `at`, `contentHash`, `deliveryRef`, `reason`), to send again
   * with `govern.reportOutcome`, and the failure on `cause` (a
   * `GovernConflictError` when a different event of that kind is already on
   * record). A hook that throws or answers something else arrives as itself.
   */
  onError?: (error: unknown) => void;
}

export interface GovernDecisionInfo {
  reply: GuardResult;
  conversationId: string;
  turnId: string;
  channel: Channel;
  audience: Audience;
  streamed: boolean;
}

interface ResolvedContext {
  conversationId: string;
  turnId: string;
  retryOf: string | undefined;
  turnRef: string | undefined;
  supersedes: string[] | undefined;
  patientRef: string | undefined;
  metadata: Record<string, unknown> | undefined;
  inbound: InboundMessage | undefined;
  /** From the options, else the wrapped model's id. */
  model: string | undefined;
  /** From the options; when absent, the provider's reported model id is used. */
  modelVersion: string | undefined;
  /**
   * The bound for the gate call, read when the call starts:
   * `providerOptions.anybioGovern.signal`, else the `signal` option.
   */
  gateSignal: () => AbortSignal | undefined;
}

export function withGovern(options: WithGovernOptions): LanguageModelMiddleware {
  if (!options.govern) throw new GovernConfigError("withGovern: `govern` (a Govern client or its options) is required.");
  if (!options.channel || !options.audience) {
    throw new GovernConfigError("withGovern: `channel` and `audience` are required.");
  }
  if (options.holdMessage !== undefined && (typeof options.holdMessage !== "string" || options.holdMessage.trim() === "")) {
    throw new GovernConfigError("withGovern: `holdMessage` must be a non-empty string: it is the text a held patient sees in place of the reply.");
  }
  if (options.signal !== undefined && typeof options.signal !== "function") {
    throw new GovernConfigError(
      "withGovern: `signal` must be a function of the call params that returns an AbortSignal for that call. One signal shared by every call would hold every call after it fired. Pass a per-call signal as `providerOptions.anybioGovern.signal`, or `signal: () => AbortSignal.timeout(ms)`.",
    );
  }
  const govern = resolveGovern(options.govern);
  const reportOutcome = options.reportOutcome ?? true;

  /**
   * `bound` says how the per-call signal travels. `"gate"` (every path that
   * has not delivered yet) passes it as `gateSignal`, so an abort is the
   * unreachable-API rule. `"call"` (a clinician stream's trailing gate call,
   * after its text went out) passes it as `signal`, so an abort is rethrown
   * to `onError` and recorded as nothing: there is nothing left to withhold.
   */
  const guardContext = (ctx: ResolvedContext, reportedModelId: string | undefined, bound: "gate" | "call"): GuardContext => {
    const guard: GuardContext = {
      conversationId: ctx.conversationId,
      turnId: ctx.turnId,
      channel: options.channel,
      audience: options.audience,
    };
    if (ctx.retryOf !== undefined) guard.retryOf = ctx.retryOf;
    if (ctx.turnRef !== undefined) guard.turnRef = ctx.turnRef;
    if (ctx.supersedes !== undefined) guard.supersedes = ctx.supersedes;
    if (ctx.patientRef !== undefined) guard.patientRef = ctx.patientRef;
    if (ctx.metadata !== undefined) guard.metadata = ctx.metadata;
    if (ctx.inbound !== undefined) guard.inbound = ctx.inbound;
    if (options.holdMessage !== undefined) guard.holdMessage = options.holdMessage;
    if (ctx.model !== undefined) guard.model = ctx.model;
    const modelVersion = ctx.modelVersion ?? reportedModelId;
    if (modelVersion !== undefined) guard.modelVersion = modelVersion;
    const signal = ctx.gateSignal();
    if (signal !== undefined) {
      if (bound === "gate") guard.gateSignal = signal;
      else guard.signal = signal;
    }
    return guard;
  };

  /**
   * A caller's `onError` is the end of the line. It runs inside floating
   * promises and stream callbacks, where a throw is an unhandled rejection, so
   * it is isolated too.
   */
  const reportFailure = failureReporter(options.onError);

  /**
   * `onDecision` is telemetry: a throw from it must not stall or break the
   * stream. Returns the info it was given, which `report` hands to
   * `deliveredText` so both hooks see the same object.
   */
  const notify = (reply: GuardResult, ctx: ResolvedContext, streamed: boolean): GovernDecisionInfo => {
    const info: GovernDecisionInfo = {
      reply,
      conversationId: ctx.conversationId,
      turnId: ctx.turnId,
      channel: options.channel,
      audience: options.audience,
      streamed,
    };
    callSafely(() => options.onDecision?.(info), reportFailure);
    return info;
  };

  /**
   * The one outcome report for a decision, made as the reply is handed over.
   * Without a hook it is `went`: the text the reply handed over by default
   * (`released`, or `discarded` with `nothing_to_send` when it handed over
   * none); a call site passes other text where other text went out (a
   * clinician stream that streamed the draft beside a substitution), or
   * `{ reason }` where nothing went out. A caller's `deliveredText` answers
   * in its place. Nothing here delays delivery: the report is a floating
   * promise whose every failure goes to `onError`.
   */
  const report = (info: GovernDecisionInfo, went?: string | { reason: string }): void => {
    if (!reportOutcome) return;
    const { reply } = info;
    // Nothing to record: no decision, or a replayed one whose outcome is
    // already on record.
    const decisionId = reply.decisionId;
    if (decisionId === null || hasOutcomeOnRecord(reply.record)) return;
    const hook = options.deliveredText;
    if (hook === undefined) {
      const outcome: AdapterReport =
        went === undefined
          ? handedOver(delivers(reply) ? reply.text : null, OUTCOME_REASONS.nothingToSend)
          : typeof went === "string"
            ? handedOver(went, OUTCOME_REASONS.nothingToSend)
            : { kind: "discarded", reason: went.reason };
      void postReport(govern, decisionId, outcome, reportFailure);
      return;
    }
    deliveredOutcome(hook, info)
      .then((outcome) => postReport(govern, decisionId, outcome, reportFailure))
      .catch(reportFailure);
  };

  /**
   * A decision whose reply reached no one because the caller cancelled while
   * the gate decided: `discarded`, `cancelled`, without asking a hook (the
   * caller was never handed the reply).
   */
  const reportCancelled = (reply: GuardResult): void => {
    if (!reportOutcome || reply.decisionId === null || hasOutcomeOnRecord(reply.record)) return;
    void postReport(govern, reply.decisionId, { kind: "discarded", reason: OUTCOME_REASONS.cancelled }, reportFailure);
  };

  return {
    specificationVersion: "v4",

    async wrapGenerate({ doGenerate, params, model }) {
      const ctx = resolveContext(options, params, model);
      const result = await doGenerate();
      const draft = textOf(result.content);
      if (draft.length === 0) return result;
      const reply = await govern.guard(() => draft, guardContext(ctx, nonBlank(result.response?.modelId), "gate"));
      const metadata = governMetadata(reply);
      const providerMetadata: ProviderMetadata = {
        ...(result.providerMetadata ?? {}),
        [PROVIDER_METADATA_KEY]: metadata,
      };
      // The verdict decides, not a string comparison: a held turn never
      // replays the content array, even when the hold message equals the
      // draft. `reply.text !== draft` still matters on its own: a clinician
      // allow carries the gate's substitution.
      const gated: GenerateResult =
        !reply.held && reply.text === draft
          ? { ...result, providerMetadata }
          : { ...result, content: replacementContent(reply), providerMetadata };
      const info = notify(reply, ctx, false);
      report(info);
      return gated;
    },

    async wrapStream({ doStream, params, model }) {
      const ctx = resolveContext(options, params, model);
      const { stream, ...rest } = await doStream();
      if (options.audience === "clinician") {
        return { stream: trailing(stream, ctx), ...rest };
      }
      return { stream: bufferAndRelease(stream, ctx), ...rest };
    },
  };

  /** Patient audience: hold every part, decide on the whole, then release or replace. */
  function bufferAndRelease(source: ReadableStream<StreamPart>, ctx: ResolvedContext): ReadableStream<StreamPart> {
    // The reader is taken here, not inside `start`, so `cancel` has a handle it
    // can actually cancel. Calling `source.cancel` while this reader holds the
    // lock cancels nothing: it rejects at the caller, and the provider carries
    // on generating (and billing) for a patient who has closed the tab.
    const reader = source.getReader();
    let cancelled = false;
    return new ReadableStream<StreamPart>({
      start(controller) {
        // Nothing below may reject. This is a floating promise: an unhandled
        // rejection ends the Node process on the default setting,
        // taking every other in-flight gated turn with it.
        void (async () => {
          try {
            const parts: StreamPart[] = [];
            let text = "";
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                parts.push(value);
                if (value.type === "text-delta") text += value.delta;
              }
            } catch (error) {
              if (!cancelled) controller.error(error);
              return;
            }

            // The consumer is gone: nothing was delivered, so there is nothing
            // to gate and nothing to record.
            if (cancelled) return;

            if (text.length === 0) {
              for (const part of parts) controller.enqueue(part);
              controller.close();
              return;
            }

            let reply: GuardResult;
            try {
              reply = await govern.guard(() => text, guardContext(ctx, reportedModelId(parts), "gate"));
            } catch (error) {
              if (!cancelled) controller.error(error);
              return;
            }

            if (cancelled) {
              // Cancelled while the gate was deciding: the decision exists and
              // nothing went out. Recorded as exactly that.
              reportCancelled(reply);
              return;
            }

            const info = notify(reply, ctx, true);
            if (cancelled) {
              // Cancelled from inside `onDecision` (a caller sending its own
              // line on a hold): nothing of this stream reached the caller.
              // Discarded, or the hook's answer when there is one: the caller
              // has had the decision, and its hook says what it sent.
              report(info, { reason: OUTCOME_REASONS.cancelled });
              return;
            }
            const metadata = governMetadata(reply);

            // Exactly one report, whether or not handing over throws: a throw
            // here means the caller did not get the reply.
            let closed = false;
            try {
              // Same rule as wrapGenerate: a held turn replays nothing, however
              // closely the hold message resembles what the model wrote.
              if (!reply.held && reply.text === text) {
                for (const part of parts) controller.enqueue(part.type === "finish" ? withMetadata(part, metadata) : part);
              } else {
                const id = randomId();
                for (const part of parts) {
                  if (part.type === "stream-start" || part.type === "response-metadata") controller.enqueue(part);
                }
                // An outbound hold with no holding line owed emits no text at all.
                if (delivers(reply)) {
                  controller.enqueue({ type: "text-start", id });
                  controller.enqueue({ type: "text-delta", id, delta: reply.text });
                  controller.enqueue({ type: "text-end", id });
                }
                for (const part of parts) {
                  if (part.type === "finish") controller.enqueue(withMetadata(part, metadata));
                  else if (part.type === "error") controller.enqueue(part);
                }
              }
              controller.close();
              closed = true;
            } finally {
              report(info, closed ? undefined : { reason: OUTCOME_REASONS.notHandedOver });
            }
          } catch (error) {
            // Whatever it was, the stream must end: one that neither closes nor
            // errors holds the caller's response open for ever.
            reportFailure(error);
            try {
              controller.error(error);
            } catch {
              // Already closed, errored or cancelled; the end is the end.
            }
          }
        })();
      },
      cancel(reason) {
        cancelled = true;
        // Through the reader, which is what holds the lock; this is the call
        // that reaches the provider and stops the generation.
        return reader.cancel(reason).catch(reportFailure);
      },
    });
  }

  /** Clinician audience: stream through, evaluate after the end, record what went out. */
  function trailing(source: ReadableStream<StreamPart>, ctx: ResolvedContext): ReadableStream<StreamPart> {
    let text = "";
    let modelId: string | undefined;
    return source.pipeThrough(
      new TransformStream<StreamPart, StreamPart>({
        transform(part, controller) {
          if (part.type === "text-delta") text += part.delta;
          if (part.type === "response-metadata") modelId = nonBlank(part.modelId) ?? modelId;
          controller.enqueue(part);
        },
        flush() {
          if (text.length === 0) return;
          const delivered = text;
          // The text has gone out, so an abort of the bound cannot withhold
          // anything and must not be recorded as a hold: the bound travels as
          // the call's own signal, and its abort goes to `onError` with every
          // other failure here.
          let gate: GuardContext;
          try {
            gate = guardContext(ctx, modelId, "call");
          } catch (error) {
            // A bound that is not a signal, found after the text went out.
            reportFailure(error);
            return;
          }
          govern
            .guard(() => delivered, gate)
            // What went out is the streamed text, whatever the decision says.
            .then((reply) => report(notify(reply, ctx, true), delivered))
            .catch(reportFailure);
        },
      }),
    );
  }
}

/** Duck-typed on purpose: a client from another copy of this package is still a client. */
function resolveGovern(value: Govern | GovernOptions): Govern {
  return typeof (value as Govern).guard === "function" ? (value as Govern) : new Govern(value as GovernOptions);
}

function resolveContext(
  options: WithGovernOptions,
  params: LanguageModelCallOptions,
  model: { modelId?: unknown } | undefined,
): ResolvedContext {
  const perCall = readCallOptions(params);
  const conversationId = resolve(options.conversationId, params) ?? perCall.conversationId;
  if (!conversationId) {
    throw new GovernConfigError(
      "withGovern: a conversationId is required. Pass `conversationId` in the middleware options or `providerOptions.anybioGovern.conversationId` on the call.",
    );
  }
  const turnId = resolve(options.turnId, params) ?? perCall.turnId ?? randomId();
  // Before the model runs, as the conversation id is. `null` is none.
  const retryOf = perCall.retryOf ?? undefined;
  if (retryOf !== undefined) requireRetryOf(retryOf, "withGovern: `providerOptions.anybioGovern.retryOf`");
  const turnRef = perCall.turnRef ?? undefined;
  if (turnRef !== undefined) requireTurnRef(turnRef, "withGovern: `providerOptions.anybioGovern.turnRef`");
  const supersedes = supersedesOf(perCall.supersedes, "withGovern: `providerOptions.anybioGovern.supersedes`");
  return {
    conversationId,
    turnId,
    retryOf,
    turnRef,
    supersedes,
    patientRef: resolve(options.patientRef, params) ?? perCall.patientRef,
    metadata: resolve(options.metadata, params) ?? perCall.metadata,
    inbound: options.inbound?.(params),
    model: nonBlank(resolve(options.model, params)) ?? nonBlank(model?.modelId),
    modelVersion: nonBlank(resolve(options.modelVersion, params)),
    gateSignal: () => perCall.signal ?? requireAbortSignal(options.signal?.(params), "withGovern: the value the `signal` option returned"),
  };
}

/** The model id the provider reported on the stream, the last one if it sent several. */
function reportedModelId(parts: readonly StreamPart[]): string | undefined {
  let modelId: string | undefined;
  for (const part of parts) {
    if (part.type === "response-metadata") modelId = nonBlank(part.modelId) ?? modelId;
  }
  return modelId;
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function readCallOptions(params: LanguageModelCallOptions): GovernCallOptions {
  const raw = params.providerOptions?.[PROVIDER_OPTIONS_KEY];
  if (!raw || typeof raw !== "object") return {};
  const out: GovernCallOptions = {};
  if (typeof raw.conversationId === "string") out.conversationId = raw.conversationId;
  if (typeof raw.turnId === "string") out.turnId = raw.turnId;
  // Checked in `resolveContext`, before the model runs. `null` is none.
  if (raw.retryOf !== undefined && raw.retryOf !== null) out.retryOf = raw.retryOf as string;
  if (raw.turnRef !== undefined && raw.turnRef !== null) out.turnRef = raw.turnRef as string;
  if (raw.supersedes !== undefined && raw.supersedes !== null) out.supersedes = raw.supersedes as string[];
  if (typeof raw.patientRef === "string") out.patientRef = raw.patientRef;
  if (raw.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata)) {
    out.metadata = raw.metadata as Record<string, unknown>;
  }
  // Read as unknown: `ai` types these options as JSON, which a signal is not.
  const signal = requireAbortSignal((raw as Record<string, unknown>).signal, "withGovern: `providerOptions.anybioGovern.signal`");
  if (signal !== undefined) out.signal = signal;
  return out;
}

function resolve<T>(value: Resolvable<T> | undefined, params: LanguageModelCallOptions): T | undefined {
  if (value === undefined) return undefined;
  return typeof value === "function" ? (value as (p: LanguageModelCallOptions) => T | undefined)(params) : value;
}

function textOf(content: readonly ContentPart[]): string {
  let text = "";
  for (const part of content) if (part.type === "text") text += part.text;
  return text;
}

/** The content that replaces a held or substituted draft: its text, or nothing when nothing is owed. */
function replacementContent(reply: GuardResult): ContentPart[] {
  return delivers(reply) ? [{ type: "text", text: reply.text }] : [];
}

function governMetadata(reply: GuardResult): GovernMetadata {
  return {
    decisionId: reply.decisionId,
    decision: reply.decision,
    mode: reply.mode,
    held: reply.held,
    sendHoldingLine: reply.sendHoldingLine,
    showHoldText: reply.showHoldText,
    stopClass: reply.stopClass,
    degraded: reply.degraded,
    reasons: [...reply.reasons],
  };
}

function withMetadata(part: Extract<StreamPart, { type: "finish" }>, metadata: GovernMetadata): StreamPart {
  return {
    ...part,
    providerMetadata: { ...(part.providerMetadata ?? {}), [PROVIDER_METADATA_KEY]: metadata },
  };
}
