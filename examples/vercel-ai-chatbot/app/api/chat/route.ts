import type { GovernDecisionInfo } from "@anybio/govern/vercel-ai";
import { convertToModelMessages, streamText, type UIMessage } from "ai";

import { gate, metadataFrom } from "../../../lib/govern";
import { newId } from "../../../lib/id";
import { scriptedModel } from "../../../lib/model";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const { messages, id } = (await request.json()) as { messages: UIMessage[]; id: string };
  const lastMessage = messages[messages.length - 1];

  // The middleware hands the decision back here so the page can render the
  // held state. Ids and codes only; the text is already gated.
  let decision: GovernDecisionInfo | undefined;

  const result = streamText({
    model: gate(scriptedModel(), (info) => {
      decision = info;
    }),
    messages: await convertToModelMessages(messages),
    providerOptions: {
      anybioGovern: {
        conversationId: id,
        turnId: lastMessage?.id ?? newId(),
      },
    },
  });

  return result.toUIMessageStreamResponse({
    messageMetadata: ({ part }) => {
      if (part.type === "finish" && decision) return { govern: metadataFrom(decision) };
      return undefined;
    },
  });
}
