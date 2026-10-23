# Care companion, gate (example)

A minimal Next.js app-router chat page with the AnyBio Govern middleware on the model. It is the smallest page that shows the three things the integration adds:

1. the disclosure line at session start, recorded through `recordDisclosure`
2. `wrapLanguageModel` with `withGovern(...)` on the model, patient audience, `web_chat` channel, buffer and release
3. the held state in the UI, with a mock reviewer that releases or rejects the original

It runs against the mock server in `../mock-server` with a scripted model, so no model provider key and no Govern key are needed.

## Run

From the repository root, once:

```
pnpm install
pnpm build
```

Then here:

```
pnpm install
pnpm dev
```

Open http://localhost:3000. `pnpm dev` starts the mock (port 8787) and Next.js (port 3000) together and fills in `ANYBIO_GOVERN_KEY`, `ANYBIO_GOVERN_BASE_URL` and `GOVERN_MOCK_MODE` when they are unset.

Type `Does this program cure high blood pressure?`. The scripted model replies with a cure claim; the gate holds it; you see the typing state, then the hold message with a "held for review" badge and the decision id. Click **Release** to stand in for the reviewer: the original appears as released content, which is what a real integration would deliver on `waitForRelease` or the webhook. Type `I logged my reading` for a reply the gate allows.

Observe mode: `GOVERN_MOCK_MODE=observe pnpm dev`. The same message is allowed through, and the mock's log (and `/__mock/state`) shows `would_have: block_and_review`.

## Against the real API

Set `ANYBIO_GOVERN_KEY` to an application key from the console, remove `ANYBIO_GOVERN_BASE_URL`, and swap `scriptedModel()` in `app/api/chat/route.ts` for a real model. The review buttons only work against the mock; with the real API a person acts in the console.

## Files

- `lib/govern.ts`: the client, `gate(model)`, and the metadata the page renders
- `lib/model.ts`: the scripted `LanguageModelV4`
- `app/api/session/route.ts`: records the disclosure
- `app/api/chat/route.ts`: `streamText` with the gate model and per-call ids in `providerOptions.anybioGovern`; forwards the decision as message metadata
- `app/api/review/route.ts`: the mock reviewer stand-in, resolved through `waitForRelease`
- `app/page.tsx`: `useChat`, the disclosure line, the typing state, the held badge and the release flow
