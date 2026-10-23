import { describe, expect, it, vi } from "vitest";

import { GovernApiError, GovernConfigError, GovernConflictError } from "../src/errors";
import type { WireDecision } from "../src/types";
import { DECISION_ID, DRAFT, HOLD, decisionView, fetchMock, jsonResponse, makeClient, tick } from "./helpers";

const HANDOFF_ID = "9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a";

/** A decision view with the hand-off fields. */
function routedView(extra: Record<string, unknown>, overrides: Partial<WireDecision> = {}): WireDecision {
  return {
    ...decisionView(overrides),
    route_to_human: false,
    would_have_routed: false,
    inbound_flags: [],
    handoff: null,
    webhook_deliveries: [],
    ...extra,
  } as unknown as WireDecision;
}

const handoffRef = {
  id: HANDOFF_ID,
  state: "queued",
  version: 1,
  queue_label: "Care companion follow-up",
  assigned_to: null,
  due_at: "2026-09-17T01:00:00Z",
  escalation_due_at: null,
  resolved_at: null,
  automation_resumed_at: null,
  pauses_automation: true,
};

const ctx = { conversationId: "conv-1", channel: "web_chat" as const, audience: "patient" as const, patientRef: "patient-42" };
const inbound = { content: "I have chest pain", receivedAt: new Date("2026-09-17T00:00:00Z") };

describe("route to a person", () => {
  it("evaluate forwards the inbound and exposes routeToHuman, handoff and inboundFlags", async () => {
    const { fetch, calls } = fetchMock(() =>
      jsonResponse(200, routedView({ route_to_human: true, inbound_flags: [{ rule_id: "cardiac.chest_pain", category: "cardiac" }], handoff: handoffRef })),
    );
    const govern = makeClient(fetch);
    const decision = await govern.evaluate({ ...ctx, turnId: "turn-1", content: DRAFT, inbound });
    expect(calls[0]!.json).toMatchObject({
      patient_ref: "patient-42",
      inbound: { content: "I have chest pain", received_at: "2026-09-17T00:00:00.000Z" },
    });
    expect(decision.decision).toBe("allow");
    expect(decision.routeToHuman).toBe(true);
    expect(decision.wouldHaveRouted).toBe(false);
    expect(decision.inboundFlags).toEqual([{ ruleId: "cardiac.chest_pain", category: "cardiac" }]);
    expect(decision.handoff).toMatchObject({ id: HANDOFF_ID, state: "queued", version: 1, queueLabel: "Care companion follow-up" });
    expect(decision.degraded).toBe(false);
    expect(decision.unknownDecision).toBeNull();
  });

  it("a decision without the hand-off fields reads as not routed", async () => {
    const { fetch } = fetchMock(() => jsonResponse(200, decisionView()));
    const decision = await makeClient(fetch).evaluate({ ...ctx, turnId: "turn-1", content: DRAFT });
    expect(decision.routeToHuman).toBe(false);
    expect(decision.handoff).toBeNull();
    expect(decision.inboundFlags).toEqual([]);
  });

  it("guard delivers an allowed draft and surfaces the route", async () => {
    const { fetch, calls } = fetchMock([
      () => jsonResponse(200, routedView({ route_to_human: true, handoff: handoffRef, inbound_flags: [{ rule_id: "cardiac.chest_pain", category: "cardiac" }] })),
      () => jsonResponse(201, routedView({ route_to_human: true, handoff: handoffRef })),
    ]);
    const govern = makeClient(fetch);
    const result = await govern.guard(() => DRAFT, { ...ctx, turnId: "turn-1", inbound });
    expect(result.text).toBe(DRAFT);
    expect(result.decision).toBe("allow");
    expect(result.held).toBe(false);
    expect(result.routeToHuman).toBe(true);
    expect(result.handoff).toMatchObject({ id: HANDOFF_ID, state: "queued" });
    expect(result.inboundFlags).toEqual([{ ruleId: "cardiac.chest_pain", category: "cardiac" }]);
    expect(result.degraded).toBe(false);
    expect(calls[0]!.json).toMatchObject({ inbound: { content: "I have chest pain" } });
    await result.ack();
    expect(calls[1]!.url.pathname).toContain("/outcome");
  });

  it("guard delivers the hold message for a held draft and still surfaces the route", async () => {
    const { fetch } = fetchMock(() =>
      jsonResponse(200, routedView({ route_to_human: true, handoff: handoffRef }, { decision: "hold", reasons: ["prohibited_claim", "held_for_review"], review_state: "pending" })),
    );
    const govern = makeClient(fetch);
    const result = await govern.guard(() => DRAFT, { ...ctx, inbound });
    expect(result.text).toBe(HOLD);
    expect(result.decision).toBe("hold");
    expect(result.held).toBe(true);
    expect(result.routeToHuman).toBe(true);
    expect(result.handoff?.id).toBe(HANDOFF_ID);
    expect(result.reasons).toEqual(["prohibited_claim", "held_for_review"]);
  });

  it("a replay of the same turn is idempotent: same header, same body, same decision id and hand-off", async () => {
    const view = routedView({ route_to_human: true, handoff: handoffRef });
    const { fetch, calls } = fetchMock(() => jsonResponse(200, view));
    const govern = makeClient(fetch);
    const first = await govern.guard(() => DRAFT, { ...ctx, turnId: "turn-rf", inbound });
    const second = await govern.guard(() => DRAFT, { ...ctx, turnId: "turn-rf", inbound });
    const evaluates = calls.filter((c) => c.url.pathname.endsWith("/evaluate"));
    expect(evaluates).toHaveLength(2);
    expect(evaluates[0]!.headers.get("idempotency-key")).toBe("turn-rf");
    expect(evaluates[1]!.headers.get("idempotency-key")).toBe("turn-rf");
    expect(evaluates[1]!.json).toEqual(evaluates[0]!.json);
    expect(second.decisionId).toBe(first.decisionId);
    expect(second.handoff?.id).toBe(first.handoff?.id);
    expect(second.routeToHuman).toBe(true);
  });

  it("treats route_to_human as a decision value fail closed: hold message, route surfaced", async () => {
    const { fetch } = fetchMock(() => jsonResponse(200, routedView({ handoff: handoffRef }, { decision: "route_to_human" as WireDecision["decision"] })));
    const result = await makeClient(fetch).guard(() => DRAFT, ctx);
    expect(result.text).toBe(HOLD);
    expect(result.decision).toBe("route_to_human");
    expect(result.held).toBe(true);
    expect(result.routeToHuman).toBe(true);
    expect(result.degraded).toBe(false);
  });
});

describe("unknown decision values fail closed", () => {
  const unknown = "route_to_moon" as WireDecision["decision"];

  it("evaluate in enforce normalises to hold, flags degraded, keeps the raw value, and does not throw", async () => {
    const { fetch } = fetchMock(() => jsonResponse(200, decisionView({ decision: unknown, mode: "enforce" })));
    const decision = await makeClient(fetch).evaluate({ ...ctx, turnId: "turn-1", content: DRAFT });
    expect(decision.decision).toBe("hold");
    expect(decision.degraded).toBe(true);
    expect(decision.unknownDecision).toBe("route_to_moon");
    expect(decision.raw.decision).toBe("route_to_moon");
  });

  it("guard in enforce returns the hold message with unknown_decision in the reasons", async () => {
    const { fetch } = fetchMock(() => jsonResponse(200, decisionView({ decision: unknown, mode: "enforce", reasons: ["held_for_review"] })));
    const result = await makeClient(fetch).guard(() => DRAFT, ctx);
    expect(result.text).toBe(HOLD);
    expect(result.decision).toBe("hold");
    expect(result.degraded).toBe(true);
    expect(result.reasons).toEqual(["held_for_review", "unknown_decision"]);
    expect(result.decisionId).toBe(DECISION_ID);
  });

  it("evaluate and guard in observe return allow with degraded: true", async () => {
    const { fetch } = fetchMock(() => jsonResponse(202, decisionView({ decision: unknown, mode: "observe", status: "pending" })));
    const govern = makeClient(fetch);
    const decision = await govern.evaluate({ ...ctx, turnId: "turn-1", content: DRAFT });
    expect(decision.decision).toBe("allow");
    expect(decision.degraded).toBe(true);
    expect(decision.unknownDecision).toBe("route_to_moon");
    const result = await govern.guard(() => DRAFT, { ...ctx, turnId: "turn-2" });
    expect(result.text).toBe(DRAFT);
    expect(result.decision).toBe("allow");
    expect(result.degraded).toBe(true);
    expect(result.reasons).toContain("unknown_decision");
  });
});

describe("govern.handoffs", () => {
  const row = {
    id: HANDOFF_ID,
    organization_id: 1,
    environment_id: "1e2d3c4b-5a69-4788-9a0b-1c2d3e4f5a6b",
    application_id: "5f0e1d2c-3b4a-4968-8776-655443322110",
    patient_ref_hash: "ab".repeat(32),
    state: "queued",
    version: 3,
    queue_label: "Care companion follow-up",
    pauses_automation: true,
    reason: "route_to_human",
    created_at: "2026-09-17T00:00:00Z",
    updated_at: "2026-09-17T00:00:00Z",
  };

  it("list sends the query as the API spells it and maps the result", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, { environment_id: row.environment_id, items: [row], patient_names: {}, total: 1 }));
    const list = await makeClient(fetch).handoffs.list({ status: "queued", overdue: true, sort: "due", limit: 20, offset: 40 });
    const call = calls[0]!;
    expect(call.method).toBe("GET");
    expect(call.url.pathname).toBe("/api/v1/govern/handoffs");
    expect(Object.fromEntries(call.url.searchParams)).toEqual({ status: "queued", overdue: "true", sort: "due", limit: "20", offset: "40" });
    expect(list.total).toBe(1);
    expect(list.items[0]!.id).toBe(HANDOFF_ID);
    expect(list.patientNames).toEqual({});
  });

  it("get reads one hand-off with its events and decisions", async () => {
    const detail = { environment_id: row.environment_id, handoff: row, subject: { application_id: row.application_id, patient_ref_hash: row.patient_ref_hash }, events: [], decisions: [] };
    const { fetch, calls } = fetchMock(() => jsonResponse(200, detail));
    const out = await makeClient(fetch).handoffs.get(HANDOFF_ID);
    expect(calls[0]!.url.pathname).toBe(`/api/v1/govern/handoffs/${HANDOFF_ID}`);
    expect(out.handoff.id).toBe(HANDOFF_ID);
    expect(out.subject.application_id).toBe(row.application_id);
  });

  it("claim, contactAttempt, resolve and resume send expected_version and the action fields", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, { ...row, state: "claimed", version: 4 }));
    const handoffs = makeClient(fetch).handoffs;
    await handoffs.claim(HANDOFF_ID, { expectedVersion: 3 });
    await handoffs.contactAttempt(HANDOFF_ID, { expectedVersion: 4, outcome: "contacted", note: "Spoke with the patient", nextDueAt: new Date("2026-09-18T00:00:00Z") });
    await handoffs.resolve(HANDOFF_ID, { expectedVersion: 5, disposition: "follow_up_completed", note: "Advised to seek care", resumeAutomation: false });
    await handoffs.resume(HANDOFF_ID, { expectedVersion: 6, note: "Review complete" });
    expect(calls.map((c) => c.url.pathname)).toEqual([
      `/api/v1/govern/handoffs/${HANDOFF_ID}/claim`,
      `/api/v1/govern/handoffs/${HANDOFF_ID}/contact-attempt`,
      `/api/v1/govern/handoffs/${HANDOFF_ID}/resolve`,
      `/api/v1/govern/handoffs/${HANDOFF_ID}/resume`,
    ]);
    expect(calls[0]!.json).toEqual({ expected_version: 3 });
    expect(calls[1]!.json).toEqual({ expected_version: 4, outcome: "contacted", note: "Spoke with the patient", next_due_at: "2026-09-18T00:00:00.000Z" });
    expect(calls[2]!.json).toEqual({ expected_version: 5, disposition: "follow_up_completed", note: "Advised to seek care", resume_automation: false });
    expect(calls[3]!.json).toEqual({ expected_version: 6, note: "Review complete" });
  });

  it("maps 409 to GovernConflictError and does not retry an action", async () => {
    vi.useFakeTimers();
    const { fetch, calls } = fetchMock(() => jsonResponse(409, { kind: "CONFLICT_ERROR", error_message: "Follow-up changed; refresh before acting" }));
    const settled = makeClient(fetch)
      .handoffs.claim(HANDOFF_ID, { expectedVersion: 2 })
      .then(
        () => null,
        (error: unknown) => error,
      );
    await vi.advanceTimersByTimeAsync(30_000);
    const error = await settled;
    expect(error).toBeInstanceOf(GovernConflictError);
    expect(error).toBeInstanceOf(GovernApiError);
    expect((error as GovernConflictError).status).toBe(409);
    expect((error as GovernConflictError).kind).toBe("CONFLICT_ERROR");
    expect(calls).toHaveLength(1);
  });

  it("does not retry an action on 5xx either, and validates expectedVersion locally", async () => {
    vi.useFakeTimers();
    const { fetch, calls } = fetchMock(() => jsonResponse(503, { kind: "SERVICE_UNAVAILABLE_ERROR", error_message: "down" }));
    const handoffs = makeClient(fetch).handoffs;
    const settled = handoffs.resume(HANDOFF_ID, { expectedVersion: 1, note: "x" }).then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await settled).toBeInstanceOf(GovernApiError);
    expect(calls).toHaveLength(1);
    await expect(handoffs.claim(HANDOFF_ID, { expectedVersion: 1.5 })).rejects.toBeInstanceOf(GovernConfigError);
    expect(calls).toHaveLength(1);
  });

  it("a conflicting outcome report is also a GovernConflictError", async () => {
    const { fetch } = fetchMock(() => jsonResponse(409, { kind: "CONFLICT_ERROR", error_message: "an outcome is already recorded for this decision" }));
    await expect(makeClient(fetch).reportOutcome(DECISION_ID, { delivered: false })).rejects.toBeInstanceOf(GovernConflictError);
    await tick();
  });
});
