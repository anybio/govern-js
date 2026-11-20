import { describe, expect, it } from "vitest";

import { GovernAbortError, GovernConfigError } from "../src/errors";
import type { GovernEvent } from "../src/types";
import { DECISION_ID, DRAFT, HOLD, decisionView, deferred, fetchMock, jsonResponse, makeClient, tick } from "./helpers";

const ctx = { conversationId: "conv-1", channel: "web_chat" as const, audience: "patient" as const };

const aborted = (): AbortSignal => {
  const controller = new AbortController();
  controller.abort(new Error("gate budget spent"));
  return controller.signal;
};

const outcomes = (calls: { url: URL; json: unknown }[]) =>
  calls.filter((c) => c.url.pathname.endsWith("/outcome")).map((c) => ({ id: c.url.pathname.split("/").at(-2), ...(c.json as object) }));

describe("guard: gateSignal bounds the gate call and answers as an unreachable gate", () => {
  it("enforce, in session: aborted before the call, a hold with the hold message, no request, and the degraded event", async () => {
    const events: GovernEvent[] = [];
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView({ decision: "allow" })));
    const govern = makeClient(fetch, { onEvent: (event) => events.push(event) });
    const reply = await govern.guard(() => DRAFT, { ...ctx, turnId: "turn-1", gateSignal: aborted() });
    expect(reply).toMatchObject({
      text: HOLD,
      decision: "hold",
      held: true,
      degraded: true,
      decisionId: null,
      reasons: ["gate_unavailable"],
      sendHoldingLine: false,
      showHoldText: true,
      record: null,
    });
    expect(calls).toHaveLength(0);
    expect(events.filter((e) => e.type === "degraded")).toEqual([
      expect.objectContaining({ turnId: "turn-1", channel: "web_chat", mode: "enforce", modeSource: "assumed", cause: "gate_unavailable", status: null }),
    ]);
    // No decision, so there is nothing to report.
    await govern.flushReports();
    expect(calls).toHaveLength(0);
  });

  it("enforce, outbound: aborted during the request, no text, and no further attempt", async () => {
    const pending = deferred<Response>();
    const { fetch, calls, waitForCall } = fetchMock(() => pending.promise);
    const gate = new AbortController();
    const result = makeClient(fetch, { maxRetries: 2 }).guard(() => DRAFT, { ...ctx, channel: "sms", gateSignal: gate.signal });
    await waitForCall("evaluate");
    await tick();
    expect(calls).toHaveLength(1);
    gate.abort();
    const reply = await result;
    expect(reply).toMatchObject({ text: "", decision: "hold", degraded: true, showHoldText: false, reasons: ["gate_unavailable"] });
    await tick(5);
    expect(calls).toHaveLength(1);
  });

  it("aborted during the wait between attempts: one request, then the unavailable reply", async () => {
    const gate = new AbortController();
    const events: GovernEvent[] = [];
    const { fetch, calls } = fetchMock(() => jsonResponse(503, { kind: "UNAVAILABLE" }));
    const govern = makeClient(fetch, {
      maxRetries: 2,
      onEvent: (event) => {
        events.push(event);
        if (event.type === "retry") gate.abort();
      },
    });
    const reply = await govern.guard(() => DRAFT, { ...ctx, gateSignal: gate.signal });
    expect(reply).toMatchObject({ text: HOLD, degraded: true, reasons: ["gate_unavailable"] });
    expect(calls).toHaveLength(1);
    expect(events.filter((e) => e.type === "request")).toHaveLength(1);
  });

  it("observe: the draft, flagged degraded", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView()));
    const govern = makeClient(fetch);
    govern.rememberMode("web_chat", "observe");
    const reply = await govern.guard(() => DRAFT, { ...ctx, gateSignal: aborted() });
    expect(reply).toMatchObject({ text: DRAFT, decision: "allow", held: false, degraded: true, mode: "observe", reasons: ["gate_unavailable"] });
    expect(calls).toHaveLength(0);
  });

  it("does not bound the draft function: a slow draft still reaches the gate when the bound has not fired", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView({ decision: "allow" })));
    const gate = new AbortController();
    const draft = deferred<string>();
    const result = makeClient(fetch).guard(() => draft.promise, { ...ctx, gateSignal: gate.signal });
    await tick();
    draft.resolve(DRAFT);
    const reply = await result;
    expect(reply).toMatchObject({ text: DRAFT, decision: "allow", degraded: false });
    expect(calls).toHaveLength(1);
  });
});

describe("guard: the call's own signal keeps its rethrow and wins", () => {
  it("rethrows when only the call's signal fired, during the request", async () => {
    const pending = deferred<Response>();
    const { fetch, waitForCall } = fetchMock(() => pending.promise);
    const call = new AbortController();
    const result = makeClient(fetch).guard(() => DRAFT, { ...ctx, signal: call.signal, gateSignal: new AbortController().signal });
    await waitForCall("evaluate");
    call.abort();
    await expect(result).rejects.toBeInstanceOf(GovernAbortError);
  });

  it("rethrows when both fired, whichever fired first", async () => {
    const { fetch } = fetchMock(() => jsonResponse(200, decisionView()));
    const govern = makeClient(fetch);
    await expect(govern.guard(() => DRAFT, { ...ctx, signal: aborted(), gateSignal: aborted() })).rejects.toBeInstanceOf(GovernAbortError);
    const pending = deferred<Response>();
    const slow = fetchMock(() => pending.promise);
    const call = new AbortController();
    const gate = new AbortController();
    const result = makeClient(slow.fetch).guard(() => DRAFT, { ...ctx, signal: call.signal, gateSignal: gate.signal });
    await slow.waitForCall("evaluate");
    gate.abort();
    call.abort();
    await expect(result).rejects.toBeInstanceOf(GovernAbortError);
  });

  it("answers as an unreachable gate when only the gate bound fired and the call's signal is live", async () => {
    const pending = deferred<Response>();
    const { fetch, waitForCall } = fetchMock(() => pending.promise);
    const gate = new AbortController();
    const result = makeClient(fetch).guard(() => DRAFT, { ...ctx, signal: new AbortController().signal, gateSignal: gate.signal });
    await waitForCall("evaluate");
    gate.abort();
    await expect(result).resolves.toMatchObject({ degraded: true, reasons: ["gate_unavailable"] });
  });

  it("leaves no listener on either signal once the call is over", async () => {
    const counted = () => {
      const controller = new AbortController();
      const counts = { added: 0, removed: 0 };
      const { signal } = controller;
      const add = signal.addEventListener.bind(signal);
      const remove = signal.removeEventListener.bind(signal);
      signal.addEventListener = ((...args: Parameters<AbortSignal["addEventListener"]>) => {
        counts.added++;
        add(...args);
      }) as AbortSignal["addEventListener"];
      signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
        counts.removed++;
        remove(...args);
      }) as AbortSignal["removeEventListener"];
      return { signal, counts };
    };
    const call = counted();
    const gate = counted();
    const { fetch } = fetchMock(() => jsonResponse(200, decisionView({ decision: "allow" })));
    await makeClient(fetch).guard(() => DRAFT, { ...ctx, signal: call.signal, gateSignal: gate.signal });
    expect(gate.counts.added).toBeGreaterThan(0);
    expect(call.counts.removed).toBe(call.counts.added);
    expect(gate.counts.removed).toBe(gate.counts.added);
  });
});

describe("guard: gateSignal on a retry", () => {
  it("is an unreachable gate: the retry is never asked, and nothing is reported for either turn", async () => {
    const { fetch, calls } = fetchMock((call) => {
      if (call.url.pathname.endsWith("/outcome")) return jsonResponse(201, decisionView({ decision: "hold" }));
      return jsonResponse(200, decisionView({ decision: "hold", retryable: true }));
    });
    const govern = makeClient(fetch, { maxRetries: 0 });
    const held = await govern.guard(() => DRAFT, { ...ctx, turnId: "turn-1" });
    expect([held.showHoldText, held.text]).toEqual([true, HOLD]);
    const retry = await govern.guard(() => DRAFT, { ...ctx, turnId: "turn-1:r1", retryOf: DECISION_ID, gateSignal: aborted() });
    expect(retry).toMatchObject({ degraded: true, decisionId: null, reasons: ["gate_unavailable"] });
    await tick();
    // The retry was never asked: no request for it at all, and no report.
    expect(calls.filter((c) => c.url.pathname.endsWith("/evaluate"))).toHaveLength(1);
    expect(outcomes(calls)).toEqual([]);
  });
});

describe("guard: a value that is not a signal", () => {
  it("is refused with GovernConfigError before anything runs, alone or beside a real signal, naming the controller slip", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView()));
    const govern = makeClient(fetch);
    let drafted = 0;
    const draft = () => {
      drafted++;
      return DRAFT;
    };
    const controller = new AbortController() as unknown as AbortSignal;
    for (const bad of [
      { gateSignal: controller },
      { signal: controller },
      { signal: new AbortController().signal, gateSignal: controller },
      { signal: controller, gateSignal: new AbortController().signal },
    ]) {
      const error = await govern.guard(draft, { ...ctx, ...bad }).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(error, JSON.stringify(Object.keys(bad))).toBeInstanceOf(GovernConfigError);
      expect(error?.message).toContain("controller.signal");
    }
    const notAnything = await govern.guard(draft, { ...ctx, gateSignal: "soon" as unknown as AbortSignal }).catch((e: unknown) => e);
    expect(notAnything).toBeInstanceOf(GovernConfigError);
    expect(drafted).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("on a retry sends nothing", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView({ decision: "hold", retryable: true })));
    const govern = makeClient(fetch, { maxRetries: 0 });
    await govern.guard(() => DRAFT, { ...ctx, turnId: "turn-1" });
    const controller = new AbortController();
    await expect(
      govern.guard(() => DRAFT, {
        ...ctx,
        turnId: "turn-1:r1",
        retryOf: DECISION_ID,
        signal: controller.signal,
        gateSignal: controller as unknown as AbortSignal,
      }),
    ).rejects.toBeInstanceOf(GovernConfigError);
    expect(calls).toHaveLength(1);
  });
});

describe("guard: null is no signal", () => {
  it("in signal and in gateSignal, as on 0.2.2", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView({ decision: "allow" })));
    const reply = await makeClient(fetch).guard(() => DRAFT, {
      ...ctx,
      signal: null,
      gateSignal: null,
    });
    expect(reply).toMatchObject({ text: DRAFT, decision: "allow", degraded: false });
    expect(calls).toHaveLength(1);
  });
});
