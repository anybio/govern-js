import { AIMessage } from "@langchain/core/messages";
import { RunnableLambda } from "@langchain/core/runnables";
import { generateText, wrapLanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Govern } from "../src/client";
import { GovernAbortError, GovernConfigError } from "../src/errors";
import { RESPONSE_METADATA_KEY, governed, type GovernedDecisionInfo } from "../src/langchain";
import type { GovernEvent, GuardContext } from "../src/types";
import {
  PROVIDER_METADATA_KEY,
  withGovern,
  type GovernDecisionInfo,
  type LanguageModelCallOptions,
  type StreamPart,
} from "../src/vercel-ai";
import { DRAFT, HOLD, collect, decisionView, deferred, fetchMock, jsonResponse, makeClient, tick, type RecordedCall } from "./helpers";

const outcomes = (calls: RecordedCall[]) => calls.filter((c) => c.url.pathname.endsWith("/outcome"));

const aborted = (): AbortSignal => {
  const controller = new AbortController();
  controller.abort(new Error("turn budget spent"));
  return controller.signal;
};

const live = (): AbortSignal => new AbortController().signal;

// ---------------------------------------------------------------------------
// Vercel AI SDK
// ---------------------------------------------------------------------------

type Middleware = ReturnType<typeof withGovern>;
type WrapGenerateArgs = Parameters<NonNullable<Middleware["wrapGenerate"]>>[0];
type WrapStreamArgs = Parameters<NonNullable<Middleware["wrapStream"]>>[0];
type GenerateResult = Awaited<ReturnType<WrapGenerateArgs["doGenerate"]>>;

const generateResult = {
  content: [{ type: "text", text: DRAFT }],
  finishReason: { unified: "stop", raw: "stop" },
  usage: {},
  warnings: [],
} as unknown as GenerateResult;

function callParams(perCall: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): LanguageModelCallOptions {
  return {
    prompt: [],
    providerOptions: { anybioGovern: { conversationId: "conv-1", turnId: "turn-1", ...perCall } },
    ...extra,
  } as unknown as LanguageModelCallOptions;
}

async function generate(
  middleware: Middleware,
  params: LanguageModelCallOptions = callParams(),
  doGenerate: () => Promise<GenerateResult> = async () => generateResult,
): Promise<GenerateResult> {
  return middleware.wrapGenerate!({
    doGenerate,
    doStream: async () => {
      throw new Error("doStream is not used by this test");
    },
    params,
    model: {} as WrapGenerateArgs["model"],
  });
}

function sourceStream(text: string): ReadableStream<StreamPart> {
  const parts: StreamPart[] = [
    { type: "stream-start", warnings: [] } as StreamPart,
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: {} } as unknown as StreamPart,
  ];
  return new ReadableStream<StreamPart>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

async function stream(middleware: Middleware, params: LanguageModelCallOptions = callParams()): Promise<StreamPart[]> {
  const result = await middleware.wrapStream!({
    doStream: async () => ({ stream: sourceStream(DRAFT) }),
    doGenerate: async () => generateResult,
    params,
    model: {} as WrapStreamArgs["model"],
  });
  return collect(result.stream);
}

const streamedText = (parts: StreamPart[]): string => parts.map((p) => (p.type === "text-delta" ? p.delta : "")).join("");

function textOf(content: GenerateResult["content"]): string {
  return content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

describe("withGovern signal: an abort lands on the unavailable rule", () => {
  it("enforce, in session: aborted before the gate call, the draft is held with the hold message and nothing is sent", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView({ decision: "allow" })));
    const decided: GovernDecisionInfo[] = [];
    const middleware = withGovern({
      govern: makeClient(fetch),
      channel: "web_chat",
      audience: "patient",
      signal: aborted,
      onDecision: (info) => decided.push(info),
    });
    const result = await generate(middleware);
    expect(result.content).toEqual([{ type: "text", text: HOLD }]);
    expect(result.providerMetadata?.[PROVIDER_METADATA_KEY]).toMatchObject({
      decision: "hold",
      held: true,
      degraded: true,
      decisionId: null,
      showHoldText: true,
      sendHoldingLine: false,
      reasons: ["gate_unavailable"],
    });
    expect(decided[0]!.reply).toMatchObject({ degraded: true, record: null });
    await tick();
    // No evaluate went out, and with no decision there is nothing to report.
    expect(calls).toHaveLength(0);
  });

  it("enforce, outbound: aborted during the gate call, the draft is held with no text, and the request is not retried", async () => {
    const pending = deferred<Response>();
    const { fetch, calls, waitForCall } = fetchMock(() => pending.promise);
    const controller = new AbortController();
    const middleware = withGovern({ govern: makeClient(fetch), channel: "sms", audience: "patient", signal: () => controller.signal });
    const result = generate(middleware);
    await waitForCall("evaluate");
    await tick();
    expect(calls).toHaveLength(1);
    controller.abort();
    const gated = await result;
    expect(gated.content).toEqual([]);
    expect(gated.providerMetadata?.[PROVIDER_METADATA_KEY]).toMatchObject({ decision: "hold", degraded: true, showHoldText: false });
    await tick(5);
    expect(calls).toHaveLength(1);
  });

  it("an abort during the retry wait ends the call: one request, then the unavailable rule", async () => {
    const controller = new AbortController();
    const events: GovernEvent[] = [];
    const { fetch, calls } = fetchMock(() => jsonResponse(503, { kind: "UNAVAILABLE" }));
    const govern = makeClient(fetch, {
      maxRetries: 2,
      onEvent: (event) => {
        events.push(event);
        // The transport is about to wait before its second attempt.
        if (event.type === "retry") controller.abort();
      },
    });
    const middleware = withGovern({ govern, channel: "web_chat", audience: "patient", signal: () => controller.signal });
    const result = await generate(middleware);
    expect(textOf(result.content)).toBe(HOLD);
    expect(calls).toHaveLength(1);
    expect(events.filter((e) => e.type === "request")).toHaveLength(1);
  });

  it("observe: the draft goes out flagged degraded", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView()));
    const govern = makeClient(fetch);
    govern.rememberMode("web_chat", "observe");
    const result = await generate(withGovern({ govern, channel: "web_chat", audience: "patient", signal: aborted }));
    expect(textOf(result.content)).toBe(DRAFT);
    expect(result.providerMetadata?.[PROVIDER_METADATA_KEY]).toMatchObject({ decision: "allow", held: false, degraded: true, reasons: ["gate_unavailable"] });
    expect(calls).toHaveLength(0);
  });

  it("a clinician hold shows its notice on every channel, as the unavailable rule says", async () => {
    const { fetch } = fetchMock(() => jsonResponse(200, decisionView()));
    const result = await generate(
      withGovern({ govern: makeClient(fetch), channel: "sms", audience: "clinician", holdMessage: "Held for review.", signal: aborted }),
    );
    expect(result.content).toEqual([{ type: "text", text: "Held for review." }]);
  });

  it("a buffered stream releases the hold message in place of the draft", async () => {
    const { fetch } = fetchMock(() => jsonResponse(200, decisionView({ decision: "allow" })));
    const out = await stream(withGovern({ govern: makeClient(fetch), channel: "web_chat", audience: "patient", signal: aborted }));
    expect(streamedText(out)).toBe(HOLD);
    expect(JSON.stringify(out)).not.toContain("cures");
    expect(out.map((p) => p.type)).toContain("finish");
  });
});

describe("withGovern signal: where it comes from and when it is read", () => {
  it("refuses a bare signal at construction: one signal would hold every call after it fired", () => {
    const { fetch } = fetchMock(() => jsonResponse(200, decisionView()));
    expect(() =>
      withGovern({
        govern: makeClient(fetch),
        channel: "web_chat",
        audience: "patient",
        signal: live() as unknown as () => AbortSignal,
      }),
    ).toThrow(GovernConfigError);
  });

  it("asks the option once per call, so a later call on the same middleware is not held by an earlier abort", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView({ decision: "allow" })));
    const signals = [aborted(), live()];
    const middleware = withGovern({
      govern: makeClient(fetch),
      channel: "web_chat",
      audience: "patient",
      reportOutcome: false,
      signal: () => signals.shift(),
    });
    const first = await generate(middleware);
    expect(first.providerMetadata?.[PROVIDER_METADATA_KEY]).toMatchObject({ decision: "hold", degraded: true });
    const second = await generate(middleware, callParams({ turnId: "turn-2" }));
    expect(textOf(second.content)).toBe(DRAFT);
    expect(second.providerMetadata?.[PROVIDER_METADATA_KEY]).toMatchObject({ decision: "allow", degraded: false });
    expect(calls).toHaveLength(1);
  });

  it("asks the option when the gate call starts, after the model has answered", async () => {
    const { fetch } = fetchMock(() => jsonResponse(200, decisionView({ decision: "allow" })));
    const order: string[] = [];
    const middleware = withGovern({
      govern: makeClient(fetch),
      channel: "web_chat",
      audience: "patient",
      reportOutcome: false,
      signal: () => {
        order.push("signal");
        return live();
      },
    });
    await generate(middleware, callParams(), async () => {
      order.push("generate");
      return generateResult;
    });
    expect(order).toEqual(["generate", "signal"]);
  });

  it("honours a per-call signal over the option, and does not ask the option then", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView({ decision: "allow" })));
    let asked = 0;
    const optionSignal = (signal: () => AbortSignal) => () => {
      asked++;
      return signal();
    };
    const govern = makeClient(fetch, { maxRetries: 0 });
    // The option's signal is live; the call's own is aborted, and decides.
    const held = await generate(
      withGovern({ govern, channel: "web_chat", audience: "patient", reportOutcome: false, signal: optionSignal(live) }),
      callParams({ signal: aborted() }),
    );
    expect(textOf(held.content)).toBe(HOLD);
    expect(calls).toHaveLength(0);
    // The other way round: the option's is aborted, the call's own is live.
    const allowed = await generate(
      withGovern({ govern, channel: "web_chat", audience: "patient", reportOutcome: false, signal: optionSignal(aborted) }),
      callParams({ signal: live(), turnId: "turn-2" }),
    );
    expect(textOf(allowed.content)).toBe(DRAFT);
    expect(asked).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("does not read the generation's own abortSignal: a cancel is not a gate abort", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView({ decision: "allow" })));
    const result = await generate(
      withGovern({ govern: makeClient(fetch), channel: "web_chat", audience: "patient", reportOutcome: false }),
      callParams({}, { abortSignal: aborted() }),
    );
    expect(textOf(result.content)).toBe(DRAFT);
    expect(result.providerMetadata?.[PROVIDER_METADATA_KEY]).toMatchObject({ degraded: false });
    expect(calls).toHaveLength(1);
  });

  it("passes through generateText: the per-call signal reaches the middleware and bounds the gate call", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView({ decision: "allow" })));
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined },
    };
    const model = wrapLanguageModel({
      model: new MockLanguageModelV4({ doGenerate: async () => ({ ...generateResult, usage }) }),
      middleware: withGovern({ govern: makeClient(fetch), channel: "web_chat", audience: "patient" }),
    });
    const result = await generateText({
      model,
      prompt: "hello",
      // `ai` types providerOptions as JSON; a signal needs the cast.
      providerOptions: { anybioGovern: { conversationId: "conv-1", turnId: "turn-1", signal: aborted() as never } },
    });
    expect(result.text).toBe(HOLD);
    expect(calls).toHaveLength(0);
  });
});

describe("withGovern signal: a clinician stream has already gone out", () => {
  it("an abort of the trailing gate call goes to onError: no hold reaches onDecision and nothing is recorded", async () => {
    const pending = deferred<Response>();
    const { fetch, calls, waitForCall } = fetchMock(() => pending.promise);
    const controller = new AbortController();
    const decided: GovernDecisionInfo[] = [];
    const errors: unknown[] = [];
    const middleware = withGovern({
      govern: makeClient(fetch),
      channel: "web_chat",
      audience: "clinician",
      signal: () => controller.signal,
      onDecision: (info) => decided.push(info),
      onError: (error) => errors.push(error),
    });
    const out = await stream(middleware);
    expect(streamedText(out)).toBe(DRAFT);
    await waitForCall("evaluate");
    await tick();
    expect(calls).toHaveLength(1);
    controller.abort();
    await tick(5);
    expect(decided).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(GovernAbortError);
    expect(calls).toHaveLength(1);
    expect(outcomes(calls)).toHaveLength(0);
  });
});

describe("withGovern signal: how the bound reaches guard", () => {
  /** A client that records the context it is called with, and answers through a real one. */
  function recording() {
    const { fetch } = fetchMock(() => jsonResponse(200, decisionView({ decision: "allow" })));
    const real = makeClient(fetch);
    const seen: GuardContext[] = [];
    const govern = {
      guard: (fn: () => string, ctx: GuardContext) => {
        seen.push(ctx);
        return real.guard(fn, ctx);
      },
    } as unknown as Govern;
    return { govern, seen };
  }

  it("as gateSignal, never as the call's own signal, on every path that has not delivered", async () => {
    const { govern, seen } = recording();
    const bound = live();
    await generate(withGovern({ govern, channel: "web_chat", audience: "patient", reportOutcome: false, signal: () => bound }));
    await stream(withGovern({ govern, channel: "web_chat", audience: "patient", reportOutcome: false, signal: () => bound }));
    expect(seen).toHaveLength(2);
    for (const ctx of seen) {
      expect(ctx.gateSignal).toBe(bound);
      expect(ctx.signal).toBeUndefined();
    }
  });

  it("as the call's own signal on a clinician stream's trailing gate call, whose text has gone out", async () => {
    const { govern, seen } = recording();
    const bound = live();
    await stream(withGovern({ govern, channel: "web_chat", audience: "clinician", reportOutcome: false, signal: () => bound }));
    await tick();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.signal).toBe(bound);
    expect(seen[0]!.gateSignal).toBeUndefined();
  });

  it("emits the degraded event for an aborted gate call, with the unreachable-API cause", async () => {
    const events: GovernEvent[] = [];
    const { fetch } = fetchMock(() => jsonResponse(200, decisionView()));
    const govern = makeClient(fetch, { onEvent: (event) => events.push(event) });
    await generate(withGovern({ govern, channel: "web_chat", audience: "patient", signal: aborted }));
    expect(events.filter((e) => e.type === "degraded")).toEqual([
      expect.objectContaining({ type: "degraded", cause: "gate_unavailable", status: null, mode: "enforce", modeSource: "assumed" }),
    ]);
  });
});

describe("withGovern signal: a value that is not a signal is refused", () => {
  const controller = () => new AbortController() as unknown as AbortSignal;

  it("from the option, when the gate call starts: GovernConfigError and no request", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView()));
    const middleware = withGovern({ govern: makeClient(fetch), channel: "web_chat", audience: "patient", signal: controller });
    const error = await generate(middleware).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(GovernConfigError);
    expect(error?.message).toContain("controller.signal");
    expect(calls).toHaveLength(0);
  });

  it("per call, from providerOptions.anybioGovern.signal", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView()));
    const middleware = withGovern({ govern: makeClient(fetch), channel: "web_chat", audience: "patient" });
    await expect(generate(middleware, callParams({ signal: { aborted: false } }))).rejects.toBeInstanceOf(GovernConfigError);
    expect(calls).toHaveLength(0);
    // Absent, undefined or null is no bound, as before.
    await generate(withGovern({ govern: makeClient(fetch), channel: "web_chat", audience: "patient", reportOutcome: false }), callParams({ signal: null }));
    expect(calls).toHaveLength(1);
  });

  it("from the option on a clinician stream, read only at the trailing gate call after the text went out: to onError, with the stream intact", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView({ audience: "clinician" })));
    const errors: unknown[] = [];
    const out = await stream(
      withGovern({ govern: makeClient(fetch), channel: "web_chat", audience: "clinician", signal: controller, onError: (error) => errors.push(error) }),
    );
    expect(streamedText(out)).toBe(DRAFT);
    await tick();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(GovernConfigError);
    expect(calls).toHaveLength(0);
  });

  it("per call on a clinician stream, known when the call starts: GovernConfigError from wrapStream, before the model runs", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView({ audience: "clinician" })));
    let streamed = 0;
    const middleware = withGovern({ govern: makeClient(fetch), channel: "web_chat", audience: "clinician" });
    await expect(
      middleware.wrapStream!({
        doStream: async () => {
          streamed++;
          return { stream: sourceStream(DRAFT) };
        },
        doGenerate: async () => generateResult,
        params: callParams({ signal: { aborted: false } }),
        model: {} as WrapStreamArgs["model"],
      }),
    ).rejects.toBeInstanceOf(GovernConfigError);
    expect(streamed).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("null from the option is no bound, as undefined is", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView({ decision: "allow" })));
    const result = await generate(
      withGovern({ govern: makeClient(fetch), channel: "web_chat", audience: "patient", reportOutcome: false, signal: () => null }),
    );
    expect(textOf(result.content)).toBe(DRAFT);
    expect(calls).toHaveLength(1);
  });
});

describe("withGovern signal: a client built by another copy of the package", () => {
  afterEach(() => {
    // Drop the second module graph this block loaded.
    vi.resetModules();
  });

  it("still answers an aborted gate call with gate_unavailable", async () => {
    // Each entry point bundles its own copy of the client and the error
    // classes. The bound is handled inside the caller's client, so a client
    // from another copy answers the same way.
    vi.resetModules();
    const other = await import("../src/client");
    const otherErrors = await import("../src/errors");
    expect(otherErrors.GovernAbortError).not.toBe(GovernAbortError);
    const { fetch } = fetchMock(() => jsonResponse(200, decisionView()));
    const govern: Govern = new other.Govern({ apiKey: "gk_sandbox_0", application: "care-companion", baseUrl: "https://govern.test", fetch, holdMessage: HOLD });
    const result = await generate(withGovern({ govern, channel: "web_chat", audience: "patient", signal: aborted }));
    expect(textOf(result.content)).toBe(HOLD);
    expect(result.providerMetadata?.[PROVIDER_METADATA_KEY]).toMatchObject({ degraded: true, decisionId: null, reasons: ["gate_unavailable"] });
  });
});

// ---------------------------------------------------------------------------
// LangChain: governed
// ---------------------------------------------------------------------------

const chatModel = RunnableLambda.from(async (_input: string) => new AIMessage(DRAFT));

describe("governed signal: an abort lands on the unavailable rule", () => {
  const configurable = (signal: AbortSignal) => ({ configurable: { anybioGovern: { conversationId: "conv-1", turnId: "turn-1", signal } } });

  it("enforce, in session: aborted before the gate call, the hold message comes back and nothing is sent", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView({ decision: "allow" })));
    const gated = governed(chatModel, { govern: makeClient(fetch), channel: "web_chat", audience: "patient" });
    const out = (await gated.invoke("hello", configurable(aborted()))) as AIMessage;
    expect(out.text).toBe(HOLD);
    expect(out.response_metadata[RESPONSE_METADATA_KEY]).toMatchObject({
      decision: "hold",
      degraded: true,
      decision_id: null,
      reasons: ["gate_unavailable"],
    });
    await tick();
    expect(calls).toHaveLength(0);
  });

  it("enforce, outbound: aborted during the gate call, empty text comes back, and the request is not retried", async () => {
    const pending = deferred<Response>();
    const { fetch, calls, waitForCall } = fetchMock(() => pending.promise);
    const controller = new AbortController();
    const stringModel = RunnableLambda.from(async (_input: string) => DRAFT);
    const gated = governed(stringModel, { govern: makeClient(fetch), channel: "sms", audience: "patient" });
    const result = gated.invoke("hello", configurable(controller.signal));
    await waitForCall("evaluate");
    await tick();
    expect(calls).toHaveLength(1);
    controller.abort();
    expect(await result).toBe("");
    await tick(5);
    expect(calls).toHaveLength(1);
    expect(outcomes(calls)).toHaveLength(0);
  });

  it("observe: the output comes back flagged degraded", async () => {
    const { fetch } = fetchMock(() => jsonResponse(200, decisionView()));
    const govern = makeClient(fetch, { assumeMode: "observe" });
    const decided: GovernedDecisionInfo[] = [];
    const gated = governed(chatModel, { govern, channel: "web_chat", audience: "patient", onDecision: (info) => decided.push(info) });
    const out = (await gated.invoke("hello", configurable(aborted()))) as AIMessage;
    expect(out.text).toBe(DRAFT);
    expect(decided[0]!.reply).toMatchObject({ decision: "allow", degraded: true, reasons: ["gate_unavailable"] });
  });

  it("does not pass the run's own config.signal to the gate, and reports a run cancelled mid-gate as not delivered", async () => {
    const pending = deferred<Response>();
    const gateSignals: (AbortSignal | null | undefined)[] = [];
    const base = fetchMock([() => pending.promise, () => jsonResponse(201, decisionView({ decision: "allow" }))]);
    const fetch: typeof globalThis.fetch = (input, init) => {
      gateSignals.push(init?.signal);
      return base.fetch(input, init);
    };
    const decided: GovernedDecisionInfo[] = [];
    let asked = 0;
    const gated = governed(chatModel, {
      govern: makeClient(fetch),
      channel: "web_chat",
      audience: "patient",
      conversationId: "conv-1",
      onDecision: (info) => decided.push(info),
      deliveredText: () => {
        asked++;
        return DRAFT;
      },
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const run = new AbortController();
      const result = gated.invoke("hello", { signal: run.signal });
      await base.waitForCall("evaluate");
      await tick();
      expect(base.calls).toHaveLength(1);
      run.abort();
      // LangChain ends the run; that is its cancel, not the gate's.
      await expect(result).rejects.toThrow();
      // The gate call itself was not aborted by it and answers in full.
      expect(gateSignals[0]?.aborted).toBe(false);
      pending.resolve(jsonResponse(200, decisionView({ decision: "allow" })));
      await base.waitForCall("outcome");
      await tick();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
    // The caller was never handed the reply: nothing reached the patient.
    expect(decided).toEqual([]);
    expect(asked).toBe(0);
    const reported = outcomes(base.calls);
    expect(reported).toHaveLength(1);
    expect(reported[0]!.json).toEqual({ kind: "discarded", reason: "cancelled", at: expect.any(String) });
  });

  it("does not gate a run cancelled before the gate call", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView({ decision: "allow" })));
    const run = new AbortController();
    // A runnable that finishes after the run was cancelled, without racing
    // the signal itself.
    const late = {
      invoke: async () => {
        run.abort();
        return new AIMessage(DRAFT);
      },
    } as unknown as typeof chatModel;
    const gated = governed(late, { govern: makeClient(fetch), channel: "web_chat", audience: "patient", conversationId: "conv-1" });
    await expect(gated.invoke("hello", { signal: run.signal })).rejects.toThrow();
    await tick(5);
    expect(calls).toHaveLength(0);
  });
});

describe("governed signal: a function, or a signal for one call", () => {
  it("a function in configurable is called per call when the gate call starts, so a bound with withConfig is safe", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView({ decision: "allow" })));
    const seen: unknown[] = [];
    const signals = [aborted(), live()];
    const gated = governed(chatModel, { govern: makeClient(fetch), channel: "web_chat", audience: "patient", reportOutcome: false }).withConfig({
      configurable: {
        anybioGovern: {
          conversationId: "conv-1",
          signal: (config: unknown) => {
            seen.push(config);
            return signals.shift();
          },
        },
      },
    });
    const first = (await gated.invoke("hello")) as AIMessage;
    expect(first.text).toBe(HOLD);
    expect(first.response_metadata[RESPONSE_METADATA_KEY]).toMatchObject({ degraded: true, reasons: ["gate_unavailable"] });
    const second = (await gated.invoke("hello")) as AIMessage;
    expect(second.text).toBe(DRAFT);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ configurable: { anybioGovern: { conversationId: "conv-1" } } });
    expect(calls).toHaveLength(1);
  });

  it("a bare signal bound with withConfig is shared by every call: the trap the docs name", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView({ decision: "allow" })));
    const shared = new AbortController();
    const gated = governed(chatModel, { govern: makeClient(fetch), channel: "web_chat", audience: "patient", reportOutcome: false }).withConfig({
      configurable: { anybioGovern: { conversationId: "conv-1", signal: shared.signal } },
    });
    expect(((await gated.invoke("hello")) as AIMessage).text).toBe(DRAFT);
    shared.abort();
    for (let i = 0; i < 2; i++) expect(((await gated.invoke("hello")) as AIMessage).text).toBe(HOLD);
    expect(calls).toHaveLength(1);
  });

  it("refuses a value that is neither, or a function that returns one, with GovernConfigError and no request", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView()));
    const gated = governed(chatModel, { govern: makeClient(fetch), channel: "web_chat", audience: "patient" });
    for (const signal of [new AbortController(), () => new AbortController(), "soon"]) {
      await expect(
        gated.invoke("hello", { configurable: { anybioGovern: { conversationId: "conv-1", signal } } }),
        String(signal),
      ).rejects.toBeInstanceOf(GovernConfigError);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("governed signal: null is no bound", () => {
  it("as a value or returned by the function", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView({ decision: "allow" })));
    const gated = governed(chatModel, { govern: makeClient(fetch), channel: "web_chat", audience: "patient", reportOutcome: false });
    for (const signal of [null, () => null]) {
      const out = (await gated.invoke("hello", { configurable: { anybioGovern: { conversationId: "conv-1", signal } } })) as AIMessage;
      expect(out.text).toBe(DRAFT);
    }
    expect(calls).toHaveLength(2);
  });
});

describe("governed signal: a per-call value that is not a signal", () => {
  it("is refused before the wrapped runnable runs", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView()));
    let ran = 0;
    const counted = RunnableLambda.from(async (_input: string) => {
      ran++;
      return new AIMessage(DRAFT);
    });
    const gated = governed(counted, { govern: makeClient(fetch), channel: "web_chat", audience: "patient" });
    await expect(
      gated.invoke("hello", { configurable: { anybioGovern: { conversationId: "conv-1", signal: new AbortController() } } }),
    ).rejects.toBeInstanceOf(GovernConfigError);
    expect(ran).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("identifiers are checked before the model runs", () => {
  it("governed: a missing conversation id or a retryOf that is not a decision id", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView()));
    let ran = 0;
    const counted = RunnableLambda.from(async (_input: string) => {
      ran++;
      return new AIMessage(DRAFT);
    });
    const gated = governed(counted, { govern: makeClient(fetch), channel: "web_chat", audience: "patient" });
    await expect(gated.invoke("hello")).rejects.toBeInstanceOf(GovernConfigError);
    await expect(gated.invoke("hello", { configurable: { anybioGovern: { conversationId: "conv-1", retryOf: "turn-1" } } })).rejects.toThrow(
      /retryOf/,
    );
    expect(ran).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("withGovern: a retryOf that is not a decision id", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView()));
    let generated = 0;
    await expect(
      generate(withGovern({ govern: makeClient(fetch), channel: "web_chat", audience: "patient" }), callParams({ retryOf: "turn-1" }), async () => {
        generated++;
        return generateResult;
      }),
    ).rejects.toThrow(/retryOf/);
    expect(generated).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
