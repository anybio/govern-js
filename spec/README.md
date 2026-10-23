# spec/

`openapi.json` is the Govern surface of the AnyBio API: every path under `/api/v1/govern/` and the schemas they reference. Generated from the AnyBio Govern API specification, 2026-09-26.

- `pnpm generate:types` writes `src/generated/openapi.ts` from it.
- `test/spec.test.ts` fails when the committed types differ from what the document generates, checks that every route `Govern` calls exists in the document, and holds the reason codes in `src/types.ts` to the API's set.
- `scripts/extract-govern-openapi.mjs` produces the document from the full API specification, sorted so an unchanged regeneration has no diff, and passes every description through `scripts/lib/sanitize-openapi.mjs`. Re-running it on `openapi.json` itself re-applies that step.

## What is not in the document

Three caller-visible rules are enforced by the API and are not expressible in OpenAPI. They are in the README, and the SDK checks the first two before it sends:

- `turn_id` and `Idempotency-Key` may not start with `govern:`, which is reserved for the rows the API writes.
- `conversation_id` is at most 187 characters and `turn_id` at most 206.
- A presented `disclosure.ref` that is not the conversation's own reference is ignored, never refused.

The reason codes do not appear in the document either; `REASONS` in `src/types.ts` lists them.
