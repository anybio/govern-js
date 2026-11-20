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
pnpm check:package   # packs the build; fails on text that must not be published, on an `@internal` member in the declarations, or on an adapter error that is not an instance of the root's error classes (ESM and CJS)
pnpm check           # lint, typecheck, test, build, check:package
```

The example integration and the mock server live in `examples/`. The mock implements the same identifier rules and the same disclosure replay as the API.

## The OpenAPI document

`spec/openapi.json` is produced by `scripts/extract-govern-openapi.mjs` from the full API specification:

```
node scripts/extract-govern-openapi.mjs <full-openapi.json> spec/openapi.json --date YYYY-MM-DD
pnpm generate:types
```

Every description passes through `scripts/lib/sanitize-openapi.mjs`, and the extraction fails if a description still carries text that must not be published (tracker references, implementation symbols, repository or branch names). Add a rule or an override there; do not edit `spec/openapi.json` by hand. Update the date in `spec/README.md` with each regeneration.

When the API's reason codes change, update `REASONS` in `src/types.ts` and the list in `test/spec.test.ts` together.

## What ships

Everything in the package is public: `README.md`, `CHANGELOG.md`, `spec/`, and the comments and JSDoc in `src/`, which reach `dist/` and the published type declarations. Write them as documentation for users of the SDK: the contract, its behaviour and its limits. Keep release process, plans and internal references out of them. `pnpm check:package` enforces the mechanical part, and loads the packed package as a consumer would, once as ESM and once as CommonJS, to check that an error an adapter entry point throws is an instance of the error classes the root entry point exports.

## Releasing

A release arrives as a pull request titled `Release <version>`, with the version in `package.json`, `SDK_VERSION` and the CHANGELOG heading already set.

1. Review and approve the pull request, then squash-merge it.
2. Push the tag `v<version>` on that merge commit in github.com/anybio/govern-js:

   ```
   git fetch origin main
   git tag v<version> <merge commit sha>
   git push origin v<version>
   ```

   `release.yml` runs on the tag: it checks that the tag matches `package.json`, runs the checks, and publishes with provenance.
3. Approve the deployment to the `npm` environment.
