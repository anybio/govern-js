import { CHANNEL, DISCLOSURE_TEXT, getGovern } from "../../../lib/govern";

export const runtime = "nodejs";

/** Session start: record the AI-identity disclosure once per conversation and return the text that was shown. */
export async function POST(request: Request) {
  const { chatId } = (await request.json()) as { chatId: string };
  if (!chatId) return Response.json({ error: "chatId is required" }, { status: 400 });
  try {
    const disclosure = await getGovern().recordDisclosure({ conversationId: chatId, channel: CHANNEL, textShown: DISCLOSURE_TEXT });
    return Response.json({ ref: disclosure.ref, created: disclosure.created, text: DISCLOSURE_TEXT });
  } catch (error) {
    console.error("[govern] recordDisclosure failed:", error instanceof Error ? error.message : String(error));
    return Response.json({ text: DISCLOSURE_TEXT, ref: null, created: false, degraded: true }, { status: 200 });
  }
}
