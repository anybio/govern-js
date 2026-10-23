/** `govern test-message`: post a synthetic draft with a prohibited claim so the first decision is visible in a minute. */

import { Govern } from "../client";
import { randomId } from "../crypto";
import { GovernApiError, GovernError } from "../errors";
import type { Audience, Channel, Decision } from "../types";
import { AUDIENCES, CHANNELS } from "../types";
import { ENV_APPLICATION, ENV_KEY } from "./init";

export const ENV_BASE_URL = "ANYBIO_GOVERN_BASE_URL";

/** A draft no policy for a patient audience should let through: a cure claim and a medication instruction. */
export const SYNTHETIC_DRAFT =
  "Good news: this program cures high blood pressure in two weeks, so you can stop taking your medication now.";

export const SYNTHETIC_DISCLOSURE =
  "You are chatting with an AI assistant. A person from the care team reviews held messages and can be reached at any time.";

export interface TestMessageOptions {
  channel: string;
  audience: string;
  baseUrl: string | undefined;
  content: string | undefined;
  conversationId: string | undefined;
  skipDisclosure: boolean;
}

export async function runTestMessage(options: TestMessageOptions): Promise<number> {
  const apiKey = process.env[ENV_KEY];
  if (!apiKey) {
    console.error(`${ENV_KEY} is not set. Create an application in the console, copy the key shown once, and export it in this shell.`);
    return 1;
  }
  if (!(CHANNELS as readonly string[]).includes(options.channel)) {
    console.error(`--channel must be one of ${CHANNELS.join(", ")}.`);
    return 1;
  }
  if (!(AUDIENCES as readonly string[]).includes(options.audience)) {
    console.error(`--audience must be one of ${AUDIENCES.join(", ")}.`);
    return 1;
  }
  const channel = options.channel as Channel;
  const audience = options.audience as Audience;
  const baseUrl = options.baseUrl ?? process.env[ENV_BASE_URL];
  const clientOptions: ConstructorParameters<typeof Govern>[0] = {
    apiKey,
    application: process.env[ENV_APPLICATION] ?? "cli",
  };
  if (baseUrl) clientOptions.baseUrl = baseUrl;
  const govern = new Govern(clientOptions);
  const conversationId = options.conversationId ?? `govern-test-message-${Date.now()}`;
  const turnId = randomId();

  console.log(`Posting a synthetic draft to ${govern.baseUrl} (channel ${channel}, audience ${audience})...`);
  try {
    if (!options.skipDisclosure) {
      const disclosure = await govern.recordDisclosure({ conversationId, channel, textShown: SYNTHETIC_DISCLOSURE });
      console.log(`Disclosure ${disclosure.created ? "recorded" : "already on record"}: ${disclosure.ref}`);
    }
    const decision = await govern.evaluate({
      conversationId,
      turnId,
      channel,
      audience,
      content: options.content ?? SYNTHETIC_DRAFT,
      metadata: { source: "govern-cli-test-message" },
    });
    printDecision(decision);
    return 0;
  } catch (error) {
    printError(error);
    return 1;
  }
}

export async function runDecision(decisionId: string, baseUrl: string | undefined): Promise<number> {
  const apiKey = process.env[ENV_KEY];
  if (!apiKey) {
    console.error(`${ENV_KEY} is not set.`);
    return 1;
  }
  const clientOptions: ConstructorParameters<typeof Govern>[0] = {
    apiKey,
    application: process.env[ENV_APPLICATION] ?? "cli",
  };
  const url = baseUrl ?? process.env[ENV_BASE_URL];
  if (url) clientOptions.baseUrl = url;
  const govern = new Govern(clientOptions);
  try {
    printDecision(await govern.getDecision(decisionId));
    return 0;
  } catch (error) {
    printError(error);
    return 1;
  }
}

export function printDecision(decision: Decision): void {
  console.log("");
  console.log(`decision id     ${decision.id ?? "(none: the channel is off)"}`);
  console.log(`mode            ${decision.mode}`);
  console.log(`status          ${decision.status}`);
  console.log(`decision        ${decision.decision}`);
  if (decision.wouldHave) console.log(`would have      ${decision.wouldHave}`);
  console.log(`reasons         ${decision.reasons.length > 0 ? decision.reasons.join(", ") : "(none)"}`);
  if (decision.policy) console.log(`policy          ${decision.policy.name} v${decision.policy.version}`);
  if (decision.disclosureRequired) console.log(`disclosure      required and not on record for this conversation`);
  if (decision.reviewUrl) console.log(`review          ${decision.reviewUrl}`);
  console.log("");
  if (decision.status === "not_evaluated") {
    console.log("This channel is off for the application. Set it to observe or enforce in the console and try again.");
  } else if (decision.mode === "observe" && decision.status === "pending") {
    console.log("Observe mode: the gate evaluates off the request path. Check the verdict in a moment:");
    console.log(`  npx @anybio/govern decision ${decision.id}`);
  } else if (decision.mode === "observe") {
    console.log(
      decision.wouldHave && decision.wouldHave !== "allow"
        ? `Observe mode: you were told allow, and the record shows the gate would have decided ${decision.wouldHave}. That is the would-have block.`
        : "Observe mode: the gate would have allowed this draft. Check the policy attached to this channel names a prohibited claim the draft contains.",
    );
  } else if (decision.decision === "hold" || decision.decision === "block") {
    console.log(`Enforce mode: the gate ${decision.decision === "hold" ? "held" : "blocked"} the draft. You just watched the gate hold a message.`);
  } else {
    console.log("Enforce mode: the gate allowed this draft. Check the policy attached to this channel names a prohibited claim the draft contains.");
  }
}

export function printError(error: unknown): void {
  if (error instanceof GovernApiError) {
    console.error(`The API answered ${error.status}${error.kind ? ` (${error.kind})` : ""}.`);
    if (error.status === 401 || error.status === 403) {
      console.error("Check the key: it must be an application key (gk_...), for this environment, presented as a bearer token.");
    } else if (error.status === 400) {
      // Asked for by name. The server's text is off `.message` because the SDK
      // cannot promise what is in it; here it is a developer at a terminal
      // debugging a draft this command wrote itself, not a log pipeline.
      console.error(error.serverMessage ? `Check the request: ${error.serverMessage}` : "Check the request.");
    }
    return;
  }
  if (error instanceof GovernError) {
    console.error(`${error.name}: ${error.message}`);
    return;
  }
  console.error(String(error));
}
