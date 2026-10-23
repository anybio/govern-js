/**
 * A caller's callback cannot change a verdict.
 *
 * `onEvent` is telemetry. If a throw from it escapes, the caller with the
 * obvious shape — `try { const r = await guard(...); send(r.text) } catch {
 * send(draft) }` — fails open, which is the one thing this package exists to
 * prevent. These tests call `guard` with callbacks that throw at every point
 * the SDK emits an event and assert the verdict is the one the gate gave.
 */

import { describe, expect, it, vi } from "vitest";

import { REASONS } from "../src/types";
import type { GovernEvent } from "../src/types";
import { DRAFT, HOLD, decisionView, fetchMock, jsonResponse, makeClient, tick } from "./helpers";

const ctx = { conversationId: "conv-1", channel: "web_chat" as const, audience: "patient" as const };

/** A callback that throws on the named event types and records every event it is given. */
function throwingOn(...types: GovernEvent["type"][]) {
  const seen: GovernEvent[] = [];
  const onEvent = (event: GovernEvent): void => {
    seen.push(event);
    if (types.includes(event.type)) throw new Error(`caller's logger is broken on ${event.type}`);
  };
  return { onEvent, seen };
}

describe("a throwing onEvent cannot alter the decision", () => {
  it("a throw on the decision event leaves an allow an allow", async () => {
    const { onEvent, seen } = throwingOn("decision");
    const { fetch } = fetchMock(() => jsonResponse(200, decisionView({ decision: "allow" })));
    const govern = makeClient(fetch, { onEvent });
    const reply = await govern.guard(() => DRAFT, { ...ctx, turnId: "turn-1" });
    expect(reply.decision).toBe("allow");
    expect(reply.text).toBe(DRAFT);
    expect(reply.degraded).toBe(false);
    expect(reply.reasons).toEqual([]);
    expect(seen.some((e) => e.type === "decision")).toBe(true);
  });

  it("a throw on the degraded event still returns the hold, not a thrown error", async () => {
    vi.useFakeTimers();
    const { onEvent } = throwingOn("degraded");
    const { fetch } = fetchMock(() => {
      throw new TypeError("fetch failed");
    });
    const govern = makeClient(fetch, { maxRetries: 0, onEvent });
    const pending = govern.guard(() => DRAFT, ctx);
    await vi.advanceTimersByTimeAsync(60_000);
    const reply = await pending;
    expect(reply.decision).toBe("hold");
    expect(reply.text).toBe(HOLD);
    expect(reply.degraded).toBe(true);
    expect(reply.reasons).toEqual([REASONS.gateUnavailable]);
  });

  it("a throw on a transport event does not fail the request", async () => {
    const { onEvent } = throwingOn("request", "response", "retry");
    const { fetch } = fetchMock(() => jsonResponse(200, decisionView({ decision: "allow" })));
    const govern = makeClient(fetch, { onEvent });
    const decision = await govern.evaluate({
      conversationId: "conv-1",
      turnId: "turn-1",
      channel: "web_chat",
      audience: "patient",
      content: DRAFT,
    });
    expect(decision.decision).toBe("allow");
    expect(decision.degraded).toBe(false);
  });

  it("a throw on the outcome event does not fail the report", async () => {
    const { onEvent } = throwingOn("outcome");
    const { fetch, calls } = fetchMock([
      () => jsonResponse(200, decisionView({ decision: "allow" })),
      () => jsonResponse(201, decisionView({ decision: "allow" })),
    ]);
    const govern = makeClient(fetch, { onEvent });
    const reply = await govern.guard(() => DRAFT, { ...ctx, turnId: "turn-1" });
    await reply.ack();
    expect(calls[1]!.url.pathname).toContain("/outcome");
  });

  it("the throw is reported back as an error event the callback can log", async () => {
    const { onEvent, seen } = throwingOn("decision");
    const { fetch } = fetchMock(() => jsonResponse(200, decisionView({ decision: "allow" })));
    await makeClient(fetch, { onEvent }).guard(() => DRAFT, { ...ctx, turnId: "turn-1" });
    expect(seen).toContainEqual(
      expect.objectContaining({ type: "error", operation: "on_event", error: expect.stringContaining("broken") }),
    );
  });

  it("a callback that throws on everything, including its own failure report, is survivable", async () => {
    let calls = 0;
    const onEvent = (): never => {
      calls += 1;
      throw new Error("always");
    };
    const { fetch } = fetchMock(() => jsonResponse(200, decisionView({ decision: "hold" })));
    const reply = await makeClient(fetch, { onEvent }).guard(() => DRAFT, { ...ctx, turnId: "turn-1" });
    expect(reply.decision).toBe("hold");
    expect(reply.text).toBe(HOLD);
    // Bounded: one report per failure, never a recursion.
    expect(calls).toBeLessThan(20);
  });

  it("a throw from the auto-ack's own events does not lose the next turn's decision", async () => {
    const { onEvent } = throwingOn("outcome", "error");
    const { fetch, calls } = fetchMock([
      () => jsonResponse(200, decisionView({ decision_id: "11111111-1111-4111-8111-111111111111" })),
      () => jsonResponse(201, decisionView({ decision_id: "11111111-1111-4111-8111-111111111111" })),
      () => jsonResponse(200, decisionView({ decision_id: "22222222-2222-4222-8222-222222222222" })),
    ]);
    const govern = makeClient(fetch, { onEvent });
    await govern.guard(() => DRAFT, { ...ctx, turnId: "turn-1" });
    const second = await govern.guard(() => "second draft", { ...ctx, turnId: "turn-2" });
    await tick();
    expect(second.decisionId).toBe("22222222-2222-4222-8222-222222222222");
    expect(calls.filter((c) => c.url.pathname.endsWith("/outcome"))).toHaveLength(1);
  });
});
