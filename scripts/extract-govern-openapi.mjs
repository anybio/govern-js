#!/usr/bin/env node
// Extract the Govern surface from the full AnyBio OpenAPI document: every
// path under /api/v1/govern/ plus the component schemas they reference,
// transitively. Output is deterministic (sorted keys) so a regeneration that
// changes nothing produces no diff.
//
// Descriptions and summaries pass through a sanitizing step
// (scripts/lib/sanitize-openapi.mjs) so the published document carries
// contract text only. The script fails if any text the step cannot clean
// remains.
//
// The input may also be spec/openapi.json itself: extraction is idempotent,
// so re-running it on the committed document re-applies the sanitizing step.
//
// Usage:
//   node scripts/extract-govern-openapi.mjs <full-openapi.json> <out.json> [--date YYYY-MM-DD]

import { readFileSync, writeFileSync } from "node:fs";

import { findUnpublishable, sanitizeDocument } from "./lib/sanitize-openapi.mjs";

const [, , input, output, ...rest] = process.argv;
if (!input || !output) {
  console.error("usage: extract-govern-openapi.mjs <full-openapi.json> <out.json> [--date YYYY-MM-DD]");
  process.exit(2);
}
const dateFlag = rest.indexOf("--date");
const date = dateFlag >= 0 ? rest[dateFlag + 1] : new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) {
  console.error("--date must be YYYY-MM-DD");
  process.exit(2);
}

const doc = JSON.parse(readFileSync(input, "utf8"));
const PREFIX = "/api/v1/govern/";

const paths = {};
for (const [path, item] of Object.entries(doc.paths ?? {})) {
  if (path.startsWith(PREFIX)) paths[path] = item;
}

// Collect $ref targets transitively.
const allSchemas = doc.components?.schemas ?? {};
const wanted = new Set();
const visit = (node) => {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) visit(child);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string") {
      const m = value.match(/^#\/components\/schemas\/(.+)$/);
      if (m) {
        const name = decodeURIComponent(m[1]);
        if (!wanted.has(name)) {
          wanted.add(name);
          visit(allSchemas[name]);
        }
      }
    } else {
      visit(value);
    }
  }
};
visit(paths);

const schemas = {};
for (const name of [...wanted].sort()) {
  if (!(name in allSchemas)) {
    console.error(`referenced schema missing from source document: ${name}`);
    process.exit(1);
  }
  schemas[name] = allSchemas[name];
}

const securitySchemes = doc.components?.securitySchemes ?? {};

const sortKeysDeep = (value) => {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key]);
    return out;
  }
  return value;
};

const out = sanitizeDocument({
  openapi: doc.openapi,
  info: {
    title: "AnyBio Govern API",
    version: doc.info?.version ?? "0.0.0",
    description: `The Govern surface of the AnyBio API. Generated from the AnyBio Govern API specification, ${date}.`,
  },
  servers: [{ url: "https://api.anybio.io" }],
  tags: (doc.tags ?? []).filter((t) => t.name === "Govern"),
  paths: sortKeysDeep(paths),
  components: sortKeysDeep({ schemas, securitySchemes }),
});

const problems = findUnpublishable(out);
if (problems.length > 0) {
  console.error("Descriptions still carry text that must not be published. Add a rule or an override in scripts/lib/sanitize-openapi.mjs:");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

writeFileSync(output, JSON.stringify(out, null, 2) + "\n");
console.log(
  `wrote ${output}: ${Object.keys(paths).length} paths, ${Object.keys(schemas).length} schemas`,
);
