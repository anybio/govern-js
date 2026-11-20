import { Govern, type GovernOptions } from "../src/client";
import type { WireDecision, WireOutcome, WireOutcomeEvent } from "../src/types";

export interface RecordedCall {
  index: number;
  url: URL;
  method: string;
  headers: Headers;
  json: unknown;
  text: string | undefined;
}

export type Responder = (call: RecordedCall) => Response | Promise<Response>;

/** A fake application key. Not a credential: the tests never reach a server. */
export const TEST_KEY = "gk_sandbox_0000000000000000000000000000000000000000";
export const BASE_URL = "https://govern.test";
export const DECISION_ID = "0b7c8f1e-2a3b-4c5d-8e9f-0a1b2c3d4e5f";
export const APPLICATION_ID = "5f0e1d2c-3b4a-4968-8776-655443322110";
/** The draft every test posts. Assertions check it never appears in an error or an outcome body. */
export const DRAFT = "Good news: this program cures high blood pressure, so you can stop your medication.";
export const HOLD = "A person will follow up.";

export function jsonResponse(status: number, body?: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

/** A recorded call to wait for: an outcome report, an evaluate, or any test of a call. */
export type CallMatcher = "outcome" | "evaluate" | ((call: RecordedCall) => boolean);

const matches = (matcher: CallMatcher, call: RecordedCall): boolean =>
  matcher === "outcome"
    ? call.url.pathname.endsWith("/outcome")
    : matcher === "evaluate"
      ? call.url.pathname.endsWith("/evaluate")
      : matcher(call);

/**
 * A fetch that answers from a list of responders in order (the last one
 * repeats) and records every call for assertions.
 *
 * `waitForCall` resolves with the `nth` recorded call that matches (default
 * the first), whether it has already been made or is still to come, and
 * rejects after `timeoutMs` (default 5000) naming what it waited for and the
 * calls it saw. Use it wherever a test waits for a request, in place of a
 * count of timer ticks: an outcome report hashes its text with Web Crypto
 * first, and `crypto.subtle.digest` completes on the libuv threadpool, which
 * no number of `setTimeout(0)` turns bounds on a loaded machine. A tick is
 * still the tool for letting microtasks settle before asserting that
 * something did not happen. It resolves the moment the call is recorded,
 * before its responder has run, so a test whose assertion is a count (one
 * report, not two) follows it with `await tick()` to give a second request
 * its window.
 */
export function fetchMock(responders: Responder | Responder[]) {
  const list = Array.isArray(responders) ? responders : [responders];
  const calls: RecordedCall[] = [];
  const waiters = new Set<() => void>();
  const waitForCall = (matcher: CallMatcher, { nth = 1, timeoutMs = 5_000 }: { nth?: number; timeoutMs?: number } = {}) =>
    new Promise<RecordedCall>((resolve, reject) => {
      const check = (): boolean => {
        const found = calls.filter((call) => matches(matcher, call));
        if (found.length < nth) return false;
        clearTimeout(timer);
        waiters.delete(onCall);
        resolve(found[nth - 1]!);
        return true;
      };
      const onCall = (): void => void check();
      const timer = setTimeout(() => {
        waiters.delete(onCall);
        const seen = calls.map((call) => `${call.method} ${call.url.pathname}`).join(", ") || "none";
        reject(new Error(`waitForCall: call ${nth} matching ${typeof matcher === "string" ? matcher : "the predicate"} did not arrive within ${timeoutMs} ms; calls seen: ${seen}`));
      }, timeoutMs);
      waiters.add(onCall);
      check();
    });
  const fetchImpl: typeof fetch = async (input, init) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const text = typeof init?.body === "string" ? init.body : undefined;
    const call: RecordedCall = {
      index: calls.length,
      url: new URL(href),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      json: text ? JSON.parse(text) : undefined,
      text,
    };
    calls.push(call);
    for (const waiter of [...waiters]) waiter();
    if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    const responder = list[Math.min(call.index, list.length - 1)]!;
    // Like a real fetch: reject when the caller aborts.
    const aborted = new Promise<never>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true });
    });
    return Promise.race([Promise.resolve().then(() => responder(call)), aborted]);
  };
  return { fetch: fetchImpl, calls, waitForCall };
}

/** The channels the API classes as in-session, spelled out here and not read from the SDK. */
const API_IN_SESSION: readonly string[] = ["web_chat", "app_message", "voice"];

/**
 * `show_hold_text` as the API computes it for a view: a stopped turn (any
 * answer but `allow`, in enforce, answered, not released or rejected) shows
 * the hold text to a clinician, to a patient in session, and to a patient on
 * an outbound channel when a holding line is owed. Spelled out here, not read
 * from the SDK, so a test fails when the two disagree. The API's other `false`
 * (a stopped turn whose retry was accepted) is not visible on the view; a test
 * about it sets the field itself.
 */
export function apiShowsHoldText(view: Omit<WireDecision, "show_hold_text">): boolean {
  const stopped =
    view.mode === "enforce" &&
    view.decision !== "allow" &&
    (view.status === "decided" || view.status === "unavailable") &&
    view.review_state !== "released" &&
    view.review_state !== "rejected";
  if (!stopped) return false;
  if (view.audience === "clinician") return true;
  if (view.audience !== "patient") return false;
  return API_IN_SESSION.includes(view.channel) || view.send_holding_line;
}

/**
 * A decision view as the API sends it. `show_hold_text` follows the API's
 * rule from the rest of the view unless the overrides set it.
 */
export function decisionView(overrides: Partial<WireDecision> = {}): WireDecision {
  const view: WireDecision = {
    decision_id: DECISION_ID,
    status: "decided",
    decision: "allow",
    mode: "enforce",
    channel: "web_chat",
    audience: "patient",
    conversation_id: "conv-1",
    turn_id: "turn-1",
    would_have: null,
    policy: { id: "7c6b5a49-3827-4165-9483-7261504f3e2d", name: "synthetic", version: 1 },
    reasons: [],
    rationale: null,
    detected_claims: [],
    matches: [],
    flagged: false,
    disclosure_required: false,
    review_url: null,
    review_state: null,
    deliverable_content: null,
    released_content: null,
    send_holding_line: false,
    show_hold_text: false,
    retryable: false,
    retry_of: null,
    created_at: "2026-09-16T00:00:00Z",
    decided_at: "2026-09-16T00:00:00Z",
    reviewed_at: null,
    outcome: null,
    route_to_human: false,
    would_have_routed: false,
    inbound_flags: [],
    handoff: null,
    webhook_deliveries: [],
    ...overrides,
  };
  if (!("show_hold_text" in overrides)) view.show_hold_text = apiShowsHoldText(view);
  return view;
}

/**
 * An outcome trail as the API returns it: one `released` event from the
 * caller, its state `released`, unless the events say otherwise.
 */
export function outcomeTrail(events: Partial<WireOutcomeEvent>[] = [{}]): WireOutcome {
  const full: WireOutcomeEvent[] = events.map((event) => ({
    kind: "released",
    source: "caller",
    at: "2026-09-16T00:00:01Z",
    recorded_at: "2026-09-16T00:00:02Z",
    content_hash: event.kind === undefined || event.kind === "released" || event.kind === "delivered" ? "a".repeat(64) : null,
    delivery_ref: null,
    reason: null,
    hash_matches_release: null,
    superseded_by: null,
    ...event,
  }));
  const has = (kind: WireOutcomeEvent["kind"]) => full.some((event) => event.kind === kind);
  const state = has("delivered") ? "delivered" : has("superseded") ? "superseded" : has("discarded") ? "discarded" : has("failed") ? "failed" : "released";
  return { state, events: full };
}

/** The same view from a server that predates `show_hold_text`, `retryable` and `retry_of`. */
export function olderServer(view: WireDecision): WireDecision {
  const { show_hold_text: _shown, retryable: _retryable, retry_of: _retryOf, ...rest } = view;
  return rest;
}

export function makeClient(fetchImpl: typeof fetch, extra: Partial<GovernOptions> = {}): Govern {
  return new Govern({
    apiKey: TEST_KEY,
    application: "care-companion",
    baseUrl: BASE_URL,
    fetch: fetchImpl,
    holdMessage: HOLD,
    ...extra,
  });
}

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let queued microtasks and already-due macrotasks run. */
export async function tick(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
  const out: T[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}
