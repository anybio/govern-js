#!/usr/bin/env node
// Generate TypeScript types from the committed OpenAPI documents into
// src/generated/. The test in test/spec.test.ts regenerates the same
// output in memory and fails when it differs from the committed file, so a
// change to spec/*.json without `pnpm generate:types` cannot land.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateTypes, TARGETS } from "./lib/generate-types.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

for (const target of TARGETS) {
  const spec = readFileSync(resolve(root, target.spec), "utf8");
  const output = await generateTypes(spec, target);
  const outPath = resolve(root, target.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, output);
  console.log(`wrote ${target.out} from ${target.spec}`);
}
