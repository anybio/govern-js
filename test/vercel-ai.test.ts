import { describe, expect, it } from "vitest";

import { GovernConfigError } from "../src/errors";
import {
  PROVIDER_METADATA_KEY,
  withGovern,
  type LanguageModelCallOptions,
  type StreamPart,
} from "../src/vercel-ai";
import { DRAFT, HOLD, collect, decisionView, deferred, fetchMock, jsonResponse, makeClient, tick } from "./helpers";

/**
 * Join the text parts of a generate result. The middleware's own `textOf` is
 * internal and stays that way; a test reaching for it was how it came to be
 * exported.
 */
function textOf(content: readonly { type: string }[]): string {
  return content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

const params = {
  prompt: [],
  providerOptions: { anybioGovern: { conversationId: "conv-1", turnId: "turn-1" } },
} as unknown as LanguageModelCallOptions;

const finishPart = { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: {} } as unknown as StreamPart;

function sourceParts(text: string[]): StreamPart[] {
  return [
    { type: "stream-start", warnings: [] } as StreamPart,
    { type: "text-start", id: "t" },
    ...text.map((delta): StreamPart => ({ type: "text-delta", id: "t", delta })),
    { type: "text-end", id: "t" },
    finishPart,
  ];
}

function streamOf(parts: StreamPart[]): ReadableStream<StreamPart> {
  return new ReadableStream<StreamPart>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

type WrapStreamArgs = Parameters<NonNullable<ReturnType<typeof withGovern>["wrapStream"]>>[0];
type WrapGenerateArgs = Parameters<NonNullable<ReturnType<typeof withGovern>["wrapGenerate"]>>[0];
type GenerateResult = Awaited<ReturnType<WrapGenerateArgs["doGenerate"]>>;

const unusedGenerate = async (): Promise<GenerateResult> => {
  throw new Error("doGenerate is not used by this test");
};

describe("anybioGovern middleware: wrapGenerate", () => {
  const generateResult = {
    content: [{ type: "text", text: DRAFT }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: {},
    warnings: [],
  } as unknown as GenerateResult;

  it("returns the generated text unchanged on allow and records the decision in providerMetadata", async () => {
    const { fetch, calls } = fetchMock([
      () => jsonResponse(200, decisionView({ decision: "allow" })),
      () => jsonResponse(201, decisionView({ decision: "allow" })),
    ]);
    const govern = makeClient(fetch);
    const middleware = withGovern({ govern, channel: "web_chat", audience: "patient" });
    const result = await middleware.wrapGenerate!({
      doGenerate: async () => generateResult,
      doStream: async () => ({ stream: streamOf([]) }),
      params,
      model: {} as WrapGenerateArgs["model"],
    });
    expect(textOf(result.content)).toBe(DRAFT);
    expect(result.providerMetadata?.[PROVIDER_METADATA_KEY]).toMatchObject({ decision: "allow", held: false, degraded: false });
    expect(calls[0]!.json).toMatchObject({ conversation_id: "conv-1", turn_id: "turn-1", content: DRAFT });
    await tick();
    expect(calls[1]!.url.pathname).toContain("/outcome");
    expect(calls[1]!.text).not.toContain(DRAFT);
  });

  it("replaces the content with the hold message on hold", async () => {
    const { fetch } = fetchMock([
      () => jsonResponse(200, decisionView({ decision: "hold", reasons: ["prohibited_claim", "held_for_review"] })),
      () => jsonResponse(201, decisionView({ decision: "hold" })),
    ]);
    const govern = makeClient(fetch);
    const decisions: string[] = [];
    const middleware = withGovern({
      govern,
      channel: "web_chat",
      audience: "patient",
      onDecision: (info) => decisions.push(info.reply.decision),
    });
    const result = await middleware.wrapGenerate!({
      doGenerate: async () => generateResult,
      doStream: async () => ({ stream: streamOf([]) }),
      params,
      model: {} as WrapGenerateArgs["model"],
    });
    expect(result.content).toEqual([{ type: "text", text: HOLD }]);
    expect(textOf(result.content)).not.toContain("cures");
    expect(result.providerMetadata?.[PROVIDER_METADATA_KEY]).toMatchObject({ decision: "hold", held: true, reasons: ["prohibited_claim", "held_for_review"] });
    expect(decisions).toEqual(["hold"]);
  });

  it("requires a conversation id from the options or providerOptions", async () => {
    const { fetch } = fetchMock(() => jsonResponse(200, decisionView()));
    const middleware = withGovern({ govern: makeClient(fetch), channel: "web_chat", audience: "patient" });
    await expect(
      middleware.wrapGenerate!({
        doGenerate: async () => generateResult,
        doStream: async () => ({ stream: streamOf([]) }),
        params: { prompt: [] } as unknown as LanguageModelCallOptions,
        model: {} as WrapGenerateArgs["model"],
      }),
    ).rejects.toBeInstanceOf(GovernConfigError);
  });
});

describe("anybioGovern middleware: wrapStream", () => {
  async function wrap(
    middleware: ReturnType<typeof withGovern>,
    parts: StreamPart[],
    callParams: LanguageModelCallOptions = params,
  ): Promise<ReadableStream<StreamPart>> {
    const result = await middleware.wrapStream!({
      doStream: async () => ({ stream: streamOf(parts) }),
      doGenerate: unusedGenerate,
      params: callParams,
      model: {} as WrapStreamArgs["model"],
    });
    return result.stream;
  }

  it("emits no chunk to a patient audience before the decision, then the hold message instead of the draft", async () => {
    const evaluate = deferred<Response>();
    const { fetch, calls } = fetchMock([() => evaluate.promise, () => jsonResponse(201, decisionView({ decision: "hold" }))]);
    const govern = makeClient(fetch);
    const middleware = withGovern({ govern, channel: "web_chat", audience: "patient" });
    const stream = await wrap(middleware, sourceParts(["Good news: this program cures ", "high blood pressure."]));

    const reader = stream.getReader();
    let firstChunk: ReadableStreamReadResult<StreamPart> | undefined;
    const firstRead = reader.read().then((chunk) => {
      firstChunk = chunk;
      return chunk;
    });
    await tick(5);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.pathname).toBe("/api/v1/govern/evaluate");
    expect(calls[0]!.json).toMatchObject({ content: "Good news: this program cures high blood pressure." });
    expect(firstChunk).toBeUndefined();

    evaluate.resolve(jsonResponse(200, decisionView({ decision: "hold" })));
    const first = await firstRead;
    expect(first.done).toBe(false);
    expect(first.value?.type).toBe("stream-start");
    const rest: StreamPart[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest.push(value);
    }
    const deltas = rest.filter((p): p is Extract<StreamPart, { type: "text-delta" }> => p.type === "text-delta");
    expect(deltas.map((d) => d.delta).join("")).toBe(HOLD);
    expect(JSON.stringify(rest)).not.toContain("cures");
    const finish = rest.find((p) => p.type === "finish") as Extract<StreamPart, { type: "finish" }>;
    expect(finish.providerMetadata?.[PROVIDER_METADATA_KEY]).toMatchObject({ decision: "hold", held: true });
    await tick();
    expect(calls[1]!.url.pathname).toContain("/outcome");
  });

  it("replays the original parts for a patient audience on allow", async () => {
    const { fetch } = fetchMock([
      () => jsonResponse(200, decisionView({ decision: "allow" })),
      () => jsonResponse(201, decisionView({ decision: "allow" })),
    ]);
    const govern = makeClient(fetch);
    const middleware = withGovern({ govern, channel: "web_chat", audience: "patient" });
    const parts = sourceParts(["Hello ", "there."]);
    const out = await collect(await wrap(middleware, parts));
    expect(out.map((p) => p.type)).toEqual(parts.map((p) => p.type));
    const deltas = out.filter((p): p is Extract<StreamPart, { type: "text-delta" }> => p.type === "text-delta");
    expect(deltas.map((d) => d.delta)).toEqual(["Hello ", "there."]);
  });

  it("passes a stream with no text through without evaluating", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView()));
    const middleware = withGovern({ govern: makeClient(fetch), channel: "web_chat", audience: "patient" });
    const parts: StreamPart[] = [{ type: "stream-start", warnings: [] } as StreamPart, finishPart];
    const out = await collect(await wrap(middleware, parts));
    expect(out).toHaveLength(2);
    expect(calls).toHaveLength(0);
  });

  it("returns the hold message when the API is unreachable in enforce (fail closed)", async () => {
    const { fetch } = fetchMock(() => {
      throw new TypeError("fetch failed");
    });
    const govern = makeClient(fetch, { maxRetries: 0 });
    const middleware = withGovern({ govern, channel: "web_chat", audience: "patient" });
    const out = await collect(await wrap(middleware, sourceParts(["draft"])));
    const deltas = out.filter((p): p is Extract<StreamPart, { type: "text-delta" }> => p.type === "text-delta");
    expect(deltas.map((d) => d.delta).join("")).toBe(HOLD);
    const finish = out.find((p) => p.type === "finish") as Extract<StreamPart, { type: "finish" }>;
    expect(finish.providerMetadata?.[PROVIDER_METADATA_KEY]).toMatchObject({ degraded: true, decision: "hold" });
  });

  it("streams a clinician audience through at once and evaluates after the end", async () => {
    const evaluate = deferred<Response>();
    const { fetch, calls } = fetchMock([() => evaluate.promise, () => jsonResponse(201, decisionView({ audience: "clinician" }))]);
    const govern = makeClient(fetch);
    const middleware = withGovern({ govern, channel: "web_chat", audience: "clinician" });
    const stream = await wrap(middleware, sourceParts(["Part one. ", "Part two."]));
    const reader = stream.getReader();
    const first = await reader.read();
    expect(first.value?.type).toBe("stream-start");
    expect(calls).toHaveLength(0);
    const rest: StreamPart[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest.push(value);
    }
    const deltas = rest.filter((p): p is Extract<StreamPart, { type: "text-delta" }> => p.type === "text-delta");
    expect(deltas.map((d) => d.delta)).toEqual(["Part one. ", "Part two."]);
    await tick();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.json).toMatchObject({ audience: "clinician", content: "Part one. Part two." });
    evaluate.resolve(jsonResponse(200, decisionView({ audience: "clinician", decision: "allow" })));
    await tick(5);
    expect(calls[1]!.url.pathname).toContain("/outcome");
    expect(calls[1]!.json).toMatchObject({ delivered: true });
  });
});

describe("anybioGovern middleware: the patient closes the tab", () => {
  /** A provider stream this test drives by hand, recording how it was cancelled. */
  function controlledSource() {
    let controller!: ReadableStreamDefaultController<StreamPart>;
    const cancelReasons: unknown[] = [];
    const stream = new ReadableStream<StreamPart>({
      start(c) {
        controller = c;
      },
      cancel(reason) {
        cancelReasons.push(reason);
      },
    });
    return { stream, enqueue: (part: StreamPart) => controller.enqueue(part), cancelReasons };
  }

  async function wrapStream(
    middleware: ReturnType<typeof withGovern>,
    stream: ReadableStream<StreamPart>,
  ): Promise<ReadableStream<StreamPart>> {
    const result = await middleware.wrapStream!({
      doStream: async () => ({ stream }),
      doGenerate: unusedGenerate,
      params,
      model: {} as WrapStreamArgs["model"],
    });
    return result.stream;
  }

  it("cancels the provider's stream mid-buffer instead of rejecting, and evaluates nothing", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView({ decision: "allow" })));
    const middleware = withGovern({ govern: makeClient(fetch), channel: "web_chat", audience: "patient" });
    const source = controlledSource();
    const reader = (await wrapStream(middleware, source.stream)).getReader();
    const pendingRead = reader.read();
    source.enqueue({ type: "text-start", id: "t" });
    source.enqueue({ type: "text-delta", id: "t", delta: "Good news: this program cures " });
    await tick();

    // The runtime cancels the response stream. Nothing may reject here, and
    // the provider must stop generating rather than bill a closed tab.
    await expect(reader.cancel("patient left")).resolves.toBeUndefined();
    expect(source.cancelReasons).toEqual(["patient left"]);
    await expect(pendingRead).resolves.toMatchObject({ done: true });
    expect(calls).toHaveLength(0);
  });

  it("does not enqueue on the closed controller when the decision lands after the cancel", async () => {
    const evaluate = deferred<Response>();
    const { fetch, calls } = fetchMock([() => evaluate.promise, () => jsonResponse(201, decisionView())]);
    const middleware = withGovern({ govern: makeClient(fetch), channel: "web_chat", audience: "patient" });
    const stream = await wrapStream(middleware, streamOf(sourceParts(["Good news: this program cures ", "high blood pressure."])));
    const reader = stream.getReader();
    void reader.read();
    await tick(5);
    expect(calls).toHaveLength(1);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await reader.cancel("patient left");
      evaluate.resolve(jsonResponse(200, decisionView({ decision: "allow" })));
      await tick(5);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    // An unhandled rejection here ends the Node process, taking
    // every other in-flight gated turn with it.
    expect(unhandled).toEqual([]);
  });

  it("records a cancelled turn as not delivered, so the next turn's auto-ack cannot claim it was", async () => {
    const evaluate = deferred<Response>();
    const { fetch, calls } = fetchMock([() => evaluate.promise, () => jsonResponse(201, decisionView())]);
    const middleware = withGovern({ govern: makeClient(fetch), channel: "web_chat", audience: "patient" });
    const stream = await wrapStream(middleware, streamOf(sourceParts(["Good news."])));
    const reader = stream.getReader();
    void reader.read();
    await tick(5);
    await reader.cancel("patient left");
    evaluate.resolve(jsonResponse(200, decisionView({ decision: "allow" })));
    await tick(5);
    const outcomes = calls.filter((c) => c.url.pathname.endsWith("/outcome"));
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.json).toMatchObject({ delivered: false });
  });

  it("a throwing onDecision cannot stall the stream or escape as an unhandled rejection", async () => {
    const { fetch } = fetchMock([
      () => jsonResponse(200, decisionView({ decision: "allow" })),
      () => jsonResponse(201, decisionView({ decision: "allow" })),
    ]);
    const errors: unknown[] = [];
    const middleware = withGovern({
      govern: makeClient(fetch),
      channel: "web_chat",
      audience: "patient",
      onDecision: () => {
        throw new Error("the caller's decision hook is broken");
      },
      onError: (error) => errors.push(error),
    });
    const out = await collect(await wrapStream(middleware, streamOf(sourceParts(["Hello ", "there."]))));
    expect(out.map((p) => p.type)).toContain("finish");
    expect(errors).toHaveLength(1);
  });
});

describe("the safety branch is the verdict, not a string comparison", () => {
  // A hold message a model could plausibly produce word for word. Comparing
  // the reply against the draft then reads a held turn as an allow and replays
  // the original content, tool calls and all.
  const ECHO = "A person from the care team will review this and follow up with you shortly.";

  const withToolCall = {
    content: [
      { type: "text", text: ECHO },
      { type: "tool-call", toolCallId: "call-1", toolName: "schedule_appointment", input: "{}" },
    ],
    finishReason: { unified: "stop", raw: "stop" },
    usage: {},
    warnings: [],
  } as unknown as GenerateResult;

  it("wrapGenerate drops the tool call on a hold whose message matches the draft", async () => {
    const { fetch } = fetchMock(() => jsonResponse(200, decisionView({ decision: "hold" })));
    const middleware = withGovern({
      govern: makeClient(fetch, { holdMessage: ECHO }),
      channel: "web_chat",
      audience: "patient",
      reportOutcome: false,
    });
    const result = await middleware.wrapGenerate!({
      doGenerate: async () => withToolCall,
      doStream: async () => ({ stream: streamOf([]) }),
      params,
      model: {} as WrapGenerateArgs["model"],
    });
    expect(result.content).toEqual([{ type: "text", text: ECHO }]);
    expect(JSON.stringify(result.content)).not.toContain("schedule_appointment");
    expect(result.providerMetadata?.[PROVIDER_METADATA_KEY]).toMatchObject({ held: true, decision: "hold" });
  });

  it("wrapStream drops the tool-call parts on the same hold", async () => {
    const { fetch } = fetchMock(() => jsonResponse(200, decisionView({ decision: "hold" })));
    const middleware = withGovern({
      govern: makeClient(fetch, { holdMessage: ECHO }),
      channel: "web_chat",
      audience: "patient",
      reportOutcome: false,
    });
    const parts: StreamPart[] = [
      { type: "stream-start", warnings: [] } as StreamPart,
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: ECHO },
      { type: "text-end", id: "t" },
      { type: "tool-call", toolCallId: "call-1", toolName: "schedule_appointment", input: "{}" } as unknown as StreamPart,
      finishPart,
    ];
    const result = await middleware.wrapStream!({
      doStream: async () => ({ stream: streamOf(parts) }),
      doGenerate: unusedGenerate,
      params,
      model: {} as WrapStreamArgs["model"],
    });
    const out = await collect(result.stream);
    expect(out.map((p) => p.type)).not.toContain("tool-call");
    expect(JSON.stringify(out)).not.toContain("schedule_appointment");
    const finish = out.find((p) => p.type === "finish") as Extract<StreamPart, { type: "finish" }>;
    expect(finish.providerMetadata?.[PROVIDER_METADATA_KEY]).toMatchObject({ held: true });
  });

  it("still delivers a clinician substitution, which is an allow with different text", async () => {
    const { fetch } = fetchMock(() =>
      jsonResponse(200, decisionView({ audience: "clinician", decision: "allow", deliverable_content: "substituted wording" })),
    );
    const middleware = withGovern({
      govern: makeClient(fetch),
      channel: "web_chat",
      audience: "clinician",
      reportOutcome: false,
    });
    const result = await middleware.wrapGenerate!({
      doGenerate: async () =>
        ({ ...withToolCall, content: [{ type: "text", text: DRAFT }] }) as unknown as GenerateResult,
      doStream: async () => ({ stream: streamOf([]) }),
      params,
      model: {} as WrapGenerateArgs["model"],
    });
    expect(textOf(result.content)).toBe("substituted wording");
  });
});
