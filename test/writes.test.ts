/**
 * The writes that land on the customer's account.
 *
 * Two properties, both about what the record says afterwards: a retried write
 * must not become two rows, and an outcome the SDK failed to report must not
 * be marked as reported.
 */

import { describe, expect, it, vi } from "vitest";

import type { GovernEvent, WirePatientState, WireTranscriptJob } from "../src/types";
import { APPLICATION_ID, DECISION_ID, DRAFT, decisionView, deferred, fetchMock, jsonResponse, makeClient, tick } from "./helpers";

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
});

describe("a failed auto-ack is not a reported outcome", () => {
  it("keeps the pending outcome so a later flush still reports it", async () => {
    const events: GovernEvent[] = [];
    const { fetch, calls } = fetchMock([
      () => jsonResponse(200, decisionView()),
      serverError,
      () => jsonResponse(201, decisionView()),
    ]);
    const govern = makeClient(fetch, { maxRetries: 0, onEvent: (e) => events.push(e) });
    await govern.guard(() => DRAFT, { ...ctx, turnId: "turn-1" });

    await govern.flushPendingAcks();
    expect(events).toContainEqual(expect.objectContaining({ type: "error", operation: "auto_ack" }));

    // The write never landed, so the outcome is still owed.
    await govern.flushPendingAcks();
    expect(calls.filter((c) => c.url.pathname.endsWith("/outcome"))).toHaveLength(2);
  });

  it("does not suppress the caller's own ack when the auto-ack failed", async () => {
    const { fetch, calls } = fetchMock([
      () => jsonResponse(200, decisionView({ decision_id: DECISION_ID })),
      serverError,
      () => jsonResponse(200, decisionView({ decision_id: "22222222-2222-4222-8222-222222222222" })),
      () => jsonResponse(201, decisionView({ decision_id: DECISION_ID })),
    ]);
    const govern = makeClient(fetch, { maxRetries: 0 });
    const first = await govern.guard(() => DRAFT, { ...ctx, turnId: "turn-1" });
    // The next turn flushes the first one's outcome, and the write fails.
    await govern.guard(() => "second draft", { ...ctx, turnId: "turn-2" });
    expect(calls.filter((c) => c.url.pathname.endsWith("/outcome"))).toHaveLength(1);

    await first.ack();
    const outcomes = calls.filter((c) => c.url.pathname.endsWith("/outcome"));
    expect(outcomes).toHaveLength(2);
    expect(outcomes[1]!.url.pathname).toContain(DECISION_ID);
  });

  // The known residual, pinned rather than papered over. A conversation holds
  // one pending outcome, on purpose: the map is bounded, and the alternative
  // is a per-conversation queue that grows during exactly the outage that
  // fills it. So when an auto-ack fails and a newer turn has already taken
  // the slot, the older outcome is dropped. It costs a row in the audit
  // trail, never a verdict or a line of returned text, and `ack()` (which
  // every adapter calls for you) still reports it. If that trade ever stops
  // being the right one, this test is the one to change.
  it("drops an auto-ack that failed while a newer turn held the slot, and leaves it to ack()", async () => {
    const SECOND = "22222222-2222-4222-8222-222222222222";
    const stalled = deferred<Response>();
    const events: GovernEvent[] = [];
    const { fetch, calls } = fetchMock([
      () => jsonResponse(200, decisionView({ decision_id: DECISION_ID })),
      () => stalled.promise,
      () => jsonResponse(200, decisionView({ decision_id: SECOND })),
      () => jsonResponse(201, decisionView({ decision_id: SECOND })),
      () => jsonResponse(201, decisionView({ decision_id: DECISION_ID })),
    ]);
    const govern = makeClient(fetch, { maxRetries: 0, onEvent: (e) => events.push(e) });
    const first = await govern.guard(() => DRAFT, { ...ctx, turnId: "turn-1" });
    // The second turn starts the first one's outcome write, and finishes
    // before that write comes back: the slot is the second turn's now.
    await govern.guard(() => "second draft", { ...ctx, turnId: "turn-2" });
    stalled.resolve(jsonResponse(500, { kind: "AXUM_ERROR", error_message: "boom" }));
    await tick();
    expect(events).toContainEqual(expect.objectContaining({ type: "error", operation: "auto_ack" }));

    // A later flush reports the second turn and nothing else: the first
    // turn's outcome was not re-queued behind it.
    await govern.flushPendingAcks();
    const outcomes = calls.filter((c) => c.url.pathname.endsWith("/outcome")).map((c) => c.url.pathname);
    expect(outcomes.filter((p) => p.includes(SECOND))).toHaveLength(1);
    expect(outcomes.filter((p) => p.includes(DECISION_ID))).toHaveLength(1);

    // And the route that always works: the caller's own ack still reports it.
    await first.ack();
    expect(calls.filter((c) => c.url.pathname.includes(DECISION_ID) && c.url.pathname.endsWith("/outcome"))).toHaveLength(2);
  });

  it("still reports each outcome exactly once when the writes do land", async () => {
    const { fetch, calls } = fetchMock([
      () => jsonResponse(200, decisionView({ decision_id: DECISION_ID })),
      () => jsonResponse(201, decisionView({ decision_id: DECISION_ID })),
      () => jsonResponse(200, decisionView({ decision_id: "22222222-2222-4222-8222-222222222222" })),
    ]);
    const govern = makeClient(fetch);
    const first = await govern.guard(() => DRAFT, { ...ctx, turnId: "turn-1" });
    await govern.guard(() => "second draft", { ...ctx, turnId: "turn-2" });
    // The first turn was already auto-acked, so the caller's late ack is a
    // no-op; the second turn's outcome is reported by the flush.
    await first.ack();
    await govern.flushPendingAcks();
    expect(calls.filter((c) => c.url.pathname.endsWith("/outcome")).map((c) => c.url.pathname)).toEqual([
      `/api/v1/govern/decisions/${DECISION_ID}/outcome`,
      "/api/v1/govern/decisions/22222222-2222-4222-8222-222222222222/outcome",
    ]);
  });
});
