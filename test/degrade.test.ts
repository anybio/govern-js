/**
 * What `guard` tells an operator when it could not get a decision.
 *
 * Both outcomes hold in enforce; that is not what these tests are about. They
 * are about the diagnosis. A stale application key and a gate outage are the
 * same hold and different work: one is fixed in the integration's
 * configuration and never heals on its own, the other heals on its own.
 */

import { describe, expect, it, vi } from "vitest";

import { TRANSIENT_HTTP_STATUSES, isClientMisconfiguration } from "../src/client";
import { GovernApiError, GovernNetworkError, GovernTimeoutError } from "../src/errors";
import { REASONS } from "../src/types";
import type { GovernEvent } from "../src/types";
import { DRAFT, HOLD, fetchMock, jsonResponse, makeClient } from "./helpers";

const ctx = { conversationId: "conv-1", channel: "web_chat" as const, audience: "patient" as const };

/** Run one `guard` against a responder, with retries off and timers driven. */
async function guardAgainst(
  responder: () => Response | Promise<Response>,
  extra: Record<string, unknown> = {},
) {
  vi.useFakeTimers();
  const events: GovernEvent[] = [];
  const { fetch } = fetchMock(responder);
  const govern = makeClient(fetch, { maxRetries: 0, onEvent: (e) => events.push(e), ...extra });
  const pending = govern.guard(() => DRAFT, ctx);
  await vi.advanceTimersByTimeAsync(60_000);
  return { reply: await pending, events };
}

describe("a refused call is the caller's configuration, not our availability", () => {
  for (const status of [401, 403]) {
    it(`${status} holds in enforce and says the client is misconfigured`, async () => {
      const { reply, events } = await guardAgainst(() =>
        jsonResponse(status, { kind: "FORBIDDEN_ERROR", error_message: "no" }),
      );
      // Unchanged: enforce still fails closed, and no draft reaches a patient.
      expect(reply.decision).toBe("hold");
      expect(reply.text).toBe(HOLD);
      expect(reply.degraded).toBe(true);
      expect(reply.decisionId).toBeNull();
      // Changed: the reason names the thing to go and look at.
      expect(reply.reasons).toEqual([REASONS.clientMisconfigured]);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "degraded",
          cause: REASONS.clientMisconfigured,
          status,
          mode: "enforce",
        }),
      );
    });
  }

  it("still fails open in observe, with the same diagnosis", async () => {
    const { reply, events } = await guardAgainst(
      () => jsonResponse(401, { kind: "UNAUTHORIZED_ERROR", error_message: "no" }),
      { assumeMode: "observe" },
    );
    expect(reply.decision).toBe("allow");
    expect(reply.text).toBe(DRAFT);
    expect(reply.degraded).toBe(true);
    expect(reply.reasons).toEqual([REASONS.clientMisconfigured]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "degraded", cause: REASONS.clientMisconfigured, mode: "observe" }),
    );
  });
});

describe("a failure that may heal is our availability", () => {
  it("503 holds in enforce and says the gate is unavailable", async () => {
    const { reply, events } = await guardAgainst(() =>
      jsonResponse(503, { kind: "SERVICE_UNAVAILABLE_ERROR", error_message: "gate down" }),
    );
    expect(reply.decision).toBe("hold");
    expect(reply.text).toBe(HOLD);
    expect(reply.degraded).toBe(true);
    expect(reply.reasons).toEqual([REASONS.gateUnavailable]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "degraded", cause: REASONS.gateUnavailable, status: 503 }),
    );
  });

  it("a timeout holds in enforce and says the gate is unavailable", async () => {
    const { reply, events } = await guardAgainst(() => new Promise<Response>(() => {}), {
      timeoutMs: 500,
    });
    expect(reply.decision).toBe("hold");
    expect(reply.text).toBe(HOLD);
    expect(reply.reasons).toEqual([REASONS.gateUnavailable]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "degraded", cause: REASONS.gateUnavailable, status: null }),
    );
  });

  it("a network failure holds in enforce and says the gate is unavailable", async () => {
    const { reply, events } = await guardAgainst(() => {
      throw new TypeError("fetch failed");
    });
    expect(reply.decision).toBe("hold");
    expect(reply.text).toBe(HOLD);
    expect(reply.reasons).toEqual([REASONS.gateUnavailable]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "degraded", cause: REASONS.gateUnavailable, status: null }),
    );
  });

  it("still fails open in observe", async () => {
    const { reply } = await guardAgainst(
      () => jsonResponse(503, { kind: "SERVICE_UNAVAILABLE_ERROR", error_message: "gate down" }),
      { assumeMode: "observe" },
    );
    expect(reply.decision).toBe("allow");
    expect(reply.text).toBe(DRAFT);
    expect(reply.degraded).toBe(true);
    expect(reply.reasons).toEqual([REASONS.gateUnavailable]);
  });
});

describe("the status boundary", () => {
  // The decision, in one table. A status is the caller's fault when the API
  // answered and the same call would be refused again. 408 and 429 are the
  // 4xx that say "later", so they belong with the outages.
  const cases: ReadonlyArray<[number, boolean]> = [
    [400, true],
    [401, true],
    [402, true],
    [403, true],
    [404, true],
    [405, true],
    [409, true],
    [413, true],
    [415, true],
    [422, true],
    [408, false],
    [429, false],
    [500, false],
    [502, false],
    [503, false],
    [504, false],
  ];

  for (const [status, permanent] of cases) {
    it(`${status} is ${permanent ? "the caller's" : "ours"}`, () => {
      const error = new GovernApiError({
        status,
        kind: null,
        serverMessage: null,
        retryable: status === 429 || status >= 500,
        retryAfterMs: null,
      });
      expect(isClientMisconfiguration(error)).toBe(permanent);
    });
  }

  it("the exported set is the 4xx exceptions, and only those", () => {
    expect([...TRANSIENT_HTTP_STATUSES].sort()).toEqual([408, 429]);
    for (const [status, permanent] of cases) {
      if (status < 500) expect(TRANSIENT_HTTP_STATUSES.has(status)).toBe(!permanent);
    }
  });

  it("a transport failure is never the caller's fault", () => {
    expect(isClientMisconfiguration(new GovernTimeoutError(500))).toBe(false);
    expect(isClientMisconfiguration(new GovernNetworkError("no route"))).toBe(false);
  });

  it("an error this version does not recognise is not blamed on the caller", () => {
    // Fail safe on the diagnosis: accusing a customer of a misconfiguration
    // they do not have costs more than saying we might be down.
    expect(isClientMisconfiguration(new TypeError("fetch failed"))).toBe(false);
    expect(isClientMisconfiguration("not even an error")).toBe(false);
  });
});
