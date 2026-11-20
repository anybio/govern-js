import { AIMessage } from "@langchain/core/messages";
import { RunnableLambda } from "@langchain/core/runnables";
import { describe, expect, it } from "vitest";

import { sha256Hex } from "../src/crypto";
import { GovernConfigError } from "../src/errors";
import { governed } from "../src/langchain";
import { withGovern } from "../src/vercel-ai";
import { DECISION_ID, DRAFT, HOLD, decisionView, deferred, fetchMock, jsonResponse, makeClient, olderServer, tick } from "./helpers";

const RETRIED = "6a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const ctx = { conversationId: "conv-1", channel: "web_chat" as const, audience: "patient" as const };

/** A stopped turn the API says may be retried once. */
const retryableHold = () =>
  decisionView({
    decision: "hold",
    reasons: ["clinical_claim", "held_for_review"],
    stop_class: "uncertain",
    review_state: "pending",
    send_holding_line: true,
    retryable: true,
  });

describe("retryOf", () => {
  it("evaluate sends it as retry_of, and sends no retry_of without it", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView({ retry_of: RETRIED })));
    const govern = makeClient(fetch);
    await govern.evaluate({ ...ctx, turnId: "turn-1:r1", content: DRAFT, retryOf: RETRIED });
    await govern.evaluate({ ...ctx, turnId: "turn-2", content: DRAFT });
    expect(calls[0]!.json).toMatchObject({ turn_id: "turn-1:r1", retry_of: RETRIED });
    expect(calls[1]!.json).not.toHaveProperty("retry_of");
  });

  it("guard passes it through, beside the metadata, which stays the caller's own", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView({ retry_of: RETRIED })));
    const reply = await makeClient(fetch).guard(() => DRAFT, { ...ctx, turnId: "turn-1:r1", retryOf: RETRIED, metadata: { attempt: 2 } });
    expect(calls[0]!.json).toMatchObject({ retry_of: RETRIED, metadata: { attempt: 2 } });
    expect(reply.record?.retryOf).toBe(RETRIED);
  });

  it("a retry the API refuses holds in enforce, as any refused call does", async () => {
    const { fetch } = fetchMock(() =>
      jsonResponse(400, { kind: "BAD_REQUEST_ERROR", error_message: "retry_of does not name a retryable decision", code: null, details: [] }),
    );
    const reply = await makeClient(fetch, { maxRetries: 0 }).guard(() => DRAFT, { ...ctx, turnId: "turn-1:r1", retryOf: RETRIED });
    expect(reply.degraded).toBe(true);
    expect(reply.decision).toBe("hold");
    expect(reply.reasons).toEqual(["client_misconfigured"]);
    expect(reply.text).toBe(HOLD);
  });
});

describe("retryable and retryOf on the decision", () => {
  it("are read from the decision view", async () => {
    const { fetch } = fetchMock(() => jsonResponse(200, retryableHold()));
    const decision = await makeClient(fetch).getDecision(DECISION_ID);
    expect(decision.retryable).toBe(true);
    expect(decision.retryOf).toBeNull();
    // The API's order: on a retryable first hold, nothing changes on the
    // first turn's own flags; the caller evaluates the retry before showing.
    expect([decision.sendHoldingLine, decision.showHoldText]).toEqual([true, true]);
  });

  it("the retry names the decision it retried and is never itself retryable", async () => {
    const { fetch } = fetchMock(() => jsonResponse(200, decisionView({ turn_id: "turn-1:r1", retry_of: RETRIED, retryable: false })));
    const decision = await makeClient(fetch).getDecision(DECISION_ID);
    expect(decision.retryOf).toBe(RETRIED);
    expect(decision.retryable).toBe(false);
  });

  it("read as not retryable and not a retry from a server that predates them", async () => {
    const { fetch } = fetchMock(() => jsonResponse(200, olderServer(retryableHold())));
    const decision = await makeClient(fetch).getDecision(DECISION_ID);
    expect(decision.retryable).toBe(false);
    expect(decision.retryOf).toBeNull();
  });

  it("only a boolean true reads as retryable", async () => {
    for (const value of ["true", 1, null]) {
      const { fetch } = fetchMock(() => jsonResponse(200, { ...retryableHold(), retryable: value }));
      expect((await makeClient(fetch).getDecision(DECISION_ID)).retryable, String(value)).toBe(false);
    }
  });
});

describe("retryOf is checked before anything runs", () => {
  for (const value of ["", "not-a-decision", ` ${RETRIED}`, 7 as unknown as string]) {
    it(`guard refuses ${JSON.stringify(value)} with GovernConfigError before the draft function runs`, async () => {
      const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView()));
      let ran = false;
      const draft = () => {
        ran = true;
        return DRAFT;
      };
      await expect(makeClient(fetch).guard(draft, { ...ctx, turnId: "turn-1:r1", retryOf: value })).rejects.toBeInstanceOf(GovernConfigError);
      expect(ran).toBe(false);
      expect(calls).toHaveLength(0);
    });
  }

  it("evaluate refuses one too, and accepts a decision id in either case", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView()));
    const govern = makeClient(fetch);
    await expect(govern.evaluate({ ...ctx, turnId: "turn-1:r1", content: DRAFT, retryOf: "turn-1" })).rejects.toBeInstanceOf(GovernConfigError);
    expect(calls).toHaveLength(0);
    await govern.evaluate({ ...ctx, turnId: "turn-1:r1", content: DRAFT, retryOf: RETRIED.toUpperCase() });
    expect(calls[0]!.json).toMatchObject({ retry_of: RETRIED.toUpperCase() });
  });
});

describe("a retry and the stopped turn's report", () => {
  const RETRY_ID = "1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9";
  const RETRY_DRAFT = "A reply the rules allow.";

  type RetryAnswer = "allow" | "refused" | "unreachable";

  /** The stopped turn on `turn-1`; any other turn answered as `retry` says. */
  function api(retry: RetryAnswer = "allow") {
    return fetchMock((call) => {
      if (call.url.pathname.endsWith("/outcome")) return jsonResponse(201, retryableHold());
      const body = call.json as { turn_id: string };
      if (body.turn_id === "turn-1") return jsonResponse(200, retryableHold());
      if (retry === "refused") {
        return jsonResponse(400, { kind: "BAD_REQUEST_ERROR", error_message: "retry_of must name a retryable decision", code: null, details: [] });
      }
      if (retry === "unreachable") throw new TypeError("fetch failed");
      return jsonResponse(200, decisionView({ decision_id: RETRY_ID, turn_id: body.turn_id, retry_of: DECISION_ID }));
    });
  }
  const reports = (calls: { url: URL; json: unknown }[]) =>
    calls.filter((c) => c.url.pathname.endsWith("/outcome")).map((c) => ({ id: c.url.pathname.split("/").at(-2), ...(c.json as object) }));

  /**
   * The voice example's shape: each attempt through its own middleware, its
   * `deliveredText` hook answered once the turn knows what was heard.
   */
  function attempt(govern: ReturnType<typeof makeClient>, turnId: string, draft: string, answer: Promise<string | null>, retryOf?: string) {
    const middleware = withGovern({ govern, channel: "voice", audience: "patient", deliveredText: () => answer });
    type WrapArgs = Parameters<NonNullable<typeof middleware.wrapGenerate>>[0];
    const result = { content: [{ type: "text", text: draft }], finishReason: { unified: "stop", raw: "stop" }, usage: {}, warnings: [] };
    const anybioGovern: Record<string, unknown> = { conversationId: "conv-1", turnId };
    if (retryOf !== undefined) anybioGovern.retryOf = retryOf;
    return middleware.wrapGenerate!({
      doGenerate: async () => result as unknown as Awaited<ReturnType<WrapArgs["doGenerate"]>>,
      doStream: async () => {
        throw new Error("unused");
      },
      params: { prompt: [], providerOptions: { anybioGovern } } as unknown as WrapArgs["params"],
      model: {} as WrapArgs["model"],
    });
  }

  it("guard reports nothing for either turn: the API records the stopped one superseded itself", async () => {
    const { fetch, calls } = api();
    const govern = makeClient(fetch, { maxRetries: 0 });
    await govern.guard(() => DRAFT, { ...ctx, turnId: "turn-1" });
    const retry = await govern.guard(() => RETRY_DRAFT, { ...ctx, turnId: "turn-1:r1", retryOf: DECISION_ID });
    expect(retry.decisionId).toBe(RETRY_ID);
    await govern.flushReports();
    await tick();
    expect(reports(calls)).toEqual([]);
  });

  it("an accepted retry: the stopped turn keeps its own report, what its hook says: discarded on null, released on text; the retry's is released", async () => {
    const legs: [string | null, Record<string, unknown>][] = [
      [null, { kind: "discarded", reason: "nothing_delivered" }],
      [HOLD, { kind: "released", content_hash: await sha256Hex(HOLD) }],
    ];
    for (const [heard, stopped] of legs) {
      const { fetch, calls } = api();
      const govern = makeClient(fetch, { maxRetries: 0 });
      const first = deferred<string | null>();
      const second = deferred<string | null>();
      await attempt(govern, "turn-1", DRAFT, first.promise);
      await attempt(govern, "turn-1:r1", RETRY_DRAFT, second.promise, DECISION_ID);
      // The order the API asks for: the retry decided first, then the answers.
      first.resolve(heard);
      second.resolve(RETRY_DRAFT);
      await tick();
      await govern.flushReports();
      // The API adds its own superseded event to the stopped turn when it applies the retry.
      const sent = reports(calls).sort((a, b) => String(a.id).localeCompare(String(b.id)));
      expect(sent, String(heard)).toEqual(
        [
          { id: DECISION_ID, at: expect.any(String), ...stopped },
          { id: RETRY_ID, kind: "released", at: expect.any(String), content_hash: await sha256Hex(RETRY_DRAFT) },
        ].sort((a, b) => a.id.localeCompare(b.id)),
      );
    }
  });

  for (const refusal of ["refused", "unreachable"] as const) {
    it(`a retry the API ${refusal === "refused" ? "refuses" : "cannot be asked about"}: the stopped turn's hook answer is its report`, async () => {
      const { fetch, calls } = api(refusal);
      const govern = makeClient(fetch, { maxRetries: 0 });
      const first = deferred<string | null>();
      await attempt(govern, "turn-1", DRAFT, first.promise);
      await attempt(govern, "turn-1:r1", RETRY_DRAFT, Promise.resolve(null), DECISION_ID);
      first.resolve(HOLD);
      await tick();
      await govern.flushReports();
      expect(reports(calls)).toEqual([{ id: DECISION_ID, kind: "released", at: expect.any(String), content_hash: await sha256Hex(HOLD) }]);
    });
  }

  it("a report already made before the retry stands: the API keeps it beside the superseded event", async () => {
    const { fetch, calls } = api();
    const govern = makeClient(fetch, { maxRetries: 0 });
    await attempt(govern, "turn-1", DRAFT, Promise.resolve(HOLD));
    await govern.flushReports();
    await attempt(govern, "turn-1:r1", RETRY_DRAFT, Promise.resolve(RETRY_DRAFT), DECISION_ID);
    await tick();
    await govern.flushReports();
    expect(reports(calls).map((r) => [r.id, (r as { kind?: string }).kind])).toEqual([
      [DECISION_ID, "released"],
      [RETRY_ID, "released"],
    ]);
  });
});

describe("the adapters carry retryOf per call, as they carry turnId", () => {
  it("withGovern reads providerOptions.anybioGovern.retryOf", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView()));
    const middleware = withGovern({ govern: makeClient(fetch), channel: "voice", audience: "patient" });
    type WrapArgs = Parameters<NonNullable<typeof middleware.wrapGenerate>>[0];
    const result = { content: [{ type: "text", text: DRAFT }], finishReason: { unified: "stop", raw: "stop" }, usage: {}, warnings: [] };
    for (const anybioGovern of [{ conversationId: "conv-1", turnId: "turn-1:r1", retryOf: RETRIED }, { conversationId: "conv-1", turnId: "turn-2" }]) {
      await middleware.wrapGenerate!({
        doGenerate: async () => result as unknown as Awaited<ReturnType<WrapArgs["doGenerate"]>>,
        doStream: async () => {
          throw new Error("unused");
        },
        params: { prompt: [], providerOptions: { anybioGovern } } as unknown as WrapArgs["params"],
        model: {} as WrapArgs["model"],
      });
    }
    const evaluations = calls.filter((c) => c.url.pathname.endsWith("/evaluate")).map((c) => c.json);
    expect(evaluations[0]).toMatchObject({ turn_id: "turn-1:r1", retry_of: RETRIED });
    expect(evaluations[1]).toMatchObject({ turn_id: "turn-2" });
    expect(evaluations[1]).not.toHaveProperty("retry_of");
  });

  it("governed reads configurable.anybioGovern.retryOf", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView()));
    const gated = governed(
      RunnableLambda.from(async (_input: string) => new AIMessage(DRAFT)),
      { govern: makeClient(fetch), channel: "web_chat", audience: "patient", reportOutcome: false },
    );
    await gated.invoke("hello", { configurable: { anybioGovern: { conversationId: "conv-1", turnId: "turn-1:r1", retryOf: RETRIED } } });
    expect(calls[0]!.json).toMatchObject({ turn_id: "turn-1:r1", retry_of: RETRIED });
  });

  it("both refuse a retryOf that is not a decision id with GovernConfigError, and send nothing", async () => {
    // `null` is no retry, as `undefined` is: see "null is no retry" below.
    for (const retryOf of [7, "turn-1"]) {
      const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView()));
      const govern = makeClient(fetch);

      const middleware = withGovern({ govern, channel: "voice", audience: "patient" });
      type WrapArgs = Parameters<NonNullable<typeof middleware.wrapGenerate>>[0];
      const result = { content: [{ type: "text", text: DRAFT }], finishReason: { unified: "stop", raw: "stop" }, usage: {}, warnings: [] };
      await expect(
        middleware.wrapGenerate!({
          doGenerate: async () => result as unknown as Awaited<ReturnType<WrapArgs["doGenerate"]>>,
          doStream: async () => {
            throw new Error("unused");
          },
          params: { prompt: [], providerOptions: { anybioGovern: { conversationId: "conv-1", turnId: "turn-1:r1", retryOf } } } as unknown as WrapArgs["params"],
          model: {} as WrapArgs["model"],
        }),
        String(retryOf),
      ).rejects.toBeInstanceOf(GovernConfigError);

      const gated = governed(
        RunnableLambda.from(async (_input: string) => new AIMessage(DRAFT)),
        { govern, channel: "web_chat", audience: "patient", reportOutcome: false },
      );
      await expect(
        gated.invoke("hello", { configurable: { anybioGovern: { conversationId: "conv-1", turnId: "turn-1:r1", retryOf } } }),
        String(retryOf),
      ).rejects.toBeInstanceOf(GovernConfigError);
      expect(calls, String(retryOf)).toHaveLength(0);
    }
  });
});

describe("null is no retry", () => {
  it("on guard, evaluate and both adapters, as undefined is", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView({ decision: "allow" })));
    const govern = makeClient(fetch);
    await govern.guard(() => DRAFT, { ...ctx, turnId: "turn-a", retryOf: null });
    await govern.evaluate({ ...ctx, turnId: "turn-b", content: DRAFT, retryOf: null });
    const middleware = withGovern({ govern, channel: "web_chat", audience: "patient", reportOutcome: false });
    type WrapArgs = Parameters<NonNullable<typeof middleware.wrapGenerate>>[0];
    const result = { content: [{ type: "text", text: DRAFT }], finishReason: { unified: "stop", raw: "stop" }, usage: {}, warnings: [] };
    await middleware.wrapGenerate!({
      doGenerate: async () => result as unknown as Awaited<ReturnType<WrapArgs["doGenerate"]>>,
      doStream: async () => {
        throw new Error("unused");
      },
      params: { prompt: [], providerOptions: { anybioGovern: { conversationId: "conv-1", turnId: "turn-c", retryOf: null } } } as unknown as WrapArgs["params"],
      model: {} as WrapArgs["model"],
    });
    const gated = governed(RunnableLambda.from(async (_input: string) => new AIMessage(DRAFT)), { govern, channel: "web_chat", audience: "patient", reportOutcome: false });
    await gated.invoke("hello", { configurable: { anybioGovern: { conversationId: "conv-1", turnId: "turn-d", retryOf: null } } });
    const evaluates = calls.filter((c) => c.url.pathname.endsWith("/evaluate"));
    expect(evaluates).toHaveLength(4);
    for (const call of evaluates) expect(call.json).not.toHaveProperty("retry_of");
  });
});
