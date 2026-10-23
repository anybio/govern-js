// A scripted language model so the example runs with no model provider key.
// It streams a reply word by word. When the last user message asks about a
// cure or about stopping a medication, the reply contains the claim the
// synthetic policy prohibits, so you can watch the gate hold it.

import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4FinishReason,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";

const PROHIBITED_REPLY =
  "Good news: this program cures high blood pressure in a few weeks, so you can stop taking your medication once your readings settle.";

const BENIGN_REPLIES = [
  "Thanks for checking in. Your readings this week look steady. Keep logging them each morning, and the care team will review anything that stands out.",
  "I can help with reminders, logging a reading, or passing a question to the care team. What would be most useful right now?",
  "Noted. I have added that to today's log. If you notice dizziness or a reading well outside your usual range, contact the care team directly.",
];

function lastUserText(options: LanguageModelV4CallOptions): string {
  for (let i = options.prompt.length - 1; i >= 0; i--) {
    const message = options.prompt[i];
    if (message?.role !== "user") continue;
    return message.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("")
      .trim();
  }
  return "";
}

function replyFor(options: LanguageModelV4CallOptions): string {
  const text = lastUserText(options).toLowerCase();
  if (/\bcure|\bmedication|stop taking|\bmeds\b/.test(text)) return PROHIBITED_REPLY;
  const index = text.length % BENIGN_REPLIES.length;
  return BENIGN_REPLIES[index] ?? BENIGN_REPLIES[0]!;
}

const usage = (): LanguageModelV4Usage => ({
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  raw: undefined,
});

const finishReason: LanguageModelV4FinishReason = { unified: "stop", raw: "stop" };

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function scriptedModel(): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "scripted",
    modelId: "care-companion-scripted",
    supportedUrls: {},

    async doGenerate(options) {
      return {
        content: [{ type: "text", text: replyFor(options) }],
        finishReason,
        usage: usage(),
        warnings: [],
      };
    },

    async doStream(options) {
      const text = replyFor(options);
      const words = text.split(/(?<=\s)/);
      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "0" });
          for (const word of words) {
            await delay(35);
            controller.enqueue({ type: "text-delta", id: "0", delta: word });
          }
          controller.enqueue({ type: "text-end", id: "0" });
          controller.enqueue({ type: "finish", finishReason, usage: usage() });
          controller.close();
        },
      });
      return { stream };
    },
  };
}
