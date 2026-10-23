# @anybio/govern

The AnyBio Govern SDK for JavaScript and TypeScript.

Put one server-side call between the text your AI produced and the moment it reaches a patient. The gate evaluates the draft against your policy and returns allow, hold or block, with the record already written. Watch for two weeks in observe mode, then enforce policy by policy.

```ts
import { Govern } from "@anybio/govern";

const govern = new Govern({ apiKey: process.env.ANYBIO_GOVERN_KEY, application: "care-companion" });

const reply = await govern.guard(
  () => llm.chat(messages),
  { conversationId, turnId, channel: "sms", audience: "patient" },
);
if (reply.text !== "") await sendSms(patient.phone, reply.text);
```

`reply.text` is the draft when the gate allows it. When it does not, `reply.text` is the hold message when `reply.showHoldText` is true, and the empty string when nothing is owed to the patient: for a patient audience, always the hold message in an in-session channel (`web_chat`, `app_message`), and on an outbound channel (`sms`, `voice`, `email`) only when a holding line is owed. A clinician-audience hold always gets the hold message. See [in-session and outbound channels](#in-session-and-outbound-channels). `reply.decisionId` is the record. Call `reply.ack()` after you send; if you do not, the next turn in the same conversation reports the previous one for you.

Status: pre-1.0. The public surface may change in a minor version; see the CHANGELOG. Documentation: [developer.anybio.io](https://developer.anybio.io).

## Contents

- [Install](#install)
- [Framework adapters](#framework-adapters)
- [What comes back](#what-comes-back)
- [Modes](#modes)
- [Conversation and turn ids](#conversation-and-turn-ids)
- [When the API cannot be reached](#when-the-api-cannot-be-reached)
- [Route to a person](#route-to-a-person)
- [Consent, opt-out and the frequency cap](#consent-opt-out-and-the-frequency-cap)
- [Hold resolution](#hold-resolution)
- [The identity disclosure](#the-identity-disclosure)
- [Outcomes](#outcomes)
- [Streaming](#streaming)
- [The CLI](#the-cli)
- [Runtime support](#runtime-support)
- [Events](#events)
- [What the SDK covers](#what-the-sdk-covers)

## Install

```
npm install @anybio/govern
# or: pnpm add @anybio/govern
```

Or let the CLI detect your framework and print the exact lines:

```
npx @anybio/govern init          # prints; add --write to create the file
```

Set the application key from the console in your server's environment. It is a server-side secret: the constructor throws if it finds a browser `window` global.

```
ANYBIO_GOVERN_KEY=gk_...
```

Then run `npx @anybio/govern test-message`: it posts a synthetic draft and prints the decision, so you watch the gate hold a message with no PHI involved. More documentation is at [developer.anybio.io](https://developer.anybio.io).

## Framework adapters

The adapters are the install; the raw client is the escape hatch. Each ships as a subpath export and declares its framework as an optional peer dependency.

### Vercel AI SDK (`ai` v7)

```ts
import { wrapLanguageModel, streamText } from "ai";
import { withGovern } from "@anybio/govern/vercel-ai";

const model = wrapLanguageModel({
  model: openai("gpt-4o"),
  middleware: withGovern({ govern, channel: "web_chat", audience: "patient" }),
});

const result = streamText({
  model,
  messages,
  providerOptions: { anybioGovern: { conversationId: chatId, turnId: messageId } },
});
```

`wrapGenerate` evaluates the generated text before it is returned. `wrapStream` buffers a patient-audience stream and releases it whole after the decision, or replaces it; a clinician-audience stream passes through and is evaluated after it ends. A held draft is replaced by the hold message when `showHoldText` is true, and by no text at all when it is false, following [the channel rule](#in-session-and-outbound-channels): on `web_chat` and `app_message` the hold message always appears, on `sms`, `voice` and `email` only when a holding line is owed, so a caller that sends whatever the model returns sends nothing. The outcome is reported to match: delivered with the hold message, or not delivered. The decision lands in `providerMetadata.anybioGovern` (on the result, and on the `finish` part of a stream), with `sendHoldingLine`, `showHoldText` and `stopClass` beside it. Every evaluation names the model: `model` is the wrapped model's `modelId` (what you asked for, `gpt-4o`), and `model_version` is the model id the provider reported on the response (the resolved snapshot, `gpt-4o-2024-08-06`) when it reports one; the `model` and `modelVersion` options override either. The adapter imports only types from `ai`.

### LangChain (`@langchain/core` v1)

```ts
import { governed, GovernCallbackHandler } from "@anybio/govern/langchain";

const gated = governed(model, { govern, channel: "web_chat", audience: "patient" });
const message = await gated.invoke(messages, {
  configurable: { anybioGovern: { conversationId: threadId, turnId: messageId } },
});
```

Callbacks run beside the chain and cannot withhold text; by the time `handleLLMEnd` fires the output is on its way. So `governed` is the gating path: it invokes the wrapped runnable, evaluates the `AIMessage` (or string) it returns, and when the decision is not allow returns a message (or string) with `reply.text` in its place, with the decision in `response_metadata.anybio_govern`. Like `guard`, that text is the hold message when `showHoldText` is true and empty when it is false (an outbound channel with no holding line owed), and the outcome is reported to match. `GovernCallbackHandler` records a decision per generation and is the observe-mode install for chains you do not want to wrap. `configurable.thread_id` is read as the conversation id when nothing else names one.

Both name the model on every evaluation. `governed` sends the chat model's own `model` (or `modelName`) and, as the version, the model the provider reported in the message's `response_metadata` (`model_name` for OpenAI-shaped integrations, `model` for Anthropic-shaped ones). `GovernCallbackHandler` sends the model named at the run's start (`invocation_params.model`, else `ls_model_name`) and the version on the generation. The `model` and `modelVersion` options override either, which is the route for a chain whose runnable is not itself a chat model. `governed` writes `send_holding_line`, `show_hold_text` and `stop_class` into `response_metadata.anybio_govern` with the rest of the decision. `GovernCallbackHandler` renders no text of its own: it records what the chain already returned.

An output `governed` cannot read as text, such as the object a structured-output chain returns, is refused rather than passed through: a gate that cannot see the output must not imply it approved it, and the error arrives on the first call rather than in production. Pass `ungatedOutput: "pass"` for a chain whose text you gate somewhere else; it returns the output unevaluated and calls `onError` with the same error.

## What comes back

`evaluate` returns a `Decision`:

| Field | Meaning |
|---|---|
| `id` | The decision id. Null only when the channel is `off`. |
| `decision` | `allow`, `hold` or `block`. |
| `mode` | `observe` or `enforce` (or `off`). |
| `status` | `pending` (observe, evaluated off the request path), `decided`, `unavailable`, `not_evaluated`. |
| `wouldHave` | Observe only: the raw gate decision (`allow`, `rewrite`, `block_and_review`, `policy_missing`) or `unavailable`. |
| `reasons` | Codes, safe to log, never patient text. The gate's: `prohibited_claim`, `medication_instruction`, `missing_disclaimer`, `clinical_claim`, `review_required`, `patient_rewrite_withheld`, `rewritten`, `held_for_review`, `disclosure_missing`, `policy_missing`, `not_evaluated`, `gate_unavailable`. The patient's state, checked before the gate: `opted_out`, `consent_missing`, `consent_revoked`, `frequency_cap`, and `patient_state_unavailable` (always beside `gate_unavailable`) when that state could not be read. And the two only the SDK adds: `unknown_decision`, and `client_misconfigured` when the API refused the call. `REASONS` exports the set. |
| `disclosureRequired` | The policy demands the AI-identity disclosure and none is on record for the conversation. |
| `reviewUrl`, `reviewState` | The console deep link and `pending` / `released` / `rejected`, when the decision is in the review queue. |
| `deliverableContent` | Clinician audience only: the gate's term substitution to deliver. Never present for a patient audience, whatever the server sends. |
| `releasedContent` | Present once a reviewer released the held message: what to deliver. |
| `stopClass` | What kind of stop a stopped draft is: `never_sendable` (a deterministic rule matched the message itself, a prohibited claim or the medication-instruction floor; no reviewer can release it) or `uncertain` (held because nobody has read it yet; a reviewer can release it). In observe it describes the stop that would have been. Null when nothing was stopped. |
| `sendHoldingLine` | Send your holding line now. True at most once per decision id per `Govern` instance; see [the holding line](#the-holding-line). |
| `model`, `modelVersion` | The model and version you named for this turn, as recorded. Null when none was sent. |
| `routeToHuman` | A person is being routed to the patient because the inbound matched a red-flag rule. Distinct from `decision`: a clean draft can be `allow` with `routeToHuman: true`. |
| `handoff` | The hand-off task opened or joined (`id`, `state`, `version`, `queueLabel`, due times, `pausesAutomation`, `automationResumedAt`), when there is one. See [route to a person](#route-to-a-person) for whether it pauses automation. |
| `inboundFlags` | The red-flag rules the inbound matched: rule id and category, never text. |
| `webhookDeliveries` | The signed webhook deliveries about this decision: the delivery log (event, status, attempts), never the body. |
| `unknownDecision` | Set when the server sent a decision value this SDK version does not know; `decision` was then normalised fail closed and `degraded` is true. |
| `raw` | The wire object, typed from the OpenAPI document. |

A rewrite for a patient audience is a hold: the message goes to a person, and the SDK never receives rewritten text to send. For a clinician audience `guard` returns `deliverableContent` in place of the draft when the API supplies one.

`guard` returns a `GuardResult`: `text`, `decisionId`, `decision`, `mode`, `degraded`, `reasons`, `held`, `sendHoldingLine`, `showHoldText`, `stopClass`, `routeToHuman`, `handoff`, `inboundFlags`, `record` and `ack()`.

On an allow, `text` is the reply. On a hold, `showHoldText` says whether `text` is the hold message to show or send now; when it is false, `text` is the empty string, the one value `guard` uses for "send nothing". Deliver `text` when it is not empty and nothing otherwise, on every channel. For a patient audience, which of the two a hold gets depends on the channel: see [in-session and outbound channels](#in-session-and-outbound-channels). A clinician-audience hold always gets the hold message.

`evaluate` and `guard` take `model` and `modelVersion`: the model your application ran for the turn and its version. They are recorded as sent (the API has nothing to check them against), counted per pair in the observe report, and either may be sent without the other. A blank value is not sent. The adapters fill both for you.

**Unknown decision values fail closed.** If a server ever returns a decision value this version of the SDK does not know (a future outcome), `evaluate` does not throw: it keeps the value on `decision.unknownDecision` and `decision.raw.decision`, sets `degraded: true`, and normalises `decision` to `hold` in enforce and `allow` in observe or off. `guard` then delivers the hold message in enforce and the draft (flagged `degraded: true`) in observe, with `unknown_decision` appended to `reasons`. `route_to_human` is known: as a decision value it delivers the hold message and sets `routeToHuman`.

The hold message is what a patient sees on hold or block, when `showHoldText` is true. Set `holdMessage` on the client or per `guard` call; the default says that a person will follow up.

### The holding line

When a patient-bound draft is stopped, the patient is waiting on a reply that is not coming. The holding line is the fixed text your clinical owner wrote in advance, saying that a person will reply, when, and what to do if it is urgent. It is yours, never model-written, and the API never sends it for you; with `guard` it is the hold message, returned as `text`. The API decides when it is owed, and `sendHoldingLine` carries the answer:

```ts
const reply = await govern.guard(() => llm.chat(messages), { conversationId, turnId, channel: "sms", audience: "patient", patientRef });
if (reply.text !== "") await sendSms(patient.phone, reply.text);
// Equivalently: if (!reply.held || reply.showHoldText). On sms, showHoldText is sendHoldingLine.
```

- It is true on a patient-audience `hold` or `block`, including the fail-closed hold with `gate_unavailable` alone.
- It is false when another message would be the wrong thing rather than merely unnecessary: `opted_out`, `consent_missing`, `consent_revoked` and `frequency_cap` stop the turn because this patient should not be messaged, and `patient_state_unavailable` means none of that could be checked. It is false in observe, where nothing was stopped, and once a reviewer has released or rejected the hold.
- It is false when the SDK could not reach the API at all. That hold is the SDK's own fail-closed answer, and no patient state was read for it, which is the `patient_state_unavailable` case.

**At most one per decision.** The API's flag is a property of the decision and comes back on every read of it: a replayed `turnId`, `getDecision`, `waitForRelease`. The SDK arms it on the first read in a `Govern` instance that carries it and answers false on every later read, so a retried turn does not send the holding line twice. A new `turnId` is a new decision with its own answer. The memory is in process and bounded (the most recent 10,000 decisions); an application that runs more than one process, or restarts between the hold and a replay, records the send itself, keyed on `decisionId`. `record.raw.send_holding_line` keeps the API's own value, unfiltered.

The automatic outcome report follows what `guard` handed over: a hold that showed nothing is reported as nothing delivered, and a hold shown in session is reported as delivered with the hold message's hash, since the patient saw it. `ack()` defaults the same way. If you sent something anyway, say so with `reply.ack({ delivered: true, content })`.

### In-session and outbound channels

For a patient audience, what a hold hands the caller depends on where the patient is. The rule exists for contacting the patient (consent and patient state), so it applies to the patient audience only: a clinician-audience hold has `showHoldText` true and `text` the hold message on every channel, and `sendHoldingLine` is always false for it.

| Channel | On any hold or block | `showHoldText` | `text` |
|---|---|---|---|
| In-session: `web_chat`, `app_message` | The patient opened the session and is waiting in it. The hold message is the reply in that session, and consent does not govern a reply there. | Always true, including the fail-closed hold when the API cannot be reached, `patient_state_unavailable`, a released or rejected hold, and the do-not-message stops | The hold message |
| Outbound: `sms`, `voice`, `email` | A message goes out only when the API says a holding line is owed | Exactly `sendHoldingLine` | The hold message when true, `""` when false |
| Any other value | Treated as outbound: fail closed | Exactly `sendHoldingLine` | As outbound |

The one-per-decision rule above applies to `sendHoldingLine` only. Showing the hold message in session is a reply in the conversation, not a holding-line send, so a replayed turn shows it again: it is the same reply. `sendHoldingLine` is still reported beside it, for a caller that also sends the holding line somewhere else.

The classification is exported as `isInSessionChannel(channel)` (and the list as `IN_SESSION_CHANNELS`); `guard` and every adapter read it, and nothing else in the SDK classifies a channel. The API applies the same classification.

## Modes

Per policy, per application, set in the console: **off** (not evaluated, nothing recorded), **observe** (evaluated and recorded as would-have; you are always told allow), **enforce** (the decision is returned and binding). A new application starts in observe.

Observe is off your hot path: the server accepts the turn with 202 and evaluates after answering. The SDK returns as soon as the 202 arrives, with `decision: "allow"`, `mode: "observe"`, `status: "pending"` and the decision id. Enforce answers inline; the server bounds the gate at three seconds and answers hold with `gate_unavailable` if it does not decide in time. Flipping a policy to enforce is an audited event; the SDK's next call on that channel is synchronous.

Idempotency: `turnId` is sent as `Idempotency-Key`. A retry, or a replay with the same turn id, returns the stored decision and writes one record.

## Conversation and turn ids

`conversationId` and `turnId` are yours to choose, with two rules. The SDK checks both before it sends, and throws `GovernConfigError`; the API answers 400 if anything reaches it another way.

**`govern:` is reserved.** Turn ids starting with `govern:` belong to the rows the API writes about a conversation itself, the disclosure evidence among them. A `turnId` or `Idempotency-Key` in that range is refused. Only the prefix is reserved: `disclosure:conv-1` is yours to use, `govern:disclosure:conv-1` is not.

**Lengths are bounded.** `conversationId` is at most **187** characters and `turnId` at most **206**, counted in code points. Longer identifiers are refused. Anything you would pass through (a UUID, a message id from your channel, a thread id) is far inside both.

`turnId` is optional on `guard`, which mints a UUID when you leave it out. Supply your own message id when you want a retry to replay the same decision.

## When the API cannot be reached

`guard` applies fail semantics learned per channel from the last successful response:

| Last known mode for the channel | `guard` returns |
|---|---|
| `enforce`, or nothing learned yet (`assumeMode` defaults to `enforce`) | a hold: `decision: "hold"`, `degraded: true`, `reasons: ["gate_unavailable"]`, `decisionId: null`, `sendHoldingLine: false`. For a patient audience, on an in-session channel (`web_chat`, `app_message`) `text` is the hold message and `showHoldText` is true, because the patient is waiting in the session; on an outbound channel `text` is `""` and `showHoldText` is false: no patient state was read, so nothing goes out. For a clinician audience `text` is the hold message and `showHoldText` is true on every channel |
| `observe` or `off` (or `assumeMode: "observe"` before anything is learned) | the draft, `decision: "allow"`, `degraded: true` |

"Cannot be reached" means every attempt failed: a network error, a per-attempt timeout (`timeoutMs`, default 5000 ms), a 5xx or 429 after the retries (`maxRetries`, default 2, full-jitter backoff, `Retry-After` honoured and capped at 30 s), or a 4xx. The caller's own `AbortSignal` and local configuration errors are rethrown, never degraded.

`timeoutMs` bounds an attempt, not the call. With the defaults, three attempts of up to 5 s and two `Retry-After` waits capped at 30 s each, the worst case before `guard` holds is about 75 s. That is not the latency of a healthy call; if a call of yours needs a bound of its own, pass `ctx.signal`. An abort is rethrown rather than degraded, so what to send next is yours to decide, and for a patient audience that is the hold message in session and nothing on an outbound channel. Tighten `timeoutMs` and `maxRetries` if you would rather bound it globally.

### Which failure was it

The hold above is the same whatever went wrong, and it should be. What is not the same is who has work to do, so the signal says which:

| `reasons` | `cause` on the event | What it is | What to check |
|---|---|---|---|
| `gate_unavailable` | `gate_unavailable` | The API did not answer: a 5xx, a timeout, a dropped connection, a 429 that outlived its retries | Nothing, usually. It heals on its own. Alert if it persists |
| `client_misconfigured` | `client_misconfigured` | The API answered and refused the call, and would refuse it again: a revoked or wrong application key, a key not bound to the application, a request the server will not accept | Your own configuration. **This does not heal.** Every message from that process holds until someone acts |

Rotating a key and missing one deployment produces the second: that process holds every patient message until the key is fixed.

Treat them as different alerts. `gate_unavailable` is a rate to watch; a single `client_misconfigured` should page whoever owns the deployment.

A 4xx is the caller's except `408` and `429`, which say "later" rather than "no": 429 is rate limiting the transport already retried, and 408 is the server giving up on the request, which is the same class of event as a client-side timeout. A failure the SDK does not recognise is reported as `gate_unavailable`. `isClientMisconfiguration(error)` and `TRANSIENT_HTTP_STATUSES` are exported if you want to make the same split around your own `evaluate` calls.

Every degraded reply emits `onEvent({ type: "degraded", mode, modeSource: "learned" | "assumed", cause, status, error })`, where `status` is the HTTP status when the API answered and `null` for a timeout or a transport failure.

**Both still hold in enforce.** This changes what an operator is told, not what reaches a patient.

`evaluate` itself throws (`GovernApiError`, `GovernConflictError` for 409, `GovernNetworkError`, `GovernTimeoutError`, `GovernAbortError`); only `guard` degrades. No error message ever contains the draft.

To carry the learned mode across processes, read `govern.lastKnownMode(channel)` and seed a new client with `govern.rememberMode(channel, mode)`.

## Route to a person

Pass the patient's inbound message on `evaluate` or `guard` (`inbound: { content, receivedAt }`, with `patientRef`) and the gate screens it against the application's red-flag rules before it evaluates the draft. A match opens (or joins) a hand-off task on your team and the decision says so:

```ts
const result = await govern.guard(() => llm.chat(messages), {
  conversationId, turnId, channel: "sms", audience: "patient", patientRef,
  inbound: { content: inboundText, receivedAt: new Date() },
});
await sendSms(patient.phone, result.text);
if (result.routeToHuman) {
  await sendSms(patient.phone, "A member of your care team will contact you shortly.");
  await yourOwnSignal(result.handoff?.id);
}
```

Routing is distinct from the outbound decision. A clean draft is `allow` with `routeToHuman: true`: the draft goes out and a person is routed beside it. A draft the policy holds is `hold` with `routeToHuman: true`: `text` follows `showHoldText` as on any hold, and a person is routed. In observe mode the record carries `wouldHaveRouted` instead. A replay of the same `turnId` returns the same decision and opens no second task; one open task exists per patient.

**A hand-off that a person owns does not always pause automation.** Every hand-off says whether it also pauses automated messaging to the patient while a person works it: `pausesAutomation` on `HandoffRef` (as on `decision.handoff` and `result.handoff`), `pauses_automation` on a wire hand-off row and on hand-off webhook events. A red flag, an exhausted budget, a missing policy, an unknown wire outcome and the route-to-human path all pause; an item that only owes the patient a reply does not. Automation is paused while `pausesAutomation` is true and `automationResumedAt` is null; a null `automationResumedAt` alone says only that a person owns the item. `isAutomationPaused(handoff)` applies exactly that rule to a `HandoffRef` or a wire row, so read it rather than `automationResumedAt` before sending anything automated to that patient:

```ts
if (isAutomationPaused(result.handoff)) {
  await pauseYourOwnOutreach(patientRef);
}
```

The pause survives resolution: it ends only when a person releases it (`resume`, or `resolve` with `resumeAutomation: true`), which sets `automationResumedAt` and sends `handoff.resumed`. A server that predates `pauses_automation` reads as paused while not resumed, which is what every open hand-off meant then.

The task itself is on `govern.handoffs`: `list(query)` and `get(id)` work with the application key and see only this application's hand-offs. `claim`, `contactAttempt`, `resolve` and `resume` take `expectedVersion` (the version you last read; a stale one is refused with `GovernConflictError`) and are staff actions: the API refuses an application key on them with 403, so they are here for a server that presents a staff credential. Actions are never retried. `list` also returns `awaitingReply`: the ids of the hand-offs on the page that carry a stopped draft nobody has answered yet. A patient has one open item, so a stop joins whatever the patient already has, and the item keeps the reason it was opened for; `awaitingReply` says what it now also owes.

## Consent, opt-out and the frequency cap

Before the gate reads a word of the draft, the turn passes the patient's own state. A turn stopped here is stopped whatever the draft says, and nothing of the draft is kept.

| What is on record | Decision | Reason |
|---|---|---|
| The patient opted out (a STOP keyword in the inbound, or a report from you) | `block`, on every channel | `opted_out` |
| No `granted` consent, on a channel that requires one | `block` | `consent_missing` |
| The consent on record was revoked | `block`, on every outbound channel | `consent_revoked` |
| Over the application's cap in the current window | `hold` | `frequency_cap` |

`sms`, `voice` and `email` require consent by default; `app_message` and `web_chat` do not. A per-channel override lives on the application beside the channel's mode, and `consent_required_channels` on the application reads back the resolved answer. A turn that carries the patient's `inbound` is answering something the patient sent, so a *missing* consent does not stop it; a revocation still does, on every outbound channel. A clinician audience is never consulted about consent, which is the rule about contacting the patient.

Observe never blocks: each of these is recorded as the `wouldHave` and you are still told allow.

You record the events; the API enforces the state you gave it. AnyBio is not the system of record for consent.

```ts
await govern.recordPatientConsent({ patientRef, state: "granted", channel: "sms" });
await govern.recordPatientOptOut({ patientRef, optedOut: true });
const state = await govern.getPatientState(patientRef);
```

The patient's word outranks yours: an opt-out that came from a STOP keyword can only be lifted by a START from the patient, not by a report from your application.

## Hold resolution

A hold sits in the review queue until a person releases or rejects it. Two paths:

**Poll.** `await govern.waitForRelease(decisionId, { timeoutMs: 15 * 60_000 })` polls `getDecision` with backoff (1 s doubling to 15 s) and resolves `{ state: "released", content }`, `{ state: "rejected" }`, `{ state: "not_held" }` for a decision that was allowed, `{ state: "blocked" }` for a block no reviewer will lift, or `null` on timeout. Pass `signal` to abort.

**Webhook.** The application's endpoint receives a signed `POST` per state change. Verify and parse it with the SDK:

```ts
const event = await govern.handleWebhook(rawBody, request.headers, process.env.ANYBIO_GOVERN_WEBHOOK_SECRET);
if (event.type === "decision.released") await deliver(event.releasedContent);
```

Verify the raw body, not a re-serialised one. The signature is `v1=` followed by the hex HMAC-SHA256 of `"{X-Govern-Timestamp}.{body}"` with the application's webhook secret; deliveries older than 300 s are refused. Two error classes, because a handler owes them different answers: a delivery that fails to verify raises `GovernWebhookError`, which is the 400 you return, and a call that could never have verified anything raises `GovernConfigError` (no secret, a tolerance that is not a window, a clock that does not return a time, a body that has already been through `JSON.parse`). The second one is yours to fix; answering 400 to it would tell the sender their signature is wrong when it is not. A verified `decision.released` or `decision.rejected` wakes any `waitForRelease` on the same decision at once. Decision events carry `model`, `modelVersion` and `stopClass` as the decision recorded them; hand-off events carry `pausesAutomation`. `handleWebhook` and `verifyWebhookSignature` are also exported as standalone functions.

## The identity disclosure

The gate refuses patient-facing content on a channel that requires the AI disclosure when no disclosure evidence is on record. Record it once per conversation, when the session starts:

```ts
const { ref } = await govern.recordDisclosure({
  conversationId,
  channel: "web_chat",
  textShown: "You are chatting with an AI assistant. A person reviews held messages and can be reached at any time.",
});
```

The SDK remembers the `ref` per conversation and attaches it to every later `evaluate`. If you record the disclosure in one process and evaluate in another, `govern.rememberDisclosure(conversationId, ref)` seeds the cache. `disclosureRequired: true` on a decision means the policy demands the disclosure and none is on record for the conversation.

**A presented `ref` must be the conversation's own.** The API answers every turn on the evidence it holds for that `conversationId`, so the reference you send decides nothing: send the right one and it agrees, send another conversation's, another application's, an empty or a malformed one, and it is **ignored, never refused**. The turn is evaluated, and if the conversation has no evidence of its own it comes back `disclosureRequired` with `disclosure_missing`. Nothing is gained by attaching one by hand, and a borrowed reference cannot stand in for a disclosure that was never shown. This is also why the SDK sends what you give it without checking the shape.

**Recording twice is safe, and the second answer describes the first.** `recordDisclosure` is idempotent per conversation: the first call creates the evidence and answers 201, a later call answers 200 and describes **the evidence on record**: its `channel`, its `evidenceId`, the time it was recorded, not the call you just made. Read `created` to tell them apart, and read `channel` and `recordedAt` off the result rather than assuming they echo your request.

## Outcomes

What you delivered is part of the record: proposed, decided, delivered. `reportOutcome(decisionId, { delivered: true, content })` hashes `content` with SHA-256 locally and sends only the hash; the text never leaves your server. One outcome per decision: the same report again is accepted, a different one is refused with 409.

With `guard`, `reply.ack()` does this for you with the text it returned. If you never call `ack()`, the next `guard` call for the same conversation reports the previous turn as `delivered: true` with the hash of the text it returned, at the time it returned it (or `delivered: false` for a hold with `showHoldText` false, where `text` was empty); a late `ack()` after that is a no-op. `govern.flushPendingAcks()` reports everything still held; call it on shutdown. The automatic report is best effort and `ack()` is the reliable route: a conversation holds one pending outcome, so an automatic write that fails after a newer turn has taken that place is dropped rather than queued behind it. It costs a row in the record, never a verdict and never a word of returned text. The adapters report the outcome themselves (`reportOutcome: true` by default) with the text they let through, or as not delivered when they let nothing through.

## Streaming

A gate cannot approve text it has not seen. For a patient audience the rule is buffer and release: the patient sees a typing state, then the gated message; no token reaches them before the decision. For a clinician audience the stream may pass through with a trailing evaluation. The Vercel AI adapter's `wrapStream` implements both; `governed(...).stream()` yields one chunk after the decision. On a hold, tool-call parts are dropped rather than passed through beside the hold message. A stream the caller cancels while the gate is deciding is reported as not delivered. For a patient audience the first token arrives only after the decision, so show a typing indicator for the whole wait.

## The CLI

```
npx @anybio/govern init [--write] [--dir <path>] [--channel <c>] [--audience <a>]
npx @anybio/govern test-message [--channel <c>] [--audience <a>] [--base-url <url>] [--content <text>]
npx @anybio/govern decision <id>
```

`init` reads `package.json`, detects the Vercel AI SDK or LangChain, and prints the install command, the environment variable and the file to add. It writes nothing unless you pass `--write`, and then it creates `lib/govern.ts` (or `src/lib/`) and appends the variable names to `.env.example`; it never edits an existing source file. `test-message` posts a synthetic draft that names a cure and a medication change, records a disclosure for the throwaway conversation first, and prints the decision: in observe you see the would-have block, in enforce you see the hold. `decision <id>` fetches a decision and its review state.

Environment: `ANYBIO_GOVERN_KEY` (required), `ANYBIO_GOVERN_APPLICATION` (optional), `ANYBIO_GOVERN_BASE_URL` (optional; for example a local mock server).

## Runtime support

Node 20 and later, and edge runtimes; CI runs the suite on Node 20 and 22. `engines.node` is `>=20` and that is the floor for every entry point in this package, the vercel-ai one included: the middleware imports `ai` for types only, so nothing in this package needs a newer runtime. Your floor is the higher of this package's and your framework's. `ai` 7 declares `engines.node` `>=22` itself, so a Vercel AI SDK project is a Node 22 project and npm and pnpm will tell you so at install; `@langchain/core` 1 declares `>=20`. The core path uses `fetch` and Web Crypto only and imports no Node module at the top level; where `globalThis.crypto` is absent it falls back to `node:crypto` through a dynamic import that bundlers do not follow. ESM and CommonJS builds ship with type declarations. The CLI is Node only.

## Events

`onEvent` receives `request`, `response`, `retry`, `decision`, `degraded`, `outcome` and `error` events with ids, codes, statuses and durations. No event carries message content, and neither does any error message: an error's text is built from the HTTP status and the server's machine-readable `kind`. Log them freely.

The server's own error text is the one thing held back from that. The evaluate 400 covers invalid content and the API document declares no schema for the body, so the SDK cannot promise what is in it; it is kept off `.message` and out of every event, and parked on `GovernApiError.serverMessage`. Read it when you are debugging one call, and treat what comes back the way you treat the message it was about.

The hook is telemetry and is treated as such: every call is isolated, so a callback that throws cannot change a verdict, fail a request or escape `guard`. The throw comes back as an `error` event with `operation: "on_event"`; a callback that throws on that one too is left alone. The adapters treat their own `onDecision` and `onError` callbacks the same way.

## What the SDK covers

Every Govern surface the API exposes. The types are generated from `spec/openapi.json`, which ships in the package.

| SDK surface | What it is |
|---|---|
| `guard`, `evaluate`, `getDecision`, `waitForRelease`, mode learning | The gate: evaluate a draft, read a decision, wait for a held one |
| `sendHoldingLine`, `stopClass` on decisions and on `GuardResult` | When the patient is owed your holding line (at most once per decision), and whether a stop can ever be released |
| `showHoldText` on `GuardResult`, `isInSessionChannel` | Whether a hold's `text` is to be shown: for a patient audience, always in session (`web_chat`, `app_message`), exactly `sendHoldingLine` on an outbound or unknown channel; always for a clinician audience |
| `model`, `modelVersion` on `evaluate` and `guard`, filled by every adapter | The model and version each turn ran on, as recorded |
| `reportOutcome`, `ack()` | What you delivered, as part of the record |
| `recordDisclosure`, `rememberDisclosure`, `disclosureRef` | The AI-identity disclosure, per conversation |
| `recordPatientConsent`, `recordPatientOptOut`, `getPatientState` | The patient's state the gate checks first |
| `submitTranscripts`, `getTranscriptJob`, `getTranscriptJobTurns` | Observe-only ingest of past conversations |
| `handleWebhook`, `verifyWebhookSignature`, `listWebhookDeliveries` | Signed delivery of hold and hand-off resolution |
| `inbound` on `evaluate` and `guard`; `routeToHuman`, `handoff`, `inboundFlags`, `wouldHaveRouted`; `govern.handoffs.*` | The red-flag screen and the hand-off on your team (the four hand-off actions need a staff credential) |
| `pausesAutomation` on hand-offs, `isAutomationPaused`, `awaitingReply` on `govern.handoffs.list` | Whether a hand-off pauses automated messaging to the patient, and which items still owe a reply |

## Maintainers

Maintained by AnyBio Engineering (platform@anybio.io). Documentation and the developer portal: [developer.anybio.io](https://developer.anybio.io).

## License

Apache License 2.0. See `LICENSE` and `NOTICE`.
