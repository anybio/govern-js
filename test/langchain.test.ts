import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatGeneration } from "@langchain/core/outputs";
import { RunnableLambda } from "@langchain/core/runnables";
import { describe, expect, it } from "vitest";

import { GovernConfigError } from "../src/errors";
import { GovernCallbackHandler, RESPONSE_METADATA_KEY, governed } from "../src/langchain";
import { DRAFT, HOLD, decisionView, fetchMock, jsonResponse, makeClient, tick } from "./helpers";

const model = RunnableLambda.from(async (_input: string) => new AIMessage(DRAFT));

/**
 * Read the text off whatever the wrapper returned. The adapter's own
 * `draftOf` is internal and stays that way; a test reaching for it was how it
 * came to be exported.
 */
function textOf(output: unknown): string {
  return typeof output === "string" ? output : (output as BaseMessage).text;
}

describe("governed", () => {
  it("returns the original AIMessage on allow", async () => {
    const { fetch, calls } = fetchMock([
      () => jsonResponse(200, decisionView({ decision: "allow" })),
      () => jsonResponse(201, decisionView({ decision: "allow" })),
    ]);
    const gated = governed(model, { govern: makeClient(fetch), channel: "web_chat", audience: "patient", conversationId: "conv-1" });
    const out = await gated.invoke("hello");
    expect(out).toBeInstanceOf(AIMessage);
    expect(textOf(out)).toBe(DRAFT);
    expect(calls[0]!.json).toMatchObject({ conversation_id: "conv-1", content: DRAFT, channel: "web_chat", audience: "patient" });
    await tick();
    expect(calls[1]!.url.pathname).toContain("/outcome");
  });

  it("replaces the AIMessage with the hold message on hold and records the decision in response_metadata", async () => {
    const { fetch } = fetchMock([
      () => jsonResponse(200, decisionView({ decision: "hold", reasons: ["prohibited_claim"] })),
      () => jsonResponse(201, decisionView({ decision: "hold" })),
    ]);
    const gated = governed(model, { govern: makeClient(fetch), channel: "web_chat", audience: "patient", conversationId: "conv-1" });
    const out = await gated.invoke("hello");
    expect(out).toBeInstanceOf(AIMessage);
    expect(textOf(out)).toBe(HOLD);
    expect(textOf(out)).not.toContain("cures");
    expect(out.response_metadata[RESPONSE_METADATA_KEY]).toMatchObject({ decision: "hold", held: true, reasons: ["prohibited_claim"] });
  });

  it("gates string outputs too", async () => {
    const { fetch } = fetchMock(() => jsonResponse(200, decisionView({ decision: "block" })));
    const stringModel = RunnableLambda.from(async (_input: string) => DRAFT);
    const gated = governed(stringModel, { govern: makeClient(fetch), channel: "web_chat", audience: "patient", conversationId: "conv-1", reportOutcome: false });
    expect(await gated.invoke("hello")).toBe(HOLD);
    // Outbound, with no holding line owed: the string comes back empty.
    const outbound = governed(stringModel, { govern: makeClient(fetch), channel: "sms", audience: "patient", conversationId: "conv-1", reportOutcome: false });
    expect(await outbound.invoke("hello")).toBe("");
  });

  it("reads the conversation id from configurable.anybioGovern or configurable.thread_id", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView()));
    const gated = governed(model, { govern: makeClient(fetch), channel: "web_chat", audience: "patient", reportOutcome: false });
    await gated.invoke("hello", { configurable: { anybioGovern: { conversationId: "conv-a", turnId: "turn-a" } } });
    expect(calls[0]!.json).toMatchObject({ conversation_id: "conv-a", turn_id: "turn-a" });
    await gated.invoke("hello", { configurable: { thread_id: "thread-9" } });
    expect(calls[1]!.json).toMatchObject({ conversation_id: "thread-9" });
    await expect(gated.invoke("hello")).rejects.toBeInstanceOf(GovernConfigError);
  });

  it("stream() yields one gated chunk after the decision", async () => {
    const { fetch } = fetchMock(() => jsonResponse(200, decisionView({ decision: "hold" })));
    const gated = governed(model, { govern: makeClient(fetch), channel: "web_chat", audience: "patient", conversationId: "conv-1", reportOutcome: false });
    const chunks: unknown[] = [];
    for await (const chunk of await gated.stream("hello")) chunks.push(chunk);
    expect(chunks).toHaveLength(1);
    expect(textOf(chunks[0])).toBe(HOLD);
  });
});

describe("GovernCallbackHandler", () => {
  it("records a decision for each generation using the run id as the turn id, and reports nothing by default", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(202, decisionView({ mode: "observe", status: "pending" })));
    const seen: string[] = [];
    const handler = new GovernCallbackHandler({
      govern: makeClient(fetch),
      channel: "web_chat",
      audience: "patient",
      conversationId: "conv-1",
      onDecision: ({ decision }) => seen.push(decision.mode),
    });
    await handler.handleLLMEnd({ generations: [[{ text: DRAFT }]] }, "run-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.json).toMatchObject({ conversation_id: "conv-1", turn_id: "run-1", content: DRAFT });
    expect(seen).toEqual(["observe"]);
  });

  it("reads the text from a chat generation's message when text is empty", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView()));
    const handler = new GovernCallbackHandler({ govern: makeClient(fetch), channel: "web_chat", audience: "patient", conversationId: "conv-1" });
    const generation: ChatGeneration = { text: "", message: new AIMessage("from message") };
    await handler.handleLLMEnd({ generations: [[generation]] }, "run-2");
    expect(calls[0]!.json).toMatchObject({ content: "from message", turn_id: "run-2" });
  });
});

describe("governed and an output it cannot read", () => {
  // A structured-output chain is a mainstream shape, and the text inside one
  // still reaches a patient. Silence here is a customer wiring the gate
  // correctly and gating nothing.
  const structured = RunnableLambda.from(async (_input: string) => ({ answer: DRAFT, confidence: 0.9 }));
  const options = { channel: "web_chat" as const, audience: "patient" as const, conversationId: "conv-1" };

  it("refuses a structured output rather than passing it through ungated", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView()));
    const gated = governed(structured, { govern: makeClient(fetch), ...options });
    await expect(gated.invoke("hello")).rejects.toBeInstanceOf(GovernConfigError);
    expect(calls).toHaveLength(0);
  });

  it("names the shape it could not read, and never its content", async () => {
    const { fetch } = fetchMock(() => jsonResponse(200, decisionView()));
    const gated = governed(structured, { govern: makeClient(fetch), ...options });
    const error = await gated.invoke("hello").then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error?.message).toContain("object");
    expect(error?.message).not.toContain("cures");
  });

  it("passes it through only when the caller asks, and says so on the way", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView()));
    const errors: unknown[] = [];
    const gated = governed(structured, {
      govern: makeClient(fetch),
      ...options,
      ungatedOutput: "pass",
      onError: (error) => errors.push(error),
    });
    expect(await gated.invoke("hello")).toMatchObject({ answer: DRAFT });
    expect(errors[0]).toBeInstanceOf(GovernConfigError);
    expect(calls).toHaveLength(0);
  });

  it("an output with no text at all is still nothing to gate", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView()));
    const empty = RunnableLambda.from(async (_input: string) => "");
    const gated = governed(empty, { govern: makeClient(fetch), ...options });
    expect(await gated.invoke("hello")).toBe("");
    expect(calls).toHaveLength(0);
  });

  it("a throwing onDecision cannot turn a hold into a thrown error", async () => {
    const { fetch } = fetchMock(() => jsonResponse(200, decisionView({ decision: "hold" })));
    const errors: unknown[] = [];
    const gated = governed(model, {
      govern: makeClient(fetch),
      ...options,
      reportOutcome: false,
      onDecision: () => {
        throw new Error("the caller's decision hook is broken");
      },
      onError: (error) => errors.push(error),
    });
    expect(textOf(await gated.invoke("hello"))).toBe(HOLD);
    expect(errors).toHaveLength(1);
  });
});

describe("governed keys the safety branch off the verdict", () => {
  const ECHO = "A person from the care team will review this and follow up with you shortly.";

  it("replaces a held message whose text matches the hold message, tool calls and all", async () => {
    const { fetch } = fetchMock(() => jsonResponse(200, decisionView({ decision: "hold" })));
    const tooled = RunnableLambda.from(
      async (_input: string) =>
        new AIMessage({
          content: ECHO,
          tool_calls: [{ name: "schedule_appointment", args: {}, id: "call-1" }],
        }),
    );
    const gated = governed(tooled, {
      govern: makeClient(fetch, { holdMessage: ECHO }),
      channel: "web_chat",
      audience: "patient",
      conversationId: "conv-1",
      reportOutcome: false,
    });
    const out = await gated.invoke("hello");
    expect(textOf(out)).toBe(ECHO);
    expect(out.tool_calls ?? []).toHaveLength(0);
    expect(out.response_metadata[RESPONSE_METADATA_KEY]).toMatchObject({ held: true, decision: "hold" });
  });
});

describe("governed returns the message class it can actually write", () => {
  it("substitutes an AIMessage for a runnable typed to another message class, and says so", async () => {
    const { fetch } = fetchMock(() => jsonResponse(200, decisionView({ decision: "hold" })));
    // A runnable whose output type is a concrete message class that is not
    // AIMessage. `replace` builds an AIMessage whatever went in: it has the
    // gate's text and the gate's metadata, and there is no general way to
    // construct a caller's subclass.
    const otherClass = RunnableLambda.from(async (_input: string) => new HumanMessage(DRAFT));
    const gated = governed(otherClass, {
      govern: makeClient(fetch),
      channel: "web_chat",
      audience: "patient",
      conversationId: "conv-1",
      reportOutcome: false,
    });
    const out = await gated.invoke("hello");
    expect(out).toBeInstanceOf(AIMessage);
    expect(out).not.toBeInstanceOf(HumanMessage);
    expect(textOf(out)).toBe(HOLD);
    // The type must carry the same news. A cast to RunOutput here told the
    // caller they still had their own class, and `out.getType()` would have
    // said "human" to anyone who believed it.
    // @ts-expect-error the declared output is HumanMessage | AIMessage, never HumanMessage alone
    const mistyped: HumanMessage = out;
    expect(mistyped.getType()).toBe("ai");
  });
});
