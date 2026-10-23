// Every test runs with a global fetch that refuses to work. A test that wants
// network behaviour passes its own `fetch` to the client (or stubs
// globalThis.fetch explicitly) and restores it afterwards. Nothing in this
// suite may reach a real host.

import { afterEach, beforeEach, vi } from "vitest";

const refuse: typeof fetch = async (input) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  throw new Error(`test attempted a real network request to ${url}`);
};

beforeEach(() => {
  vi.stubGlobal("fetch", refuse);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
