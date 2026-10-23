#!/usr/bin/env node
// `pnpm dev`: start the mock Govern server and the Next.js dev server together.
// No real key is needed; the defaults below point the SDK at the mock.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sdkDist = resolve(here, "../../dist/index.js");
if (!existsSync(sdkDist)) {
  console.error("The SDK is not built. Run `pnpm build` in the repository root first, then `pnpm dev` here.");
  process.exit(1);
}

process.env.ANYBIO_GOVERN_KEY ??= "gk_mock_local_only";
process.env.ANYBIO_GOVERN_APPLICATION ??= "care-companion-example";
process.env.ANYBIO_GOVERN_BASE_URL ??= "http://localhost:8787";
process.env.GOVERN_MOCK_MODE ??= "enforce";
process.env.PORT = new URL(process.env.ANYBIO_GOVERN_BASE_URL).port || "8787";

const children = [];
const start = (label, command, args, cwd) => {
  const child = spawn(command, args, { stdio: "inherit", env: process.env, cwd });
  child.on("exit", (code) => {
    console.log(`${label} exited with ${code ?? "signal"}`);
    shutdown(code ?? 0);
  });
  children.push(child);
};

let stopping = false;
const shutdown = (code) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 200);
};
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

start("mock", process.execPath, [resolve(here, "../mock-server/server.mjs")], here);
start("next", resolve(here, "node_modules/.bin/next"), ["dev", "-p", "3000"], here);

console.log("");
console.log(`Govern mock: ${process.env.ANYBIO_GOVERN_BASE_URL} (mode ${process.env.GOVERN_MOCK_MODE})`);
console.log("Chat page:   http://localhost:3000");
console.log("");
