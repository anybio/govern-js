/**
 * The transport: one function that sends a JSON request with the application
 * key, a per-attempt timeout, and idempotent retries on 429 (honouring
 * `Retry-After`), 5xx, timeouts and network failures, with jittered
 * exponential backoff. Nothing here reads or logs a request body.
 */

import {
  GovernAbortError,
  GovernApiError,
  GovernConflictError,
  GovernNetworkError,
  GovernTimeoutError,
} from "./errors";
import type { GovernEvent } from "./types";
import { SDK_NAME, SDK_VERSION } from "./version";

export interface TransportConfig {
  baseUrl: string;
  apiKey: string;
  fetch: typeof fetch;
  /** Per attempt. */
  timeoutMs: number;
  /** Retries after the first attempt. */
  maxRetries: number;
  onEvent?: ((event: GovernEvent) => void) | undefined;
}

export interface TransportRequest {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal | undefined;
  /** Default true. */
  retry?: boolean;
}

export interface TransportResponse<T> {
  status: number;
  body: T;
  headers: Headers;
}

const BACKOFF_BASE_MS = 250;
const BACKOFF_MAX_MS = 5_000;
const RETRY_AFTER_MAX_MS = 30_000;

export const HEADER_IDEMPOTENCY_KEY = "Idempotency-Key";

export async function send<T>(
  config: TransportConfig,
  request: TransportRequest,
): Promise<TransportResponse<T>> {
  const url = buildUrl(config.baseUrl, request.path, request.query);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    Accept: "application/json",
    "X-AnyBio-Govern-SDK": `${SDK_NAME}/${SDK_VERSION}`,
  };
  if (request.body !== undefined) headers["Content-Type"] = "application/json";
  if (request.idempotencyKey) headers[HEADER_IDEMPOTENCY_KEY] = request.idempotencyKey;
  const payload = request.body === undefined ? undefined : JSON.stringify(request.body);
  const retry = request.retry ?? true;
  const attempts = retry ? config.maxRetries + 1 : 1;

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (request.signal?.aborted) throw new GovernAbortError(request.signal.reason);
    config.onEvent?.({ type: "request", method: request.method, path: request.path, attempt });
    const started = now();
    let response: Response;
    try {
      response = await withTimeout(
        config.fetch,
        url,
        { method: request.method, headers, body: payload },
        config.timeoutMs,
        request.signal,
      );
    } catch (error) {
      if (error instanceof GovernAbortError) throw error;
      const failure =
        error instanceof GovernTimeoutError
          ? error
          : new GovernNetworkError("AnyBio Govern request failed before a response arrived", {
              cause: error,
            });
      lastError = failure;
      if (attempt < attempts) {
        const delayMs = backoff(attempt);
        config.onEvent?.({
          type: "retry",
          method: request.method,
          path: request.path,
          attempt,
          status: null,
          delayMs,
          reason: failure instanceof GovernTimeoutError ? "timeout" : "network",
        });
        await sleep(delayMs, request.signal);
        continue;
      }
      throw failure;
    }

    config.onEvent?.({
      type: "response",
      method: request.method,
      path: request.path,
      status: response.status,
      attempt,
      durationMs: Math.round(now() - started),
    });

    if (response.ok) {
      return { status: response.status, body: await readJson<T>(response), headers: response.headers };
    }

    const retryable = response.status === 429 || response.status >= 500;
    const retryAfterMs = response.status === 429 ? parseRetryAfter(response.headers.get("retry-after")) : null;
    const { kind, message } = await readError(response);
    const detail = { status: response.status, kind, serverMessage: message, retryable, retryAfterMs };
    const failure = response.status === 409 ? new GovernConflictError(detail) : new GovernApiError(detail);
    lastError = failure;
    if (retryable && attempt < attempts) {
      const delayMs = retryAfterMs ?? backoff(attempt);
      config.onEvent?.({
        type: "retry",
        method: request.method,
        path: request.path,
        attempt,
        status: response.status,
        delayMs,
        reason: response.status === 429 ? "rate_limited" : "server_error",
      });
      await sleep(delayMs, request.signal);
      continue;
    }
    throw failure;
  }
  // Unreachable: the loop either returns or throws.
  throw lastError ?? new GovernNetworkError("AnyBio Govern request failed");
}

function buildUrl(baseUrl: string, path: string, query?: Record<string, string | undefined>): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const url = new URL(`${base}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

async function withTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  let rejectTimeout: (error: Error) => void = () => {};
  // Raced against the fetch so a fetch implementation that ignores the abort
  // signal still cannot hold the caller past the timeout.
  const timeout = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectTimeout(new GovernTimeoutError(timeoutMs));
  }, timeoutMs);
  const onAbort = () => {
    controller.abort();
    rejectTimeout(new GovernAbortError(signal?.reason));
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([fetchImpl(url, { ...init, signal: controller.signal }), timeout]);
  } catch (error) {
    if (signal?.aborted) throw new GovernAbortError(signal.reason);
    if (timedOut) throw new GovernTimeoutError(timeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new GovernNetworkError(`AnyBio Govern API returned a non-JSON body with status ${response.status}`);
  }
}

async function readError(response: Response): Promise<{ kind: string | null; message: string | null }> {
  let text = "";
  try {
    text = await response.text();
  } catch {
    return { kind: null, message: null };
  }
  if (!text) return { kind: null, message: null };
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const kind = typeof parsed.kind === "string" ? parsed.kind : null;
    const message =
      typeof parsed.error_message === "string"
        ? parsed.error_message
        : typeof parsed.error === "string"
          ? parsed.error
          : typeof parsed.message === "string"
            ? parsed.message
            : null;
    return { kind, message };
  } catch {
    return { kind: null, message: null };
  }
}

/** `Retry-After` as seconds or an HTTP date, clamped to [0, 30 s]. */
export function parseRetryAfter(header: string | null, nowMs: number = Date.now()): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    return Math.min(Number(trimmed) * 1000, RETRY_AFTER_MAX_MS);
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.min(at - nowMs, RETRY_AFTER_MAX_MS));
}

/** Full-jitter exponential backoff: uniform in [0, min(cap, base * 2^(attempt-1))]. */
export function backoff(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(random() * ceiling);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new GovernAbortError(signal.reason));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new GovernAbortError(signal?.reason));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
