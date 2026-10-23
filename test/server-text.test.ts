/**
 * The server's own error text is not ours to repeat.
 *
 * The evaluate 400 is documented as covering invalid *content*, and the
 * document declares no schema for that body, so the SDK cannot know what is in
 * it. The README promises flatly that no event and no error carries message
 * content, and that promise has to hold whatever a server sends: it is read by
 * an operator deciding to pipe these strings into a log aggregator that is not
 * a covered system.
 *
 * So the server's text never reaches `.message` or any event. It stays on
 * `GovernApiError.serverMessage`, where reading it is a decision the caller
 * makes.
 */

import { describe, expect, it, vi } from "vitest";

import { GovernApiError } from "../src/errors";
import type { GovernEvent } from "../src/types";
import { DRAFT, HOLD, decisionView, fetchMock, jsonResponse, makeClient } from "./helpers";

const ctx = { conversationId: "conv-1", channel: "web_chat" as const, audience: "patient" as const };

/** A 400 whose body echoes the draft back, which the document permits. */
const echoing400 = () =>
  jsonResponse(400, {
    kind: "BAD_REQUEST_ERROR",
    error_message: `content is not valid: ${DRAFT}`,
  });

describe("GovernApiError", () => {
  it("builds its message from the status and the kind, and nothing the server wrote", () => {
    const error = new GovernApiError({
      status: 400,
      kind: "BAD_REQUEST_ERROR",
      serverMessage: `content is not valid: ${DRAFT}`,
      retryable: false,
      retryAfterMs: null,
    });
    expect(error.message).toBe("AnyBio Govern API responded 400 (BAD_REQUEST_ERROR)");
    expect(error.message).not.toContain(DRAFT);
    expect(error.message).not.toContain("cures");
  });

  it("keeps the server's text on serverMessage, one line and bounded", () => {
    const error = new GovernApiError({
      status: 400,
      kind: null,
      serverMessage: `  line one\n  line two  ${"x".repeat(400)}`,
      retryable: false,
      retryAfterMs: null,
    });
    expect(error.serverMessage).toContain("line one line two");
    expect(error.serverMessage?.length).toBe(303);
    expect(error.serverMessage?.endsWith("...")).toBe(true);
  });

  it("is null when the server sent none", () => {
    const error = new GovernApiError({ status: 500, kind: null, serverMessage: null, retryable: true, retryAfterMs: null });
    expect(error.serverMessage).toBeNull();
    expect(error.message).toBe("AnyBio Govern API responded 500");
  });
});

describe("a 400 that echoes the draft", () => {
  it("does not put it in the thrown error's message", async () => {
    const { fetch } = fetchMock(echoing400);
    const govern = makeClient(fetch);
    const error = await govern
      .evaluate({ conversationId: "conv-1", turnId: "turn-1", channel: "web_chat", audience: "patient", content: DRAFT })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(GovernApiError);
    expect((error as Error).message).not.toContain(DRAFT);
    expect((error as Error).message).not.toContain("cures");
    expect((error as GovernApiError).serverMessage).toContain(DRAFT);
  });

  it("does not put it in the degraded event guard emits, which is the string operators log", async () => {
    vi.useFakeTimers();
    const events: GovernEvent[] = [];
    const { fetch } = fetchMock(echoing400);
    const govern = makeClient(fetch, { maxRetries: 0, onEvent: (e) => events.push(e) });
    const pending = govern.guard(() => DRAFT, ctx);
    await vi.advanceTimersByTimeAsync(60_000);
    const reply = await pending;
    expect(reply.text).toBe(HOLD);
    const degraded = events.find((e) => e.type === "degraded");
    expect(degraded).toBeDefined();
    expect(JSON.stringify(events)).not.toContain(DRAFT);
    expect(JSON.stringify(events)).not.toContain("cures");
    // Still diagnosable: the status and the kind are there.
    expect(degraded).toMatchObject({ status: 400, cause: "client_misconfigured" });
  });

  it("does not put it in the auto-ack error event either", async () => {
    const events: GovernEvent[] = [];
    const { fetch } = fetchMock([
      () => jsonResponse(200, decisionView()),
      echoing400,
    ]);
    const govern = makeClient(fetch, { maxRetries: 0, onEvent: (e) => events.push(e) });
    await govern.guard(() => DRAFT, { ...ctx, turnId: "turn-1" });
    await govern.flushPendingAcks();
    expect(events).toContainEqual(expect.objectContaining({ type: "error", operation: "auto_ack" }));
    expect(JSON.stringify(events)).not.toContain(DRAFT);
  });
});
