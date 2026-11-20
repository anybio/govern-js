#!/usr/bin/env node
// Pack the package exactly as `npm publish` would, unpack it, and fail if any
// shipped file carries text that must not be published: source maps,
// tracker references, repository or branch names, release notes about
// unshipped work, or a member marked `@internal` in the type declarations.
// Then load the unpacked package as a consumer does, by its
// name through its `exports`, once as ESM and once as CommonJS, and fail if an
// error thrown by an adapter entry point is not an instance of the error
// classes the root entry point exports. Runs in `pnpm check`, so
// `prepublishOnly` and CI run it.
//
// Run after `pnpm build`: it checks the dist on disk, it does not build.

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Case-insensitive substrings that fail the check wherever they appear. */
const FORBIDDEN_TEXT = [
  "anybio#",
  "anybio-kb",
  "anybio/anybio",
  "be/src",
  "chore/",
  "feat/",
  "never published",
  "placeholder",
  "not built",
  "unit lands",
  "later units",
  "sourcesContent",
  "sourceMappingURL",
];

/** File names that fail the check. */
const FORBIDDEN_FILES = [/\.map$/i];

/**
 * Members marked `@internal` that must not reach the published type
 * declarations (the build strips them), beside a public member the same
 * declarations must carry, so the check cannot pass on empty files.
 */
const INTERNAL_MEMBERS = ["reportForAdapter"];
const PUBLIC_MEMBER = "reportOutcome(";
const DECLARATION_FILE = /\.d\.c?ts$/;

/**
 * The single package entry from `npm pack --json`. npm 10 and 11 print an
 * array of entries; npm 12 prints an object keyed by package name. Accept
 * either, and fail loudly on anything else: checking nothing is not a pass.
 */
function packResult(stdout) {
  const expected = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name;
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`npm pack --json did not print JSON: ${error.message}`);
  }
  let entries;
  if (Array.isArray(parsed)) {
    entries = parsed;
  } else if (parsed !== null && typeof parsed === "object") {
    entries = Object.values(parsed);
  } else {
    throw new Error(`npm pack --json printed an unrecognised shape: ${stdout.slice(0, 200)}`);
  }
  if (entries.length !== 1) {
    throw new Error(`npm pack --json reported ${entries.length} packages, expected exactly 1`);
  }
  const [entry] = entries;
  if (
    entry === null ||
    typeof entry !== "object" ||
    typeof entry.filename !== "string" ||
    entry.filename === "" ||
    typeof entry.name !== "string" ||
    typeof entry.version !== "string"
  ) {
    throw new Error(`npm pack --json entry has no filename, name or version: ${JSON.stringify(entry).slice(0, 200)}`);
  }
  if (entry.name !== expected) {
    throw new Error(`npm pack --json reported package ${entry.name}, expected ${expected}`);
  }
  return entry;
}

/**
 * The consumer each identity probe runs as. One body serves both module
 * formats: `load` is `import()` or `require`, and `resolve` names the file a
 * specifier resolves to under that format's conditions, which must be inside
 * the unpacked package and nowhere else.
 *
 * Both adapters refuse a blank `holdMessage` with `GovernConfigError` when
 * they are built, before they touch the client or the model, so building one
 * is enough to get an error thrown from inside the adapter's own code. The
 * root line is the control: an error the root throws, tested against the
 * root's own classes.
 *
 * The last line a probe prints is its sentinel, `identity <format>:
 * <passed>/<run> checks`. The parent accepts a probe only on that line with
 * every one of `IDENTITY_CHECKS` passed, so a probe that stops early, or runs
 * fewer checks than this file expects, fails the run.
 */
const IDENTITY_CHECKS = 3;

/** How long one probe may run before it is killed and fails the check. */
const PROBE_TIMEOUT_MS = 60_000;

const PROBE_BODY = `
async function probe(format, load, resolve) {
  const [packageName, packageDir] = process.argv.slice(2);
  const failures = [];
  const entries = {};
  const files = [];
  for (const [entry, subpath] of [["root", ""], ["vercel-ai", "/vercel-ai"], ["langchain", "/langchain"]]) {
    const specifier = packageName + subpath;
    const file = realpathSync(resolve(specifier));
    if (file.startsWith(packageDir + sep)) files.push(file.slice(packageDir.length + 1));
    else failures.push(format + " " + specifier + " resolved to " + file + ", outside the unpacked package");
    entries[entry] = await load(specifier);
  }
  console.log("  " + format + " loads " + files.join(", "));
  const { Govern, GovernConfigError, GovernError, isGovernError } = entries.root;
  const client = { apiKey: "gk_check_package", application: "check-package", baseUrl: "https://example.invalid" };
  const adapter = { govern: new Govern(client), channel: "sms", audience: "patient", conversationId: "check-package", holdMessage: " " };
  const triggers = [
    ["root Govern", () => new Govern({ ...client, holdMessage: " " })],
    ["vercel-ai withGovern", () => entries["vercel-ai"].withGovern(adapter)],
    ["langchain governed", () => entries.langchain.governed({ invoke: async () => "" }, adapter)],
  ];
  let passing = 0;
  for (const [label, trigger] of triggers) {
    let thrown;
    try {
      trigger();
    } catch (error) {
      thrown = error;
    }
    const results = [
      ["instanceof GovernConfigError", thrown instanceof GovernConfigError],
      ["instanceof GovernError", thrown instanceof GovernError],
      ["isGovernError", isGovernError(thrown)],
    ];
    const ok = thrown?.name === "GovernConfigError" && results.every(([, passed]) => passed);
    const threw = thrown === undefined ? "nothing" : String(thrown?.name);
    console.log("  " + (ok ? "ok  " : "FAIL") + " " + format + " " + label + ": threw " + threw + ", " + results.map(([what, passed]) => what + " " + passed).join(", "));
    if (ok) passing += 1;
    else process.exitCode = 1;
  }
  for (const failure of failures) console.error("  FAIL " + failure);
  if (failures.length > 0) process.exitCode = 1;
  console.log("  identity " + format + ": " + passing + "/" + triggers.length + " checks");
}
`;

// `import.meta.resolve` is unflagged and synchronous from Node 20.6. On an
// older 20 the probe stops with a message naming that floor instead of a
// TypeError; the package's own floor is unaffected, since this script never
// ships.
const ESM_PROBE = `import { realpathSync } from "node:fs";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";
${PROBE_BODY}
function resolveImport(specifier) {
  if (typeof import.meta.resolve !== "function") {
    throw new Error("check:package needs Node 20.6 or later: the ESM identity probe resolves entry points with import.meta.resolve. Running on " + process.version + ".");
  }
  return fileURLToPath(import.meta.resolve(specifier));
}
await probe("esm", (specifier) => import(specifier), resolveImport);
`;

const CJS_PROBE = `"use strict";
const { realpathSync } = require("node:fs");
const { sep } = require("node:path");
${PROBE_BODY}
probe("cjs", async (specifier) => require(specifier), (specifier) => require.resolve(specifier)).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;

/**
 * One class identity per process: an error an adapter throws must be an
 * instance of the classes the root entry point exports, in each module
 * format. The unpacked package is laid out as an install would place it,
 * under `node_modules` by its name, with every peer it declares linked beside
 * it from the copy installed here as a devDependency, as an install that
 * carries both adapters' peers would have them. Only `@langchain/core` is
 * loaded: the LangChain entry imports it when it loads, and the Vercel entry
 * imports `ai` for its types alone. Each probe is written to a directory of
 * its own beside the package, never inside it, and runs in a process of its
 * own, so the ESM run and the CommonJS run never share a class.
 *
 * Returns whether both formats passed. The links live under `work` and go
 * with it: a recursive delete removes a link without following it.
 */
function checkErrorIdentity(work, pkgDir, packageName) {
  const nodeModules = join(work, "node_modules");
  const link = (target, name) => {
    const path = join(nodeModules, ...name.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(target, path, "junction");
  };
  link(pkgDir, packageName);
  const { peerDependencies = {} } = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const { devDependencies = {} } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const peer of Object.keys(peerDependencies)) {
    if (!Object.hasOwn(devDependencies, peer)) {
      throw new Error(`the peer dependency ${peer} is not a devDependency of ${packageName}, so there is no installed copy to link for the identity probes: add it to devDependencies`);
    }
    const installed = join(root, "node_modules", ...peer.split("/"));
    if (!existsSync(installed)) {
      throw new Error(`the devDependency ${peer}@${devDependencies[peer]} is not installed in ${join(root, "node_modules")}: install the devDependencies before check:package`);
    }
    link(realpathSync(installed), peer);
  }

  const consumer = join(work, "consumer");
  mkdirSync(consumer);
  console.log("error class identity across entry points:");
  let ok = true;
  for (const [format, file, source] of [
    ["esm", "identity.mjs", ESM_PROBE],
    ["cjs", "identity.cjs", CJS_PROBE],
  ]) {
    const path = join(consumer, file);
    writeFileSync(path, source);
    const run = spawnSync(process.execPath, [path, packageName, realpathSync(pkgDir)], {
      cwd: consumer,
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
    });
    const stdout = run.stdout ?? "";
    process.stdout.write(stdout);
    const sentinel = `identity ${format}: ${IDENTITY_CHECKS}/${IDENTITY_CHECKS} checks`;
    const reasons = [];
    if (run.error) reasons.push(run.error.message);
    if (run.signal) reasons.push(`killed by ${run.signal}${run.error?.code === "ETIMEDOUT" ? ` after ${PROBE_TIMEOUT_MS / 1000} s` : ""}`);
    if (run.status !== null && run.status !== 0) reasons.push(`exit status ${run.status}`);
    if (!stdout.split("\n").some((line) => line.trim() === sentinel)) reasons.push(`no "${sentinel}" line`);
    if (reasons.length > 0) {
      ok = false;
      process.stderr.write(run.stderr ?? "");
      console.error(`  FAIL ${file}: ${reasons.join("; ")}`);
    }
  }
  return ok;
}

const work = mkdtempSync(join(tmpdir(), "govern-pack-"));
try {
  const packed = packResult(
    execFileSync("npm", ["pack", "--json", "--pack-destination", work], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );
  const tarball = join(work, packed.filename);
  if (!existsSync(tarball)) {
    throw new Error(`npm pack reported ${packed.filename}, but no such file is in ${work}`);
  }
  execFileSync("tar", ["-xzf", tarball, "-C", work]);
  const pkgDir = join(work, "package");

  const walk = (dir) =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
  const files = walk(pkgDir).sort();

  const problems = [];
  let publicMemberDeclared = false;
  for (const file of files) {
    const rel = relative(pkgDir, file);
    for (const pattern of FORBIDDEN_FILES) {
      if (pattern.test(rel)) problems.push(`${rel}: file name matches ${pattern}`);
    }
    const text = readFileSync(file, "utf8");
    if (DECLARATION_FILE.test(rel)) {
      for (const member of INTERNAL_MEMBERS) {
        if (text.includes(member)) problems.push(`${rel}: declares the internal member ${member}`);
      }
      if (text.includes(PUBLIC_MEMBER)) publicMemberDeclared = true;
    }
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      const lower = line.toLowerCase();
      for (const needle of FORBIDDEN_TEXT) {
        if (lower.includes(needle.toLowerCase())) problems.push(`${rel}:${index + 1}: contains "${needle}"`);
      }
    });
  }

  if (!publicMemberDeclared) problems.push(`no declaration file declares ${PUBLIC_MEMBER}: the internal-member check would pass on nothing`);

  console.log(`${packed.name}@${packed.version}: ${files.length} files`);
  for (const file of files) console.log(`  ${relative(pkgDir, file)}`);
  if (problems.length > 0) {
    console.error(`\nThe package carries text that must not be published (${problems.length}):`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exitCode = 1;
  } else {
    console.log("package contents: clean");
  }

  if (checkErrorIdentity(work, pkgDir, packed.name)) {
    console.log("error class identity: one per module format");
  } else {
    console.error("\nThe error class identity check failed (the FAIL lines above say where): an adapter entry point's errors must be instances of the root entry point's error classes.");
    process.exitCode = 1;
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
