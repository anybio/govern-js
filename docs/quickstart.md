# Quickstart: your first held message in fifteen minutes

You will put the gate between your AI and a patient-facing channel, send one synthetic message that a policy must not let through, and watch the gate hold it. No hardware, no PHI, no real patient: the draft is synthetic and the conversation is a throwaway.

## Before you start

<details>
<summary>An application and its key</summary>

In the console, create an application for the integration (one per AI you run). The key is shown once. It is a server-side secret: keep it in your server's environment and never in a browser bundle or a mobile app.

```
ANYBIO_GOVERN_KEY=gk_...
ANYBIO_GOVERN_APPLICATION=<the application id, or any label>
```

A new application starts in observe mode on every channel. For this walkthrough, switch the `web_chat` channel to **enforce** so the hold is visible in the response itself. Observe works too; you then read the would-have decision from the record instead.

</details>

<details>
<summary>A policy on the channel</summary>

The channel needs an active policy. The sandbox's synthetic policy prohibits one claim (a cure claim) and requires the AI-identity disclosure; the synthetic draft the CLI sends contains that claim. If your policy differs, pass your own draft with `--content`.

With no active policy the gate fails closed: enforce answers hold with `policy_missing`, observe answers allow with `would_have: policy_missing`. You will still see a decision, just not the one this walkthrough describes.

</details>

<details>
<summary>Node 20 or later, and a package manager</summary>

Node 20 or later for the SDK; Node 22 or later if you use the Vercel AI SDK adapter, because `ai` 7 requires it. `pnpm`, `npm`, `yarn` and `bun` all work; the CLI prints the command for the one your project uses.

</details>

<details>
<summary>No server yet? Use the mock</summary>

`examples/mock-server` is a small Node script that implements evaluate, decisions, outcomes and disclosures with a synthetic policy that blocks one phrase. Start it with `node examples/mock-server/server.mjs` and set `ANYBIO_GOVERN_BASE_URL=http://localhost:8787`. Every step below then runs against it with any `gk_` key.

</details>

## Step 1: install and set the key

```
npm install @anybio/govern
export ANYBIO_GOVERN_KEY=gk_...
```

Or let the CLI look at your `package.json` and print the exact lines for your framework:

```
npx @anybio/govern init
```

It prints and writes nothing. Add `--write` when you are happy with what it shows.

## Step 2: add one line at model setup

Pick your framework.

<details open>
<summary>Vercel AI SDK</summary>

```ts
// lib/govern.ts
import { Govern } from "@anybio/govern";
import { withGovern } from "@anybio/govern/vercel-ai";
import { wrapLanguageModel } from "ai";

export const govern = new Govern({
  apiKey: process.env.ANYBIO_GOVERN_KEY!,
  application: process.env.ANYBIO_GOVERN_APPLICATION ?? "care-companion",
});

export const gate = (model: Parameters<typeof wrapLanguageModel>[0]["model"]) =>
  wrapLanguageModel({ model, middleware: withGovern({ govern, channel: "web_chat", audience: "patient" }) });
```

```ts
// app/api/chat/route.ts
const result = streamText({
  model: gate(openai("gpt-4o")),
  messages,
  providerOptions: { anybioGovern: { conversationId: chatId, turnId: lastMessageId } },
});
```

</details>

<details>
<summary>LangChain</summary>

```ts
import { Govern } from "@anybio/govern";
import { governed } from "@anybio/govern/langchain";

export const govern = new Govern({
  apiKey: process.env.ANYBIO_GOVERN_KEY!,
  application: process.env.ANYBIO_GOVERN_APPLICATION ?? "care-companion",
});

const gated = governed(model, { govern, channel: "web_chat", audience: "patient" });
const message = await gated.invoke(messages, {
  configurable: { anybioGovern: { conversationId: threadId, turnId: messageId } },
});
```

</details>

<details>
<summary>Raw client (any framework, any language model)</summary>

```ts
import { Govern } from "@anybio/govern";

const govern = new Govern({ apiKey: process.env.ANYBIO_GOVERN_KEY!, application: "care-companion" });

const reply = await govern.guard(
  () => llm.chat(messages),
  { conversationId, turnId, channel: "web_chat", audience: "patient" },
);
await send(reply.text);
await reply.ack();
```

</details>

Once per conversation, when the session starts, record the AI-identity disclosure you showed:

```ts
await govern.recordDisclosure({
  conversationId: chatId,
  channel: "web_chat",
  textShown: "You are chatting with an AI assistant. A person reviews held messages and can be reached at any time.",
});
```

The SDK attaches the returned `ref` to every later `evaluate` for that conversation, so you never handle it. Two things worth knowing rather than discovering: calling it again for the same conversation is safe and answers 200 describing **the evidence already on record** (`created: false`, and its channel and time, not the ones you just sent); and a `disclosure.ref` you attach by hand that is not this conversation's own reference is **ignored, never refused**, so a turn in a conversation that was never disclosed to still comes back `disclosureRequired`.

`conversationId` is bounded at 187 characters and `turnId` at 206, and `turnId` may not start with `govern:`. The SDK throws `GovernConfigError` before sending; see [Conversation and turn ids](../README.md#conversation-and-turn-ids).

## Step 3: send a test message

```
npx @anybio/govern test-message
```

The CLI records a disclosure for a throwaway conversation, posts a synthetic draft that names a cure and tells the patient to stop a medication, and prints the decision:

```
decision id     6f1c...
mode            enforce
status          decided
decision        hold
reasons         prohibited_claim, held_for_review
policy          synthetic v1
review          https://.../reviews?id=6f1c...

Enforce mode: the gate held the draft. You just watched the gate hold a message.
```

**You just watched the gate hold a message.** The record exists (the console shows it in the review queue with the original text beside the reasons), the draft never reached anyone, and your application received the hold message to show instead.

In observe mode the output reads `decision: allow` with `would have: block_and_review`: you were told allow, and the record shows what the gate would have done. That is the would-have block; two weeks of those is the observe report.

Now send a normal message through your own application and check the console: the decision row appears, and `reply.ack()` (or the adapter) records what you delivered.

## If your first request fails

| What you see | What it means | What to do |
|---|---|---|
| `GovernConfigError: ... must not run in a browser` | The client was constructed where a `window` global exists. | Move the call to a server route, an edge or serverless function. Never ship the key to a browser. |
| `401` | No credential reached the API. | Check `ANYBIO_GOVERN_KEY` is set in the process that runs the call, and that it is sent as `Authorization: Bearer`. The SDK does this; a proxy may strip it. |
| `403 ... accepts a Govern application key only` | The key is not an application key (`gk_...`): a developer key, a session, or a publishable SDK token. | Create an application in the console and use the key it shows. |
| `403 ... not bound to the named application` | `application` is a UUID of a different application, or the key belongs to the other environment (sandbox versus production). | Use the id of the application the key was minted for, or a plain label. |
| `400 audience 'clinician' is not allowed on channel 'sms'` | `sms` and `voice` reach the patient's own handset; only a patient audience is accepted there. | Use `audience: "patient"`, or a channel that admits a clinician audience (`app_message`, `web_chat`, `email`). |
| `400 Idempotency-Key must equal turn_id` | A proxy or your own code set the header to something else. | Let the SDK set it from `turnId`. |
| `GovernConfigError: turnId must not start with "govern:"` | That prefix names the rows the API writes about a conversation itself. | Use any other value. Only the prefix is reserved: `disclosure:conv-1` is fine. |
| `GovernConfigError: conversationId must be at most 187 characters` (or `turnId ... 206`) | The API composes each stored reference from your identifier and the column is bounded. | Shorten the identifier, or pass an opaque id (a UUID) and keep your longer key in `metadata`. |
| `decision: block`, `reasons: [consent_missing]` | The channel requires a `granted` consent and none is on record for this patient. | Record it with `recordPatientConsent`, or pass the patient's `inbound` if the turn answers something they sent. |
| `decision: block`, `reasons: [consent_revoked]` or `[opted_out]` | The patient revoked consent or opted out. | Nothing to fix here. An opt-out from a STOP keyword lifts only on a START from the patient. |
| `decision: hold`, `reasons: [frequency_cap]` | The patient is over the application's cap for the current window. | Expected back-pressure. Raise the cap on the application, or send fewer messages. |
| `decision: hold`, `reasons: [policy_missing]` | The channel has no active policy. Enforce fails closed. | Activate a policy on the channel (or the organisation default) in the console. |
| `decision: allow`, `wouldHave: policy_missing` | Same, in observe mode. | Same. |
| `disclosureRequired: true` | The policy requires the AI-identity disclosure and none is on record for this conversation. | Call `recordDisclosure` once per conversation before the first evaluate. `test-message` does this for you unless you pass `--skip-disclosure`. |
| `status: not_evaluated`, `decisionId: null` | The channel is `off` for the application. | Set it to observe or enforce in the console. |
| `decision: hold`, `reasons: [gate_unavailable]`, `degraded: true` | The SDK could not reach the API and the channel's last known mode is enforce (or unknown). | Check `ANYBIO_GOVERN_BASE_URL` (or the default origin), network egress, and `onEvent` for the underlying error. This one heals on its own once we answer again. |
| `decision: hold`, `reasons: [client_misconfigured]`, `degraded: true` | The API answered and refused the call, and would refuse it again: a revoked or wrong key, a key not bound to the application, a request it will not accept. | Your own configuration. Read `status` on the `degraded` event: 401 or 403 is the credential, 400 is the request. **It will not heal**, so every message from this process holds until you fix it. |
| The test message was allowed | The policy does not name the claim the draft contains. | Check the prohibited claims on the policy attached to this channel, or pass `--content` with a draft it does name. |
| `GovernTimeoutError` | One attempt exceeded `timeoutMs` (default 5000 ms). | Raise `timeoutMs`, and check egress latency; enforce answers within three seconds on the server side. That is the server's bound, not the call's: `timeoutMs` bounds one attempt, and with the default retries and a run of `Retry-After` answers `guard` can take about 75 s before it holds. Pass `ctx.signal` for a per-call bound, and see [the README](../README.md#when-the-api-cannot-be-reached). |
| `routeToHuman: true` on an allowed reply | The inbound matched a red-flag rule; a hand-off task was opened for a person on your team. | Deliver `text` as usual, tell the patient a person will contact them, and record your own signal. Not a failure. |
| `degraded: true` with `unknownDecision` set | The server sent a decision value this SDK version does not know. | Upgrade the SDK. Until then it fails closed in enforce and open in observe. |

## Next

- [Streaming](streaming.md): buffer and release for a patient audience, trailing evaluation for a clinician audience, and how to render the held state.
- Hold resolution: `waitForRelease` and the webhook, in the [README](../README.md#hold-resolution).
- Observe for two weeks, read the report, then enforce policy by policy.
