import { defineConfig } from "tsup";

const shared = {
  sourcemap: false,
  treeshake: true,
  minify: false,
  target: "es2022" as const,
};

export default defineConfig([
  {
    ...shared,
    // A module more than one entry point uses is emitted once, in a chunk
    // those entry points import, in both formats. Without it each bundle
    // inlines its own copy of the error classes, and an error an adapter
    // throws is not an instance of the class the root exports. With
    // `treeshake` on, tsup builds the CommonJS output as ESM chunks and has
    // rollup convert each chunk, so both formats split along the same lines.
    // `scripts/check-package.mjs` checks the packed package for this.
    splitting: true,
    clean: true,
    entry: {
      index: "src/index.ts",
      "vercel-ai": "src/vercel-ai.ts",
      langchain: "src/langchain.ts",
    },
    format: ["esm", "cjs"],
    // A member marked `@internal` (the adapters' report path on `Govern`)
    // stays out of the published declarations; `scripts/check-package.mjs`
    // checks the packed package for it.
    dts: { compilerOptions: { stripInternal: true } },
    platform: "neutral",
    external: ["ai", "@ai-sdk/provider", "@langchain/core"],
    outExtension({ format }) {
      return { js: format === "cjs" ? ".cjs" : ".js" };
    },
  },
  {
    ...shared,
    // One self-contained executable: nothing imports it, so there is nothing
    // to share a chunk with.
    splitting: false,
    clean: false,
    entry: { cli: "src/cli/index.ts" },
    format: ["esm"],
    dts: false,
    platform: "node",
    banner: { js: "#!/usr/bin/env node" },
    outExtension() {
      return { js: ".js" };
    },
  },
]);
