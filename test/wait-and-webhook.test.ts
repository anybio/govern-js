import { describe, expect, it, vi } from "vitest";

import { GovernAbortError, GovernConfigError, GovernWebhookError } from "../src/errors";
import { handleWebhook, signWebhookPayload, verifyWebhookSignature } from "../src/webhook";
import { DECISION_ID, decisionView, fetchMock, jsonResponse, makeClient } from "./helpers";

const SECRET = "whsec_000000000000000000000000000000000000000000000000";

describe("waitForRelease", () => {
  it("resolves released with the content", async () => {
    vi.useFakeTimers();
    const { fetch, calls } = fetchMock([
      () => jsonResponse(200, decisionView({ decision: "hold", review_state: "pending" })),
      () => jsonResponse(200, decisionView({ decision: "hold", review_state: "pending" })),
      () => jsonResponse(200, decisionView({ decision: "hold", review_state: "released", released_content: "the reviewed text" })),
    ]);
    const govern = makeClient(fetch);
    const pending = govern.waitForRelease(DECISION_ID, { intervalMs: 1_000, maxIntervalMs: 4_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await pending;
    expect(result).toMatchObject({ state: "released", content: "the reviewed text" });
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.method === "GET" && c.url.pathname === `/api/v1/govern/decisions/${DECISION_ID}`)).toBe(true);
  });

  it("resolves rejected", async () => {
    const { fetch } = fetchMock(() => jsonResponse(200, decisionView({ decision: "hold", review_state: "rejected" })));
    const govern = makeClient(fetch);
    const result = await govern.waitForRelease(DECISION_ID);
    expect(result).toMatchObject({ state: "rejected" });
  });

  it("resolves not_held for an allowed decision and blocked for a block no reviewer can lift", async () => {
    const allowed = makeClient(fetchMock(() => jsonResponse(200, decisionView({ decision: "allow" }))).fetch);
    expect(await allowed.waitForRelease(DECISION_ID)).toMatchObject({ state: "not_held" });
    const blocked = makeClient(fetchMock(() => jsonResponse(200, decisionView({ decision: "block", reasons: ["opted_out"] }))).fetch);
    expect(await blocked.waitForRelease(DECISION_ID)).toMatchObject({ state: "blocked" });
  });

  it("resolves null when the timeout elapses", async () => {
    vi.useFakeTimers();
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView({ decision: "hold", review_state: "pending" })));
    const govern = makeClient(fetch);
    const pending = govern.waitForRelease(DECISION_ID, { timeoutMs: 5_000, intervalMs: 1_000, maxIntervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toBeNull();
    expect(calls.length).toBeGreaterThanOrEqual(5);
    expect(calls.length).toBeLessThanOrEqual(7);
  });

  it("throws GovernAbortError when the signal fires", async () => {
    vi.useFakeTimers();
    const { fetch } = fetchMock(() => jsonResponse(200, decisionView({ decision: "hold", review_state: "pending" })));
    const govern = makeClient(fetch);
    const controller = new AbortController();
    const pending = govern.waitForRelease(DECISION_ID, { signal: controller.signal, intervalMs: 60_000 });
    const settled = pending.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    expect(await settled).toBeInstanceOf(GovernAbortError);
  });

  it("is woken early by a verified webhook for the same decision", async () => {
    vi.useFakeTimers();
    const { fetch, calls } = fetchMock([
      () => jsonResponse(200, decisionView({ decision: "hold", review_state: "pending" })),
      () => jsonResponse(200, decisionView({ decision: "hold", review_state: "released", released_content: "released" })),
    ]);
    const govern = makeClient(fetch);
    const pending = govern.waitForRelease(DECISION_ID, { intervalMs: 60_000 });
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toHaveLength(1);
    const body = JSON.stringify({
      id: "d1",
      event: "decision.released",
      created_at: "2026-09-16T00:00:00Z",
      attempt: 1,
      application_id: "app",
      decision_id: DECISION_ID,
      conversation_id: "conv-1",
      turn_id: "turn-1",
      channel: "web_chat",
      review_state: "released",
      reviewer: { role: "clinician" },
      at: "2026-09-16T00:00:01Z",
      released_content: "released",
    });
    const timestamp = 1_700_000_000;
    const event = await govern.handleWebhook(
      body,
      { "x-govern-timestamp": String(timestamp), "x-govern-signature": await signWebhookPayload(SECRET, timestamp, body), "x-govern-event": "decision.released" },
      SECRET,
      { now: () => timestamp },
    );
    expect(event.type).toBe("decision.released");
    await vi.advanceTimersByTimeAsync(10);
    const result = await pending;
    expect(result).toMatchObject({ state: "released", content: "released" });
    expect(calls).toHaveLength(2);
  });
});

describe("webhook verification", () => {
  const body = '{"id":"d1","event":"decision.rejected","decision_id":"abc","attempt":1}';
  const timestamp = 1_700_000_000;

  it("matches the sender's recipe: v1= hex(HMAC-SHA256(secret, timestamp.body))", async () => {
    const signature = await signWebhookPayload(SECRET, timestamp, body);
    expect(signature).toMatch(/^v1=[0-9a-f]{64}$/);
    const verified = await verifyWebhookSignature(
      body,
      { "x-govern-timestamp": String(timestamp), "x-govern-signature": signature },
      SECRET,
      { now: () => timestamp + 10 },
    );
    expect(verified.timestamp).toBe(timestamp);
    expect(verified.body).toBe(body);
  });

  it("verifies raw bytes identically to the string form", async () => {
    const signature = await signWebhookPayload(SECRET, timestamp, body);
    const headers = new Headers({ "x-govern-timestamp": String(timestamp), "x-govern-signature": signature });
    await expect(verifyWebhookSignature(new TextEncoder().encode(body), headers, SECRET, { now: () => timestamp })).resolves.toBeTruthy();
  });

  it("rejects a wrong secret, a changed body, a changed timestamp and a stale timestamp", async () => {
    const signature = await signWebhookPayload(SECRET, timestamp, body);
    const headers = { "x-govern-timestamp": String(timestamp), "x-govern-signature": signature };
    await expect(verifyWebhookSignature(body, headers, "whsec_other", { now: () => timestamp })).rejects.toBeInstanceOf(GovernWebhookError);
    await expect(verifyWebhookSignature(`${body} `, headers, SECRET, { now: () => timestamp })).rejects.toBeInstanceOf(GovernWebhookError);
    await expect(
      verifyWebhookSignature(body, { ...headers, "x-govern-timestamp": String(timestamp + 1) }, SECRET, { now: () => timestamp }),
    ).rejects.toBeInstanceOf(GovernWebhookError);
    await expect(verifyWebhookSignature(body, headers, SECRET, { now: () => timestamp + 301 })).rejects.toBeInstanceOf(GovernWebhookError);
    await expect(verifyWebhookSignature(body, headers, SECRET, { now: () => timestamp + 301, toleranceSeconds: 0 })).resolves.toBeTruthy();
  });

  it("refuses a missing or blank secret as the caller's own mistake, not a bad delivery", async () => {
    const signature = await signWebhookPayload(SECRET, timestamp, body);
    const headers = { "x-govern-timestamp": String(timestamp), "x-govern-signature": signature };
    // A missing secret is a configuration error: there is no secret to check
    // the signature against, so it must not read as a failed verification.
    for (const secret of ["", "   ", undefined as unknown as string]) {
      await expect(verifyWebhookSignature(body, headers, secret, { now: () => timestamp })).rejects.toBeInstanceOf(GovernConfigError);
      await expect(verifyWebhookSignature(body, headers, secret, { now: () => timestamp })).rejects.not.toBeInstanceOf(GovernWebhookError);
      await expect(handleWebhook(body, headers, secret, { now: () => timestamp })).rejects.toBeInstanceOf(GovernConfigError);
      // The sender's half of the recipe has the same input and the same answer.
      await expect(signWebhookPayload(secret, timestamp, body)).rejects.toBeInstanceOf(GovernConfigError);
    }
  });

  it("refuses a body that cannot be the bytes that were signed, instead of calling it a bad signature", async () => {
    const signature = await signWebhookPayload(SECRET, timestamp, body);
    const headers = { "x-govern-timestamp": String(timestamp), "x-govern-signature": signature };
    // The mistake the module's own doc comment warns about: handing over the
    // parsed body. `new Uint8Array(anObject)` is empty, so it must not verify
    // as zero bytes and come back "signature does not match".
    const parsed = JSON.parse(body) as unknown;
    await expect(verifyWebhookSignature(parsed as string, headers, SECRET, { now: () => timestamp })).rejects.toBeInstanceOf(GovernConfigError);
    await expect(verifyWebhookSignature(parsed as string, headers, SECRET, { now: () => timestamp })).rejects.not.toBeInstanceOf(GovernWebhookError);
    await expect(handleWebhook(parsed as string, headers, SECRET, { now: () => timestamp })).rejects.toBeInstanceOf(GovernConfigError);
    await expect(
      verifyWebhookSignature(undefined as unknown as string, headers, SECRET, { now: () => timestamp }),
    ).rejects.toBeInstanceOf(GovernConfigError);
    // What the signature is actually over still verifies, in all three forms.
    await expect(verifyWebhookSignature(body, headers, SECRET, { now: () => timestamp })).resolves.toBeTruthy();
    await expect(verifyWebhookSignature(new TextEncoder().encode(body), headers, SECRET, { now: () => timestamp })).resolves.toBeTruthy();
    const buffer = new TextEncoder().encode(body).buffer as ArrayBuffer;
    await expect(verifyWebhookSignature(buffer, headers, SECRET, { now: () => timestamp })).resolves.toBeTruthy();
  });

  it("refuses a clock that does not answer with a time, instead of skipping the window", async () => {
    const signature = await signWebhookPayload(SECRET, timestamp, body);
    const headers = { "x-govern-timestamp": String(timestamp), "x-govern-signature": signature };
    // `Math.abs(NaN - timestamp) > tolerance` is false, so a clock that
    // returns NaN read as "inside the window" and verified a delivery of any
    // age: the tolerance bug again, one input along.
    await expect(verifyWebhookSignature(body, headers, SECRET, { now: () => Number.NaN })).rejects.toBeInstanceOf(GovernConfigError);
    await expect(
      verifyWebhookSignature(body, headers, SECRET, { now: () => Number.POSITIVE_INFINITY }),
    ).rejects.toBeInstanceOf(GovernConfigError);
    await expect(verifyWebhookSignature(body, headers, SECRET, { now: () => Number.NaN })).rejects.not.toBeInstanceOf(GovernWebhookError);
  });

  it("refuses a tolerance that is not a window, instead of quietly checking nothing", async () => {
    const signature = await signWebhookPayload(SECRET, timestamp, body);
    const headers = { "x-govern-timestamp": String(timestamp), "x-govern-signature": signature };
    // A negative or NaN tolerance must not disable the replay window. Zero is
    // the way to ask for no window.
    for (const toleranceSeconds of [-1, -300, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        verifyWebhookSignature(body, headers, SECRET, { now: () => timestamp + 10_000, toleranceSeconds }),
      ).rejects.toBeInstanceOf(GovernConfigError);
    }
    // The caller's own mistake, not the sender's: a handler that turns every
    // GovernWebhookError into a 400 must not answer 400 to its own bad config.
    await expect(
      verifyWebhookSignature(body, headers, SECRET, { now: () => timestamp, toleranceSeconds: -1 }),
    ).rejects.not.toBeInstanceOf(GovernWebhookError);
    // Still a window when it is one, still disabled when asked explicitly.
    await expect(verifyWebhookSignature(body, headers, SECRET, { now: () => timestamp + 10, toleranceSeconds: 60 })).resolves.toBeTruthy();
    await expect(verifyWebhookSignature(body, headers, SECRET, { now: () => timestamp + 10_000, toleranceSeconds: 0 })).resolves.toBeTruthy();
  });

  it("parses decision and hand-off events and passes unknown events through", async () => {
    const decision = await handleWebhook(
      body,
      { "x-govern-timestamp": String(timestamp), "x-govern-signature": await signWebhookPayload(SECRET, timestamp, body) },
      SECRET,
      { now: () => timestamp },
    );
    expect(decision).toMatchObject({ type: "decision.rejected", decisionId: "abc", reviewState: "rejected", releasedContent: null });

    const handoffBody = JSON.stringify({ id: "d2", event: "handoff.opened", handoff_id: "h1", state: "queued", version: 1, assigned: false, application_id: "app", at: "x", created_at: "y", attempt: 2 });
    const handoff = await handleWebhook(
      handoffBody,
      { "x-govern-timestamp": String(timestamp), "x-govern-signature": await signWebhookPayload(SECRET, timestamp, handoffBody) },
      SECRET,
      { now: () => timestamp },
    );
    expect(handoff).toMatchObject({ type: "handoff.opened", handoffId: "h1", state: "queued", attempt: 2 });

    const otherBody = JSON.stringify({ id: "d3", event: "policy.activated" });
    const other = await handleWebhook(
      otherBody,
      { "x-govern-timestamp": String(timestamp), "x-govern-signature": await signWebhookPayload(SECRET, timestamp, otherBody) },
      SECRET,
      { now: () => timestamp },
    );
    expect(other).toMatchObject({ type: "unknown", event: "policy.activated" });
  });
});
