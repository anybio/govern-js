#!/usr/bin/env node
// Pack the package exactly as `npm publish` would, unpack it, and fail if any
// shipped file carries text that must not be published: source maps,
// tracker references, repository or branch names, or release notes about
// unshipped work. Runs in `pnpm check`, so `prepublishOnly` and CI run it.
//
// Run after `pnpm build`: it checks the dist on disk, it does not build.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
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
 * The single package entry from `npm pack --json`. npm 10 and 11 print an
 * array of entries; npm 12 prints an object keyed by package name. Accept
 * either, and fail loudly on anything else rather than check nothing.
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
  for (const file of files) {
    const rel = relative(pkgDir, file);
    for (const pattern of FORBIDDEN_FILES) {
      if (pattern.test(rel)) problems.push(`${rel}: file name matches ${pattern}`);
    }
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      const lower = line.toLowerCase();
      for (const needle of FORBIDDEN_TEXT) {
        if (lower.includes(needle.toLowerCase())) problems.push(`${rel}:${index + 1}: contains "${needle}"`);
      }
    });
  }

  console.log(`${packed.name}@${packed.version}: ${files.length} files`);
  for (const file of files) console.log(`  ${relative(pkgDir, file)}`);
  if (problems.length > 0) {
    console.error(`\nThe package carries text that must not be published (${problems.length}):`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exitCode = 1;
  } else {
    console.log("package contents: clean");
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
