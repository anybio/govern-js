import { Govern, type GovernOptions } from "../src/client";
import type { WireDecision } from "../src/types";

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

/**
 * A fetch that answers from a list of responders in order (the last one
 * repeats) and records every call for assertions.
 */
export function fetchMock(responders: Responder | Responder[]) {
  const list = Array.isArray(responders) ? responders : [responders];
  const calls: RecordedCall[] = [];
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
    if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    const responder = list[Math.min(call.index, list.length - 1)]!;
    // Like a real fetch: reject when the caller aborts.
    const aborted = new Promise<never>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true });
    });
    return Promise.race([Promise.resolve().then(() => responder(call)), aborted]);
  };
  return { fetch: fetchImpl, calls };
}

export function decisionView(overrides: Partial<WireDecision> = {}): WireDecision {
  return {
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
    disclosure_required: false,
    review_url: null,
    review_state: null,
    deliverable_content: null,
    released_content: null,
    send_holding_line: false,
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
