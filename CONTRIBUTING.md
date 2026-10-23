# Contributing

This file is for maintainers of `@anybio/govern`. It is not part of the published package.

## Development

```
pnpm install
pnpm test            # Vitest; no test reaches the network
pnpm typecheck
pnpm lint
pnpm build           # tsup: ESM, CJS, d.ts, CLI; no source maps
pnpm generate:types  # from spec/openapi.json into src/generated/ (a test fails if they drift)
pnpm check:package   # packs the build and fails on text that must not be published
pnpm check           # lint, typecheck, test, build, check:package
```

The example integration and the mock server live in `examples/`. The mock implements the same identifier rules and the same disclosure replay as the API.

## The OpenAPI document

`spec/openapi.json` is produced by `scripts/extract-govern-openapi.mjs` from the full API specification:

```
node scripts/extract-govern-openapi.mjs <full-openapi.json> spec/openapi.json --date YYYY-MM-DD
pnpm generate:types
```

Every description passes through `scripts/lib/sanitize-openapi.mjs`, and the extraction fails if a description still carries text that must not be published (tracker references, implementation symbols, repository or branch names). Add a rule or an override there rather than editing `spec/openapi.json` by hand. Update the date in `spec/README.md` with each regeneration.

When the API's reason codes change, update `REASONS` in `src/types.ts` and the list in `test/spec.test.ts` together.

## What ships

Everything in the package is public: `README.md`, `CHANGELOG.md`, `spec/`, and the comments and JSDoc in `src/`, which reach `dist/` and the published type declarations. Write them as documentation for users of the SDK: the contract, its behaviour and its limits. Keep release process, plans and internal references out of them. `pnpm check:package` enforces the mechanical part.

## Releasing

1. Bump `version` in `package.json` and `SDK_VERSION` in `src/version.ts` (a test keeps them equal), and add a CHANGELOG entry.
2. Merge to `main`.
3. Push a tag `v<version>` on the merge commit. `release.yml` checks that the tag matches `package.json`, runs the checks, and publishes.
