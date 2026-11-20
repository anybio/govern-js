/**
 * The writes that land on the customer's account.
 *
 * Three properties, all about what the record says afterwards: a retried
 * write must not become two rows, an outcome report that failed reaches
 * the caller and is not made later in its place, and a decision the API
 * already holds an outcome for is not reported again.
 */

import { describe, expect, it, vi } from "vitest";

import { GovernReportError } from "../src/errors";
import type { WireOutcome, WirePatientState, WireTranscriptJob } from "../src/types";
import { GovernCallbackHandler } from "../src/langchain";
import { withGovern } from "../src/vercel-ai";
import { APPLICATION_ID, DECISION_ID, DRAFT, decisionView, fetchMock, jsonResponse, makeClient, outcomeTrail, tick } from "./helpers";

const ctx = { conversationId: "conv-1", channel: "web_chat" as const, audience: "patient" as const };

const JOB: WireTranscriptJob = {
  job_id: "8f14e45f-ceea-4167-a59c-bd9be9a7b1ff",
  application_id: APPLICATION_ID,
  status: "queued",
  total: 1,
  processed: 0,
  evaluated: 0,
  duplicate: 0,
  unavailable: 0,
  abandoned: 0,
  submitted_at: "2026-09-16T00:00:00Z",
  would_have: {},
};

const PATIENT_STATE: WirePatientState = {
  application_id: APPLICATION_ID,
  patient_ref_hash: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  consent_state: "granted",
  opted_out: false,
  events: [],
};

const TURNS = [
  {
    conversationId: "conv-1",
    turnId: "turn-1",
    channel: "sms" as const,
    audience: "patient" as const,
    content: DRAFT,
    sentAt: "2026-09-01T00:00:00Z",
  },
];

const serverError = () => jsonResponse(500, { kind: "AXUM_ERROR", error_message: "boom" });

/** Drive one call through a 500 and its retry. */
async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  const pending = run();
  await vi.advanceTimersByTimeAsync(30_000);
  return pending;
}

describe("a retried write does not double-write", () => {
  it("submitTranscripts sends the same idempotency key on every attempt", async () => {
    const { fetch, calls } = fetchMock([serverError, () => jsonResponse(202, JOB)]);
    const govern = makeClient(fetch, { maxRetries: 1 });
    const job = await withRetry(() => govern.submitTranscripts({ turns: TURNS }));
    expect(job.jobId).toBe(JOB.job_id);
    expect(calls).toHaveLength(2);
    const key = calls[0]!.headers.get("idempotency-key");
    // Without one, the 500-then-success opens a second job on the customer's
    // account: the exact thing the input field documents preventing.
    expect(key).toBeTruthy();
    expect(calls[1]!.headers.get("idempotency-key")).toBe(key);
  });

  it("an explicit idempotencyKey still wins", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(202, JOB));
    const govern = makeClient(fetch);
    await govern.submitTranscripts({ turns: TURNS, idempotencyKey: "batch-2026-09-01" });
    expect(calls[0]!.headers.get("idempotency-key")).toBe("batch-2026-09-01");
  });

  it("recordPatientConsent sends one too, the same on both attempts", async () => {
    const { fetch, calls } = fetchMock([serverError, () => jsonResponse(200, PATIENT_STATE)]);
    const govern = makeClient(fetch, { maxRetries: 1 });
    await withRetry(() => govern.recordPatientConsent({ patientRef: "patient-1", state: "granted" }));
    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers.get("idempotency-key")).toBeTruthy();
    expect(calls[1]!.headers.get("idempotency-key")).toBe(calls[0]!.headers.get("idempotency-key"));
  });

  it("recordPatientOptOut sends one too, and takes an explicit key", async () => {
    const { fetch, calls } = fetchMock([serverError, () => jsonResponse(200, PATIENT_STATE)]);
    const govern = makeClient(fetch, { maxRetries: 1 });
    await withRetry(() => govern.recordPatientOptOut({ patientRef: "patient-1", optedOut: true }));
    expect(calls[0]!.headers.get("idempotency-key")).toBeTruthy();
    expect(calls[1]!.headers.get("idempotency-key")).toBe(calls[0]!.headers.get("idempotency-key"));

    const second = fetchMock(() => jsonResponse(200, PATIENT_STATE));
    await makeClient(second.fetch).recordPatientOptOut({
      patientRef: "patient-1",
      optedOut: true,
      idempotencyKey: "opt-out-1",
    });
    expect(second.calls[0]!.headers.get("idempotency-key")).toBe("opt-out-1");
  });

  it("no key is ever in the API's reserved range", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(202, JOB));
    const govern = makeClient(fetch);
    await govern.submitTranscripts({ turns: TURNS });
    await govern.recordPatientConsent({ patientRef: "patient-1", state: "granted" });
    for (const call of calls) expect(call.headers.get("idempotency-key")).not.toMatch(/^govern:/);
  });

  it("an outcome report the transport retries is the same event: the same at, so the API answers it as a replay", async () => {
    const { fetch, calls } = fetchMock([serverError, () => jsonResponse(200, decisionView({ outcome: outcomeTrail() }))]);
    const govern = makeClient(fetch);
    // A given hash, so nothing runs off the fake clock before the first attempt.
    await withRetry(() => govern.reportOutcome(DECISION_ID, { kind: "released", at: new Date("2026-09-16T00:00:01Z"), contentHash: "a".repeat(64) }));
    expect(calls).toHaveLength(2);
    expect(calls[1]!.json).toEqual(calls[0]!.json);
    expect(calls[0]!.json).toMatchObject({ at: "2026-09-16T00:00:01.000Z" });
  });
});

describe("a failed outcome report is the caller's", () => {
  it("reaches the adapter's onError, and nothing reports the decision later", async () => {
    const errors: unknown[] = [];
    const { fetch, calls } = fetchMock([() => jsonResponse(200, decisionView()), serverError, () => jsonResponse(200, decisionView({ decision_id: "22222222-2222-4222-8222-222222222222" }))]);
    const govern = makeClient(fetch, { maxRetries: 0 });
    const middleware = withGovern({ govern, channel: "web_chat", audience: "patient", onError: (error) => errors.push(error) });
    await generate(middleware, "turn-1");
    await govern.flushReports();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(GovernReportError);
    expect(errors[0]).toMatchObject({ decisionId: DECISION_ID, kind: "released" });
    await govern.guard(() => "second draft", { ...ctx, turnId: "turn-2" });
    await govern.flushReports();
    expect(calls.filter((c) => c.url.pathname.endsWith("/outcome"))).toHaveLength(1);
  });
});

describe("a decision with an outcome already on record", () => {
  it("arms no holding line in a fresh process: the turn is already closed", async () => {
    const stopped = { decision: "hold" as const, channel: "sms" as const, reasons: ["prohibited_claim", "held_for_review"], review_state: "pending" as const, send_holding_line: true };
    const smsCtx = { conversationId: "conv-1", turnId: "turn-1", channel: "sms" as const, audience: "patient" as const };

    // The same stopped turn, first decided fresh: the holding line is owed.
    const fresh = fetchMock([() => jsonResponse(200, decisionView({ ...stopped }))]);
    const first = await makeClient(fresh.fetch, { maxRetries: 0 }).guard(() => DRAFT, smsCtx);
    expect(first.sendHoldingLine).toBe(true);

    // Process B replays it with an outcome on record: nothing is owed again.
    const replayed = fetchMock([() => jsonResponse(200, decisionView({ ...stopped, outcome: outcomeTrail([{ kind: "discarded" }]) }))]);
    const reply = await makeClient(replayed.fetch, { maxRetries: 0 }).guard(() => DRAFT, smsCtx);
    expect(reply.held).toBe(true);
    expect(reply.record?.outcome?.state).toBe("discarded");
    expect(reply.sendHoldingLine).toBe(false);
    expect(reply.showHoldText).toBe(false);
    expect(reply.text).toBe("");
  });

  it("reads the trail: its state and each event, camelCased, with the wire object on raw", async () => {
    const trail = outcomeTrail([
      { kind: "released", delivery_ref: "SM-1", hash_matches_release: true },
      { kind: "superseded", source: "retry", superseded_by: "22222222-2222-4222-8222-222222222222", at: "2026-09-16T00:00:03Z", recorded_at: "2026-09-16T00:00:03Z" },
    ]);
    const { fetch } = fetchMock(() => jsonResponse(200, decisionView({ outcome: trail })));
    const decision = await makeClient(fetch).getDecision(DECISION_ID);
    expect(decision.outcome).toEqual({
      state: "superseded",
      events: [
        {
          kind: "released",
          source: "caller",
          at: "2026-09-16T00:00:01Z",
          recordedAt: "2026-09-16T00:00:02Z",
          contentHash: "a".repeat(64),
          deliveryRef: "SM-1",
          reason: null,
          hashMatchesRelease: true,
          supersededBy: null,
          raw: trail.events[0],
        },
        {
          kind: "superseded",
          source: "retry",
          at: "2026-09-16T00:00:03Z",
          recordedAt: "2026-09-16T00:00:03Z",
          contentHash: null,
          deliveryRef: null,
          reason: null,
          hashMatchesRelease: null,
          supersededBy: "22222222-2222-4222-8222-222222222222",
          raw: trail.events[1],
        },
      ],
      raw: trail,
    });
  });

  it("an outcome without a state, from a server that predates the trail, reads as none; raw keeps it", async () => {
    const older = { delivered: true, delivered_at: "2026-09-16T00:00:01Z", recorded_at: "2026-09-16T00:00:02Z" };
    const { fetch } = fetchMock(() => jsonResponse(200, decisionView({ outcome: older as unknown as WireOutcome })));
    const decision = await makeClient(fetch).getDecision(DECISION_ID);
    expect(decision.outcome).toBeNull();
    expect(decision.raw.outcome).toEqual(older);
  });

  it("is skipped by the LangChain callback handler, which reports without guard", async () => {
    const { fetch, calls } = fetchMock([() => jsonResponse(200, decisionView({ decision_id: DECISION_ID, outcome: outcomeTrail() }))]);
    const errors: unknown[] = [];
    const handler = new GovernCallbackHandler({
      govern: makeClient(fetch, { maxRetries: 0 }),
      channel: "web_chat",
      audience: "patient",
      conversationId: "conv-1",
      reportOutcome: true,
      onError: (error) => errors.push(error),
    });
    await handler.handleLLMEnd({ generations: [[{ text: DRAFT }]] }, "run-1");
    expect(calls.map((c) => c.url.pathname)).toEqual(["/api/v1/govern/evaluate"]);
    expect(errors).toEqual([]);
  });

  it("is the same through the Vercel AI middleware: no report is posted for it", async () => {
    const { fetch, calls } = fetchMock([() => jsonResponse(200, decisionView({ decision_id: DECISION_ID, outcome: outcomeTrail() }))]);
    const middleware = withGovern({ govern: makeClient(fetch, { maxRetries: 0 }), channel: "web_chat", audience: "patient" });
    await generate(middleware, "turn-1");
    await tick();
    expect(calls.filter((c) => c.url.pathname.endsWith("/outcome"))).toHaveLength(0);
  });
});

/** One `wrapGenerate` call of the middleware on the draft, in conversation `conv-1`. */
async function generate(middleware: ReturnType<typeof withGovern>, turnId: string): Promise<void> {
  type Args = Parameters<NonNullable<typeof middleware.wrapGenerate>>[0];
  const generated = { content: [{ type: "text", text: DRAFT }], finishReason: { unified: "stop", raw: "stop" }, usage: {}, warnings: [] };
  await middleware.wrapGenerate!({
    doGenerate: async () => generated as unknown as Awaited<ReturnType<Args["doGenerate"]>>,
    doStream: async () => ({ stream: new ReadableStream() }) as unknown as Awaited<ReturnType<Args["doStream"]>>,
    params: { prompt: [], providerOptions: { anybioGovern: { conversationId: "conv-1", turnId } } } as unknown as Args["params"],
    model: {} as Args["model"],
  });
}

