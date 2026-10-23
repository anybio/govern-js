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
 */

import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { AIMessage, isBaseMessage, type BaseMessage } from "@langchain/core/messages";
import type { Serialized } from "@langchain/core/load/serializable";
import type { LLMResult } from "@langchain/core/outputs";
import { RunnableLambda, type Runnable, type RunnableConfig } from "@langchain/core/runnables";

import { Govern, type GovernOptions } from "./client";
import { randomId } from "./crypto";
import { GovernConfigError } from "./errors";
import type { Audience, Channel, Decision, GuardContext, GuardResult, InboundMessage } from "./types";

/** The key under `config.configurable` the adapter reads per-call identifiers from. */
export const CONFIGURABLE_KEY = "anybioGovern";
/** The key under `AIMessage.response_metadata` the wrapper writes the decision to. */
export const RESPONSE_METADATA_KEY = "anybio_govern";

export interface GovernConfigurable {
  conversationId?: string;
  turnId?: string;
  patientRef?: string;
  metadata?: Record<string, unknown>;
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
  inbound?: (config: RunnableConfig | undefined) => InboundMessage | undefined;
  holdMessage?: string;
  /** Called when reporting an outcome fails. */
  onError?: (error: unknown) => void;
}

export interface GovernedOptions extends GovernLangChainOptions {
  /** Report the outcome as delivered with the text the wrapper returned. Default true. */
  reportOutcome?: boolean;
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
  onDecision?: (info: { reply: GuardResult; conversationId: string; turnId: string }) => void;
}

export interface GovernCallbackHandlerOptions extends GovernLangChainOptions {
  /**
   * Report every recorded decision as delivered. Default false: a callback
   * cannot know what the chain delivered, so leave outcome reporting to the
   * code that sends the message.
   */
  reportOutcome?: boolean;
  onDecision?: (info: { decision: Decision; runId: string }) => void;
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
 * subclass widens the type by exactly that much rather than pretending the
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
  return RunnableLambda.from<RunInput, GovernedOutput<RunOutput>>(async (input, config) => {
    const output = await runnable.invoke(input, config);
    const draft = draftOf(output);
    if (draft === null) {
      // Not a string and not a message: there is text in there for a patient
      // and the gate never saw it. Loud beats silent for a fail-safe gate.
      const error = new GovernConfigError(
        `governed: the runnable returned ${outputKind(output)}, which this adapter cannot read as text, so nothing was evaluated. Wrap a runnable that returns a string or a message, gate the text where it is produced, or pass ungatedOutput: "pass" to return this output unevaluated on purpose.`,
      );
      if ((options.ungatedOutput ?? "error") === "error") throw error;
      safely(() => options.onError?.(error));
      return untouched(output);
    }
    if (draft.length === 0) return untouched(output);
    const ctx = resolveContext(options, config, undefined, {
      model: modelOfRunnable(runnable),
      modelVersion: reportedModel(output),
    });
    const reply = await govern.guard(() => draft, guardContext(options, ctx));
    // Telemetry is isolated: a throw here must not escape `governed` and land
    // in the caller's catch, where the obvious handler sends the ungated draft.
    safely(() => options.onDecision?.({ reply, conversationId: ctx.conversationId, turnId: ctx.turnId }), options.onError);
    if (reportOutcome) {
      // Nothing went out on a hold that shows nothing: report exactly that.
      const outcome = !reply.held || reply.showHoldText ? { delivered: true, content: reply.text } : { delivered: false };
      reply.ack(outcome).catch((error: unknown) => safely(() => options.onError?.(error)));
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
  /** The model each run named at its start, until the run ends. Bounded, for runs that never end. */
  private readonly runModels = new Map<string, string>();

  constructor(options: GovernCallbackHandlerOptions) {
    super();
    requireOptions(options);
    this.options = options;
    this.govern = resolveGovern(options.govern);
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
        safely(() => this.options.onDecision?.({ decision, runId }), this.options.onError);
        if (reportOutcome && decision.id) {
          await this.govern.reportOutcome(decision.id, { delivered: true, content: text });
        }
      } catch (error) {
        safely(() => this.options.onError?.(error));
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
  patientRef: string | undefined;
  metadata: Record<string, unknown> | undefined;
  inbound: InboundMessage | undefined;
  model: string | undefined;
  modelVersion: string | undefined;
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
  return {
    conversationId,
    turnId,
    patientRef: resolve(options.patientRef, config) ?? perCall.patientRef,
    metadata: resolve(options.metadata, config) ?? perCall.metadata,
    inbound: options.inbound?.(config),
    model: nonBlank(resolve(options.model, config)) ?? observed.model,
    modelVersion: nonBlank(resolve(options.modelVersion, config)) ?? observed.modelVersion,
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

function guardContext(options: GovernLangChainOptions, ctx: ResolvedContext): GuardContext {
  const guard: GuardContext = {
    conversationId: ctx.conversationId,
    turnId: ctx.turnId,
    channel: options.channel,
    audience: options.audience,
  };
  if (ctx.patientRef !== undefined) guard.patientRef = ctx.patientRef;
  if (ctx.metadata !== undefined) guard.metadata = ctx.metadata;
  if (ctx.inbound !== undefined) guard.inbound = ctx.inbound;
  if (options.holdMessage !== undefined) guard.holdMessage = options.holdMessage;
  if (ctx.model !== undefined) guard.model = ctx.model;
  if (ctx.modelVersion !== undefined) guard.modelVersion = ctx.modelVersion;
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

/**
 * Run a caller's callback where a throw from it would otherwise decide what
 * happens to a gated message. The failure hook gets it; if that throws too,
 * there is nowhere left to report.
 */
function safely(run: () => void, onFailure?: (error: unknown) => void): void {
  try {
    run();
  } catch (error) {
    try {
      onFailure?.(error);
    } catch {
      // Nothing left to tell, and nowhere safe to tell it.
    }
  }
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
