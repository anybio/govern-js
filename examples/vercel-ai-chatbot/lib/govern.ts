// The one place the SDK is configured. Server-side only: this module is
// imported by route handlers, never by a client component.

import { Govern, type DecisionVerdict } from "@anybio/govern";
import { withGovern, type GovernDecisionInfo } from "@anybio/govern/vercel-ai";
import { wrapLanguageModel } from "ai";

export const CHANNEL = "web_chat" as const;
export const AUDIENCE = "patient" as const;

export const DISCLOSURE_TEXT =
  "You are chatting with an AI assistant. A person on the care team reviews any message it holds back and can be reached at any time.";

let client: Govern | undefined;

/**
 * The client, constructed on first use so `next build` (which evaluates route
 * modules without the runtime environment) does not need the key.
 */
export function getGovern(): Govern {
  if (client) return client;
  const apiKey = process.env.ANYBIO_GOVERN_KEY;
  if (!apiKey) {
    throw new Error("ANYBIO_GOVERN_KEY is not set. Run `pnpm dev` (which points at the mock) or set a real key.");
  }
  const options: ConstructorParameters<typeof Govern>[0] = {
    apiKey,
    application: process.env.ANYBIO_GOVERN_APPLICATION ?? "care-companion-example",
    holdMessage:
      "Thanks for your message. A person on the care team is going to review it and follow up with you shortly.",
    onEvent: (event) => {
      if (event.type === "decision" || event.type === "degraded" || event.type === "error") {
        console.log("[govern]", JSON.stringify(event));
      }
    },
  };
  if (process.env.ANYBIO_GOVERN_BASE_URL) options.baseUrl = process.env.ANYBIO_GOVERN_BASE_URL;
  client = new Govern(options);
  return client;
}

type Model = Parameters<typeof wrapLanguageModel>[0]["model"];

/** One line at model setup. The middleware is created per request so it can hand the decision back to the route. */
export function gate(model: Model, onDecision?: (info: GovernDecisionInfo) => void) {
  return wrapLanguageModel({
    model,
    middleware: withGovern({
      govern: getGovern(),
      channel: CHANNEL,
      audience: AUDIENCE,
      ...(onDecision ? { onDecision } : {}),
    }),
  });
}

/** What the page renders for a held turn. Ids and codes only; never text. */
export interface GovernMessageMetadata {
  decisionId: string | null;
  decision: DecisionVerdict;
  mode: string;
  held: boolean;
  degraded: boolean;
  reasons: string[];
}

export function metadataFrom(info: GovernDecisionInfo): GovernMessageMetadata {
  return {
    decisionId: info.reply.decisionId,
    decision: info.reply.decision,
    mode: info.reply.mode,
    held: info.reply.held,
    degraded: info.reply.degraded,
    reasons: info.reply.reasons,
  };
}
