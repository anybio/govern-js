# Changelog

All notable changes to `@anybio/govern` are recorded here. The format follows Keep a Changelog; versions follow Semantic Versioning. Until 1.0.0, a minor version may change the public surface.

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
