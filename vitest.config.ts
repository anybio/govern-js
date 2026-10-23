import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // No test may reach the network. The setup file replaces global fetch
    // with one that throws, so a test that forgets to mock fails fast.
    setupFiles: ["test/setup.ts"],
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/generated/**"],
    },
  },
});
