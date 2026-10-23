import { AIMessage } from "@langchain/core/messages";
import type { ChatGeneration } from "@langchain/core/outputs";
import { RunnableLambda } from "@langchain/core/runnables";
import { describe, expect, it } from "vitest";

import { GovernCallbackHandler, RESPONSE_METADATA_KEY, governed } from "../src/langchain";
import { PROVIDER_METADATA_KEY, withGovern, type LanguageModelCallOptions, type StreamPart } from "../src/vercel-ai";
import { DRAFT, collect, decisionView, fetchMock, jsonResponse, makeClient, tick } from "./helpers";

/** The evaluate request body of the first call. */
function evaluateBody(calls: { url: URL; json: unknown }[]): Record<string, unknown> {
  const call = calls.find((c) => c.url.pathname === "/api/v1/govern/evaluate");
  return (call?.json ?? {}) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Vercel AI SDK
// ---------------------------------------------------------------------------

type Middleware = ReturnType<typeof withGovern>;
type WrapGenerateArgs = Parameters<NonNullable<Middleware["wrapGenerate"]>>[0];
type WrapStreamArgs = Parameters<NonNullable<Middleware["wrapStream"]>>[0];
type GenerateResult = Awaited<ReturnType<WrapGenerateArgs["doGenerate"]>>;

const params = {
  prompt: [],
  providerOptions: { anybioGovern: { conversationId: "conv-1", turnId: "turn-1" } },
} as unknown as LanguageModelCallOptions;

const wrappedModel = { modelId: "gpt-4o", provider: "openai.chat" } as unknown as WrapGenerateArgs["model"];

function generated(responseModelId?: string): GenerateResult {
  return {
    content: [{ type: "text", text: DRAFT }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: {},
    warnings: [],
    ...(responseModelId ? { response: { modelId: responseModelId } } : {}),
  } as unknown as GenerateResult;
}

function streamOf(parts: StreamPart[]): ReadableStream<StreamPart> {
  return new ReadableStream<StreamPart>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

function streamParts(responseModelId?: string): StreamPart[] {
  return [
    { type: "stream-start", warnings: [] } as StreamPart,
    ...(responseModelId ? [{ type: "response-metadata", modelId: responseModelId } as StreamPart] : []),
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: DRAFT },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: {} } as unknown as StreamPart,
  ];
}

describe("the Vercel AI middleware names the model", () => {
  it("wrapGenerate sends the wrapped model's id and the provider's reported version", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView()));
    const middleware = withGovern({ govern: makeClient(fetch), channel: "web_chat", audience: "patient", reportOutcome: false });
    await middleware.wrapGenerate!({
      doGenerate: async () => generated("gpt-4o-2024-08-06"),
      doStream: async () => ({ stream: streamOf([]) }),
      params,
      model: wrappedModel,
    });
    expect(evaluateBody(calls)).toMatchObject({ model: "gpt-4o", model_version: "gpt-4o-2024-08-06" });
  });

  it("wrapGenerate sends no version when the provider reports none, and the options override both", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView()));
    const bare = withGovern({ govern: makeClient(fetch), channel: "web_chat", audience: "patient", reportOutcome: false });
    await bare.wrapGenerate!({ doGenerate: async () => generated(), doStream: async () => ({ stream: streamOf([]) }), params, model: wrappedModel });
    expect(evaluateBody(calls)).toMatchObject({ model: "gpt-4o" });
    expect(evaluateBody(calls)).not.toHaveProperty("model_version");

    const second = fetchMock(() => jsonResponse(200, decisionView()));
    const named = withGovern({
      govern: makeClient(second.fetch),
      channel: "web_chat",
      audience: "patient",
      reportOutcome: false,
      model: "care-assistant",
      modelVersion: () => "2026-09",
    });
    await named.wrapGenerate!({
      doGenerate: async () => generated("gpt-4o-2024-08-06"),
      doStream: async () => ({ stream: streamOf([]) }),
      params,
      model: wrappedModel,
    });
    expect(evaluateBody(second.calls)).toMatchObject({ model: "care-assistant", model_version: "2026-09" });
  });

  it("wrapStream (patient) reads the version off the response-metadata part", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView()));
    const middleware = withGovern({ govern: makeClient(fetch), channel: "web_chat", audience: "patient", reportOutcome: false });
    const { stream } = await middleware.wrapStream!({
      doStream: async () => ({ stream: streamOf(streamParts("gpt-4o-2024-08-06")) }),
      doGenerate: async () => generated(),
      params,
      model: wrappedModel as unknown as WrapStreamArgs["model"],
    });
    await collect(stream);
    expect(evaluateBody(calls)).toMatchObject({ model: "gpt-4o", model_version: "gpt-4o-2024-08-06" });
  });

  it("wrapStream (clinician) does the same on the trailing evaluation", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView({ audience: "clinician" })));
    const middleware = withGovern({ govern: makeClient(fetch), channel: "web_chat", audience: "clinician", reportOutcome: false });
    const { stream } = await middleware.wrapStream!({
      doStream: async () => ({ stream: streamOf(streamParts("gpt-4o-2024-08-06")) }),
      doGenerate: async () => generated(),
      params,
      model: wrappedModel as unknown as WrapStreamArgs["model"],
    });
    await collect(stream);
    await tick();
    expect(evaluateBody(calls)).toMatchObject({ model: "gpt-4o", model_version: "gpt-4o-2024-08-06" });
  });

  it("puts sendHoldingLine and stopClass in the provider metadata", async () => {
    const { fetch } = fetchMock(() =>
      jsonResponse(200, decisionView({ decision: "hold", stop_class: "uncertain", send_holding_line: true, review_state: "pending" })),
    );
    const middleware = withGovern({ govern: makeClient(fetch), channel: "web_chat", audience: "patient", reportOutcome: false });
    const result = await middleware.wrapGenerate!({
      doGenerate: async () => generated(),
      doStream: async () => ({ stream: streamOf([]) }),
      params,
      model: wrappedModel,
    });
    expect(result.providerMetadata?.[PROVIDER_METADATA_KEY]).toMatchObject({ held: true, sendHoldingLine: true, stopClass: "uncertain" });
  });
});

// ---------------------------------------------------------------------------
// LangChain
// ---------------------------------------------------------------------------

describe("the LangChain adapters name the model", () => {
  it("governed sends the chat model's own name and the version on the response", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView()));
    const chatModel = Object.assign(
      RunnableLambda.from(async (_input: string) => new AIMessage({ content: DRAFT, response_metadata: { model_name: "gpt-4o-2024-08-06" } })),
      { model: "gpt-4o" },
    );
    const gated = governed(chatModel, { govern: makeClient(fetch), channel: "web_chat", audience: "patient", conversationId: "conv-1", reportOutcome: false });
    await gated.invoke("hello");
    expect(evaluateBody(calls)).toMatchObject({ model: "gpt-4o", model_version: "gpt-4o-2024-08-06" });
  });

  it("governed reads an Anthropic-shaped `model` in response_metadata, and the options override", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView()));
    const chatModel = RunnableLambda.from(
      async (_input: string) => new AIMessage({ content: DRAFT, response_metadata: { model: "claude-sonnet-4-5-20250929" } }),
    );
    const gated = governed(chatModel, {
      govern: makeClient(fetch),
      channel: "web_chat",
      audience: "patient",
      conversationId: "conv-1",
      reportOutcome: false,
      model: "care-assistant",
    });
    await gated.invoke("hello");
    expect(evaluateBody(calls)).toMatchObject({ model: "care-assistant", model_version: "claude-sonnet-4-5-20250929" });
  });

  it("governed sends neither when nothing names a model", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView()));
    const gated = governed(RunnableLambda.from(async (_input: string) => DRAFT), {
      govern: makeClient(fetch),
      channel: "web_chat",
      audience: "patient",
      conversationId: "conv-1",
      reportOutcome: false,
    });
    await gated.invoke("hello");
    expect(evaluateBody(calls)).not.toHaveProperty("model");
    expect(evaluateBody(calls)).not.toHaveProperty("model_version");
  });

  it("governed writes send_holding_line and stop_class into response_metadata", async () => {
    const { fetch } = fetchMock(() =>
      jsonResponse(200, decisionView({ decision: "hold", stop_class: "never_sendable", send_holding_line: true, review_state: "pending" })),
    );
    const gated = governed(RunnableLambda.from(async (_input: string) => new AIMessage(DRAFT)), {
      govern: makeClient(fetch),
      channel: "web_chat",
      audience: "patient",
      conversationId: "conv-1",
      reportOutcome: false,
    });
    const out = await gated.invoke("hello");
    expect(out.response_metadata[RESPONSE_METADATA_KEY]).toMatchObject({ send_holding_line: true, stop_class: "never_sendable" });
  });

  it("GovernCallbackHandler sends the model named at the run's start and the version on the generation", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView()));
    const handler = new GovernCallbackHandler({ govern: makeClient(fetch), channel: "web_chat", audience: "patient", conversationId: "conv-1" });
    handler.handleChatModelStart(
      { lc: 1, type: "not_implemented", id: [] },
      [],
      "run-1",
      undefined,
      { invocation_params: { model: "gpt-4o" } },
    );
    const generation: ChatGeneration = {
      text: DRAFT,
      message: new AIMessage({ content: DRAFT, response_metadata: { model_name: "gpt-4o-2024-08-06" } }),
    };
    await handler.handleLLMEnd({ generations: [[generation]] }, "run-1");
    expect(evaluateBody(calls)).toMatchObject({ model: "gpt-4o", model_version: "gpt-4o-2024-08-06" });
  });

  it("GovernCallbackHandler falls back to ls_model_name and llmOutput.model_name", async () => {
    const { fetch, calls } = fetchMock(() => jsonResponse(200, decisionView()));
    const handler = new GovernCallbackHandler({ govern: makeClient(fetch), channel: "web_chat", audience: "patient", conversationId: "conv-1" });
    handler.handleLLMStart({ lc: 1, type: "not_implemented", id: [] }, ["hi"], "run-2", undefined, {}, [], {
      ls_model_name: "claude-sonnet-4-5",
    });
    await handler.handleLLMEnd({ generations: [[{ text: DRAFT }]], llmOutput: { model_name: "claude-sonnet-4-5-20250929" } }, "run-2");
    expect(evaluateBody(calls)).toMatchObject({ model: "claude-sonnet-4-5", model_version: "claude-sonnet-4-5-20250929" });
  });
});
