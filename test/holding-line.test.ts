import { describe, expect, it, vi } from "vitest";

import { DECISION_ID, DRAFT, HOLD, decisionView, fetchMock, jsonResponse, makeClient } from "./helpers";

const ctx = { conversationId: "conv-1", channel: "web_chat" as const, audience: "patient" as const };

/** A patient-audience hold the API says owes a holding line. */
const armedHold = (overrides: Parameters<typeof decisionView>[0] = {}) =>
  decisionView({
    decision: "hold",
    reasons: ["prohibited_claim"],
    stop_class: "never_sendable",
    send_holding_line: true,
    review_state: "pending",
    ...overrides,
  });

describe("the holding line: at most one per decision", () => {
  it("the first hold arms it, with the stop class", async () => {
    const { fetch } = fetchMock(() => jsonResponse(200, armedHold()));
    const reply = await makeClient(fetch).guard(() => DRAFT, { ...ctx, turnId: "turn-1" });
    expect(reply.held).toBe(true);
    expect(reply.text).toBe(HOLD);
    expect(reply.sendHoldingLine).toBe(true);
    expect(reply.stopClass).toBe("never_sendable");
    expect(reply.record?.sendHoldingLine).toBe(true);
  });

  it("a replayed turnId does not re-arm it", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, armedHold()));
    const govern = makeClient(fetch);
    const first = await govern.guard(() => DRAFT, { ...ctx, turnId: "turn-1" });
    const replay = await govern.guard(() => DRAFT, { ...ctx, turnId: "turn-1" });
    expect(first.sendHoldingLine).toBe(true);
    expect(replay.decisionId).toBe(DECISION_ID);
    expect(replay.held).toBe(true);
    expect(replay.sendHoldingLine).toBe(false);
    // The API's own value is still there to read, unfiltered.
    expect(replay.record?.raw.send_holding_line).toBe(true);
    // The replay's flush reports the first turn's holding line as sent...
    const outcomes = calls.filter((c) => c.url.pathname.endsWith("/outcome"));
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.json).toMatchObject({ delivered: true });
    // ...and the replay itself is not queued as a second one: the decision is
    // already reported, so nothing more is written for it.
    await govern.flushPendingAcks();
    expect(calls.filter((c) => c.url.pathname.endsWith("/outcome"))).toHaveLength(1);
  });

  it("guard and evaluate send model and modelVersion, and drop blanks", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView()));
    const govern = makeClient(fetch);
    await govern.guard(() => DRAFT, { ...ctx, model: "gpt-4o", modelVersion: "gpt-4o-2024-08-06" });
    expect(calls[0]!.json).toMatchObject({ model: "gpt-4o", model_version: "gpt-4o-2024-08-06" });
    await govern.evaluate({ ...ctx, turnId: "turn-2", content: DRAFT, model: "  ", modelVersion: "" });
    expect(calls.at(-1)!.json).not.toHaveProperty("model");
    expect(calls.at(-1)!.json).not.toHaveProperty("model_version");
    await govern.evaluate({ ...ctx, turnId: "turn-3", content: DRAFT });
    expect(calls.at(-1)!.json).not.toHaveProperty("model");
  });

  it("a getDecision or an evaluate replay after the same hold does not re-arm it", async () => {
    const { fetch } = fetchMock(() => jsonResponse(200, armedHold()));
    const govern = makeClient(fetch);
    const input = { ...ctx, turnId: "turn-1", content: DRAFT };
    expect((await govern.evaluate(input)).sendHoldingLine).toBe(true);
    expect((await govern.getDecision(DECISION_ID)).sendHoldingLine).toBe(false);
    expect((await govern.evaluate(input)).sendHoldingLine).toBe(false);
  });

  it("each new decision has its own answer", async () => {
    const { fetch } = fetchMock([
      () => jsonResponse(200, armedHold()),
      () => jsonResponse(200, armedHold({ decision_id: "1b7c8f1e-2a3b-4c5d-8e9f-0a1b2c3d4e5f", turn_id: "turn-2" })),
    ]);
    const govern = makeClient(fetch);
    expect((await govern.evaluate({ ...ctx, turnId: "turn-1", content: DRAFT })).sendHoldingLine).toBe(true);
    expect((await govern.evaluate({ ...ctx, turnId: "turn-2", content: DRAFT })).sendHoldingLine).toBe(true);
  });

  it("a released or rejected hold never arms it, even if a server says so", async () => {
    for (const review_state of ["released", "rejected"] as const) {
      const { fetch } = fetchMock(() => jsonResponse(200, armedHold({ review_state, released_content: "reviewed" })));
      const govern = makeClient(fetch);
      expect((await govern.getDecision(DECISION_ID)).sendHoldingLine).toBe(false);
      const reply = await govern.guard(() => DRAFT, { ...ctx, turnId: "turn-1" });
      expect(reply.sendHoldingLine).toBe(false);
    }
  });

  it("patient_state_unavailable never arms it, and on an outbound channel the auto-ack records nothing sent", async () => {
    const { fetch, calls } = fetchMock(() =>
      jsonResponse(
        200,
        armedHold({
          status: "unavailable",
          reasons: ["gate_unavailable", "patient_state_unavailable"],
          stop_class: "uncertain",
          policy: null,
        }),
      ),
    );
    const govern = makeClient(fetch);
    const reply = await govern.guard(() => DRAFT, { ...ctx, channel: "sms", turnId: "turn-1" });
    expect(reply.held).toBe(true);
    expect(reply.sendHoldingLine).toBe(false);
    expect(reply.showHoldText).toBe(false);
    expect(reply.text).toBe("");
    expect(reply.reasons).toContain("patient_state_unavailable");
    await govern.flushPendingAcks();
    const outcome = calls.find((c) => c.url.pathname.endsWith("/outcome"));
    expect(outcome?.json).toMatchObject({ delivered: false });
    expect(outcome?.json).not.toHaveProperty("delivered_content_hash");
  });

  it("the stops that mean do-not-message never arm it", async () => {
    for (const reason of ["opted_out", "consent_missing", "consent_revoked", "frequency_cap"]) {
      const { fetch } = fetchMock(() => jsonResponse(200, armedHold({ decision: "block", reasons: [reason] })));
      const reply = await makeClient(fetch).guard(() => DRAFT, ctx);
      expect(reply.sendHoldingLine, reason).toBe(false);
    }
  });

  it("an allow, a clinician audience or an absent flag never arms it", async () => {
    const cases = [
      decisionView({ decision: "allow", send_holding_line: true }),
      armedHold({ audience: "clinician" }),
      decisionView({ decision: "hold", reasons: ["review_required"] }),
    ];
    for (const view of cases) {
      const { fetch } = fetchMock(() => jsonResponse(200, view));
      const reply = await makeClient(fetch).guard(() => DRAFT, { ...ctx, audience: view.audience });
      expect(reply.sendHoldingLine).toBe(false);
    }
  });

  it("an SDK-side fail-closed hold does not arm it: no patient state was read", async () => {
    vi.useFakeTimers();
    try {
      const { fetch } = fetchMock(() => {
        throw new TypeError("fetch failed");
      });
      const pending = makeClient(fetch, { maxRetries: 0 }).guard(() => DRAFT, ctx);
      await vi.advanceTimersByTimeAsync(10_000);
      const reply = await pending;
      expect(reply.held).toBe(true);
      expect(reply.degraded).toBe(true);
      expect(reply.sendHoldingLine).toBe(false);
      expect(reply.stopClass).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("an outcome report counts as having seen the decision", async () => {
    const { fetch } = fetchMock([() => jsonResponse(200, armedHold()), () => jsonResponse(200, armedHold())]);
    const govern = makeClient(fetch);
    const reported = await govern.reportOutcome(DECISION_ID, { delivered: true, content: HOLD });
    expect(reported.sendHoldingLine).toBe(false);
    expect((await govern.getDecision(DECISION_ID)).sendHoldingLine).toBe(false);
  });

  it("the memory is bounded", async () => {
    const { fetch } = fetchMock((call) => {
      const id = call.url.pathname.split("/").pop()!;
      return jsonResponse(200, armedHold({ decision_id: id }));
    });
    const govern = makeClient(fetch);
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    expect((await govern.getDecision(id(0))).sendHoldingLine).toBe(true);
    for (let n = 1; n <= 10_000; n++) await govern.getDecision(id(n));
    // The oldest id was evicted, so an instance that has seen more than the
    // bound can arm it again: the documented reason a multi-process or
    // long-lived application records the send itself.
    expect((await govern.getDecision(id(0))).sendHoldingLine).toBe(true);
  });
});

describe("the decision view's new fields", () => {
  it("maps stop_class, model and model_version, and reads an unknown class as uncertain", async () => {
    const { fetch } = fetchMock([
      () => jsonResponse(200, armedHold({ stop_class: "uncertain", model: "gpt-4o", model_version: "gpt-4o-2024-08-06" })),
      () => jsonResponse(200, armedHold({ stop_class: "some_future_class" as never })),
      () => jsonResponse(200, decisionView()),
    ]);
    const govern = makeClient(fetch);
    const first = await govern.getDecision(DECISION_ID);
    expect(first.stopClass).toBe("uncertain");
    expect(first.model).toBe("gpt-4o");
    expect(first.modelVersion).toBe("gpt-4o-2024-08-06");
    expect((await govern.getDecision(DECISION_ID)).stopClass).toBe("uncertain");
    const allowed = await govern.getDecision(DECISION_ID);
    expect(allowed.stopClass).toBeNull();
    expect(allowed.model).toBeNull();
    expect(allowed.modelVersion).toBeNull();
    expect(allowed.sendHoldingLine).toBe(false);
  });
});
