# Streaming

Every chatbot streams, and a gate cannot approve text it has not seen. This page says what the SDK does about that before you hit it.

## The rule, per audience

**Patient audience: buffer and release.** The whole stream is held until the model finishes, the full text is evaluated once, and then one of two things is emitted: the original parts, replayed in order (allow), or the draft replaced (hold, block, or the API unreachable while the channel is in enforce): a single text block carrying the hold message when `showHoldText` is true, which is every hold on `web_chat` and `app_message`, and no text at all when it is false, which is an outbound channel (`sms`, `voice`, `email`) with no holding line owed. No token reaches the patient before the decision. The patient sees a typing state for as long as the model would have taken plus one round trip to the gate.

**Clinician audience: pass through with a trailing evaluation.** Tokens stream as they arrive. When the stream ends, the full text is evaluated and the outcome is recorded with the hash of what actually went out. If the gate would have substituted terms or held the message, the record says so and the reviewer sees it; the clinician already has the text. Use this only where the reader is a clinician by the channel's definition.

The same rule applies to `guard` when you stream yourself: collect the tokens, call `guard` with the full text, then send `reply.text`.

## The Vercel AI SDK adapter

```ts
const model = wrapLanguageModel({
  model: openai("gpt-4o"),
  middleware: withGovern({ govern, channel: "web_chat", audience: "patient" }),
});
```

`wrapStream` returns a new `ReadableStream` in front of the provider's:

- patient: reads the source to the end, accumulates the `text-delta` parts, calls `guard` with the joined text, then either enqueues every buffered part unchanged (allow) or enqueues the source's `stream-start` and `response-metadata` parts, then synthetic `text-start`, `text-delta` (the hold message), `text-end` when `showHoldText` is true (none of the three when it is false), then the original `finish` part. Tool-call parts are dropped on a hold: a tool call the gate did not see act on the patient's behalf is not something to let through beside a hold message.
- clinician: a `TransformStream` that forwards every part as it arrives and, on flush, calls `guard` with the accumulated text and reports the outcome with that text.

The decision is attached to the `finish` part as `providerMetadata.anybioGovern`:

```json
{ "decisionId": "...", "decision": "hold", "mode": "enforce", "held": true, "degraded": false, "reasons": ["prohibited_claim", "held_for_review"] }
```

If the source stream errors before it ends, the wrapped stream errors too and nothing buffered is emitted; an error part inside a completed stream is forwarded after the gated text.

## When the patient leaves

A patient closing the tab cancels the response stream, and a buffered turn is the one most likely to be cancelled: the whole generation happens before the first token. Cancelling the wrapped stream cancels the provider's stream through the reader that holds it, so the model stops generating rather than finishing a message nobody will read. Nothing buffered is emitted.

What the gate does depends on when the cancel lands. Before the evaluate call, there is no call: nothing was delivered, so there is nothing to gate or record. While the gate is deciding, the decision still lands on the record and the outcome is reported as **not delivered**, because the decision exists and nothing reached the patient; without that report the next turn on the conversation would auto-ack it as delivered. Nothing is enqueued after the cancel, and no callback of yours can turn any of this into an unhandled rejection: `onDecision` and `onError` are called inside a guard, and a throw from either is passed to `onError` and otherwise ignored.

A stream with no text (a tool call only) is passed through without an evaluate call.

## Rendering the held state

With `useChat` (or any UI over the AI SDK's UI message stream), a held turn on an in-session channel arrives as a normal assistant message whose text is the hold message. To style it differently, read the decision from the finish metadata on the server and forward it as a data part, or set `onDecision` on the middleware and write the decision id into your own message store. The example in `examples/vercel-ai-chatbot` does the first: the route handler passes `providerMetadata.anybioGovern` through as message metadata and the page renders a "held" badge with the decision id.

Show a typing indicator while the stream is pending; for a patient audience the first token arrives only after the decision, so the indicator is the whole wait. Keep it: a blank gap reads as a failure.

## LangChain

`governed(runnable, options).stream(input)` yields one chunk after the decision. `RunnableLambda` streams a non-streaming function's return value as a single item, and the wrapper's function awaits `invoke` on the inner runnable and gates the result, so buffer and release falls out of the shape. Token-level streaming through the wrapper is not supported for a patient audience by design; for a clinician audience, stream the inner runnable directly and use `GovernCallbackHandler` to record.

## The hold message

The hold message is set by your application: once on the client (`holdMessage`) or per call (`GuardContext.holdMessage`, or the adapters' `holdMessage`). The default:

> Thanks for your message. A person from our team will review it and follow up with you shortly.

Keep it true: a held message goes to the review queue, and someone does follow up when it is released or rejected. See hold resolution in the [README](../README.md#hold-resolution) for `waitForRelease` and the webhook.

## Latency

Enforce adds one round trip after the model finishes. The server bounds the gate at three seconds before it answers hold with `gate_unavailable`. Observe adds one round trip that returns on the 202 and does not wait for the gate. Streaming to a patient audience therefore costs the model's full generation time before the first token; there is no way around that which keeps the text gated.
