import { defineConfig } from "tsup";

const shared = {
  sourcemap: false,
  treeshake: true,
  splitting: false,
  minify: false,
  target: "es2022" as const,
};

export default defineConfig([
  {
    ...shared,
    clean: true,
    entry: {
      index: "src/index.ts",
      "vercel-ai": "src/vercel-ai.ts",
      langchain: "src/langchain.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    platform: "neutral",
    external: ["ai", "@ai-sdk/provider", "@langchain/core"],
    outExtension({ format }) {
      return { js: format === "cjs" ? ".cjs" : ".js" };
    },
  },
  {
    ...shared,
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
