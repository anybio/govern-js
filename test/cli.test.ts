import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { detectProject, installCommand } from "../src/cli/detect";
import { parseArgs } from "../src/cli/index";
import { planInit, runInit } from "../src/cli/init";
import { SYNTHETIC_DRAFT } from "../src/cli/test-message";

const none = { has: () => false };

describe("detectProject", () => {
  it("detects a Vercel AI SDK project", () => {
    const detection = detectProject(
      { dependencies: { ai: "^7.0.0", next: "16.0.0", "@ai-sdk/openai": "^4.0.0" }, devDependencies: { typescript: "^5" } },
      { has: (p) => p === "pnpm-lock.yaml" || p === "lib" },
    );
    expect(detection).toMatchObject({ framework: "vercel-ai", hasAi: true, hasLangChain: false, hasNext: true, typescript: true, packageManager: "pnpm", libDir: "lib", aiVersion: "^7.0.0" });
  });

  it("detects a LangChain project", () => {
    const detection = detectProject({ dependencies: { "@langchain/core": "^1.2.0", "@langchain/openai": "^1.0.0" } }, { has: (p) => p === "yarn.lock" || p === "src" });
    expect(detection).toMatchObject({ framework: "langchain", hasLangChain: true, packageManager: "yarn", libDir: "src/lib", typescript: false });
  });

  it("detects both and neither", () => {
    expect(detectProject({ dependencies: { ai: "7", langchain: "1" } }, none).framework).toBe("both");
    expect(detectProject({ dependencies: { express: "5" } }, none).framework).toBe("none");
  });

  it("prefers the packageManager field and falls back to lockfiles", () => {
    expect(detectProject({ packageManager: "bun@1.2.0" }, { has: (p) => p === "pnpm-lock.yaml" }).packageManager).toBe("bun");
    expect(detectProject({}, { has: (p) => p === "bun.lock" }).packageManager).toBe("bun");
    expect(detectProject({}, none).packageManager).toBe("npm");
    expect(installCommand("pnpm", "@anybio/govern")).toBe("pnpm add @anybio/govern");
  });
});

describe("planInit", () => {
  it("renders the middleware line for the Vercel AI SDK", () => {
    const plan = planInit(detectProject({ dependencies: { ai: "7" }, devDependencies: { typescript: "5" } }, none), { channel: "web_chat", audience: "patient" });
    expect(plan.file).toBe("lib/govern.ts");
    expect(plan.contents).toContain('from "@anybio/govern/vercel-ai"');
    expect(plan.contents).toContain("wrapLanguageModel({");
    expect(plan.contents).toContain('channel: "web_chat", audience: "patient"');
    expect(plan.usage).toContain("providerOptions: { anybioGovern:");
    expect(plan.contents).toContain("ANYBIO_GOVERN_KEY");
  });

  it("renders the wrapper for LangChain", () => {
    const plan = planInit(detectProject({ dependencies: { "@langchain/core": "1" } }, none), { channel: "sms", audience: "patient" });
    expect(plan.file).toBe("lib/govern.js");
    expect(plan.contents).toContain('from "@anybio/govern/langchain"');
    expect(plan.contents).toContain("governed(runnable");
    expect(plan.usage).toContain("configurable: { anybioGovern:");
  });

  it("falls back to guard when no framework is present", () => {
    const plan = planInit(detectProject({}, none), { channel: "web_chat", audience: "patient" });
    expect(plan.contents).not.toContain("vercel-ai");
    expect(plan.usage).toContain("govern.guard(");
  });
});

describe("runInit", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("prints without writing by default, and writes the file and .env.example with --write", () => {
    dir = mkdtempSync(join(tmpdir(), "govern-init-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { ai: "^7.0.0" }, devDependencies: { typescript: "^5" } }));
    mkdirSync(join(dir, "lib"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(runInit({ dir, write: false, channel: "web_chat", audience: "patient" })).toBe(0);
    expect(existsSync(join(dir, "lib", "govern.ts"))).toBe(false);
    expect(existsSync(join(dir, ".env.example"))).toBe(false);
    expect(log.mock.calls.flat().join("\n")).toContain("Nothing was written");

    expect(runInit({ dir, write: true, channel: "web_chat", audience: "patient" })).toBe(0);
    const written = readFileSync(join(dir, "lib", "govern.ts"), "utf8");
    expect(written).toContain("withGovern({ govern");
    const env = readFileSync(join(dir, ".env.example"), "utf8");
    expect(env).toContain("ANYBIO_GOVERN_KEY=");
    expect(env).not.toMatch(/ANYBIO_GOVERN_KEY=\S/);

    // A second --write does not overwrite or duplicate.
    expect(runInit({ dir, write: true, channel: "web_chat", audience: "patient" })).toBe(0);
    expect(readFileSync(join(dir, "lib", "govern.ts"), "utf8")).toBe(written);
    expect(readFileSync(join(dir, ".env.example"), "utf8").match(/ANYBIO_GOVERN_KEY=/g)).toHaveLength(1);
  });

  it("fails cleanly without a package.json", () => {
    dir = mkdtempSync(join(tmpdir(), "govern-init-empty-"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(runInit({ dir, write: false, channel: "web_chat", audience: "patient" })).toBe(1);
    expect(error).toHaveBeenCalled();
  });
});

describe("parseArgs", () => {
  it("parses commands, positionals and flags in both forms", () => {
    expect(parseArgs(["init", "--write", "--dir", "/tmp/x", "--channel=sms"])).toEqual({
      command: "init",
      positionals: [],
      flags: { write: true, dir: "/tmp/x", channel: "sms" },
    });
    expect(parseArgs(["decision", "abc", "--base-url", "http://localhost:8787"])).toEqual({
      command: "decision",
      positionals: ["abc"],
      flags: { "base-url": "http://localhost:8787" },
    });
  });
});

describe("test-message", () => {
  it("ships a synthetic draft that names a cure and a medication change", () => {
    expect(SYNTHETIC_DRAFT.toLowerCase()).toContain("cure");
    expect(SYNTHETIC_DRAFT.toLowerCase()).toContain("medication");
  });
});
