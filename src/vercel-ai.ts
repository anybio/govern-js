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
 *   outcome recorded with what actually went out.
 *
 * What replaces a held draft follows `reply.showHoldText`, the same rule as
 * `guard`: on an in-session channel (`web_chat`, `app_message`) a single text
 * block with the hold message; on an outbound channel (`sms`, `voice`,
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
 * The middleware imports only types from `ai`; there is no runtime coupling.
 */

import type { LanguageModelMiddleware } from "ai";

import { Govern, type GovernOptions } from "./client";
import { randomId } from "./crypto";
import { GovernConfigError } from "./errors";
import type { Audience, Channel, GuardContext, GuardResult, InboundMessage } from "./types";

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
  patientRef?: string;
  metadata?: Record<string, unknown>;
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
  /** The patient's inbound message, for the red-flag screen. */
  inbound?: (params: LanguageModelCallOptions) => InboundMessage | undefined;
  /** Overrides the client's hold message. */
  holdMessage?: string;
  /** Report the outcome as delivered with the text the middleware let through. Default true. */
  reportOutcome?: boolean;
  /** Called with every decision, after the reply is determined. */
  onDecision?: (info: GovernDecisionInfo) => void;
  /** Called when reporting an outcome fails. Delivery is unaffected. */
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
  patientRef: string | undefined;
  metadata: Record<string, unknown> | undefined;
  inbound: InboundMessage | undefined;
  /** From the options, else the wrapped model's id. */
  model: string | undefined;
  /** From the options; when absent, the provider's reported model id is used. */
  modelVersion: string | undefined;
}

export function withGovern(options: WithGovernOptions): LanguageModelMiddleware {
  if (!options.govern) throw new GovernConfigError("withGovern: `govern` (a Govern client or its options) is required.");
  if (!options.channel || !options.audience) {
    throw new GovernConfigError("withGovern: `channel` and `audience` are required.");
  }
  const govern = resolveGovern(options.govern);
  const reportOutcome = options.reportOutcome ?? true;

  const guardContext = (ctx: ResolvedContext, reportedModelId?: string): GuardContext => {
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
    const modelVersion = ctx.modelVersion ?? reportedModelId;
    if (modelVersion !== undefined) guard.modelVersion = modelVersion;
    return guard;
  };

  /**
   * A caller's `onError` is the end of the line. It runs inside floating
   * promises and stream callbacks, where a throw is an unhandled rejection, so
   * it is isolated too.
   */
  const reportFailure = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // A failure hook that fails has nowhere left to report.
    }
  };

  /** `onDecision` is telemetry: a throw from it must not stall or break the stream. */
  const notify = (reply: GuardResult, ctx: ResolvedContext, streamed: boolean): void => {
    try {
      options.onDecision?.({
        reply,
        conversationId: ctx.conversationId,
        turnId: ctx.turnId,
        channel: options.channel,
        audience: options.audience,
        streamed,
      });
    } catch (error) {
      reportFailure(error);
    }
  };

  /** `delivered` is the text that went out, or null when nothing did. */
  const report = (reply: GuardResult, delivered: string | null): void => {
    if (reportOutcome) {
      reply.ack(delivered === null ? { delivered: false } : { delivered: true, content: delivered }).catch(reportFailure);
    }
  };

  return {
    specificationVersion: "v4",

    async wrapGenerate({ doGenerate, params, model }) {
      const ctx = resolveContext(options, params, model);
      const result = await doGenerate();
      const draft = textOf(result.content);
      if (draft.length === 0) return result;
      const reply = await govern.guard(() => draft, guardContext(ctx, nonBlank(result.response?.modelId)));
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
      notify(reply, ctx, false);
      report(reply, delivers(reply) ? reply.text : null);
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
              reply = await govern.guard(() => text, guardContext(ctx, reportedModelId(parts)));
            } catch (error) {
              if (!cancelled) controller.error(error);
              return;
            }

            if (cancelled) {
              // Cancelled while the gate was deciding: the decision exists and
              // nothing went out. Report that, or the next turn on this
              // conversation auto-acks it as delivered.
              if (reportOutcome) reply.ack({ delivered: false }).catch(reportFailure);
              return;
            }

            notify(reply, ctx, true);
            const metadata = governMetadata(reply);

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
            report(reply, delivers(reply) ? reply.text : null);
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
          govern
            .guard(() => delivered, guardContext(ctx, modelId))
            .then((reply) => {
              notify(reply, ctx, true);
              report(reply, delivered);
            })
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
  return {
    conversationId,
    turnId,
    patientRef: resolve(options.patientRef, params) ?? perCall.patientRef,
    metadata: resolve(options.metadata, params) ?? perCall.metadata,
    inbound: options.inbound?.(params),
    model: nonBlank(resolve(options.model, params)) ?? nonBlank(model?.modelId),
    modelVersion: nonBlank(resolve(options.modelVersion, params)),
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
  if (typeof raw.patientRef === "string") out.patientRef = raw.patientRef;
  if (raw.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata)) {
    out.metadata = raw.metadata as Record<string, unknown>;
  }
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

/**
 * Whether the reply hands the caller text to deliver: an allow, or a hold
 * with `showHoldText`. The channel rule lives in `guard` (through
 * `isInSessionChannel`); the adapter reads its answer and adds no rule of its own.
 */
function delivers(reply: GuardResult): boolean {
  return !reply.held || reply.showHoldText;
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
