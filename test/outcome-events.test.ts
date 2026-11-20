/**
 * The outcome as an event trail: what `reportOutcome` sends for each kind,
 * what it refuses before sending, how the API's replay and conflict answers
 * reach the caller, the `released` report every adapter makes as it hands the
 * reply over, `turnRef` and `supersedes` on the wire from every entry point,
 * and the shutdown flush.
 */

import { AIMessage } from "@langchain/core/messages";
import { RunnableLambda } from "@langchain/core/runnables";
import { describe, expect, it } from "vitest";

import { MAX_SUPERSEDES, MAX_TURN_REF_CHARS } from "../src/client";
import { sha256Hex } from "../src/crypto";
import { GovernApiError, GovernConfigError, GovernConflictError, GovernError, GovernReportError } from "../src/errors";
import { GovernCallbackHandler, governed } from "../src/langchain";
import { OUTCOME_REASONS, type GovernEvent, type ReportOutcomeInput } from "../src/types";
import { withGovern, type LanguageModelCallOptions, type StreamPart } from "../src/vercel-ai";
import { DECISION_ID, DRAFT, HOLD, collect, decisionView, deferred, fetchMock, jsonResponse, makeClient, outcomeTrail, tick, type RecordedCall } from "./helpers";

const ctx = { conversationId: "conv-1", channel: "web_chat" as const, audience: "patient" as const };
const AT = "2026-09-16T10:00:00Z";
const OTHER = "22222222-2222-4222-8222-222222222222";
const THIRD = "33333333-3333-4333-8333-333333333333";

const outcomes = (calls: RecordedCall[]) => calls.filter((c) => c.url.pathname.endsWith("/outcome"));
const evaluates = (calls: RecordedCall[]) => calls.filter((c) => c.url.pathname.endsWith("/evaluate"));
const recorded = () => jsonResponse(201, decisionView({ outcome: outcomeTrail() }));

// ---------------------------------------------------------------------------
// reportOutcome
// ---------------------------------------------------------------------------

describe("reportOutcome: one event per call, each kind as the API takes it", () => {
  it("released and delivered carry the hash of the text, never the text", async () => {
    const { fetch, calls } = fetchMock(recorded);
    const govern = makeClient(fetch);
    await govern.reportOutcome(DECISION_ID, { kind: "released", at: AT, content: DRAFT, deliveryRef: "SM-1" });
    await govern.reportOutcome(DECISION_ID, { kind: "delivered", at: new Date(AT), contentHash: (await sha256Hex(DRAFT)).toUpperCase(), deliveryRef: "SM-1" });
    expect(calls.map((c) => c.json)).toEqual([
      { kind: "released", at: AT, content_hash: await sha256Hex(DRAFT), delivery_ref: "SM-1" },
      { kind: "delivered", at: "2026-09-16T10:00:00.000Z", content_hash: await sha256Hex(DRAFT), delivery_ref: "SM-1" },
    ]);
    for (const call of calls) {
      expect(call.url.pathname).toBe(`/api/v1/govern/decisions/${DECISION_ID}/outcome`);
      expect(call.text).not.toContain(DRAFT);
    }
  });

  it("discarded and failed carry no hash, and take a reason and a reference", async () => {
    const { fetch, calls } = fetchMock(recorded);
    const govern = makeClient(fetch);
    await govern.reportOutcome(DECISION_ID, { kind: "discarded", at: AT, reason: "barge_in" });
    await govern.reportOutcome(DECISION_ID, { kind: "failed", at: AT, reason: "carrier_rejected", deliveryRef: "SM-1" });
    await govern.reportOutcome(DECISION_ID, { kind: "failed", at: AT });
    expect(calls.map((c) => c.json)).toEqual([
      { kind: "discarded", at: AT, reason: "barge_in" },
      { kind: "failed", at: AT, reason: "carrier_rejected", delivery_ref: "SM-1" },
      { kind: "failed", at: AT },
    ]);
  });

  it("resolves with the decision as the API answers it, the trail mapped", async () => {
    const trail = outcomeTrail([{ kind: "released", hash_matches_release: true }]);
    const { fetch } = fetchMock(() => jsonResponse(201, decisionView({ outcome: trail })));
    const decision = await makeClient(fetch).reportOutcome(DECISION_ID, { kind: "released", at: AT, content: DRAFT });
    expect(decision.outcome?.state).toBe("released");
    expect(decision.outcome?.events).toEqual([expect.objectContaining({ kind: "released", source: "caller", hashMatchesRelease: true })]);
  });
});

describe("reportOutcome: the replay and the conflict", () => {
  it("the same event again is the API's 200: it resolves as any accepted report does, and needs nothing more", async () => {
    const events: GovernEvent[] = [];
    const { fetch, calls } = fetchMock([recorded, () => jsonResponse(200, decisionView({ outcome: outcomeTrail() }))]);
    const govern = makeClient(fetch, { onEvent: (e) => events.push(e) });
    const input: ReportOutcomeInput = { kind: "released", at: AT, content: DRAFT };
    const first = await govern.reportOutcome(DECISION_ID, input);
    const again = await govern.reportOutcome(DECISION_ID, input);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.json).toEqual(calls[0]!.json);
    expect(again.outcome).toEqual(first.outcome);
    expect(events.filter((e) => e.type === "outcome")).toEqual([
      { type: "outcome", decisionId: DECISION_ID, kind: "released" },
      { type: "outcome", decisionId: DECISION_ID, kind: "released" },
    ]);
  });

  it("a different event of a kind already on record is the API's 409: GovernConflictError, no outcome event, never retried", async () => {
    const events: GovernEvent[] = [];
    const { fetch, calls } = fetchMock(() => jsonResponse(409, { kind: "CONFLICT_ERROR", error_message: "a different event of this kind is already recorded" }));
    const govern = makeClient(fetch, { onEvent: (e) => events.push(e) });
    await expect(govern.reportOutcome(DECISION_ID, { kind: "released", at: AT, content: "other text" })).rejects.toBeInstanceOf(GovernConflictError);
    expect(calls).toHaveLength(1);
    expect(events.filter((e) => e.type === "outcome")).toEqual([]);
    // Nothing is remembered: the next report is posted and answered on its own.
    await expect(govern.reportOutcome(DECISION_ID, { kind: "released", at: AT, content: "other text" })).rejects.toBeInstanceOf(GovernConflictError);
    expect(calls).toHaveLength(2);
  });
});

describe("reportOutcome: the fields are checked before anything is sent", () => {
  const refused = async (input: unknown, pattern: RegExp) => {
    const { fetch, calls } = fetchMock(recorded);
    await expect(makeClient(fetch).reportOutcome(DECISION_ID, input as ReportOutcomeInput), JSON.stringify(input)).rejects.toThrow(pattern);
    await expect(makeClient(fetch).reportOutcome(DECISION_ID, input as ReportOutcomeInput)).rejects.toBeInstanceOf(GovernConfigError);
    expect(calls).toHaveLength(0);
  };

  it("superseded is the API's own, and any other kind is not one", async () => {
    await refused({ kind: "superseded", at: AT }, /recorded by the API itself/);
    for (const kind of ["sent", "", undefined, 1, "RELEASED"]) await refused({ kind, at: AT, content: DRAFT }, /`kind` must be released, delivered, discarded or failed/);
  });

  it("at is required and must be a valid Date or an RFC 3339 date-time", async () => {
    for (const at of [undefined, "", "around noon", "2026-09-16", new Date("not a time"), 7]) {
      await refused({ kind: "discarded", at }, /`at` is required/);
    }
  });

  it("released and delivered need the text or its hash", async () => {
    for (const kind of ["released", "delivered"]) {
      await refused({ kind, at: AT }, new RegExp(`\`${kind}\` carries the hash of the text`));
      await refused({ kind, at: AT, contentHash: "  " }, /carries the hash/);
    }
  });

  it("discarded and failed carry no text: content or a hash is refused, as the API refuses it", async () => {
    for (const kind of ["discarded", "failed"]) {
      await refused({ kind, at: AT, content: DRAFT }, new RegExp(`\`${kind}\` carries no text`));
      await refused({ kind, at: AT, contentHash: "a".repeat(64) }, /carries no text/);
    }
  });

  it("content, contentHash, deliveryRef and reason must be strings", async () => {
    await refused({ kind: "released", at: AT, content: 123 }, /`content` must be a string/);
    await refused({ kind: "released", at: AT, contentHash: 42 }, /`contentHash` must be a string/);
    await refused({ kind: "discarded", at: AT, deliveryRef: {} }, /`deliveryRef` must be a string/);
    await refused({ kind: "discarded", at: AT, reason: 7 }, /`reason` must be a string/);
  });

  it("empty content is no text: released needs a hash then, and discarded takes it and sends no hash", async () => {
    await refused({ kind: "released", at: AT, content: "" }, /`released` carries the hash of the text/);
    const { fetch, calls } = fetchMock(recorded);
    await makeClient(fetch).reportOutcome(DECISION_ID, { kind: "discarded", at: AT, content: "" });
    expect(calls[0]!.json).toEqual({ kind: "discarded", at: AT });
  });

  it("a hash is 64 hex characters, either case, as the API takes it", async () => {
    for (const contentHash of ["abc", "g".repeat(64), "a".repeat(63), "a".repeat(65)]) {
      await refused({ kind: "released", at: AT, contentHash }, /`contentHash` must be the SHA-256/);
    }
    const { fetch, calls } = fetchMock(recorded);
    await makeClient(fetch).reportOutcome(DECISION_ID, { kind: "released", at: AT, contentHash: ` ${"A".repeat(64)} ` });
    expect(calls[0]!.json).toMatchObject({ content_hash: "a".repeat(64) });
  });

  it("deliveryRef and reason as the API bounds them: not blank, at most 256 characters, no control characters", async () => {
    for (const field of ["deliveryRef", "reason"]) {
      for (const value of ["", "   ", "x".repeat(257), "line\nbreak", "bell\u0007", "c1\u0085x"]) {
        await refused({ kind: "discarded", at: AT, [field]: value }, new RegExp(`\`${field}\` must not be blank`));
      }
    }
    const { fetch, calls } = fetchMock(recorded);
    await makeClient(fetch).reportOutcome(DECISION_ID, { kind: "failed", at: AT, deliveryRef: "\u{1F600}".repeat(256), reason: " tts_error " });
    // Sent trimmed, as the API stores them.
    expect(calls[0]!.json).toMatchObject({ delivery_ref: "\u{1F600}".repeat(256), reason: "tts_error" });
  });

  it("trims with the API's white space: U+0085 and U+3000 at the edges go, U+FEFF stays", async () => {
    const { fetch, calls } = fetchMock(recorded);
    const govern = makeClient(fetch);
    await govern.reportOutcome(DECISION_ID, { kind: "failed", at: AT, deliveryRef: "\u0085SM-1\u3000", reason: "\uFEFFbounce" });
    expect(calls[0]!.json).toMatchObject({ delivery_ref: "SM-1", reason: "\uFEFFbounce" });
    // Blank by the API's measure, though String.prototype.trim keeps U+0085.
    await refused({ kind: "failed", at: AT, reason: "\u0085\u0085" }, /`reason` must not be blank/);
  });

  it("null is absent for content, contentHash, deliveryRef and reason", async () => {
    const { fetch, calls } = fetchMock(recorded);
    const govern = makeClient(fetch);
    await govern.reportOutcome(DECISION_ID, { kind: "discarded", at: AT, content: null, contentHash: null, deliveryRef: null, reason: null });
    await govern.reportOutcome(DECISION_ID, { kind: "released", at: AT, content: DRAFT, contentHash: null, deliveryRef: null, reason: null });
    expect(calls.map((c) => c.json)).toEqual([
      { kind: "discarded", at: AT },
      { kind: "released", at: AT, content_hash: await sha256Hex(DRAFT) },
    ]);
    await refused({ kind: "released", at: AT, content: null, contentHash: null }, /`released` carries the hash of the text/);
  });

  it("RFC 3339 by its fields, not by Date.parse: refuses dates an engine would roll over, accepts a leap second, a leap day and lower-case letters", async () => {
    for (const at of ["2026-02-30T10:00:00Z", "2026-09-31T10:00:00Z", "2026-09-16T24:00:00Z", "2026-09-16T10:60:00Z", "2026-09-16T10:00:00+24:00", "2025-02-29T10:00:00Z", "1900-02-29T10:00:00Z", "2026-09-16T10:00:00+23:60"]) {
      await refused({ kind: "discarded", at }, /`at` is required/);
    }
    const good = ["2016-12-31T23:59:60Z", "2024-02-29T10:00:00Z", "2000-02-29T10:00:00Z", "2026-09-16t10:00:00z", "2026-09-16T10:00:00.123-05:30", "2026-09-16T10:00:00-00:00", "2026-09-16T10:00:00+23:59"];
    const { fetch, calls } = fetchMock(recorded);
    const govern = makeClient(fetch);
    for (const at of good) await govern.reportOutcome(DECISION_ID, { kind: "discarded", at });
    expect(calls.map((c) => (c.json as { at: string }).at)).toEqual(good);
  });

  it("a hold message is never empty, on the client and on guard", async () => {
    const { fetch, calls } = fetchMock(recorded);
    for (const holdMessage of ["", "   "]) {
      expect(() => makeClient(fetch, { holdMessage }), JSON.stringify(holdMessage)).toThrow(GovernConfigError);
      await expect(makeClient(fetch).guard(() => DRAFT, { ...ctx, holdMessage }), JSON.stringify(holdMessage)).rejects.toThrow(/holdMessage/);
    }
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The adapters: released at write
// ---------------------------------------------------------------------------

type Middleware = ReturnType<typeof withGovern>;
type WrapGenerateArgs = Parameters<NonNullable<Middleware["wrapGenerate"]>>[0];
type WrapStreamArgs = Parameters<NonNullable<Middleware["wrapStream"]>>[0];
type GenerateResult = Awaited<ReturnType<WrapGenerateArgs["doGenerate"]>>;

const callParams = (anybioGovern: Record<string, unknown> = {}) =>
  ({ prompt: [], providerOptions: { anybioGovern: { conversationId: "conv-1", turnId: "turn-1", ...anybioGovern } } }) as unknown as LanguageModelCallOptions;

const generated = (text: string) =>
  ({ content: [{ type: "text", text }], finishReason: { unified: "stop", raw: "stop" }, usage: {}, warnings: [] }) as unknown as GenerateResult;

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

const generate = (middleware: Middleware, anybioGovern?: Record<string, unknown>) =>
  middleware.wrapGenerate!({
    doGenerate: async () => generated(DRAFT),
    doStream: async () => ({ stream: sourceStream(DRAFT) }),
    params: callParams(anybioGovern),
    model: {} as WrapGenerateArgs["model"],
  });

const streamed = async (middleware: Middleware, anybioGovern?: Record<string, unknown>) =>
  collect(
    (
      await middleware.wrapStream!({
        doStream: async () => ({ stream: sourceStream(DRAFT) }),
        doGenerate: async () => generated(DRAFT),
        params: callParams(anybioGovern),
        model: {} as WrapStreamArgs["model"],
      })
    ).stream,
  );

const chatModel = RunnableLambda.from(async (_input: string) => new AIMessage(DRAFT));

describe("every adapter path records released, with the hash of what it handed over, as it hands it over", () => {
  const allow = (audience: "patient" | "clinician" = "patient") => decisionView({ decision: "allow", audience });
  const hold = () => decisionView({ decision: "hold", reasons: ["prohibited_claim", "held_for_review"], review_state: "pending" });

  const cases: { name: string; view: () => ReturnType<typeof decisionView>; text: string; run: (govern: ReturnType<typeof makeClient>) => PromiseLike<unknown> }[] = [
    { name: "withGovern wrapGenerate, an allow", view: () => allow(), text: DRAFT, run: (govern) => generate(withGovern({ govern, ...ctx })) },
    { name: "withGovern wrapGenerate, a hold shown in session", view: hold, text: HOLD, run: (govern) => generate(withGovern({ govern, ...ctx })) },
    { name: "withGovern buffered stream, an allow", view: () => allow(), text: DRAFT, run: (govern) => streamed(withGovern({ govern, ...ctx })) },
    { name: "withGovern buffered stream, a hold shown in session", view: hold, text: HOLD, run: (govern) => streamed(withGovern({ govern, ...ctx })) },
    { name: "withGovern clinician stream, the streamed text", view: () => allow("clinician"), text: DRAFT, run: (govern) => streamed(withGovern({ govern, ...ctx, audience: "clinician" })) },
    { name: "governed, an allow", view: () => allow(), text: DRAFT, run: (govern) => governed(chatModel, { govern, ...ctx }).invoke("hello") },
    { name: "governed, a hold shown in session", view: hold, text: HOLD, run: (govern) => governed(chatModel, { govern, ...ctx }).invoke("hello") },
    {
      name: "GovernCallbackHandler with reportOutcome, the generation",
      view: () => allow(),
      text: DRAFT,
      run: (govern) => new GovernCallbackHandler({ govern, ...ctx, reportOutcome: true }).handleLLMEnd({ generations: [[{ text: DRAFT }]] }, "run-1"),
    },
  ];

  for (const { name, view, text, run } of cases) {
    it(name, async () => {
      const { fetch, calls, waitForCall } = fetchMock((call) => (call.url.pathname.endsWith("/outcome") ? jsonResponse(201, view()) : jsonResponse(200, view())));
      const govern = makeClient(fetch);
      const before = Date.now();
      await run(govern);
      await waitForCall("outcome");
      await govern.flushReports();
      const reports = outcomes(calls);
      expect(reports).toHaveLength(1);
      expect(reports[0]!.json).toEqual({ kind: "released", at: expect.any(String), content_hash: await sha256Hex(text) });
      // Never `delivered`: the channel has not confirmed anything yet.
      expect(reports[0]!.text).not.toContain("delivered");
      expect(Date.parse((reports[0]!.json as { at: string }).at)).toBeGreaterThanOrEqual(before - 1);
    });
  }

  it("a hold that handed over nothing is discarded, nothing_to_send, on withGovern and governed", async () => {
    const silent = () => decisionView({ decision: "hold", channel: "sms", reasons: ["prohibited_claim"], send_holding_line: false });
    for (const run of [
      (govern: ReturnType<typeof makeClient>) => generate(withGovern({ govern, ...ctx, channel: "sms" })),
      (govern: ReturnType<typeof makeClient>) => streamed(withGovern({ govern, ...ctx, channel: "sms" })),
      (govern: ReturnType<typeof makeClient>) => governed(chatModel, { govern, ...ctx, channel: "sms" }).invoke("hello"),
    ]) {
      const { fetch, calls, waitForCall } = fetchMock((call) => (call.url.pathname.endsWith("/outcome") ? jsonResponse(201, silent()) : jsonResponse(200, silent())));
      const govern = makeClient(fetch);
      await run(govern);
      await waitForCall("outcome");
      expect(outcomes(calls)[0]!.json).toEqual({ kind: "discarded", at: expect.any(String), reason: OUTCOME_REASONS.nothingToSend });
    }
  });

  it("a deliveredText answer is released with its own time and reference, and null is discarded, nothing_delivered", async () => {
    const answers = [{ text: "A line of our own.", deliveredAt: new Date(AT), deliveryRef: "call-1:line-2" }, null];
    const expected = [
      { kind: "released", at: "2026-09-16T10:00:00.000Z", content_hash: await sha256Hex("A line of our own."), delivery_ref: "call-1:line-2" },
      { kind: "discarded", at: expect.any(String), reason: OUTCOME_REASONS.nothingDelivered },
    ];
    for (const [index, answer] of answers.entries()) {
      const { fetch, calls, waitForCall } = fetchMock((call) => (call.url.pathname.endsWith("/outcome") ? recorded() : jsonResponse(200, decisionView())));
      await generate(withGovern({ govern: makeClient(fetch), ...ctx, deliveredText: () => answer }));
      await waitForCall("outcome");
      expect(outcomes(calls)[0]!.json).toEqual(expected[index]);
    }
  });

  it("the hook is skipped for a decision whose outcome state is set, whatever the state", async () => {
    for (const kind of ["released", "discarded", "failed", "superseded", "delivered"] as const) {
      const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView({ outcome: outcomeTrail([{ kind }]) })));
      let asked = 0;
      await generate(withGovern({ govern: makeClient(fetch), ...ctx, deliveredText: () => (asked++, DRAFT) }));
      await governed(chatModel, { govern: makeClient(fetch), ...ctx, deliveredText: () => (asked++, DRAFT) }).invoke("hello");
      await tick();
      expect(asked, kind).toBe(0);
      expect(outcomes(calls), kind).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// turnRef and supersedes
// ---------------------------------------------------------------------------

describe("turnRef and supersedes on the wire, from every entry point", () => {
  const sent = { turn_ref: "conv-1:turn-4", supersedes: [OTHER, THIRD] };
  const given = { turnRef: "conv-1:turn-4", supersedes: [OTHER, THIRD] };

  it("evaluate and guard send turn_ref and supersedes, and send neither without them", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView()));
    const govern = makeClient(fetch);
    await govern.evaluate({ ...ctx, turnId: "turn-1", content: DRAFT, ...given });
    await govern.guard(() => DRAFT, { ...ctx, turnId: "turn-2", ...given, retryOf: OTHER });
    await govern.evaluate({ ...ctx, turnId: "turn-3", content: DRAFT });
    await govern.guard(() => DRAFT, { ...ctx, turnId: "turn-4", turnRef: null, supersedes: [] });
    const bodies = evaluates(calls).map((c) => c.json as Record<string, unknown>);
    expect(bodies[0]).toMatchObject(sent);
    expect(bodies[1]).toMatchObject({ ...sent, retry_of: OTHER });
    for (const body of bodies.slice(2)) {
      expect(body).not.toHaveProperty("turn_ref");
      expect(body).not.toHaveProperty("supersedes");
    }
  });

  it("withGovern reads them per call from providerOptions.anybioGovern, beside retryOf, on generate and stream", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView()));
    const middleware = withGovern({ govern: makeClient(fetch), ...ctx, reportOutcome: false });
    await generate(middleware, given);
    await streamed(middleware, { ...given, turnId: "turn-2" });
    await generate(middleware, { turnId: "turn-3", turnRef: null, supersedes: null });
    const bodies = evaluates(calls).map((c) => c.json as Record<string, unknown>);
    expect(bodies[0]).toMatchObject(sent);
    expect(bodies[1]).toMatchObject(sent);
    expect(bodies[2]).not.toHaveProperty("turn_ref");
    expect(bodies[2]).not.toHaveProperty("supersedes");
  });

  it("governed reads them per call from configurable.anybioGovern, beside retryOf", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView()));
    const gated = governed(chatModel, { govern: makeClient(fetch), ...ctx, reportOutcome: false });
    await gated.invoke("hello", { configurable: { anybioGovern: { turnId: "turn-1", ...given } } });
    await gated.invoke("hello", { configurable: { anybioGovern: { turnId: "turn-2" } } });
    const bodies = evaluates(calls).map((c) => c.json as Record<string, unknown>);
    expect(bodies[0]).toMatchObject(sent);
    expect(bodies[1]).not.toHaveProperty("turn_ref");
  });

  it("a turnRef or a supersedes list the API could not read is refused before the draft is written or the model runs", async () => {
    const bad: Record<string, unknown>[] = [
      { turnRef: "" },
      { turnRef: "   " },
      { turnRef: 4 },
      { turnRef: "x".repeat(MAX_TURN_REF_CHARS + 1) },
      { supersedes: OTHER },
      { supersedes: ["turn-1"] },
      { supersedes: [OTHER, 7] },
      { supersedes: Array.from({ length: MAX_SUPERSEDES + 1 }, () => OTHER) },
    ];
    for (const fields of bad) {
      const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView()));
      const govern = makeClient(fetch);
      let drafted = 0;
      let modelRan = 0;
      const label = JSON.stringify(fields).slice(0, 60);
      await expect(govern.evaluate({ ...ctx, turnId: "turn-1", content: DRAFT, ...(fields as object) }), label).rejects.toBeInstanceOf(GovernConfigError);
      await expect(govern.guard(() => (drafted++, DRAFT), { ...ctx, ...(fields as object) }), label).rejects.toBeInstanceOf(GovernConfigError);
      const middleware = withGovern({ govern, ...ctx });
      await expect(
        middleware.wrapGenerate!({
          doGenerate: async () => (modelRan++, generated(DRAFT)),
          doStream: async () => ({ stream: sourceStream(DRAFT) }),
          params: callParams(fields),
          model: {} as WrapGenerateArgs["model"],
        }),
        label,
      ).rejects.toBeInstanceOf(GovernConfigError);
      const model = RunnableLambda.from(async (_input: string) => (modelRan++, new AIMessage(DRAFT)));
      await expect(governed(model, { govern, ...ctx }).invoke("hello", { configurable: { anybioGovern: fields } }), label).rejects.toBeInstanceOf(GovernConfigError);
      expect([drafted, modelRan, calls.length], label).toEqual([0, 0, 0]);
    }
  });

  it("accepts a turnRef at the bound, counted in code points, and supersedes at the bound", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView()));
    const govern = makeClient(fetch);
    const atBound = "\u{1F600}".repeat(MAX_TURN_REF_CHARS);
    const ids = Array.from({ length: MAX_SUPERSEDES }, (_, n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
    await govern.evaluate({ ...ctx, turnId: "turn-1", content: DRAFT, turnRef: atBound, supersedes: ids });
    expect(calls[0]!.json).toMatchObject({ turn_ref: atBound, supersedes: ids });
  });
});

describe("supersedes changes nothing in what the adapters report", () => {
  /** An attempt through its own middleware, its hook answered by the test. */
  async function attempt(govern: ReturnType<typeof makeClient>, turnId: string, answer: Promise<string | null>, anybioGovern: Record<string, unknown> = {}) {
    const middleware = withGovern({ govern, ...ctx, channel: "voice", deliveredText: () => answer });
    await middleware.wrapGenerate!({
      doGenerate: async () => generated(DRAFT),
      doStream: async () => ({ stream: sourceStream(DRAFT) }),
      params: callParams({ turnId, ...anybioGovern }),
      model: {} as WrapGenerateArgs["model"],
    });
  }

  function api(answer: "accepted" | "refused") {
    return fetchMock((call) => {
      if (call.url.pathname.endsWith("/outcome")) return recorded();
      const body = call.json as { turn_id: string };
      if (body.turn_id === "turn-1") return jsonResponse(200, decisionView({ channel: "voice" }));
      if (answer === "refused") return jsonResponse(409, { kind: "CONFLICT_ERROR", error_message: "a named decision was delivered" });
      return jsonResponse(200, decisionView({ decision_id: OTHER, turn_id: body.turn_id, channel: "voice" }));
    });
  }
  /** The reports sent, by decision id: two hashed concurrently may land in either order. */
  const sent = (calls: RecordedCall[]) =>
    outcomes(calls)
      .map((c) => [c.url.pathname.split("/").at(-2)!, (c.json as { kind: string }).kind])
      .sort(([a], [b]) => a!.localeCompare(b!));

  it("accepted: each decision's hook answer is its report, the superseded one included; the API adds superseded beside it", async () => {
    const { fetch, calls } = api("accepted");
    const govern = makeClient(fetch, { maxRetries: 0 });
    const speculative = deferred<string | null>();
    const confirmed = deferred<string | null>();
    await attempt(govern, "turn-1", speculative.promise, { turnRef: "turn-4" });
    await attempt(govern, "turn-1:a2", confirmed.promise, { turnRef: "turn-4", supersedes: [DECISION_ID] });
    // The speculative reply was written to the platform, which then dropped it.
    speculative.resolve(DRAFT);
    confirmed.resolve(DRAFT);
    await tick();
    await govern.flushReports();
    expect(sent(calls)).toEqual([
      [DECISION_ID, "released"],
      [OTHER, "released"],
    ]);
  });

  it("refused (a named decision was delivered): the turn holds, and the first decision's answer is its report", async () => {
    const { fetch, calls } = api("refused");
    const govern = makeClient(fetch, { maxRetries: 0 });
    const speculative = deferred<string | null>();
    await attempt(govern, "turn-1", speculative.promise);
    await attempt(govern, "turn-1:a2", Promise.resolve(DRAFT), { supersedes: [DECISION_ID] });
    speculative.resolve(DRAFT);
    await tick();
    await govern.flushReports();
    expect(sent(calls)).toEqual([[DECISION_ID, "released"]]);
  });
});

// ---------------------------------------------------------------------------
// A report an adapter made that did not land
// ---------------------------------------------------------------------------

describe("a failed adapter report reaches onError as a GovernReportError, the event as it was sent", () => {
  const unavailable = () => jsonResponse(503, { kind: "AXUM_ERROR", error_message: "unavailable" });

  it("released: the decision id, kind, at, the hash and the reference, and the transport's failure on cause; resending it is the same event", async () => {
    const errors: unknown[] = [];
    const { fetch, calls } = fetchMock((call) => (call.url.pathname.endsWith("/outcome") ? (outcomes(calls).length === 1 ? unavailable() : recorded()) : jsonResponse(200, decisionView())));
    const govern = makeClient(fetch, { maxRetries: 0 });
    // The hook answers at once; let its answer reach the report.
    await generate(withGovern({ govern, ...ctx, onError: (error) => errors.push(error), deliveredText: () => ({ text: DRAFT, deliveredAt: AT, deliveryRef: " chat-7 " }) }));
    await tick();
    await govern.flushReports();
    // No yield after the flush: the error has reached onError by then.
    expect(errors).toHaveLength(1);
    const error = errors[0] as GovernReportError;
    expect(error).toBeInstanceOf(GovernReportError);
    expect(error).toBeInstanceOf(GovernError);
    // As sent: the reference trimmed, the hash the request carried.
    expect(error).toMatchObject({ decisionId: DECISION_ID, kind: "released", at: AT, contentHash: await sha256Hex(DRAFT), deliveryRef: "chat-7", reason: null });
    expect(outcomes(calls)[0]!.json).toEqual({ kind: "released", at: AT, content_hash: error.contentHash, delivery_ref: "chat-7" });
    expect(error.cause).toBeInstanceOf(GovernApiError);
    expect((error.cause as GovernApiError).status).toBe(503);
    expect(error.message).not.toContain(DRAFT);
    // The caller sends the identical event again from the error alone.
    await govern.reportOutcome(error.decisionId, { kind: error.kind, at: error.at, contentHash: error.contentHash, deliveryRef: error.deliveryRef, reason: error.reason });
    const [first, again] = outcomes(calls);
    expect(again!.json).toEqual(first!.json);
  });

  it("flushReports resolves only after onError has run, while the failing response is still on its way at the flush", async () => {
    const order: string[] = [];
    const answer = deferred<Response>();
    const { fetch, waitForCall } = fetchMock((call) => (call.url.pathname.endsWith("/outcome") ? answer.promise : jsonResponse(200, decisionView())));
    const govern = makeClient(fetch, { maxRetries: 0 });
    await generate(withGovern({ govern, ...ctx, onError: () => order.push("onError") }));
    await waitForCall("outcome");
    const flushed = govern.flushReports().then(() => order.push("flushed"));
    answer.resolve(unavailable());
    await flushed;
    expect(order).toEqual(["onError", "flushed"]);
  });

  it("a field refused before sending reaches onFailure at once, with nothing awaited and nothing sent", async () => {
    const { fetch, calls } = fetchMock(recorded);
    const govern = makeClient(fetch);
    const failures: unknown[] = [];
    const done = govern.reportForAdapter(DECISION_ID, { kind: "discarded", at: "around noon", reason: " cancelled ", deliveryRef: "\u0085call-1 " }, (error) => failures.push(error));
    // Before anything is awaited.
    expect(failures).toHaveLength(1);
    const error = failures[0] as GovernReportError;
    expect(error).toBeInstanceOf(GovernReportError);
    // Nothing was sent, so the fields are as given, trimmed as the API trims them.
    expect(error).toMatchObject({ kind: "discarded", at: "around noon", contentHash: null, reason: "cancelled", deliveryRef: "call-1" });
    expect(error.cause).toBeInstanceOf(GovernConfigError);
    await done;
    await govern.flushReports();
    expect(calls).toHaveLength(0);
  });

  it("a kind outside the four names no event: onFailure gets the GovernConfigError itself", async () => {
    const { fetch, calls } = fetchMock(recorded);
    const govern = makeClient(fetch);
    const failures: unknown[] = [];
    await govern.reportForAdapter(DECISION_ID, { kind: "superseded" as ReportOutcomeInput["kind"], at: AT }, (error) => failures.push(error));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(GovernConfigError);
    expect(failures[0]).not.toBeInstanceOf(GovernReportError);
    expect(calls).toHaveLength(0);
  });

  it("flushReports started while the report's hash is still computing waits for the report and for onFailure", async () => {
    const order: string[] = [];
    const answer = deferred<Response>();
    const { fetch, waitForCall } = fetchMock(() => answer.promise);
    const govern = makeClient(fetch, { maxRetries: 0 });
    // The hash of the content is computed inside the report: nothing is on the wire yet.
    void govern.reportForAdapter(DECISION_ID, { kind: "released", at: AT, content: DRAFT }, () => order.push("onFailure"));
    const flushed = govern.flushReports().then(() => order.push("flushed"));
    await tick();
    expect(order).toEqual([]);
    // Once the request is out, the response is still held: the flush still waits.
    await waitForCall("outcome");
    await tick();
    expect(order).toEqual([]);
    answer.resolve(jsonResponse(503, { kind: "AXUM_ERROR", error_message: "unavailable" }));
    await flushed;
    expect(order).toEqual(["onFailure", "flushed"]);
  });

  it("a hook answer whose deliveryRef the API would refuse is the hook's slip: a GovernConfigError naming deliveredText, and no report", async () => {
    for (const deliveryRef of ["  ", "x".repeat(257), "line\nbreak", 7]) {
      const errors: unknown[] = [];
      const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView()));
      const govern = makeClient(fetch);
      await generate(withGovern({ govern, ...ctx, onError: (error) => errors.push(error), deliveredText: () => ({ text: DRAFT, deliveryRef: deliveryRef as string }) }));
      await tick();
      await govern.flushReports();
      expect(errors, String(deliveryRef)).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(GovernConfigError);
      expect((errors[0] as Error).message).toMatch(/^deliveredText must return/);
      expect(outcomes(calls)).toHaveLength(0);
    }
  });

  it("discarded: no hash, the SDK's reason, and an at that is the one sent; a 409 is its cause", async () => {
    const errors: unknown[] = [];
    const silent = () => decisionView({ decision: "hold", channel: "sms", reasons: ["prohibited_claim"], send_holding_line: false });
    const { fetch, calls } = fetchMock((call) =>
      call.url.pathname.endsWith("/outcome")
        ? jsonResponse(409, { kind: "CONFLICT_ERROR", error_message: "a different event of this kind is already recorded" })
        : jsonResponse(200, silent()),
    );
    const govern = makeClient(fetch, { maxRetries: 0 });
    await governed(chatModel, { govern, ...ctx, channel: "sms", onError: (error) => errors.push(error) }).invoke("hello");
    await govern.flushReports();
    const error = errors[0] as GovernReportError;
    expect(error).toBeInstanceOf(GovernReportError);
    expect(error).toMatchObject({ kind: "discarded", contentHash: null, reason: OUTCOME_REASONS.nothingToSend, deliveryRef: null });
    expect(error.at).toBe((outcomes(calls)[0]!.json as { at: string }).at);
    expect(error.cause).toBeInstanceOf(GovernConflictError);
  });

  it("the callback handler's report too, and a hook that throws still arrives as itself", async () => {
    const errors: unknown[] = [];
    const { fetch } = fetchMock((call) => (call.url.pathname.endsWith("/outcome") ? unavailable() : jsonResponse(200, decisionView())));
    const govern = makeClient(fetch, { maxRetries: 0 });
    await new GovernCallbackHandler({ govern, ...ctx, reportOutcome: true, onError: (error) => errors.push(error) }).handleLLMEnd({ generations: [[{ text: DRAFT }]] }, "run-1");
    const broken = new Error("the hook is broken");
    await generate(
      withGovern({
        govern,
        ...ctx,
        onError: (error) => errors.push(error),
        deliveredText: () => {
          throw broken;
        },
      }),
    );
    await tick();
    expect(errors[0]).toBeInstanceOf(GovernReportError);
    expect(errors[0]).toMatchObject({ kind: "released", contentHash: await sha256Hex(DRAFT) });
    expect(errors[1]).toBe(broken);
  });
});

describe("a deliveredText answer reads null as none", () => {
  it("deliveredAt and deliveryRef null are absent: the default at applies and no reference is sent", async () => {
    const errors: unknown[] = [];
    const { fetch, waitForCall } = fetchMock((call) => (call.url.pathname.endsWith("/outcome") ? recorded() : jsonResponse(200, decisionView())));
    await generate(withGovern({ govern: makeClient(fetch), ...ctx, onError: (error) => errors.push(error), deliveredText: () => ({ text: DRAFT, deliveredAt: null, deliveryRef: null }) }));
    const report = await waitForCall("outcome");
    expect(errors).toEqual([]);
    expect(report.json).toEqual({ kind: "released", at: expect.any(String), content_hash: await sha256Hex(DRAFT) });
  });
});

// ---------------------------------------------------------------------------
// The shutdown flush
// ---------------------------------------------------------------------------

describe("flushReports", () => {
  it("waits for every report on the wire, and resolves whether each was recorded or failed", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const { fetch } = fetchMock((call) => (call.url.pathname.includes(DECISION_ID) ? first.promise : second.promise));
    const govern = makeClient(fetch, { maxRetries: 0 });
    const a = govern.reportOutcome(DECISION_ID, { kind: "released", at: AT, content: DRAFT });
    const b = govern.reportOutcome(OTHER, { kind: "discarded", at: AT }).catch((error: unknown) => error);
    let flushed = false;
    const flush = govern.flushReports().then(() => (flushed = true));
    await tick();
    expect(flushed).toBe(false);
    first.resolve(recorded());
    await a;
    await tick();
    expect(flushed).toBe(false);
    second.resolve(jsonResponse(503, { kind: "AXUM_ERROR", error_message: "unavailable" }));
    await flush;
    expect(flushed).toBe(true);
    expect(await b).toBeInstanceOf(Error);
  });

  it("resolves at once with nothing on the wire", async () => {
    const { fetch } = fetchMock(recorded);
    await expect(makeClient(fetch).flushReports()).resolves.toBeUndefined();
  });

  it("covers a hook's report once the hook has answered and one macrotask has passed, and not a hook still unanswered", async () => {
    const report = deferred<Response>();
    const { fetch, calls } = fetchMock((call) => (call.url.pathname.endsWith("/outcome") ? report.promise : jsonResponse(200, decisionView())));
    const govern = makeClient(fetch, { maxRetries: 0 });
    const heard = deferred<string | null>();
    await generate(withGovern({ govern, ...ctx, deliveredText: () => heard.promise }));
    // Unanswered: there is nothing on the wire, so the flush does not wait for the hook.
    await expect(govern.flushReports()).resolves.toBeUndefined();
    heard.resolve(DRAFT);
    await new Promise((resolve) => setImmediate(resolve));
    let flushed = false;
    const flush = govern.flushReports().then(() => (flushed = true));
    await tick();
    // Registered before the hash is computed, so the flush waits for the report still on the wire.
    expect(flushed).toBe(false);
    report.resolve(recorded());
    await flush;
    expect(outcomes(calls)).toHaveLength(1);
  });
});
