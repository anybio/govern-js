import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function json<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(root, path), "utf8")) as T;
}

interface Pkg {
  main: string;
  module: string;
  types: string;
  engines: { node: string };
  typesVersions: Record<string, Record<string, string[]>>;
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional?: boolean }>;
  exports: Record<string, { import?: { types: string; default: string }; require?: { types: string; default: string } } | string>;
}

const pkg = json<Pkg>("package.json");

describe("the Node floor this package states", () => {
  it("is one floor for the whole package, and the one CI proves", () => {
    // `engines` is package-wide; there is no per-entry-point form of it. This
    // is the floor for every entry point here, the vercel-ai one included.
    expect(pkg.engines.node).toBe(">=20");
    const ci = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
    const matrix = /node:\s*\[([0-9,\s]+)\]/.exec(ci);
    const versions = (matrix?.[1] ?? "").split(",").map((n) => Number(n.trim()));
    expect(versions.length).toBeGreaterThan(0);
    expect(Math.min(...versions)).toBe(20);
  });

  it("leaves the vercel adapter's higher floor to `ai`, which states it itself", () => {
    // A consumer on Node 20 who installs `ai` 7 is refused by `ai`, not by a
    // number of ours that would also refuse a LangChain or core-only install
    // that runs there perfectly well. What makes that honest rather than
    // convenient is the import: `ai` is types only in the middleware, so
    // nothing of ours needs Node 22 at runtime. A value import from `ai` here
    // would move our own floor, and this is the check that would notice.
    const source = readFileSync(resolve(root, "src/vercel-ai.ts"), "utf8");
    const imports = [...source.matchAll(/^import\s+(type\s+)?[^;]*from\s+"ai";$/gm)];
    expect(imports).toHaveLength(1);
    expect(imports[0]![1]).toBe("type ");
    expect(pkg.peerDependenciesMeta.ai?.optional).toBe(true);
    expect(pkg.peerDependenciesMeta["@langchain/core"]?.optional).toBe(true);
  });

  it("is a floor the peers' own engines agree with, as the README says they do", () => {
    // The README tells a reader that `ai` 7 is where the Node 22 requirement
    // comes from and that `@langchain/core` 1 is happy on 20. If either peer
    // changes its mind, that paragraph is wrong and this fails.
    expect(json<{ engines: { node: string } }>("node_modules/ai/package.json").engines.node).toBe(">=22");
    expect(json<{ engines: { node: string } }>("node_modules/@langchain/core/package.json").engines.node).toBe(">=20");
  });
});

describe("entry points", () => {
  it("pairs each declaration file with a build of the same module format", () => {
    // A resolver that has never heard of `exports` reads `main` and `types`
    // together. `main` is the CommonJS build, so `types` is the CommonJS
    // declarations; `module` is the ESM build and the `import` condition
    // carries the ESM ones. The two files differ only in the extension they
    // re-export through, which is exactly why this is worth keeping straight
    // rather than worth arguing about.
    expect(pkg.main.endsWith(".cjs")).toBe(true);
    expect(pkg.types.endsWith(".d.cts")).toBe(true);
    expect(pkg.module.endsWith(".js")).toBe(true);

    for (const [name, entry] of Object.entries(pkg.exports)) {
      if (typeof entry === "string") continue;
      expect(entry.import?.types.endsWith(".d.ts"), `${name} import types`).toBe(true);
      expect(entry.import?.default.endsWith(".js"), `${name} import default`).toBe(true);
      expect(entry.require?.types.endsWith(".d.cts"), `${name} require types`).toBe(true);
      expect(entry.require?.default.endsWith(".cjs"), `${name} require default`).toBe(true);
    }
    expect(pkg.exports["."]).toMatchObject({ require: { types: pkg.types, default: pkg.main } });
  });

  it("maps the adapter subpaths for a resolver that reads typesVersions and not exports", () => {
    // Node reads `exports` at runtime, so `@anybio/govern/vercel-ai` loads
    // wherever it is imported. TypeScript's node10 resolver does not read it,
    // and the `types` field covers the root entry point only: without this
    // map a consumer on `moduleResolution: "node"` runs the adapter fine and
    // has no types for it. The file it names is the CommonJS one, for the
    // same reason `types` is.
    const subpaths = Object.entries(pkg.exports).filter(([name]) => name !== "." && name !== "./package.json");
    expect(subpaths.length).toBeGreaterThan(0);
    for (const [name, entry] of subpaths) {
      if (typeof entry === "string") continue;
      expect(pkg.typesVersions["*"]?.[name.replace(/^\.\//, "")], name).toEqual([entry.require?.types]);
    }
  });
});
