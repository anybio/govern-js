# Changelog

All notable changes to `@anybio/govern` are recorded here. The format follows Keep a Changelog; versions follow Semantic Versioning. Until 1.0.0, a minor version may change the public surface.

## 0.3.0

0.3.0 changes the outcome report and the decision's outcome, so this minor version changes the public surface. It needs an API that records the outcome event trail. `turnRef` and `supersedes` take effect once the API accepts them and are ignored before that. The README and `spec/openapi.json` carry the field rules.

### Breaking

- The outcome is an event trail. `reportOutcome(decisionId, input)` records one event, `{ kind, at, content | contentHash, deliveryRef?, reason? }`, with `kind` one of `released`, `delivered`, `discarded` or `failed`. `delivered: boolean` and `deliveredAt` are gone. `released` and `delivered` carry the SHA-256 of the text; `discarded` and `failed` carry none. Every field is checked before the request is sent; a slip is a `GovernConfigError` that names it.
- One event per kind per decision, `failed` excepted. The same event again resolves with the decision; a different event of a kind already on record is the API's 409, `GovernConflictError`.
- `Decision.outcome` is `{ state, events, raw }` or null. `state` is derived by the API from the trail. A server that predates the trail maps to null.
- `guard` reports no outcome. `GuardResult.ack()`, `AckOptions` and the automatic report the next `guard` made are removed; record what you wrote with `reportOutcome`. `flushPendingAcks()` is now `flushReports()`.
- The adapters (`withGovern`, `governed`, `GovernCallbackHandler` with `reportOutcome: true`) record `released` with the hash of the text they hand over, or `discarded` with a reason when nothing went out. Recording `delivered` is yours, from the channel's confirmation.
- A report an adapter made that did not land reaches `onError` as a `GovernReportError`, carrying the decision id and the event as it was sent, so the same event can be passed back to `reportOutcome`.
- A 409 on `evaluate` degrades with reason and cause `turn_conflict`, no longer `client_misconfigured`; the reply still holds in enforce.
- The `outcome` event is `{ type: "outcome", decisionId, kind }`. `delivered` and `auto` are gone.

### Added

- `turnRef` and `supersedes` on `evaluate`, `guard` and the adapters, sent as `turn_ref` and `supersedes`. `turnRef` is your stable reference for the patient turn, the same on every draft of it (`MAX_TURN_REF_CHARS`, 128). `supersedes` names up to `MAX_SUPERSEDES` (8) decisions this turn replaces; each must belong to the turn's `patientRef`. The API refuses another patient's decision with 400, and with 409 one still being decided, delivered, acted on by a reviewer, or already superseded or retried.
- `retryOf` on `evaluate` and `guard`, sent as `retry_of`: the decision a new draft retries. The API answers a retry of a superseded, retried, delivered or reviewer-acted decision with 409, and one that was never retryable or belongs to another patient with 400. `retryable` and `retryOf` on `Decision`.
- `showHoldText` on `Decision` and `GuardResult`, following the API's `show_hold_text` when the decision carries it, else the channel rule.
- `gateSignal` on `guard`, and a per-call `signal` on the adapters, bounding the gate call alone. When it fires, the unreachable-API rule applies: a hold in enforce, a `degraded` draft in observe, `gate_unavailable` as the reason. A buffered patient stream whose gate call aborts releases the hold message in place of the draft. The generation's own abort signal is never passed to the gate, so a cancel never becomes a hold.
- `deliveredText` on the adapters: tell the adapter what actually went out, and its one report carries that. `null` or empty text records `discarded`.
- Types: `OutcomeKind`, `ReportedOutcomeKind`, `OutcomeSource`, `OutcomeEvent`, `WireOutcomeEvent`, `OUTCOME_REASONS`, `GovernReportError`, `DeliveredText` and `DeliveredMessage`; `turn_conflict` in `REASONS`.
- `spec/openapi.json` and the generated types follow the current API document. A field the document requires but an older server omits is optional in the exported types.

### Changed

- `governed` resolves the call's context before the wrapped runnable runs, as `withGovern` does before the model. A run that cannot be gated fails with `GovernConfigError` before the model runs.
- An empty or blank `holdMessage` is refused with `GovernConfigError`.
- `reportOutcome: false` on an adapter means it records nothing.
- `voice` is an in-session channel for the hold rule, with `web_chat` and `app_message`; `sms` and `email` stay outbound. `voice` still requires a consent by default.
- For a server that predates `show_hold_text`, a hold a reviewer has released or rejected shows nothing.

### Fixed

- A replayed turn whose decision already has an outcome on record is closed: no holding line is armed and no second report is made.
- `governed` no longer reports a cancelled run as delivered. It records `discarded` (`cancelled`) and throws.
- A `withGovern` buffered stream cancelled from inside `onDecision` records exactly one outcome.
- `flushReports()` waits for every report from the moment it is made, and a failed report has reached `onError` before it resolves.
- An error thrown by an adapter is an instance of the classes the root entry point exports, so `instanceof` and `isGovernError` hold across entry points.

## 0.2.2

No change to the SDK. Built and published from github.com/anybio/govern-js with a provenance statement.

## 0.2.1

First public release.

### Added

- `Govern` client: `evaluate` (idempotent by `turnId`; observe answers 202 with allow at once; retries on 429 with `Retry-After`, 5xx, timeouts and network failures), `getDecision`, `reportOutcome` (SHA-256 of the delivered text, computed locally), `recordDisclosure` (the `ref` is attached to later evaluates for the conversation), `waitForRelease` (polls with backoff; a verified webhook wakes it), `handleWebhook`.
- `guard(fn, ctx)`: the draft on allow, the hold message or nothing on hold or block, the clinician substitution when supplied. Fails closed in enforce and fails open, flagged `degraded`, in observe, with the mode learned per channel. `ack()` reports the outcome, and the next turn in the conversation reports it automatically if you do not.
- The holding line: `sendHoldingLine` on `Decision` and `GuardResult` says the patient is owed your fixed holding line now. The SDK arms it at most once per decision id per `Govern` instance. The memory is in process and bounded to the most recent 10,000 decisions; an application that runs more than one process records the send itself, keyed on `decisionId`. It is never true on an allow, a clinician audience, a released or rejected hold, a stop carrying `opted_out`, `consent_missing`, `consent_revoked`, `frequency_cap` or `patient_state_unavailable`, or a hold the SDK produced because the API could not be reached.
- The channel rule: `showHoldText` on `GuardResult`. For a patient audience, in-session channels (`web_chat`, `app_message`) show the hold message on every hold or block; outbound channels (`sms`, `voice`, `email`) and unknown channel values follow `sendHoldingLine`, and `text` is the empty string when nothing is owed. A clinician-audience hold always shows the hold message. `isInSessionChannel` and `IN_SESSION_CHANNELS` are exported.
- `stopClass` on `Decision` and `GuardResult`: `never_sendable` (no reviewer can release it) or `uncertain` (a reviewer can).
- `model` and `modelVersion` on `evaluate` and `guard`, recorded on the decision and counted in the observe report. Every adapter fills both.
- Route to a person: `inbound` on `evaluate` and `guard`; `routeToHuman`, `handoff`, `inboundFlags` and `wouldHaveRouted` on decisions; `govern.handoffs` (`list`, `get`, `claim`, `contactAttempt`, `resolve`, `resume`) with `expectedVersion`, and 409 mapped to `GovernConflictError`. `pausesAutomation` and `isAutomationPaused` say whether a hand-off pauses automated messaging; `awaitingReply` lists the hand-offs that still owe a reply.
- Consent, opt-out and the frequency cap: `recordPatientConsent`, `recordPatientOptOut`, `getPatientState`, and the reason codes the API returns when the patient's state stops a turn.
- Transcripts and webhooks: `submitTranscripts`, `getTranscriptJob`, `getTranscriptJobTurns`, `listWebhookDeliveries`, `verifyWebhookSignature`. Webhook configuration mistakes (no secret, a tolerance that is not a window, a parsed body) raise `GovernConfigError`, distinct from `GovernWebhookError` for a delivery that fails to verify.
- `guard` tells a refused call apart from an outage: `client_misconfigured` for a 4xx the API would refuse again (other than 408 and 429), `gate_unavailable` otherwise. Both hold in enforce. `isClientMisconfiguration` and `TRANSIENT_HTTP_STATUSES` are exported.
- Unknown decision values fail closed: `unknownDecision` keeps the value, and `decision` is normalised to hold in enforce and allow in observe.
- Identifiers are checked before the request: `turnId` outside the reserved `govern:` prefix, `conversationId` at most 187 code points and `turnId` at most 206, each refused with `GovernConfigError`.
- No callback can change a verdict: `onEvent` and the adapters' `onDecision` and `onError` run isolated, and a throw comes back as an `error` event.
- No event and no error message carries message content. The server's own error text is on `GovernApiError.serverMessage` only.
- Writes the transport retries carry an idempotency key by default, so a retried write is recorded once.
- `@anybio/govern/vercel-ai`: middleware for `ai` v7, with buffer and release for a patient-audience stream and a trailing evaluation for a clinician audience. Cancelling a buffered stream stops the provider's generation.
- `@anybio/govern/langchain`: the `governed` runnable wrapper (gates) and `GovernCallbackHandler` (records). `governed` refuses an output it cannot read as text unless `ungatedOutput: "pass"` is set.
- CLI: `init`, `test-message`, `decision`.
- Wire types generated from `spec/openapi.json`, which ships in the package.
- ESM and CommonJS builds with type declarations; Node 20 and later, and edge runtimes.
