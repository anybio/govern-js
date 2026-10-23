import { describe, expect, it } from "vitest";

import * as langchain from "../src/langchain";
import * as root from "../src/index";
import * as vercelAi from "../src/vercel-ai";

/**
 * The published surface, pinned.
 *
 * Every name in these lists is a promise: the tag freezes it, and taking one
 * back afterwards is a major version. The lists exist so that adding a name is
 * a decision somebody made, rather than an `export` keyword that travelled
 * with a helper. An internal helper stays internal and its tests import it
 * from its own module, not from the entry point.
 *
 * Only runtime values appear here: a module namespace has no types in it.
 */
function exportedValues(namespace: object): string[] {
  return Object.keys(namespace).sort();
}

describe("the published export surface", () => {
  it("@anybio/govern exports exactly these values", () => {
    expect(exportedValues(root)).toEqual([
      "AUDIENCES",
      "CHANNELS",
      "DEFAULT_BASE_URL",
      "DEFAULT_HOLD_MESSAGE",
      "DEFAULT_MAX_RETRIES",
      "DEFAULT_TIMEOUT_MS",
      "Govern",
      "GovernAbortError",
      "GovernApiError",
      "GovernConfigError",
      "GovernConflictError",
      "GovernError",
      "GovernHandoffs",
      "GovernNetworkError",
      "GovernNotAvailableError",
      "GovernTimeoutError",
      "GovernWebhookError",
      "IN_SESSION_CHANNELS",
      "MAX_CONVERSATION_ID_CHARS",
      "MAX_TURN_ID_CHARS",
      "REASONS",
      "RESERVED_TURN_ID_PREFIX",
      "SDK_NAME",
      "SDK_VERSION",
      "TRANSIENT_HTTP_STATUSES",
      "WEBHOOK_EVENTS",
      "WEBHOOK_HEADERS",
      "createGovern",
      "handleWebhook",
      "isAutomationPaused",
      "isClientMisconfiguration",
      "isGovernError",
      "isInSessionChannel",
      "parseEvent",
      "sha256Hex",
      "signWebhookPayload",
      "verifyWebhookSignature",
    ]);
  });

  it("@anybio/govern/vercel-ai exports exactly these values", () => {
    expect(exportedValues(vercelAi)).toEqual(["PROVIDER_METADATA_KEY", "PROVIDER_OPTIONS_KEY", "withGovern"]);
  });

  it("@anybio/govern/langchain exports exactly these values", () => {
    expect(exportedValues(langchain)).toEqual(["CONFIGURABLE_KEY", "GovernCallbackHandler", "RESPONSE_METADATA_KEY", "governed"]);
  });

  // `toDecision` is the wire mapper and `GOVERN_PATHS` is the server's own
  // route table: publishing them
  // makes an internal mapping and a server-side rename into breaking changes
  // for every consumer. Both stay exported from `client.ts` for the tests and
  // the spec check that read them; neither is part of the package.
  it("keeps the wire mapper and the route table out of the package", () => {
    expect(root).not.toHaveProperty("toDecision");
    expect(root).not.toHaveProperty("GOVERN_PATHS");
  });
});
