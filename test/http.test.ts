import { describe, expect, it, vi } from "vitest";

import { GovernNetworkError, GovernTimeoutError } from "../src/errors";
import { backoff, parseRetryAfter } from "../src/http";
import { DRAFT, decisionView, fetchMock, jsonResponse, makeClient } from "./helpers";

describe("parseRetryAfter", () => {
  it("reads seconds and HTTP dates and clamps to thirty seconds", () => {
    expect(parseRetryAfter("2")).toBe(2_000);
    expect(parseRetryAfter("0")).toBe(0);
    expect(parseRetryAfter("120")).toBe(30_000);
    const now = Date.parse("2026-09-16T00:00:00Z");
    expect(parseRetryAfter("Wed, 16 Sep 2026 00:00:05 GMT", now)).toBe(5_000);
    expect(parseRetryAfter("Tue, 15 Sep 2026 00:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("soon")).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
});

describe("backoff", () => {
  it("is full-jitter exponential and capped", () => {
    expect(backoff(1, () => 1)).toBe(250);
    expect(backoff(2, () => 1)).toBe(500);
    expect(backoff(3, () => 0.5)).toBe(500);
    expect(backoff(10, () => 1)).toBe(5_000);
    expect(backoff(1, () => 0)).toBe(0);
  });
});

describe("per-attempt timeout", () => {
  it("aborts a slow attempt, retries, and reports the retry's own failure without content", async () => {
    vi.useFakeTimers();
    const { fetch, calls } = fetchMock(
      (call) =>
        new Promise<Response>((resolve, reject) => {
          if (call.index === 0) {
            // never resolves; the SDK's timeout aborts it
            return;
          }
          if (call.index === 1) {
            reject(new TypeError("fetch failed"));
            return;
          }
          resolve(jsonResponse(200, decisionView()));
        }),
    );
    const govern = makeClient(fetch, { timeoutMs: 1_000, maxRetries: 1 });
    const settled = govern
      .evaluate({ conversationId: "c", turnId: "t", channel: "web_chat", audience: "patient", content: DRAFT })
      .then(
        () => null,
        (error: unknown) => error,
      );
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(10_000);
    const error = await settled;
    expect(calls).toHaveLength(2);
    // The first attempt times out and the second is refused by the network,
    // so the network error is the one that survives: the classification the
    // caller sees is the last attempt's, not the worst of them. A timeout on
    // every attempt is the next test.
    expect(error).toBeInstanceOf(GovernNetworkError);
    expect(error).not.toBeInstanceOf(GovernTimeoutError);
    expect((error as Error).message).not.toContain(DRAFT);
  });

  it("surfaces GovernTimeoutError when every attempt times out", async () => {
    vi.useFakeTimers();
    const { fetch } = fetchMock(() => new Promise<Response>(() => {}));
    const govern = makeClient(fetch, { timeoutMs: 500, maxRetries: 0 });
    const settled = govern
      .evaluate({ conversationId: "c", turnId: "t", channel: "web_chat", audience: "patient", content: DRAFT })
      .then(
        () => null,
        (error: unknown) => error,
      );
    await vi.advanceTimersByTimeAsync(600);
    const error = await settled;
    expect(error).toBeInstanceOf(GovernTimeoutError);
  });
});
