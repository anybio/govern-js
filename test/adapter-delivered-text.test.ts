import { AIMessage } from "@langchain/core/messages";
import { RunnableLambda } from "@langchain/core/runnables";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { sha256Hex } from "../src/crypto";
import { GovernConfigError, GovernConflictError, GovernReportError } from "../src/errors";
import { GovernCallbackHandler, governed, type GovernCallbackDecisionInfo, type GovernedDecisionInfo } from "../src/langchain";
import { withGovern, type DeliveredText, type GovernDecisionInfo, type LanguageModelCallOptions, type StreamPart } from "../src/vercel-ai";
import { DECISION_ID, DRAFT, HOLD, collect, decisionView, deferred, fetchMock, jsonResponse, makeClient, outcomeTrail, tick, type RecordedCall } from "./helpers";

/**
 * An outbound turn (`sms`) held with no holding line owed: the adapter hands
 * the caller nothing to send, so its own report is `discarded`. The caller
 * then sends something of its own (an emergency line), which is what the
 * record has to carry.
 */
const SPOKEN = "If this is an emergency, hang up and call 911.";

const heldOutbound = () => decisionView({ decision: "hold", channel: "sms", reasons: ["prohibited_claim"], send_holding_line: false });

const outcomes = (calls: RecordedCall[]) => calls.filter((c) => c.url.pathname.endsWith("/outcome"));

/** A replayed turn: the stored decision, with an outcome already on record. */
const replayedWithOutcome = () => decisionView({ decision: "hold", channel: "sms", outcome: outcomeTrail([{ kind: "discarded" }]) });

/** When the line was spoken, and the channel's own reference for it. */
const SPOKEN_AT = new Date("2026-09-16T00:00:07Z");
const SPOKEN_REF = "call-9:line-2";
const spokenWithTime = () => ({ text: SPOKEN, deliveredAt: SPOKEN_AT, deliveryRef: SPOKEN_REF });

const countingHook = () => {
  const hook = Object.assign(
    () => {
      hook.asked++;
      return SPOKEN;
    },
    { asked: 0 },
  );
  return hook;
};

// ---------------------------------------------------------------------------
// Vercel AI SDK
// ---------------------------------------------------------------------------

const params = {
  prompt: [],
  providerOptions: { anybioGovern: { conversationId: "conv-1", turnId: "turn-1" } },
} as unknown as LanguageModelCallOptions;

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

const finishPart = { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: {} } as unknown as StreamPart;

function sourceStream(text: string): ReadableStream<StreamPart> {
  const parts: StreamPart[] = [
    { type: "stream-start", warnings: [] } as StreamPart,
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    finishPart,
  ];
  return new ReadableStream<StreamPart>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

async function generate(middleware: Middleware): Promise<GenerateResult> {
  return middleware.wrapGenerate!({
    doGenerate: async () => generateResult,
    doStream: async () => ({ stream: sourceStream("") }),
    params,
    model: {} as WrapGenerateArgs["model"],
  });
}

async function stream(middleware: Middleware): Promise<StreamPart[]> {
  const result = await middleware.wrapStream!({
    doStream: async () => ({ stream: sourceStream(DRAFT) }),
    doGenerate: async () => generateResult,
    params,
    model: {} as WrapStreamArgs["model"],
  });
  return collect(result.stream);
}

describe("withGovern deliveredText", () => {
  it("records what the caller wrote on a hold: released, with the hash of that text", async () => {
    const { fetch, calls, waitForCall } = fetchMock([() => jsonResponse(200, heldOutbound()), () => jsonResponse(201, heldOutbound())]);
    const decided: GovernDecisionInfo[] = [];
    const asked: GovernDecisionInfo[] = [];
    const middleware = withGovern({
      govern: makeClient(fetch),
      channel: "sms",
      audience: "patient",
      onDecision: (info) => decided.push(info),
      deliveredText: (info) => {
        asked.push(info);
        return info.reply.held ? SPOKEN : info.reply.text;
      },
    });
    const result = await generate(middleware);
    // The adapter still hands over nothing: the hook changes the record, not the reply.
    expect(result.content).toEqual([]);
    await waitForCall("outcome");
    await tick();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toBe(decided[0]);
    expect(asked[0]!.reply).toMatchObject({ held: true, showHoldText: false, sendHoldingLine: false, decisionId: DECISION_ID });
    const reported = outcomes(calls);
    expect(reported).toHaveLength(1);
    expect(reported[0]!.json).toMatchObject({ kind: "released", content_hash: await sha256Hex(SPOKEN) });
    expect(reported[0]!.text).not.toContain(SPOKEN);
  });

  it("records discarded when the hook answers null, and when it answers the empty string", async () => {
    for (const answer of [null, ""]) {
      const { fetch, calls, waitForCall } = fetchMock([
        () => jsonResponse(200, decisionView({ decision: "allow", channel: "sms" })),
        () => jsonResponse(201, decisionView({ decision: "allow", channel: "sms" })),
      ]);
      const middleware = withGovern({ govern: makeClient(fetch), channel: "sms", audience: "patient", deliveredText: () => answer });
      await generate(middleware);
      await waitForCall("outcome");
      await tick();
      const reported = outcomes(calls);
      expect(reported).toHaveLength(1);
      expect(reported[0]!.json).toMatchObject({ kind: "discarded", reason: "nothing_delivered" });
      expect(reported[0]!.json).not.toHaveProperty("content_hash");
    }
  });

  it("without the hook, keeps the middleware's own report: discarded on a hold that showed nothing", async () => {
    const { fetch, calls, waitForCall } = fetchMock([() => jsonResponse(200, heldOutbound()), () => jsonResponse(201, heldOutbound())]);
    await generate(withGovern({ govern: makeClient(fetch), channel: "sms", audience: "patient" }));
    await waitForCall("outcome");
    await tick();
    const reported = outcomes(calls);
    expect(reported).toHaveLength(1);
    expect(reported[0]!.json).toMatchObject({ kind: "discarded", reason: "nothing_to_send" });
  });

  it("does not hold the reply for the hook, and reports once its promise settles", async () => {
    const { fetch, calls, waitForCall } = fetchMock([() => jsonResponse(200, heldOutbound()), () => jsonResponse(201, heldOutbound())]);
    const spoken = deferred<string | null>();
    const middleware = withGovern({ govern: makeClient(fetch), channel: "sms", audience: "patient", deliveredText: () => spoken.promise });
    const out = await stream(middleware);
    expect(out.map((p) => p.type)).toContain("finish");
    await tick();
    expect(outcomes(calls)).toHaveLength(0);
    spoken.resolve(SPOKEN);
    await waitForCall("outcome");
    await tick();
    const reported = outcomes(calls);
    expect(reported).toHaveLength(1);
    expect(reported[0]!.json).toMatchObject({ kind: "released", content_hash: await sha256Hex(SPOKEN) });
  });

  it("a hook that throws reaches onError, the stream completes, and nothing is reported", async () => {
    const { fetch, calls } = fetchMock([() => jsonResponse(200, heldOutbound()), () => jsonResponse(201, heldOutbound())]);
    const errors: unknown[] = [];
    const broken = new Error("the caller's delivery hook is broken");
    const middleware = withGovern({
      govern: makeClient(fetch),
      channel: "sms",
      audience: "patient",
      deliveredText: () => {
        throw broken;
      },
      onError: (error) => errors.push(error),
    });
    const out = await stream(middleware);
    expect(out.map((p) => p.type)).toContain("finish");
    await tick();
    expect(errors).toEqual([broken]);
    expect(outcomes(calls)).toHaveLength(0);
  });

  it("an answer that is not a string, a { text } object or null reaches onError and records nothing", async () => {
    const { fetch, calls } = fetchMock([() => jsonResponse(200, heldOutbound()), () => jsonResponse(201, heldOutbound())]);
    const errors: unknown[] = [];
    const middleware = withGovern({
      govern: makeClient(fetch),
      channel: "sms",
      audience: "patient",
      deliveredText: (() => undefined) as unknown as () => string | null,
      onError: (error) => errors.push(error),
    });
    await generate(middleware);
    await tick();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(GovernConfigError);
    expect(outcomes(calls)).toHaveLength(0);
  });

  it("reports the time and reference the hook gives with the text", async () => {
    const { fetch, calls, waitForCall } = fetchMock([() => jsonResponse(200, heldOutbound()), () => jsonResponse(201, heldOutbound())]);
    await generate(withGovern({ govern: makeClient(fetch), channel: "sms", audience: "patient", deliveredText: spokenWithTime }));
    await waitForCall("outcome");
    await tick();
    const reported = outcomes(calls);
    expect(reported).toHaveLength(1);
    expect(reported[0]!.json).toMatchObject({
      kind: "released",
      content_hash: await sha256Hex(SPOKEN),
      at: SPOKEN_AT.toISOString(),
      delivery_ref: SPOKEN_REF,
    });
  });

  it("an answer with empty text is discarded; one with a time that is not a time reaches onError", async () => {
    const empty = fetchMock([() => jsonResponse(200, heldOutbound()), () => jsonResponse(201, heldOutbound())]);
    await generate(withGovern({ govern: makeClient(empty.fetch), channel: "sms", audience: "patient", deliveredText: () => ({ text: "" }) }));
    await empty.waitForCall("outcome");
    await tick();
    expect(outcomes(empty.calls)).toHaveLength(1);
    expect(outcomes(empty.calls)[0]!.json).toMatchObject({ kind: "discarded", reason: "nothing_delivered" });
    expect(outcomes(empty.calls)[0]!.json).not.toHaveProperty("content_hash");

    const bad = fetchMock([() => jsonResponse(200, heldOutbound()), () => jsonResponse(201, heldOutbound())]);
    const errors: unknown[] = [];
    await generate(
      withGovern({
        govern: makeClient(bad.fetch),
        channel: "sms",
        audience: "patient",
        deliveredText: () => ({ text: SPOKEN, deliveredAt: 7 as unknown as Date }),
        onError: (error) => errors.push(error),
      }),
    );
    await tick();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(GovernConfigError);
    expect((errors[0] as Error).message).not.toContain(SPOKEN);
    expect(outcomes(bad.calls)).toHaveLength(0);
  });

  it("is not asked for a stream cancelled while the gate decides, which is recorded as discarded", async () => {
    const evaluate = deferred<Response>();
    const { fetch, calls, waitForCall } = fetchMock([() => evaluate.promise, () => jsonResponse(201, heldOutbound())]);
    const deliveredText = countingHook();
    const middleware = withGovern({ govern: makeClient(fetch), channel: "sms", audience: "patient", deliveredText });
    const result = await middleware.wrapStream!({
      doStream: async () => ({ stream: sourceStream(DRAFT) }),
      doGenerate: async () => generateResult,
      params,
      model: {} as WrapStreamArgs["model"],
    });
    const reader = result.stream.getReader();
    void reader.read();
    await waitForCall("evaluate");
    await tick();
    expect(calls).toHaveLength(1);
    await reader.cancel("caller hung up");
    evaluate.resolve(jsonResponse(200, decisionView({ decision: "allow", channel: "sms" })));
    await waitForCall("outcome");
    await tick();
    expect(deliveredText.asked).toBe(0);
    const reported = outcomes(calls);
    expect(reported).toHaveLength(1);
    expect(reported[0]!.json).toMatchObject({ kind: "discarded", reason: "cancelled" });
  });

  it("reports the clinician stream's trailing decision with the hook's answer", async () => {
    const view = () => decisionView({ decision: "allow", audience: "clinician" });
    const { fetch, calls, waitForCall } = fetchMock([() => jsonResponse(200, view()), () => jsonResponse(201, view())]);
    const asked: GovernDecisionInfo[] = [];
    const middleware = withGovern({
      govern: makeClient(fetch),
      channel: "web_chat",
      audience: "clinician",
      deliveredText: (info) => {
        asked.push(info);
        return "what the clinician was shown";
      },
    });
    await stream(middleware);
    await waitForCall("outcome");
    await tick();
    expect(asked).toHaveLength(1);
    expect(asked[0]!.streamed).toBe(true);
    expect(outcomes(calls)[0]!.json).toMatchObject({
      kind: "released",
      content_hash: await sha256Hex("what the clinician was shown"),
    });
  });

  it("is never asked for a replayed decision that already has an outcome on record", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, replayedWithOutcome()));
    const deliveredText = countingHook();
    await generate(withGovern({ govern: makeClient(fetch), channel: "sms", audience: "patient", deliveredText }));
    await tick();
    expect(deliveredText.asked).toBe(0);
    expect(outcomes(calls)).toHaveLength(0);
  });

  it("is never asked with reportOutcome off, or for a reply with no decision id", async () => {
    let asked = 0;
    const deliveredText = () => {
      asked++;
      return SPOKEN;
    };
    const { fetch, calls } = fetchMock(() => jsonResponse(200, heldOutbound()));
    await generate(withGovern({ govern: makeClient(fetch), channel: "sms", audience: "patient", reportOutcome: false, deliveredText }));
    const unreachable = fetchMock(() => {
      throw new TypeError("fetch failed");
    });
    await generate(withGovern({ govern: makeClient(unreachable.fetch, { maxRetries: 0 }), channel: "sms", audience: "patient", deliveredText }));
    await tick();
    expect(asked).toBe(0);
    expect(outcomes(calls)).toHaveLength(0);
    expect(outcomes(unreachable.calls)).toHaveLength(0);
  });
});

describe("withGovern: a stream cancelled from inside onDecision", () => {
  const SECOND = "22222222-2222-4222-8222-222222222222";
  const OWN = "A person from the clinic will call you back.";

  /**
   * A buffered web_chat stream held by the gate; `onDecision` cancels the
   * reader, as a caller that sends its own line on a hold would. The evaluate
   * waits for the test, so the reader exists before the decision lands.
   */
  async function cancelledInOnDecision(deliveredText?: (info: GovernDecisionInfo) => string | null) {
    const evaluate = deferred<Response>();
    const mock = fetchMock((call) => {
      if (call.url.pathname.endsWith("/outcome")) return jsonResponse(201, decisionView());
      const body = call.json as { turn_id: string };
      if (body.turn_id === "turn-1") return evaluate.promise.then(() => jsonResponse(200, decisionView({ decision: "hold" })));
      return jsonResponse(200, decisionView({ decision_id: SECOND, turn_id: body.turn_id }));
    });
    const govern = makeClient(mock.fetch, { maxRetries: 0 });
    // Filled in once the stream exists; the decision cannot land before that.
    const held: { reader?: ReadableStreamDefaultReader<StreamPart> } = {};
    const decided: GovernDecisionInfo[] = [];
    const asked: GovernDecisionInfo[] = [];
    const middleware = withGovern({
      govern,
      channel: "web_chat",
      audience: "patient",
      onDecision: (info) => {
        decided.push(info);
        void held.reader!.cancel("the caller sends its own line");
      },
      ...(deliveredText
        ? {
            deliveredText: (info: GovernDecisionInfo) => {
              asked.push(info);
              return deliveredText(info);
            },
          }
        : {}),
    });
    const result = await middleware.wrapStream!({
      doStream: async () => ({ stream: sourceStream(DRAFT) }),
      doGenerate: async () => generateResult,
      params: { prompt: [], providerOptions: { anybioGovern: { conversationId: "conv-1", turnId: "turn-1" } } } as unknown as LanguageModelCallOptions,
      model: {} as WrapStreamArgs["model"],
    });
    held.reader = result.stream.getReader();
    const read = held.reader.read();
    await mock.waitForCall("evaluate");
    evaluate.resolve(new Response());
    const first = await read;
    return { ...mock, govern, decided, asked, first };
  }

  it("without a hook, records discarded once, and the next turn reports nothing in its place", async () => {
    const { calls, waitForCall, govern, decided, first } = await cancelledInOnDecision();
    expect(decided).toHaveLength(1);
    expect(first.done).toBe(true);
    await waitForCall("outcome");
    await tick();
    await govern.guard(() => "next draft", { conversationId: "conv-1", turnId: "turn-2", channel: "web_chat", audience: "patient" });
    await govern.flushReports();
    await tick();
    const firstTurn = outcomes(calls).filter((c) => c.url.pathname.includes(DECISION_ID));
    expect(firstTurn).toHaveLength(1);
    expect(firstTurn[0]!.json).toEqual({ kind: "discarded", reason: "cancelled", at: expect.any(String) });
    expect(JSON.stringify(firstTurn[0]!.json)).not.toContain(await sha256Hex(HOLD));
  });

  it("with a hook, asks it once, since the caller had the decision, and reports its answer", async () => {
    const { calls, waitForCall, decided, asked } = await cancelledInOnDecision(() => OWN);
    await waitForCall("outcome");
    await tick();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toBe(decided[0]);
    const reported = outcomes(calls);
    expect(reported).toHaveLength(1);
    expect(reported[0]!.json).toMatchObject({ kind: "released", content_hash: await sha256Hex(OWN) });
  });
});

describe("deliveredText: deliveredAt is checked", () => {
  const heldResult = async (deliveredAt: unknown) => {
    const { fetch, calls, waitForCall } = fetchMock([() => jsonResponse(200, heldOutbound()), () => jsonResponse(201, heldOutbound())]);
    const errors: unknown[] = [];
    await generate(
      withGovern({
        govern: makeClient(fetch),
        channel: "sms",
        audience: "patient",
        deliveredText: () => ({ text: SPOKEN, deliveredAt: deliveredAt as Date }),
        onError: (error) => errors.push(error),
      }),
    );
    await tick();
    return { calls, errors, waitForCall };
  };

  it("accepts a Date from another realm and sends its ISO time", async () => {
    const foreign = runInNewContext('new Date("2026-09-16T00:00:07Z")') as unknown;
    expect(foreign instanceof Date).toBe(false);
    const { errors, waitForCall } = await heldResult(foreign);
    const reported = await waitForCall("outcome");
    expect(errors).toEqual([]);
    expect(reported.json).toMatchObject({ kind: "released", at: "2026-09-16T00:00:07.000Z" });
  });

  it("refuses an invalid Date or a string that is not a time with an error that names deliveredText, and reports nothing", async () => {
    for (const bad of [new Date("not a time"), "yesterday-ish"]) {
      const { calls, errors } = await heldResult(bad);
      expect(errors, String(bad)).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(GovernConfigError);
      expect((errors[0] as Error).message).toContain("deliveredText");
      expect(outcomes(calls)).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// LangChain: governed
// ---------------------------------------------------------------------------

const chatModel = RunnableLambda.from(async (_input: string) => new AIMessage(DRAFT));
const governedOptions = { channel: "sms" as const, audience: "patient" as const, conversationId: "conv-1" };

describe("governed deliveredText", () => {
  it("records what the caller wrote on a hold: released, with the hash of that text", async () => {
    const { fetch, calls, waitForCall } = fetchMock([() => jsonResponse(200, heldOutbound()), () => jsonResponse(201, heldOutbound())]);
    const decided: GovernedDecisionInfo[] = [];
    const asked: GovernedDecisionInfo[] = [];
    const gated = governed(chatModel, {
      govern: makeClient(fetch),
      ...governedOptions,
      onDecision: (info) => decided.push(info),
      deliveredText: (info) => {
        asked.push(info);
        return info.reply.held ? SPOKEN : info.reply.text;
      },
    });
    const out = await gated.invoke("hello");
    expect((out as AIMessage).text).toBe("");
    await waitForCall("outcome");
    await tick();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toBe(decided[0]);
    expect(asked[0]!.reply).toMatchObject({ held: true, showHoldText: false, decisionId: DECISION_ID });
    const reported = outcomes(calls);
    expect(reported).toHaveLength(1);
    expect(reported[0]!.json).toMatchObject({ kind: "released", content_hash: await sha256Hex(SPOKEN) });
  });

  it("reports the time and reference the hook gives with the text", async () => {
    const { fetch, calls, waitForCall } = fetchMock([() => jsonResponse(200, heldOutbound()), () => jsonResponse(201, heldOutbound())]);
    await governed(chatModel, { govern: makeClient(fetch), ...governedOptions, deliveredText: spokenWithTime }).invoke("hello");
    await waitForCall("outcome");
    await tick();
    const reported = outcomes(calls);
    expect(reported).toHaveLength(1);
    expect(reported[0]!.json).toMatchObject({
      kind: "released",
      content_hash: await sha256Hex(SPOKEN),
      at: SPOKEN_AT.toISOString(),
      delivery_ref: SPOKEN_REF,
    });
  });

  it("records discarded when the hook answers null", async () => {
    const { fetch, calls, waitForCall } = fetchMock([
      () => jsonResponse(200, decisionView({ decision: "allow", channel: "sms" })),
      () => jsonResponse(201, decisionView({ decision: "allow", channel: "sms" })),
    ]);
    const gated = governed(chatModel, { govern: makeClient(fetch), ...governedOptions, deliveredText: () => null });
    expect((await gated.invoke("hello")) as AIMessage).toBeInstanceOf(AIMessage);
    await waitForCall("outcome");
    await tick();
    const reported = outcomes(calls);
    expect(reported).toHaveLength(1);
    expect(reported[0]!.json).toMatchObject({ kind: "discarded", reason: "nothing_delivered" });
    expect(reported[0]!.json).not.toHaveProperty("content_hash");
  });

  it("without the hook, keeps the wrapper's own report: discarded on a hold that showed nothing", async () => {
    const { fetch, calls, waitForCall } = fetchMock([() => jsonResponse(200, heldOutbound()), () => jsonResponse(201, heldOutbound())]);
    await governed(chatModel, { govern: makeClient(fetch), ...governedOptions }).invoke("hello");
    await waitForCall("outcome");
    await tick();
    const reported = outcomes(calls);
    expect(reported).toHaveLength(1);
    expect(reported[0]!.json).toMatchObject({ kind: "discarded", reason: "nothing_to_send" });
  });

  it("a hook that throws reaches onError, the reply still comes back, and nothing is reported", async () => {
    const { fetch, calls } = fetchMock([() => jsonResponse(200, heldOutbound()), () => jsonResponse(201, heldOutbound())]);
    const errors: unknown[] = [];
    const broken = new Error("the caller's delivery hook is broken");
    const gated = governed(chatModel, {
      govern: makeClient(fetch),
      ...governedOptions,
      deliveredText: async () => {
        throw broken;
      },
      onError: (error) => errors.push(error),
    });
    const chunks: unknown[] = [];
    for await (const chunk of await gated.stream("hello")) chunks.push(chunk);
    expect(chunks).toHaveLength(1);
    await tick();
    expect(errors).toEqual([broken]);
    expect(outcomes(calls)).toHaveLength(0);
  });

  it("is never asked with reportOutcome off, or for a replayed decision that already has an outcome on record", async () => {
    const deliveredText = countingHook();
    const off = fetchMock(() => jsonResponse(200, heldOutbound()));
    await governed(chatModel, { govern: makeClient(off.fetch), ...governedOptions, reportOutcome: false, deliveredText }).invoke("hello");
    const replay = fetchMock(() => jsonResponse(200, replayedWithOutcome()));
    await governed(chatModel, { govern: makeClient(replay.fetch), ...governedOptions, deliveredText }).invoke("hello");
    await tick();
    expect(deliveredText.asked).toBe(0);
    expect(outcomes(off.calls)).toHaveLength(0);
    expect(outcomes(replay.calls)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// LangChain: GovernCallbackHandler
// ---------------------------------------------------------------------------

describe("GovernCallbackHandler deliveredText", () => {
  const handlerOptions = { channel: "sms" as const, audience: "patient" as const, conversationId: "conv-1", reportOutcome: true };

  it("records what the caller wrote: released, with the hash of that text", async () => {
    const { fetch, calls, waitForCall } = fetchMock([() => jsonResponse(200, heldOutbound()), () => jsonResponse(201, heldOutbound())]);
    const decided: GovernCallbackDecisionInfo[] = [];
    const asked: GovernCallbackDecisionInfo[] = [];
    const handler = new GovernCallbackHandler({
      govern: makeClient(fetch),
      ...handlerOptions,
      onDecision: (info) => decided.push(info),
      deliveredText: (info) => {
        asked.push(info);
        return info.decision.decision === "hold" ? SPOKEN : null;
      },
    });
    await handler.handleLLMEnd({ generations: [[{ text: DRAFT }]] }, "run-1");
    await waitForCall("outcome");
    await tick();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toBe(decided[0]);
    expect(asked[0]).toMatchObject({ runId: "run-1", decision: { id: DECISION_ID, decision: "hold" } });
    const reported = outcomes(calls);
    expect(reported).toHaveLength(1);
    expect(reported[0]!.json).toMatchObject({ kind: "released", content_hash: await sha256Hex(SPOKEN) });
  });

  it("reports the time and reference the hook gives with the text", async () => {
    const { fetch, calls, waitForCall } = fetchMock([() => jsonResponse(200, heldOutbound()), () => jsonResponse(201, heldOutbound())]);
    const handler = new GovernCallbackHandler({ govern: makeClient(fetch), ...handlerOptions, deliveredText: spokenWithTime });
    await handler.handleLLMEnd({ generations: [[{ text: DRAFT }]] }, "run-1");
    await waitForCall("outcome");
    await tick();
    const reported = outcomes(calls);
    expect(reported).toHaveLength(1);
    expect(reported[0]!.json).toMatchObject({
      kind: "released",
      content_hash: await sha256Hex(SPOKEN),
      at: SPOKEN_AT.toISOString(),
      delivery_ref: SPOKEN_REF,
    });
  });

  it("records discarded when the hook answers null", async () => {
    const { fetch, calls, waitForCall } = fetchMock([() => jsonResponse(200, heldOutbound()), () => jsonResponse(201, heldOutbound())]);
    const handler = new GovernCallbackHandler({ govern: makeClient(fetch), ...handlerOptions, deliveredText: () => null });
    await handler.handleLLMEnd({ generations: [[{ text: DRAFT }]] }, "run-1");
    await waitForCall("outcome");
    await tick();
    const reported = outcomes(calls);
    expect(reported).toHaveLength(1);
    expect(reported[0]!.json).toMatchObject({ kind: "discarded", reason: "nothing_delivered" });
    expect(reported[0]!.json).not.toHaveProperty("content_hash");
  });

  it("without the hook, keeps the handler's own report: the generation's text, released", async () => {
    const { fetch, calls } = fetchMock([() => jsonResponse(200, heldOutbound()), () => jsonResponse(201, heldOutbound())]);
    const handler = new GovernCallbackHandler({ govern: makeClient(fetch), ...handlerOptions });
    await handler.handleLLMEnd({ generations: [[{ text: DRAFT }]] }, "run-1");
    const reported = outcomes(calls);
    expect(reported).toHaveLength(1);
    expect(reported[0]!.json).toMatchObject({ kind: "released", content_hash: await sha256Hex(DRAFT) });
  });

  it("does not hold the callback for the hook, and a hook that throws reaches onError with nothing reported", async () => {
    const { fetch, calls } = fetchMock([() => jsonResponse(200, heldOutbound()), () => jsonResponse(201, heldOutbound())]);
    const errors: unknown[] = [];
    const broken = new Error("the caller's delivery hook is broken");
    const later = deferred<string | null>();
    const handler = new GovernCallbackHandler({
      govern: makeClient(fetch),
      ...handlerOptions,
      deliveredText: () => later.promise,
      onError: (error) => errors.push(error),
    });
    // Resolves while the hook is still waiting: the callback is not held for it.
    await handler.handleLLMEnd({ generations: [[{ text: DRAFT }]] }, "run-1");
    expect(outcomes(calls)).toHaveLength(0);
    later.reject(broken);
    await tick();
    expect(errors).toEqual([broken]);
    expect(outcomes(calls)).toHaveLength(0);
  });

  it("is never asked for a replayed decision that already has an outcome on record", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, replayedWithOutcome()));
    const deliveredText = countingHook();
    const handler = new GovernCallbackHandler({ govern: makeClient(fetch), ...handlerOptions, deliveredText });
    await handler.handleLLMEnd({ generations: [[{ text: DRAFT }]] }, "run-1");
    await tick();
    expect(deliveredText.asked).toBe(0);
    expect(outcomes(calls)).toHaveLength(0);
  });
});

describe("deliveredText: a date alone is not a time", () => {
  it("reaches onError and records nothing", async () => {
    const { fetch, calls } = fetchMock([() => jsonResponse(200, heldOutbound()), () => jsonResponse(201, heldOutbound())]);
    const errors: unknown[] = [];
    await generate(
      withGovern({
        govern: makeClient(fetch),
        channel: "sms",
        audience: "patient",
        deliveredText: () => ({ text: SPOKEN, deliveredAt: "2026-11-16" }),
        onError: (error) => errors.push(error),
      }),
    );
    await tick();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toContain("RFC 3339");
    expect(outcomes(calls)).toHaveLength(0);
  });
});

describe("deliveredText after the decision has an event of that kind on record", () => {
  /** A hook-owned hold on web_chat (its hold text shown) whose `released` the caller records by hand before the hook answers. */
  async function releasedBeforeTheHook(answer: string, api: "replay" | "conflict") {
    let reports = 0;
    const held = () => decisionView({ decision: "hold" });
    const { fetch, calls, waitForCall } = fetchMock((call) => {
      if (call.url.pathname.endsWith("/outcome")) {
        reports++;
        if (reports === 1) return jsonResponse(201, held());
        return api === "replay"
          ? jsonResponse(200, held())
          : jsonResponse(409, { kind: "CONFLICT_ERROR", error_message: "a different event of this kind is already recorded" });
      }
      return jsonResponse(200, held());
    });
    const govern = makeClient(fetch, { maxRetries: 0 });
    const hook = deferred<DeliveredText>();
    const errors: unknown[] = [];
    await generate(withGovern({ govern, channel: "web_chat", audience: "patient", deliveredText: () => hook.promise, onError: (error) => errors.push(error) }));
    await govern.reportOutcome(DECISION_ID, { kind: "released", at: SPOKEN_AT, content: HOLD });
    hook.resolve({ text: answer, deliveredAt: SPOKEN_AT });
    await waitForCall("outcome", { nth: 2 });
    await tick();
    return { calls, errors };
  }

  it("the same event again is posted, and the API's 200 replay needs nothing more", async () => {
    const { calls, errors } = await releasedBeforeTheHook(HOLD, "replay");
    expect(errors).toEqual([]);
    expect(outcomes(calls).map((c) => c.json)).toEqual([
      { kind: "released", at: SPOKEN_AT.toISOString(), content_hash: await sha256Hex(HOLD) },
      { kind: "released", at: SPOKEN_AT.toISOString(), content_hash: await sha256Hex(HOLD) },
    ]);
  });

  it("a different one is posted too, and the API's 409 reaches onError as a GovernReportError whose cause is the GovernConflictError", async () => {
    const { calls, errors } = await releasedBeforeTheHook(SPOKEN, "conflict");
    expect(outcomes(calls)).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(GovernReportError);
    expect((errors[0] as GovernReportError).cause).toBeInstanceOf(GovernConflictError);
  });
});

describe("two results for one decision", () => {
  it("each posts its own report: nothing is held back for the other, and the API's one-per-kind rule answers the second", async () => {
    let reports = 0;
    const { fetch, calls, waitForCall } = fetchMock((call) => {
      if (call.url.pathname.endsWith("/outcome")) {
        reports++;
        return reports === 1
          ? jsonResponse(201, decisionView({ decision: "hold" }))
          : jsonResponse(409, { kind: "CONFLICT_ERROR", error_message: "a different event of this kind is already recorded" });
      }
      return jsonResponse(200, decisionView({ decision: "hold" }));
    });
    const errors: unknown[] = [];
    const middleware = withGovern({ govern: makeClient(fetch, { maxRetries: 0 }), channel: "web_chat", audience: "patient", onError: (error) => errors.push(error) });
    await stream(middleware);
    await waitForCall("outcome");
    await stream(middleware);
    await waitForCall("outcome", { nth: 2 });
    await tick();
    expect(outcomes(calls).map((c) => (c.json as { kind: string }).kind)).toEqual(["released", "released"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(GovernReportError);
    expect((errors[0] as GovernReportError).cause).toBeInstanceOf(GovernConflictError);
  });

  it("two results cancelled while the gate decides, on a hold that showed nothing: each records discarded, cancelled", async () => {
    const silent = () => heldOutbound();
    for (const adapter of ["withGovern", "governed"] as const) {
      const evaluates: ReturnType<typeof deferred<Response>>[] = [];
      const { fetch, calls, waitForCall } = fetchMock((call) => {
        if (call.url.pathname.endsWith("/outcome")) return jsonResponse(201, silent());
        const gate = deferred<Response>();
        evaluates.push(gate);
        return gate.promise.then(() => jsonResponse(200, silent()));
      });
      const govern = makeClient(fetch, { maxRetries: 0 });
      for (let run = 1; run <= 2; run++) {
        if (adapter === "withGovern") {
          const middleware = withGovern({ govern, channel: "sms", audience: "patient" });
          const result = await middleware.wrapStream!({
            doStream: async () => ({ stream: sourceStream(DRAFT) }),
            doGenerate: async () => generateResult,
            params,
            model: {} as WrapStreamArgs["model"],
          });
          const reader = result.stream.getReader();
          void reader.read();
          await waitForCall("evaluate", { nth: run });
          await reader.cancel("caller hung up");
        } else {
          const gated = governed(chatModel, { govern, channel: "sms", audience: "patient", conversationId: "conv-1" });
          const runCancel = new AbortController();
          const invoked = gated.invoke("hello", { signal: runCancel.signal, configurable: { anybioGovern: { turnId: "turn-1" } } });
          await waitForCall("evaluate", { nth: run });
          runCancel.abort();
          await expect(invoked).rejects.toThrow();
        }
        evaluates[run - 1]!.resolve(new Response());
        await waitForCall("outcome", { nth: run });
        await tick();
      }
      const reported = outcomes(calls);
      expect(reported, adapter).toHaveLength(2);
      for (const report of reported) expect(report.json, adapter).toEqual({ kind: "discarded", reason: "cancelled", at: expect.any(String) });
    }
  });
});

describe("deliveredText: more checks", () => {
  it("a hook's deliveredAt on a date an engine would roll over reaches onError and records nothing", async () => {
    const { fetch, calls } = fetchMock([() => jsonResponse(200, heldOutbound()), () => jsonResponse(201, heldOutbound())]);
    const errors: unknown[] = [];
    await generate(
      withGovern({
        govern: makeClient(fetch),
        channel: "sms",
        audience: "patient",
        deliveredText: () => ({ text: SPOKEN, deliveredAt: "2026-02-30T10:00:00Z" }),
        onError: (error) => errors.push(error),
      }),
    );
    await tick();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(GovernConfigError);
    expect(outcomes(calls)).toHaveLength(0);
  });

  it("an empty or blank hold message is refused when an adapter is built", () => {
    const { fetch } = fetchMock(() => jsonResponse(200, decisionView()));
    for (const holdMessage of ["", "  "]) {
      expect(() => withGovern({ govern: makeClient(fetch), channel: "web_chat", audience: "patient", holdMessage })).toThrow(GovernConfigError);
      expect(() => governed(chatModel, { govern: makeClient(fetch), channel: "web_chat", audience: "patient", holdMessage })).toThrow(GovernConfigError);
    }
  });
});
