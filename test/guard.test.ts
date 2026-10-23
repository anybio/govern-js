import { describe, expect, it, vi } from "vitest";

import { DEFAULT_HOLD_MESSAGE } from "../src/client";
import { GovernAbortError } from "../src/errors";
import type { GovernEvent } from "../src/types";
import { DECISION_ID, DRAFT, HOLD, decisionView, fetchMock, jsonResponse, makeClient, tick } from "./helpers";

const ctx = { conversationId: "conv-1", channel: "web_chat" as const, audience: "patient" as const };

describe("guard", () => {
  it("returns the draft on allow with the decision id and a working ack", async () => {
    const { fetch, calls } = fetchMock([
      () => jsonResponse(200, decisionView({ decision: "allow" })),
      () => jsonResponse(201, decisionView({ decision: "allow" })),
    ]);
    const govern = makeClient(fetch);
    const reply = await govern.guard(() => DRAFT, { ...ctx, turnId: "turn-1" });
    expect(reply.text).toBe(DRAFT);
    expect(reply.decision).toBe("allow");
    expect(reply.held).toBe(false);
    expect(reply.degraded).toBe(false);
    expect(reply.decisionId).toBe(DECISION_ID);
    expect(reply.mode).toBe("enforce");
    await reply.ack();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url.pathname).toBe(`/api/v1/govern/decisions/${DECISION_ID}/outcome`);
    expect(calls[1]!.json).toMatchObject({ delivered: true, delivered_content_hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(calls[1]!.text).not.toContain(DRAFT);
    await reply.ack();
    expect(calls).toHaveLength(2);
  });

  it("returns the hold message on hold and on block, never the draft", async () => {
    for (const verdict of ["hold", "block"] as const) {
      const { fetch } = fetchMock(() => jsonResponse(200, decisionView({ decision: verdict, deliverable_content: "rewritten" })));
      const govern = makeClient(fetch);
      const reply = await govern.guard(() => ({ text: DRAFT }), ctx);
      expect(reply.decision).toBe(verdict);
      expect(reply.held).toBe(true);
      expect(reply.text).toBe(HOLD);
      expect(reply.text).not.toContain("rewritten");
    }
  });

  it("uses the per-call hold message, then the client's, then the default", async () => {
    const { fetch } = fetchMock(() => jsonResponse(200, decisionView({ decision: "hold" })));
    const perCall = await makeClient(fetch).guard(() => DRAFT, { ...ctx, holdMessage: "Custom per call." });
    expect(perCall.text).toBe("Custom per call.");
    const defaulted = await makeClient(fetch, { holdMessage: undefined }).guard(() => DRAFT, ctx);
    expect(defaulted.text).toBe(DEFAULT_HOLD_MESSAGE);
  });

  it("returns the clinician deliverable content when the API provides one", async () => {
    const { fetch } = fetchMock(() =>
      jsonResponse(200, decisionView({ audience: "clinician", decision: "allow", deliverable_content: "substituted wording" })),
    );
    const govern = makeClient(fetch);
    const reply = await govern.guard(() => DRAFT, { ...ctx, audience: "clinician" });
    expect(reply.text).toBe("substituted wording");
    expect(reply.decision).toBe("allow");
  });

  it("fails closed when the API is unreachable and the mode is unknown (assumed enforce)", async () => {
    vi.useFakeTimers();
    const events: GovernEvent[] = [];
    const { fetch, calls } = fetchMock(() => {
      throw new TypeError("fetch failed");
    });
    const govern = makeClient(fetch, { maxRetries: 1, onEvent: (e) => events.push(e) });
    const pending = govern.guard(() => DRAFT, ctx);
    await vi.advanceTimersByTimeAsync(60_000);
    const reply = await pending;
    expect(calls).toHaveLength(2);
    expect(reply.decision).toBe("hold");
    expect(reply.text).toBe(HOLD);
    expect(reply.degraded).toBe(true);
    expect(reply.decisionId).toBeNull();
    expect(reply.mode).toBe("enforce");
    expect(reply.reasons).toEqual(["gate_unavailable"]);
    expect(events).toContainEqual(expect.objectContaining({ type: "degraded", mode: "enforce", modeSource: "assumed" }));
    await reply.ack();
    expect(calls).toHaveLength(2);
  });

  it("fails closed when the last known mode for the channel is enforce", async () => {
    vi.useFakeTimers();
    const events: GovernEvent[] = [];
    const { fetch } = fetchMock([
      () => jsonResponse(200, decisionView({ mode: "enforce" })),
      () => jsonResponse(500, { kind: "AXUM_ERROR", error_message: "boom" }),
    ]);
    // `assumeMode: "observe"` is what makes this a test of the learning. The
    // default assumption is enforce too, so with it the hold below arrives
    // whether the channel's mode was learned from the first turn or never
    // learned at all, and deleting the learning would not have failed
    // anything here.
    const govern = makeClient(fetch, { maxRetries: 0, assumeMode: "observe", onEvent: (e) => events.push(e) });
    await govern.guard(() => DRAFT, ctx);
    const pending = govern.guard(() => DRAFT, ctx);
    await vi.advanceTimersByTimeAsync(60_000);
    const reply = await pending;
    expect(reply.decision).toBe("hold");
    expect(reply.degraded).toBe(true);
    expect(reply.text).toBe(HOLD);
    expect(reply.mode).toBe("enforce");
    expect(events).toContainEqual(expect.objectContaining({ type: "degraded", mode: "enforce", modeSource: "learned" }));
  });

  it("fails open with degraded: true when the last known mode for the channel is observe", async () => {
    vi.useFakeTimers();
    const events: GovernEvent[] = [];
    const { fetch } = fetchMock([
      () => jsonResponse(202, decisionView({ mode: "observe", status: "pending" })),
      () => jsonResponse(201, decisionView({ mode: "observe" })),
      () => jsonResponse(503, { kind: "SERVICE_UNAVAILABLE_ERROR", error_message: "gate down" }),
    ]);
    const govern = makeClient(fetch, { maxRetries: 0, onEvent: (e) => events.push(e) });
    await govern.guard(() => DRAFT, { ...ctx, turnId: "turn-1" });
    const pending = govern.guard(() => DRAFT, { ...ctx, turnId: "turn-2" });
    await vi.advanceTimersByTimeAsync(60_000);
    const reply = await pending;
    expect(reply.decision).toBe("allow");
    expect(reply.text).toBe(DRAFT);
    expect(reply.degraded).toBe(true);
    expect(reply.mode).toBe("observe");
    expect(reply.decisionId).toBeNull();
    expect(events).toContainEqual(expect.objectContaining({ type: "degraded", mode: "observe", modeSource: "learned" }));
  });

  it("fails open when assumeMode is observe and nothing has been learned", async () => {
    vi.useFakeTimers();
    const { fetch } = fetchMock(() => {
      throw new TypeError("fetch failed");
    });
    const govern = makeClient(fetch, { maxRetries: 0, assumeMode: "observe" });
    const pending = govern.guard(() => DRAFT, ctx);
    await vi.advanceTimersByTimeAsync(60_000);
    const reply = await pending;
    expect(reply.decision).toBe("allow");
    expect(reply.degraded).toBe(true);
    expect(reply.text).toBe(DRAFT);
  });

  it("reports the previous turn as delivered with its hash when ack was not called", async () => {
    const { fetch, calls } = fetchMock([
      () => jsonResponse(200, decisionView({ decision_id: "11111111-1111-4111-8111-111111111111" })),
      () => jsonResponse(201, decisionView({ decision_id: "11111111-1111-4111-8111-111111111111" })),
      () => jsonResponse(200, decisionView({ decision_id: "22222222-2222-4222-8222-222222222222" })),
    ]);
    const govern = makeClient(fetch);
    const first = await govern.guard(() => DRAFT, { ...ctx, turnId: "turn-1" });
    expect(first.decisionId).toBe("11111111-1111-4111-8111-111111111111");
    const second = await govern.guard(() => "second draft", { ...ctx, turnId: "turn-2" });
    await tick();
    const outcomeCalls = calls.filter((c) => c.url.pathname.endsWith("/outcome"));
    expect(outcomeCalls).toHaveLength(1);
    expect(outcomeCalls[0]!.url.pathname).toBe("/api/v1/govern/decisions/11111111-1111-4111-8111-111111111111/outcome");
    expect(outcomeCalls[0]!.json).toMatchObject({ delivered: true, delivered_content_hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(outcomeCalls[0]!.text).not.toContain(DRAFT);
    // A late ack on the first reply is a no-op: it was already reported.
    await first.ack();
    expect(calls.filter((c) => c.url.pathname.endsWith("/outcome"))).toHaveLength(1);
    expect(second.decisionId).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("flushPendingAcks reports everything still held", async () => {
    const { fetch, calls } = fetchMock([
      () => jsonResponse(200, decisionView()),
      () => jsonResponse(201, decisionView()),
    ]);
    const govern = makeClient(fetch);
    await govern.guard(() => DRAFT, ctx);
    await govern.flushPendingAcks();
    expect(calls.filter((c) => c.url.pathname.endsWith("/outcome"))).toHaveLength(1);
  });

  it("does not register an ack when the channel is off", async () => {
    const { fetch, calls } = fetchMock(() =>
      jsonResponse(200, decisionView({ decision_id: null, status: "not_evaluated", mode: "off", reasons: ["not_evaluated"] })),
    );
    const govern = makeClient(fetch);
    const reply = await govern.guard(() => DRAFT, ctx);
    expect(reply.text).toBe(DRAFT);
    expect(reply.decisionId).toBeNull();
    await reply.ack();
    await govern.guard(() => DRAFT, ctx);
    expect(calls.filter((c) => c.url.pathname.endsWith("/outcome"))).toHaveLength(0);
  });

  it("rethrows an abort from the caller instead of degrading", async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetch } = fetchMock(() => jsonResponse(200, decisionView()));
    const govern = makeClient(fetch);
    await expect(govern.guard(() => DRAFT, { ...ctx, signal: controller.signal })).rejects.toBeInstanceOf(GovernAbortError);
  });
});
