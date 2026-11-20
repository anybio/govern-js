/**
 * `@anybio/govern/langchain`: a callback handler that records, and a runnable
 * wrapper that gates.
 *
 * Callbacks in LangChain run beside the chain; by the time `handleLLMEnd`
 * fires the output is already on its way to the caller, so a callback can
 * record a decision but cannot withhold text. `GovernCallbackHandler` is
 * therefore the observe-mode install. `governed(runnable, options)` is the
 * gating path: it invokes the wrapped runnable, evaluates the `AIMessage` (or
 * string) it returns, and returns the hold message in its place when the
 * decision is not allow and `reply.showHoldText` is true, or empty text when
 * it is false (an outbound channel with no holding line owed): the same
 * channel rule as `guard`, see `isInSessionChannel`.
 *
 * Both name the model on every evaluation. `model` is the `model` option, else
 * what the model itself says it is (a chat model's `model` or `modelName`, or
 * the model LangChain passes to callbacks at the start of the run).
 * `modelVersion` is the `modelVersion` option, else the model the provider
 * reported on the response (`response_metadata.model_name`, or `model`), when
 * it reports one.
 *
 * Two signals, kept apart on purpose. The run's own `config.signal` is
 * LangChain's cancel: it is never passed to the gate, so it never becomes a
 * hold. A run cancelled before `governed`'s gate call is not gated, and one
 * cancelled while the gate decides is recorded as `discarded`, since the
 * caller's `invoke` has ended and nothing reached the patient.
 * `configurable.anybioGovern.signal` bounds only `governed`'s gate call, and
 * its abort is an answer: the rule for an unreachable API decides what is
 * returned.
 */

import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { AIMessage, isBaseMessage, type BaseMessage } from "@langchain/core/messages";
import type { Serialized } from "@langchain/core/load/serializable";
import type { LLMResult } from "@langchain/core/outputs";
import { RunnableLambda, type Runnable, type RunnableConfig } from "@langchain/core/runnables";

import {
  callSafely,
  deliveredOutcome,
  delivers,
  failureReporter,
  handedOver,
  hasOutcomeOnRecord,
  postReport,
  type DeliveredText,
} from "./adapters";
import { Govern, requireRetryOf, requireTurnRef, supersedesOf, type GovernOptions } from "./client";
import { randomId } from "./crypto";
import { GovernAbortError, GovernConfigError } from "./errors";
import { requireAbortSignal } from "./signal";
import { OUTCOME_REASONS, type Audience, type Channel, type Decision, type GuardContext, type GuardResult, type InboundMessage } from "./types";

export type { DeliveredMessage, DeliveredText } from "./adapters";

/** The key under `config.configurable` the adapter reads per-call identifiers from. */
export const CONFIGURABLE_KEY = "anybioGovern";
/** The key under `AIMessage.response_metadata` the wrapper writes the decision to. */
export const RESPONSE_METADATA_KEY = "anybio_govern";

/** What a caller may pass as `config.configurable.anybioGovern` on one call. */
export interface GovernConfigurable {
  conversationId?: string;
  turnId?: string;
  /** The decision this call's turn retries. See `EvaluateInput.retryOf`. `null` is no retry. */
  retryOf?: string | null;
  /** Your stable reference for the patient turn. See `EvaluateInput.turnRef`. `null` is none. */
  turnRef?: string | null;
  /** The decisions this call's turn replaces. See `EvaluateInput.supersedes`. `null` is none. */
  supersedes?: readonly string[] | null;
  patientRef?: string;
  metadata?: Record<string, unknown>;
  /**
   * Bounds `governed`'s gate call for this call.
   *
   * When it aborts, before or during the gate call, the call ends (no retry
   * follows) and the rule for an unreachable API applies: in enforce the
   * output is held, with the hold message where `showHoldText` is true and
   * empty text where it is false; in observe the output comes back flagged
   * `degraded`. The reply carries `reasons: ["gate_unavailable"]` and no
   * decision id, and the client emits its `degraded` event. It travels to
   * `guard` as `gateSignal`, which answers this way; the call's own `signal`
   * would be rethrown instead, and the wrapper owns the reply.
   *
   * Not the run's `config.signal`, which is LangChain's cancel and is never
   * passed to the gate: wiring it in would turn a cancel into a hold.
   * `GovernCallbackHandler` sees no per-call config and makes no gate call,
   * so it takes no signal.
   *
   * A signal or a function that returns one. A signal's clock starts when
   * you create it, so one made before `invoke` bounds the wrapped runnable
   * and the gate together, and it belongs to one call: bound with
   * `withConfig`, the same signal is shared by every call after it, and once
   * it fires every one of them holds. The function is called when the gate
   * call starts, once per call, so `() => AbortSignal.timeout(ms)` is a
   * fresh bound measured from the gate call, safe to bind once. `null`, or
   * a function returning `null` or `undefined`, is no bound. A value that is
   * neither a signal nor a function is refused with `GovernConfigError`
   * before the wrapped runnable runs; a function that returns something
   * else is refused when the gate call starts.
   */
  signal?: AbortSignal | null | ((config: RunnableConfig | undefined) => AbortSignal | null | undefined);
}

type Resolvable<T> = T | ((config: RunnableConfig | undefined) => T | undefined);

export interface GovernLangChainOptions {
  /** A `Govern` client, or the options to construct one. */
  govern: Govern | GovernOptions;
  channel: Channel;
  audience: Audience;
  /**
   * Your thread id. A string, a function of the call config, or per call via
   * `config.configurable.anybioGovern.conversationId`; `configurable.thread_id`
   * is read as a last resort. Required by one of those routes.
   */
  conversationId?: Resolvable<string>;
  /** Your message id. Default: `configurable.anybioGovern.turnId`, else the LangChain run id, else a random id. */
  turnId?: Resolvable<string>;
  patientRef?: Resolvable<string>;
  metadata?: Resolvable<Record<string, unknown>>;
  /** The model name recorded on each decision. Default: what the model reports about itself (see the module note). */
  model?: Resolvable<string>;
  /** The model version recorded on each decision. Default: the model the provider reported on the response, when it reports one. */
  modelVersion?: Resolvable<string>;
  /**
   * The patient's inbound message, for the red-flag screen. Requires
   * `patientRef` (the option, or `configurable.anybioGovern.patientRef`).
   */
  inbound?: (config: RunnableConfig | undefined) => InboundMessage | undefined;
  holdMessage?: string;
  /**
   * Called when recording an outcome fails, and with a failing
   * `deliveredText`. Nothing retries a failed report after the transport's
   * own retries. A report that did not land arrives as a
   * `GovernReportError`: the decision id and the event exactly as sent
   * (`kind`, `at`, `contentHash`, `deliveryRef`, `reason`), to send again
   * with `govern.reportOutcome`, and the failure on `cause` (a
   * `GovernConflictError` when a different event of that kind is already on
   * record). A hook that throws or answers something else arrives as itself.
   */
  onError?: (error: unknown) => void;
}

/** What `governed` hands `onDecision` and `deliveredText`. */
export interface GovernedDecisionInfo {
  reply: GuardResult;
  conversationId: string;
  turnId: string;
}

/** What `GovernCallbackHandler` hands `onDecision` and `deliveredText`. */
export interface GovernCallbackDecisionInfo {
  decision: Decision;
  runId: string;
}

/**
 * The call's context (conversation id, turn id, `retryOf`, patient
 * reference, metadata, inbound and the per-call bound) is resolved before
 * the wrapped runnable runs, as `withGovern` resolves it before the model is
 * called. A run that could not be gated fails with `GovernConfigError`
 * before the model runs, even one that would never reach the gate (an empty
 * output, or `ungatedOutput: "pass"`), and a resolver function you pass sees
 * the state before the chain. Only the model version the provider reports is
 * read from the output, afterwards.
 */
export interface GovernedOptions extends GovernLangChainOptions {
  /**
   * Record the write-time outcome once per decision, as the wrapper returns:
   * `released` with the hash of the text it returned, or of what
   * `deliveredText` says went out; `discarded` when nothing went out.
   * Default true.
   *
   * With false the wrapper reports nothing, and the outcome is yours alone
   * to record with `govern.reportOutcome`. A decision you never report stays
   * without an outcome.
   */
  reportOutcome?: boolean;
  /**
   * What actually went out, for the outcome report. Without it the wrapper
   * records `released` with the text it returned, or `discarded`
   * (`nothing_to_send`) when it returned empty text. With it, the wrapper
   * asks: return the text you wrote to the channel (it is hashed locally;
   * only the hash is sent), `{ text, deliveredAt?, deliveryRef? }` to say
   * when it went out and under which reference, or `null` when nothing went
   * out. Text is recorded as `released`, a shown hold message included;
   * `null` and empty text as `discarded` (`nothing_delivered`).
   *
   * Called once per decision with the same info `onDecision` receives, as the
   * wrapper returns. It does not wait for it before returning. Return a
   * promise to answer once you know; its answer is the decision's one
   * report, whenever it settles. A decision the hook fails to answer stays
   * without an outcome. A decision a retry or a later turn's `supersedes`
   * replaced is recorded like any other, from the hook's answer (on a
   * retried hold nothing was shown, so `null`, which is `discarded`); the API
   * adds its own `superseded` event when it applies the retry or the list.
   * On a turn you retry, settle the hook after the retry's gate call: the
   * stopped turn's answer (nothing, or the hold text after a refused retry)
   * is known only once the retry is accepted or refused, and the SDK cannot
   * order it for you.
   *
   * Never called with `reportOutcome: false`, for a reply with no decision
   * id (the API unreachable, or the channel off), for a replayed decision
   * whose outcome already has a state on record, or for a run whose own
   * `config.signal` fired while the gate was deciding (recorded as
   * `discarded`, `cancelled`). A throw, a rejection or any other value goes
   * to `onError`, and nothing is recorded for that decision.
   */
  deliveredText?: (info: GovernedDecisionInfo) => DeliveredText | Promise<DeliveredText>;
  /**
   * What to do when the wrapped runnable returns something this adapter cannot
   * read as text: a structured output, a dict, a list.
   *
   * Default `"error"`. A gate that cannot see the output must not imply it
   * approved it, and a structured-output chain is a mainstream shape: passed
   * through in silence, a correctly wired chain would gate nothing.
   * The error is deterministic and arrives on the first call, which is where
   * an integration mistake belongs.
   *
   * `"pass"` returns the output unevaluated for a chain whose text is gated
   * somewhere else. It is still not silent: `onError` is called with the same
   * error.
   */
  ungatedOutput?: "error" | "pass";
  onDecision?: (info: GovernedDecisionInfo) => void;
}

export interface GovernCallbackHandlerOptions extends GovernLangChainOptions {
  /**
   * Record every recorded decision's generation as `released`. Default
   * false: a callback cannot know what the chain delivered, so leave outcome
   * reporting to the code that sends the message, or set `deliveredText`.
   */
  reportOutcome?: boolean;
  /**
   * What actually went out, for the outcome report when `reportOutcome` is
   * true. Without it the handler records the generation's text as
   * `released`. With it, the handler asks: return the text you wrote to the
   * channel (hashed locally; only the hash is sent), `{ text, deliveredAt?,
   * deliveryRef? }` to say when it went out and under which reference, or
   * `null` when nothing went out. Text is recorded as `released`; `null` and
   * empty text as `discarded` (`nothing_delivered`).
   *
   * Called once per recorded decision with the same info `onDecision`
   * receives, after the decision is recorded. The handler does not wait for
   * it: LangChain runs callbacks one at a time, and a hook that waits for the
   * chain's own delivery would hold every callback behind it. Return a
   * promise to answer once you know.
   *
   * Never called with `reportOutcome` off, for a decision with no id, or for
   * a replayed decision whose outcome already has a state on record. A
   * throw, a rejection or any other value goes to `onError`, and nothing is
   * recorded for that decision.
   */
  deliveredText?: (info: GovernCallbackDecisionInfo) => DeliveredText | Promise<DeliveredText>;
  onDecision?: (info: GovernCallbackDecisionInfo) => void;
}

// ---------------------------------------------------------------------------
// The gating path
// ---------------------------------------------------------------------------

/**
 * What `governed` returns for a runnable that returns `T`.
 *
 * A string in, a string out. Anything else comes back either as it was (an
 * allow the gate did not touch) or as the `AIMessage` the wrapper writes in
 * its place: the hold message (or empty text, when `showHoldText` is false),
 * plus the decision under
 * `response_metadata.anybio_govern`. The gate has one message class it can
 * construct, so wrapping a runnable whose output is some other `BaseMessage`
 * subclass widens the type by exactly that much, and does not pretend the
 * subclass survives the substitution.
 */
export type GovernedOutput<T> = T extends string ? string : T | AIMessage;

/**
 * Wrap a runnable (a chat model, a chain) so the text it returns is
 * evaluated before the caller sees it. On a hold, string outputs are replaced
 * by `reply.text`; message outputs are replaced by a new `AIMessage` with that
 * text and the decision in `response_metadata.anybio_govern`. `reply.text` is
 * the hold message when `showHoldText` is true (every hold on an in-session
 * channel, an owed holding line on an outbound one) and empty otherwise, so an
 * outbound caller that sends what it gets back sends nothing. An
 * output this adapter cannot read as text is refused, not passed through: see
 * `ungatedOutput`.
 *
 * `stream()` on the returned runnable yields one chunk after the decision:
 * buffer and release, which is the patient-audience rule.
 */
export function governed<RunInput, RunOutput>(
  runnable: Runnable<RunInput, RunOutput>,
  options: GovernedOptions,
): Runnable<RunInput, GovernedOutput<RunOutput>> {
  requireOptions(options);
  const govern = resolveGovern(options.govern);
  const reportOutcome = options.reportOutcome ?? true;
  const failed = failureReporter(options.onError);
  return RunnableLambda.from<RunInput, GovernedOutput<RunOutput>>(async (input, config) => {
    // The identifiers, the per-call bound and the rest of the call's context
    // are known now: resolved, and refused when they are wrong, before the
    // model runs. Only the model version the provider reports is read from
    // the output, afterwards. A signal function is called when the gate call
    // starts.
    const ctx = resolveContext(options, config, undefined, { model: modelOfRunnable(runnable), modelVersion: undefined });
    const output = await runnable.invoke(input, config);
    const draft = draftOf(output);
    if (draft === null) {
      // Not a string and not a message: there is text in there for a patient
      // and the gate never saw it. Loud beats silent for a fail-safe gate.
      const error = new GovernConfigError(
        `governed: the runnable returned ${outputKind(output)}, which this adapter cannot read as text, so nothing was evaluated. Wrap a runnable that returns a string or a message, gate the text where it is produced, or pass ungatedOutput: "pass" to return this output unevaluated on purpose.`,
      );
      if ((options.ungatedOutput ?? "error") === "error") throw error;
      failed(error);
      return untouched(output);
    }
    if (draft.length === 0) return untouched(output);
    // The run was cancelled before the gate call: LangChain has already ended
    // the caller's `invoke`, so nothing is gated. Thrown, never returned, so
    // an ungated output cannot surface on a path that does not race the signal.
    if (config?.signal?.aborted) throw new GovernAbortError(config.signal.reason);
    ctx.modelVersion ??= reportedModel(output);
    const reply = await govern.guard(() => draft, guardContext(options, ctx));
    // Nothing to record: no decision, or a replayed one whose outcome is
    // already on record.
    const decisionId = reportOutcome && !hasOutcomeOnRecord(reply.record) ? reply.decisionId : null;
    if (config?.signal?.aborted) {
      // Cancelled while the gate was deciding: the decision exists, and the
      // caller's `invoke` ended before it, so nothing reached the patient.
      // Recorded as exactly that, as the Vercel stream-cancel path does, and
      // neither hook is asked: the caller was never handed this reply.
      if (decisionId !== null) void postReport(govern, decisionId, { kind: "discarded", reason: OUTCOME_REASONS.cancelled }, failed);
      throw new GovernAbortError(config.signal.reason);
    }
    const info: GovernedDecisionInfo = { reply, conversationId: ctx.conversationId, turnId: ctx.turnId };
    // Telemetry is isolated: a throw here must not escape `governed` and land
    // in the caller's catch, where the obvious handler sends the ungated draft.
    callSafely(() => options.onDecision?.(info), failed);
    if (decisionId !== null) {
      // Floating: the reply is not held for the report.
      const hook = options.deliveredText;
      if (hook === undefined) {
        // What the wrapper returns: its text, or nothing on a hold that
        // showed nothing.
        void postReport(govern, decisionId, handedOver(delivers(reply) ? reply.text : null, OUTCOME_REASONS.nothingToSend), failed);
      } else {
        deliveredOutcome(hook, info)
          .then((outcome) => postReport(govern, decisionId, outcome, failed))
          .catch(failed);
      }
    }
    // The verdict decides, so a hold message that matches the draft is still a
    // hold. The text check covers a clinician substitution, which is an allow
    // with different text.
    if (!reply.held && reply.text === draft) return untouched(output);
    return replace(output, reply);
  }).withConfig({ runName: "anybio_govern" });
}

// ---------------------------------------------------------------------------
// The recording path
// ---------------------------------------------------------------------------

/**
 * Records a decision for every generation an LLM or chat model produces.
 * Cannot withhold output; pair it with observe mode, or use `governed` to
 * gate.
 */
export class GovernCallbackHandler extends BaseCallbackHandler {
  name = "anybio_govern";
  private readonly options: GovernCallbackHandlerOptions;
  private readonly govern: Govern;
  private readonly reportFailure: (error: unknown) => void;
  /** The model each run named at its start, until the run ends. Bounded, for runs that never end. */
  private readonly runModels = new Map<string, string>();

  constructor(options: GovernCallbackHandlerOptions) {
    super();
    requireOptions(options);
    this.options = options;
    this.govern = resolveGovern(options.govern);
    this.reportFailure = failureReporter(options.onError);
  }

  override handleLLMStart(
    _llm: Serialized,
    _prompts: string[],
    runId: string,
    _parentRunId?: string,
    extraParams?: Record<string, unknown>,
    _tags?: string[],
    metadata?: Record<string, unknown>,
  ): void {
    this.rememberModel(runId, extraParams, metadata);
  }

  override handleChatModelStart(
    _llm: Serialized,
    _messages: BaseMessage[][],
    runId: string,
    _parentRunId?: string,
    extraParams?: Record<string, unknown>,
    _tags?: string[],
    metadata?: Record<string, unknown>,
  ): void {
    this.rememberModel(runId, extraParams, metadata);
  }

  override handleLLMError(_error: Error, runId: string): void {
    this.runModels.delete(runId);
  }

  override async handleLLMEnd(output: LLMResult, runId: string): Promise<void> {
    const model = this.runModels.get(runId);
    this.runModels.delete(runId);
    const llmOutputModel = nonBlank((output.llmOutput as Record<string, unknown> | undefined)?.model_name);
    const texts: { text: string; modelVersion: string | undefined }[] = [];
    for (const generations of output.generations) {
      for (const generation of generations) {
        const message = (generation as { message?: unknown }).message;
        const text = typeof generation.text === "string" && generation.text.length > 0
          ? generation.text
          : draftOf(message);
        if (text && text.length > 0) texts.push({ text, modelVersion: reportedModel(message) ?? llmOutputModel });
      }
    }
    const reportOutcome = this.options.reportOutcome ?? false;
    for (const [index, { text, modelVersion }] of texts.entries()) {
      const ctx = resolveContext(this.options, undefined, texts.length === 1 ? runId : `${runId}:${index}`, {
        model,
        modelVersion,
      });
      try {
        const decision = await this.govern.evaluate({
          ...evaluateFields(this.options, ctx),
          content: text,
        });
        const info: GovernCallbackDecisionInfo = { decision, runId };
        callSafely(() => this.options.onDecision?.(info), this.reportFailure);
        // A replayed decision with an outcome on record was recorded then.
        if (reportOutcome && decision.id && !hasOutcomeOnRecord(decision)) {
          const hook = this.options.deliveredText;
          const decisionId = decision.id;
          if (hook === undefined) {
            await postReport(this.govern, decisionId, { kind: "released", content: text }, this.reportFailure);
          } else {
            // Not awaited: callbacks run one at a time, and a hook that waits
            // for the chain's delivery must not hold the queue (or, with
            // awaited handlers, the chain itself) until it does.
            deliveredOutcome(hook, info)
              .then((outcome) => postReport(this.govern, decisionId, outcome, this.reportFailure))
              .catch(this.reportFailure);
          }
        }
      } catch (error) {
        this.reportFailure(error);
      }
    }
  }

  private rememberModel(
    runId: string,
    extraParams: Record<string, unknown> | undefined,
    metadata: Record<string, unknown> | undefined,
  ): void {
    const invocation = extraParams?.invocation_params as Record<string, unknown> | undefined;
    const model = nonBlank(invocation?.model) ?? nonBlank(invocation?.model_name) ?? nonBlank(metadata?.ls_model_name);
    if (model === undefined) return;
    this.runModels.set(runId, model);
    if (this.runModels.size > 10_000) {
      const oldest = this.runModels.keys().next();
      if (!oldest.done) this.runModels.delete(oldest.value);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ResolvedContext {
  conversationId: string;
  turnId: string;
  retryOf: string | undefined;
  turnRef: string | undefined;
  supersedes: string[] | undefined;
  patientRef: string | undefined;
  metadata: Record<string, unknown> | undefined;
  inbound: InboundMessage | undefined;
  model: string | undefined;
  modelVersion: string | undefined;
  /**
   * The bound for the gate call, `configurable.anybioGovern.signal` (never
   * the run's own `config.signal`): read when the gate call starts, so a
   * function is called then.
   */
  gateSignal: () => AbortSignal | undefined;
}

/** What the model and the response say about themselves, used when the options do not. */
interface ObservedModel {
  model: string | undefined;
  modelVersion: string | undefined;
}

function resolveGovern(value: Govern | GovernOptions): Govern {
  return typeof (value as Govern).guard === "function" ? (value as Govern) : new Govern(value as GovernOptions);
}

function requireOptions(options: GovernLangChainOptions): void {
  if (!options.govern) throw new GovernConfigError("@anybio/govern/langchain: `govern` (a Govern client or its options) is required.");
  if (!options.channel || !options.audience) {
    throw new GovernConfigError("@anybio/govern/langchain: `channel` and `audience` are required.");
  }
  if (options.holdMessage !== undefined && (typeof options.holdMessage !== "string" || options.holdMessage.trim() === "")) {
    throw new GovernConfigError("@anybio/govern/langchain: `holdMessage` must be a non-empty string: it is the text a held patient sees in place of the reply.");
  }
}

function resolveContext(
  options: GovernLangChainOptions,
  config: RunnableConfig | undefined,
  fallbackTurnId: string | undefined,
  observed: ObservedModel,
): ResolvedContext {
  const configurable = (config?.configurable ?? {}) as Record<string, unknown>;
  const perCall = (configurable[CONFIGURABLE_KEY] ?? {}) as GovernConfigurable;
  const threadId = typeof configurable.thread_id === "string" ? configurable.thread_id : undefined;
  const conversationId = resolve(options.conversationId, config) ?? perCall.conversationId ?? threadId;
  if (!conversationId) {
    throw new GovernConfigError(
      "@anybio/govern/langchain: a conversationId is required. Pass `conversationId` in the options or `configurable.anybioGovern.conversationId` (or `configurable.thread_id`) on the call.",
    );
  }
  const turnId =
    resolve(options.turnId, config) ?? perCall.turnId ?? (typeof config?.runId === "string" ? config.runId : undefined) ?? fallbackTurnId ?? randomId();
  // `null` is none, as `undefined` is.
  const retryOf = perCall.retryOf ?? undefined;
  if (retryOf !== undefined) requireRetryOf(retryOf, "@anybio/govern/langchain: `configurable.anybioGovern.retryOf`");
  const turnRef = perCall.turnRef ?? undefined;
  if (turnRef !== undefined) requireTurnRef(turnRef, "@anybio/govern/langchain: `configurable.anybioGovern.turnRef`");
  const supersedes = supersedesOf(perCall.supersedes, "@anybio/govern/langchain: `configurable.anybioGovern.supersedes`");
  return {
    conversationId,
    turnId,
    retryOf,
    turnRef,
    supersedes,
    patientRef: resolve(options.patientRef, config) ?? perCall.patientRef,
    metadata: resolve(options.metadata, config) ?? perCall.metadata,
    inbound: options.inbound?.(config),
    model: nonBlank(resolve(options.model, config)) ?? observed.model,
    modelVersion: nonBlank(resolve(options.modelVersion, config)) ?? observed.modelVersion,
    gateSignal: gateSignalOf(perCall.signal, config),
  };
}

/** A chat model's own name for itself: `model` on the current integrations, `modelName` on older ones. */
function modelOfRunnable(runnable: unknown): string | undefined {
  if (!runnable || typeof runnable !== "object") return undefined;
  const r = runnable as { model?: unknown; modelName?: unknown };
  return nonBlank(r.model) ?? nonBlank(r.modelName);
}

/** The model the provider reported on a message it returned, when it reported one. */
function reportedModel(output: unknown): string | undefined {
  if (!isBaseMessage(output)) return undefined;
  const metadata = (output.response_metadata ?? {}) as Record<string, unknown>;
  return nonBlank(metadata.model_name) ?? nonBlank(metadata.model);
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function resolve<T>(value: Resolvable<T> | undefined, config: RunnableConfig | undefined): T | undefined {
  if (value === undefined) return undefined;
  return typeof value === "function" ? (value as (c: RunnableConfig | undefined) => T | undefined)(config) : value;
}

/**
 * The per-call bound, the one place it is checked: a signal (or `null` or
 * `undefined`) is checked now, as the context is resolved; a function is
 * called when the gate call starts, and what it returns is checked then.
 */
function gateSignalOf(value: unknown, config: RunnableConfig | undefined): () => AbortSignal | undefined {
  if (typeof value === "function") {
    return () =>
      requireAbortSignal((value as (c: RunnableConfig | undefined) => unknown)(config), "@anybio/govern/langchain: the value `configurable.anybioGovern.signal` returned");
  }
  const signal = requireAbortSignal(value, "@anybio/govern/langchain: `configurable.anybioGovern.signal`");
  return () => signal;
}

function guardContext(options: GovernLangChainOptions, ctx: ResolvedContext): GuardContext {
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
  if (ctx.modelVersion !== undefined) guard.modelVersion = ctx.modelVersion;
  // The bound on the gate call, never the run's own cancel.
  const gateSignal = ctx.gateSignal();
  if (gateSignal !== undefined) guard.gateSignal = gateSignal;
  return guard;
}

function evaluateFields(options: GovernLangChainOptions, ctx: ResolvedContext) {
  const fields: {
    conversationId: string;
    turnId: string;
    channel: Channel;
    audience: Audience;
    patientRef?: string;
    metadata?: Record<string, unknown>;
    inbound?: InboundMessage;
    model?: string;
    modelVersion?: string;
  } = {
    conversationId: ctx.conversationId,
    turnId: ctx.turnId,
    channel: options.channel,
    audience: options.audience,
  };
  if (ctx.patientRef !== undefined) fields.patientRef = ctx.patientRef;
  if (ctx.metadata !== undefined) fields.metadata = ctx.metadata;
  if (ctx.inbound !== undefined) fields.inbound = ctx.inbound;
  if (ctx.model !== undefined) fields.model = ctx.model;
  if (ctx.modelVersion !== undefined) fields.modelVersion = ctx.modelVersion;
  return fields;
}

/** The shape of an output, for an error message. Never its content. */
function outputKind(output: unknown): string {
  if (output === null) return "null";
  if (Array.isArray(output)) return "an array";
  if (typeof output === "object") {
    const name = (output as { constructor?: { name?: string } }).constructor?.name;
    return name && name !== "Object" ? `a ${name}` : "an object";
  }
  return `a ${typeof output}`;
}

/** The text of a runnable's output, or null when it carries none. */
function draftOf(output: unknown): string | null {
  if (typeof output === "string") return output;
  if (isBaseMessage(output)) return output.text;
  return null;
}

/**
 * The output the gate left alone. `T` is a member of `GovernedOutput<T>` on
 * both branches of the conditional, but a conditional type over a generic the
 * compiler has not resolved cannot be checked, so it is asserted here once.
 */
function untouched<T>(output: T): GovernedOutput<T> {
  return output as GovernedOutput<T>;
}

function replace<T>(output: T, reply: GuardResult): GovernedOutput<T> {
  const metadata = {
    decision_id: reply.decisionId,
    decision: reply.decision,
    mode: reply.mode,
    held: reply.held,
    send_holding_line: reply.sendHoldingLine,
    show_hold_text: reply.showHoldText,
    stop_class: reply.stopClass,
    degraded: reply.degraded,
    reasons: [...reply.reasons],
  };
  // Narrowed, so both assertions are the resolved branch of the conditional:
  // a string output has `GovernedOutput<T> = string`, and anything else has
  // `AIMessage` among its members.
  if (typeof output === "string") return reply.text as GovernedOutput<T>;
  const original = output as BaseMessage;
  return new AIMessage({
    content: reply.text,
    response_metadata: { ...(original.response_metadata ?? {}), [RESPONSE_METADATA_KEY]: metadata },
  }) as GovernedOutput<T>;
}
