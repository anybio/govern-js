/**
 * What the framework adapters share: the outcome report they make, from
 * what they handed over or from a caller's `deliveredText` hook, the replay
 * check, and reporting a failure to `onError`.
 * Internal; the adapters re-export the two answer types, and nothing else
 * here leaves the package. The rule for a gate call whose bound fired lives
 * in `guard` (`GuardContext.gateSignal`), not here.
 */

import type { Govern } from "./client";
import { GovernConfigError } from "./errors";
import { MAX_SHORT_TEXT_CHARS, shortTextFault } from "./text";
import { timeValue } from "./time";
import { OUTCOME_REASONS, type Decision, type GuardResult, type ReportOutcomeInput } from "./types";

/**
 * Whether the reply hands the caller text to deliver: an allow, or a hold
 * with `showHoldText`. The channel rule lives in `guard`; the adapters read
 * its answer and add no rule of their own.
 */
export function delivers(reply: Pick<GuardResult, "held" | "showHoldText">): boolean {
  return !reply.held || reply.showHoldText;
}

/**
 * What went out, with when and under which reference, for a caller that
 * knows. Recorded as the decision's `released` event: the text's hash, at
 * `deliveredAt`, under `deliveryRef`.
 */
export interface DeliveredMessage {
  /** The text that went out. Hashed locally; only the hash is sent. The empty string means nothing went out. */
  text: string;
  /**
   * When it went out (for a voice line, when it started to be spoken): a
   * Date, or an RFC 3339 date-time string. The event's `at`. Default (also
   * for `null`): when the hook answered.
   */
  deliveredAt?: Date | string | null;
  /**
   * Your own reference for the delivery (a message id on your channel).
   * `null` is none. Trimmed of Unicode white space at either end, as the API
   * trims it, it must not be blank, must be at most 256 characters and must
   * carry no control character; anything else is a `GovernConfigError`
   * naming `deliveredText`, passed to `onError`, and no report is made.
   */
  deliveryRef?: string | null;
}

/**
 * What a `deliveredText` hook answers: the text that went out, the same with
 * its time and reference, or `null` when nothing went out.
 */
export type DeliveredText = string | DeliveredMessage | null;

/**
 * The one report an adapter makes for a decision: `released` with the text
 * that went out, or `discarded` with the reason nothing did.
 */
export type AdapterReport =
  | { kind: "released"; content: string; at?: string; deliveryRef?: string }
  | { kind: "discarded"; reason: string; at?: string; deliveryRef?: string };

/**
 * Ask the caller's hook what went out and turn the answer into the report.
 * Non-empty text is `released` with that text (hashed by the client; the
 * text is never sent), a shown hold message included. `null` is `discarded`
 * (`nothing_delivered`), and so is empty text, which is the SDK's one "send
 * nothing" value: a hook that answers with `reply.text` on a hold that
 * showed nothing has delivered nothing.
 *
 * Anything else is a wiring mistake. It is thrown, so it reaches `onError`
 * and nothing is recorded from it: a guess is not a record.
 */
export async function deliveredOutcome<I>(
  hook: (info: I) => DeliveredText | Promise<DeliveredText>,
  info: I,
): Promise<AdapterReport> {
  const answer: unknown = await hook(info);
  if (answer === null || answer === "") return { kind: "discarded", reason: OUTCOME_REASONS.nothingDelivered };
  if (typeof answer === "string") return { kind: "released", content: answer };
  if (typeof answer === "object" && typeof (answer as { text?: unknown }).text === "string") {
    const { text, deliveredAt, deliveryRef } = answer as { text: string; deliveredAt?: unknown; deliveryRef?: unknown };
    const report: AdapterReport =
      text === "" ? { kind: "discarded", reason: OUTCOME_REASONS.nothingDelivered } : { kind: "released", content: text };
    // `null` is none, as it is for every optional on this surface.
    if (deliveredAt !== undefined && deliveredAt !== null) report.at = timeOf(deliveredAt);
    if (deliveryRef !== undefined && deliveryRef !== null) {
      // The API's rule, checked here so a bad value is a slip of the hook's,
      // refused before any report is made, like every other.
      const fault = shortTextFault(deliveryRef);
      if (fault !== undefined) throw invalid(`a \`deliveryRef\` that ${fault} (the API takes a non-blank string of at most ${MAX_SHORT_TEXT_CHARS} characters, with no control characters)`);
      report.deliveryRef = deliveryRef as string;
    }
    return report;
  }
  throw invalid(answer === undefined ? "undefined" : `a ${typeof answer} with no string \`text\``);
}

/** `deliveredAt` as the report will send it (see `timeValue`), or the error that names the hook. */
function timeOf(value: unknown): string {
  const time = timeValue(value);
  if (time !== undefined) return time;
  throw invalid(
    typeof value === "string"
      ? "a `deliveredAt` string that is not an RFC 3339 date-time (such as 2026-09-16T10:00:00Z)"
      : "a `deliveredAt` that is neither a valid Date nor an RFC 3339 date-time string",
  );
}

function invalid(what: string): GovernConfigError {
  return new GovernConfigError(
    `deliveredText must return a string, { text, deliveredAt?, deliveryRef? } or null (or a promise of one); it returned ${what}. No outcome was reported for the decision.`,
  );
}

/**
 * The report for what an adapter itself handed over: `released` with the
 * text, or `discarded` with `reason` when it handed over nothing.
 */
export function handedOver(text: string | null, reason: string): AdapterReport {
  return text === null || text === "" ? { kind: "discarded", reason } : { kind: "released", content: text };
}

/**
 * Make an adapter's report for a decision, for every decision, a retried or
 * superseded one included: what the caller says happened to it is its
 * record, and the API adds its own `superseded` event beside it when it
 * applies a `retryOf` or a `supersedes`.
 *
 * The report is in flight for `flushReports` from this call, and a failure
 * reaches `onFailure` (the adapter's isolated `onError`) as a
 * `GovernReportError` built from the body that was sent, inside that same
 * flight: `flushReports` resolves only after `onFailure` has run. The
 * returned promise settles then too, and never rejects.
 */
export function postReport(govern: Govern, decisionId: string, report: AdapterReport, onFailure: (error: unknown) => void): Promise<void> {
  const at = report.at ?? new Date();
  const input: ReportOutcomeInput =
    report.kind === "released"
      ? { kind: "released", at, content: report.content }
      : { kind: "discarded", at, reason: report.reason };
  if (report.deliveryRef !== undefined) input.deliveryRef = report.deliveryRef;
  return govern.reportForAdapter(decisionId, input, onFailure);
}

/**
 * A caller's `onError`, isolated. It runs inside floating promises and
 * stream callbacks, where a throw is an unhandled rejection, and a failure
 * hook that fails has nowhere left to report.
 */
export function failureReporter(onError: ((error: unknown) => void) | undefined): (error: unknown) => void {
  return (error) => {
    try {
      onError?.(error);
    } catch {
      // Nothing left to tell, and nowhere safe to tell it.
    }
  };
}

/**
 * Run a caller's callback (`onDecision`) where a throw from it would
 * otherwise decide what happens to a gated message: the throw goes to
 * `reportFailure`, a `failureReporter`, and nowhere else.
 */
export function callSafely(run: () => void, reportFailure: (error: unknown) => void): void {
  try {
    run();
  } catch (error) {
    reportFailure(error);
  }
}

/**
 * Whether a decision already has an outcome on record when the API answers:
 * a replayed turn, decided for an earlier draft, whose outcome was recorded
 * then. The adapters neither report it nor ask `deliveredText` about it.
 */
export function hasOutcomeOnRecord(decision: Pick<Decision, "outcome"> | null | undefined): boolean {
  return decision?.outcome?.state != null;
}
