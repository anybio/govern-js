import { describe, expect, it, vi } from "vitest";

import { MAX_CONVERSATION_ID_CHARS, MAX_TURN_ID_CHARS } from "../src/client";
import { GovernApiError, GovernConfigError, GovernNetworkError } from "../src/errors";
import {
  APPLICATION_ID,
  DECISION_ID,
  DRAFT,
  HOLD,
  TEST_KEY,
  decisionView,
  fetchMock,
  jsonResponse,
  makeClient,
} from "./helpers";

const evaluateInput = {
  conversationId: "conv-1",
  turnId: "turn-1",
  channel: "web_chat" as const,
  audience: "patient" as const,
  content: DRAFT,
};

describe("Govern.evaluate", () => {
  it("sets the Idempotency-Key header from turnId and sends the application key as a bearer token", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView()));
    const govern = makeClient(fetch);
    await govern.evaluate(evaluateInput);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url.pathname).toBe("/api/v1/govern/evaluate");
    expect(call.headers.get("idempotency-key")).toBe("turn-1");
    expect(call.headers.get("authorization")).toBe(`Bearer ${TEST_KEY}`);
    expect(call.headers.get("content-type")).toBe("application/json");
    expect(call.json).toMatchObject({
      conversation_id: "conv-1",
      turn_id: "turn-1",
      channel: "web_chat",
      audience: "patient",
      content: DRAFT,
    });
    expect(call.json).not.toHaveProperty("application_id");
  });

  it("sends application_id when the application option is a UUID", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView()));
    const govern = makeClient(fetch, { application: APPLICATION_ID.toUpperCase() });
    await govern.evaluate(evaluateInput);
    expect(calls[0]!.json).toMatchObject({ application_id: APPLICATION_ID });
  });

  it("returns allow with the decision id at once when the server answers 202 in observe mode", async () => {
    const { fetch } = fetchMock(() =>
      jsonResponse(202, decisionView({ mode: "observe", status: "pending", decision: "allow", would_have: null })),
    );
    const govern = makeClient(fetch);
    const decision = await govern.evaluate(evaluateInput);
    expect(decision.decision).toBe("allow");
    expect(decision.mode).toBe("observe");
    expect(decision.accepted).toBe(true);
    expect(decision.status).toBe("pending");
    expect(decision.id).toBe(DECISION_ID);
    expect(decision.degraded).toBe(false);
    expect(govern.lastKnownMode("web_chat")).toBe("observe");
  });

  it("honours Retry-After on 429 and retries the same idempotent request", async () => {
    vi.useFakeTimers();
    const events: unknown[] = [];
    const { fetch, calls } = fetchMock([
      () => jsonResponse(429, { kind: "RATE_LIMIT_ERROR", error_message: "rate limit exceeded" }, { "retry-after": "2" }),
      () => jsonResponse(200, decisionView()),
    ]);
    const govern = makeClient(fetch, { onEvent: (e) => events.push(e) });
    const pending = govern.evaluate(evaluateInput);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    const decision = await pending;
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers.get("idempotency-key")).toBe("turn-1");
    expect(calls[1]!.json).toEqual(calls[0]!.json);
    expect(decision.decision).toBe("allow");
    expect(events).toContainEqual(
      expect.objectContaining({ type: "retry", status: 429, delayMs: 2_000, reason: "rate_limited" }),
    );
  });

  it("retries 5xx with backoff and then surfaces an error that never contains the content", async () => {
    vi.useFakeTimers();
    const { fetch, calls } = fetchMock(() => jsonResponse(503, { kind: "SERVICE_UNAVAILABLE_ERROR", error_message: "gate down" }));
    const govern = makeClient(fetch, { maxRetries: 2 });
    const pending = govern.evaluate(evaluateInput);
    const settled = pending.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    const error = (await settled) as GovernApiError;
    expect(calls).toHaveLength(3);
    expect(error).toBeInstanceOf(GovernApiError);
    expect(error.status).toBe(503);
    expect(error.kind).toBe("SERVICE_UNAVAILABLE_ERROR");
    expect(error.retryable).toBe(true);
    expect(error.message).not.toContain(DRAFT);
    expect(JSON.stringify(error)).not.toContain(DRAFT);
  });

  it("does not retry a 4xx and never echoes the content in the error", async () => {
    const { fetch, calls } = fetchMock(() =>
      jsonResponse(400, { kind: "BAD_REQUEST_ERROR", error_message: "audience 'clinician' is not allowed on channel 'sms'" }),
    );
    const govern = makeClient(fetch);
    const error = await govern.evaluate({ ...evaluateInput, channel: "sms", audience: "clinician" }).catch((e: unknown) => e);
    expect(calls).toHaveLength(1);
    expect(error).toBeInstanceOf(GovernApiError);
    expect((error as GovernApiError).status).toBe(400);
    expect((error as Error).message).toContain("BAD_REQUEST_ERROR");
    expect((error as Error).message).not.toContain(DRAFT);
  });

  it("retries a network failure and surfaces GovernNetworkError without the content", async () => {
    vi.useFakeTimers();
    const { fetch, calls } = fetchMock(() => {
      throw new TypeError("fetch failed");
    });
    const govern = makeClient(fetch, { maxRetries: 1 });
    const settled = govern.evaluate(evaluateInput).then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    const error = await settled;
    expect(calls).toHaveLength(2);
    expect(error).toBeInstanceOf(GovernNetworkError);
    expect((error as Error).message).not.toContain(DRAFT);
  });

  it("never exposes deliverable content for a patient audience, even if a server sends it", async () => {
    const { fetch } = fetchMock(() =>
      jsonResponse(200, decisionView({ decision: "hold", reasons: ["patient_rewrite_withheld", "held_for_review"], deliverable_content: "rewritten text" })),
    );
    const govern = makeClient(fetch);
    const decision = await govern.evaluate(evaluateInput);
    expect(decision.decision).toBe("hold");
    expect(decision.deliverableContent).toBeNull();
    expect(decision.reasons).toContain("patient_rewrite_withheld");
  });

  it("returns deliverable content for a clinician audience", async () => {
    const { fetch } = fetchMock(() =>
      jsonResponse(200, decisionView({ audience: "clinician", decision: "allow", reasons: ["rewritten"], deliverable_content: "substituted wording" })),
    );
    const govern = makeClient(fetch);
    const decision = await govern.evaluate({ ...evaluateInput, audience: "clinician" });
    expect(decision.decision).toBe("allow");
    expect(decision.deliverableContent).toBe("substituted wording");
  });

  it("attaches the disclosure ref recorded for the conversation to later evaluates", async () => {
    const ref = `govern:${APPLICATION_ID}:conversation:conv-1:disclosure`;
    const { fetch, calls } = fetchMock([
      () =>
        jsonResponse(201, {
          ref,
          application_id: APPLICATION_ID,
          conversation_id: "conv-1",
          channel: "web_chat",
          evidence_id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
          recorded_at: "2026-09-16T00:00:00Z",
        }),
      () => jsonResponse(200, decisionView()),
    ]);
    const govern = makeClient(fetch);
    const disclosure = await govern.recordDisclosure({
      conversationId: "conv-1",
      channel: "web_chat",
      textShown: "You are chatting with an AI assistant.",
    });
    expect(disclosure.ref).toBe(ref);
    expect(disclosure.created).toBe(true);
    expect(calls[0]!.url.pathname).toBe("/api/v1/govern/disclosures");
    expect(calls[0]!.json).toMatchObject({ conversation_id: "conv-1", channel: "web_chat", text_shown: "You are chatting with an AI assistant." });
    await govern.evaluate(evaluateInput);
    expect(calls[1]!.json).toMatchObject({ disclosure: { established: true, ref } });
  });

  it("validates identifiers locally before any request", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView()));
    const govern = makeClient(fetch);
    await expect(govern.evaluate({ ...evaluateInput, turnId: " " })).rejects.toBeInstanceOf(GovernConfigError);
    await expect(govern.evaluate({ ...evaluateInput, content: "" })).rejects.toBeInstanceOf(GovernConfigError);
    expect(calls).toHaveLength(0);
  });

  it("refuses a turn id in the API's reserved range before any request", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView()));
    const govern = makeClient(fetch);
    await expect(
      govern.evaluate({ ...evaluateInput, turnId: "govern:disclosure:conv-1" }),
    ).rejects.toBeInstanceOf(GovernConfigError);
    // Only the prefix is reserved; the word on its own is a caller's to use.
    expect(calls).toHaveLength(0);
    await govern.evaluate({ ...evaluateInput, turnId: "disclosure:conv-1" });
    expect(calls).toHaveLength(1);
  });

  it("refuses identifiers longer than the API's bound, and accepts the bound itself", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView()));
    const govern = makeClient(fetch);
    await expect(
      govern.evaluate({ ...evaluateInput, conversationId: "c".repeat(MAX_CONVERSATION_ID_CHARS + 1) }),
    ).rejects.toBeInstanceOf(GovernConfigError);
    await expect(
      govern.evaluate({ ...evaluateInput, turnId: "t".repeat(MAX_TURN_ID_CHARS + 1) }),
    ).rejects.toBeInstanceOf(GovernConfigError);
    await expect(
      govern.recordDisclosure({
        conversationId: "c".repeat(MAX_CONVERSATION_ID_CHARS + 1),
        channel: "web_chat",
        textShown: "You are chatting with an AI assistant.",
      }),
    ).rejects.toBeInstanceOf(GovernConfigError);
    expect(calls).toHaveLength(0);

    await govern.evaluate({
      ...evaluateInput,
      conversationId: "c".repeat(MAX_CONVERSATION_ID_CHARS),
      turnId: "t".repeat(MAX_TURN_ID_CHARS),
    });
    expect(calls).toHaveLength(1);
  });

  it("counts identifier length in code points, as the API does", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView()));
    const govern = makeClient(fetch);
    // An astral character is one code point and two UTF-16 units; counting
    // `.length` would refuse this turn, which the API accepts.
    const conversationId = "\u{10348}".repeat(MAX_CONVERSATION_ID_CHARS);
    expect(conversationId.length).toBe(MAX_CONVERSATION_ID_CHARS * 2);
    await govern.evaluate({ ...evaluateInput, conversationId });
    expect(calls).toHaveLength(1);
  });

  it("guard checks the identifiers before the draft is generated", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView()));
    const govern = makeClient(fetch);
    const draft = vi.fn(() => DRAFT);
    await expect(
      govern.guard(draft, {
        conversationId: "c".repeat(MAX_CONVERSATION_ID_CHARS + 1),
        channel: "web_chat",
        audience: "patient",
      }),
    ).rejects.toBeInstanceOf(GovernConfigError);
    await expect(
      govern.guard(draft, {
        conversationId: "conv-1",
        turnId: "govern:disclosure:conv-1",
        channel: "web_chat",
        audience: "patient",
      }),
    ).rejects.toBeInstanceOf(GovernConfigError);
    expect(draft).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("sends a presented disclosure ref as given; the API ignores one that is not the conversation's own", async () => {
    // The SDK does not second-guess it. A borrowed reference is ignored by the
    // API, never refused, and the turn is answered on this conversation's own
    // evidence, so the decision comes back `disclosureRequired`.
    const borrowed = `govern:${APPLICATION_ID}:conversation:someone-elses:disclosure`;
    const { fetch, calls } = fetchMock(() =>
      jsonResponse(200, decisionView({ disclosure_required: true, reasons: ["disclosure_missing"] })),
    );
    const govern = makeClient(fetch);
    const decision = await govern.evaluate({ ...evaluateInput, disclosure: { ref: borrowed } });
    expect(calls[0]!.json).toMatchObject({ disclosure: { ref: borrowed } });
    expect(decision.disclosureRequired).toBe(true);
  });

  it("a replayed disclosure describes the evidence on record, not the call asking for it", async () => {
    const ref = `govern:${APPLICATION_ID}:conversation:conv-1:disclosure`;
    const { fetch } = fetchMock(() =>
      // 200, not 201: the evidence was already there. Its channel and time are
      // the recorded ones, which is why they are read off the response.
      jsonResponse(200, {
        ref,
        application_id: APPLICATION_ID,
        conversation_id: "conv-1",
        channel: "sms",
        evidence_id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
        recorded_at: "2026-09-16T00:00:00Z",
      }),
    );
    const govern = makeClient(fetch);
    const disclosure = await govern.recordDisclosure({
      conversationId: "conv-1",
      channel: "web_chat",
      textShown: "You are chatting with an AI assistant.",
    });
    expect(disclosure.created).toBe(false);
    expect(disclosure.channel).toBe("sms");
    expect(disclosure.recordedAt).toBe("2026-09-16T00:00:00Z");
    expect(govern.disclosureRef("conv-1")).toBe(ref);
  });
});

describe("Govern.reportOutcome", () => {
  it("sends the SHA-256 of the delivered text and never the text", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(201, decisionView({ outcome: null })));
    const govern = makeClient(fetch);
    await govern.reportOutcome(DECISION_ID, { delivered: true, content: DRAFT, deliveredAt: "2026-09-16T00:00:05Z", deliveryRef: "SM123" });
    const call = calls[0]!;
    expect(call.url.pathname).toBe(`/api/v1/govern/decisions/${DECISION_ID}/outcome`);
    expect(call.json).toEqual({
      delivered: true,
      delivered_at: "2026-09-16T00:00:05Z",
      delivered_content_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      delivery_ref: "SM123",
    });
    expect(call.text).not.toContain(DRAFT);
    expect(call.text).not.toContain("cures");
  });

  it("computes the documented hash (SHA-256 of UTF-8, lowercase hex)", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(201, decisionView()));
    const govern = makeClient(fetch);
    await govern.reportOutcome(DECISION_ID, { delivered: true, content: "abc" });
    expect((calls[0]!.json as { delivered_content_hash: string }).delivered_content_hash).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("refuses delivered=true without content or a hash before any request", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(201, decisionView()));
    const govern = makeClient(fetch);
    await expect(govern.reportOutcome(DECISION_ID, { delivered: true })).rejects.toBeInstanceOf(GovernConfigError);
    expect(calls).toHaveLength(0);
  });

  it("treats a blank contentHash as absent and hashes the content instead", async () => {
    // "" is not undefined, so neither the fallback nor the delivered guard used
    // to fire: a blank string went to the compliance record verbatim, and the
    // record then said a message was delivered whose hash matches nothing.
    const { fetch, calls } = fetchMock(() => jsonResponse(201, decisionView()));
    const govern = makeClient(fetch);
    await govern.reportOutcome(DECISION_ID, { delivered: true, contentHash: "   ", content: "abc" });
    expect((calls[0]!.json as { delivered_content_hash: string }).delivered_content_hash).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("refuses delivered=true with a blank hash and no content, before any request", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(201, decisionView()));
    const govern = makeClient(fetch);
    await expect(govern.reportOutcome(DECISION_ID, { delivered: true, contentHash: "" })).rejects.toBeInstanceOf(
      GovernConfigError,
    );
    expect(calls).toHaveLength(0);
  });

  it("allows delivered=false without a hash", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(201, decisionView()));
    const govern = makeClient(fetch);
    await govern.reportOutcome(DECISION_ID, { delivered: false });
    expect(calls[0]!.json).toEqual({ delivered: false, delivered_at: expect.any(String) });
  });
});

describe("constructor", () => {
  it("throws when a browser window global is present", () => {
    vi.stubGlobal("window", { document: {} });
    expect(() => makeClient(fetchMock(() => jsonResponse(200, {})).fetch)).toThrow(GovernConfigError);
    expect(() => makeClient(fetchMock(() => jsonResponse(200, {})).fetch, { dangerouslyAllowBrowser: true })).not.toThrow();
  });

  it("requires an api key and an application", () => {
    const { fetch } = fetchMock(() => jsonResponse(200, {}));
    expect(() => makeClient(fetch, { apiKey: "" })).toThrow(GovernConfigError);
    expect(() => makeClient(fetch, { application: "" })).toThrow(GovernConfigError);
  });

  it("uses the configured hold message default", async () => {
    const { fetch } = fetchMock(() => jsonResponse(200, decisionView({ decision: "hold" })));
    const govern = makeClient(fetch);
    const reply = await govern.guard(() => DRAFT, { conversationId: "conv-1", channel: "web_chat", audience: "patient" });
    expect(reply.text).toBe(HOLD);
  });
});
