import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { RunnableLambda } from "@langchain/core/runnables";
import { describe, expect, it } from "vitest";

import { sha256Hex } from "../src/crypto";
import { IN_SESSION_CHANNELS, isInSessionChannel } from "../src/index";
import { GovernCallbackHandler, RESPONSE_METADATA_KEY, governed } from "../src/langchain";
import type { Channel, WireDecision } from "../src/types";
import { PROVIDER_METADATA_KEY, withGovern, type LanguageModelCallOptions, type StreamPart } from "../src/vercel-ai";
import { DECISION_ID, DRAFT, HOLD, collect, decisionView, fetchMock, jsonResponse, makeClient, tick } from "./helpers";

/**
 * The channel rule, for the patient audience. In-session channels
 * (`web_chat`, `app_message`) show the hold text on every hold; outbound
 * channels (`sms`, `voice`, `email`) and any value this version does not know
 * follow `sendHoldingLine`, and hand the caller nothing (`text` empty) when it
 * is false. A clinician hold shows the hold text on every channel.
 */

const UNKNOWN = "carrier_pigeon" as Channel;
const IN_SESSION: Channel[] = ["web_chat", "app_message"];
const OUTBOUND: Channel[] = ["sms", "voice", "email", UNKNOWN];
const ALL: Channel[] = [...IN_SESSION, ...OUTBOUND];

const outcomeCalls = (calls: { url: URL; json: unknown }[]) => calls.filter((c) => c.url.pathname.endsWith("/outcome"));

/** The four holds every channel is checked against. `null` is the API unreachable. */
const HOLDS: Record<string, (channel: Channel) => WireDecision | null> = {
  "a normal hold with send_holding_line true": (channel) =>
    decisionView({
      channel,
      decision: "hold",
      reasons: ["prohibited_claim"],
      stop_class: "never_sendable",
      send_holding_line: true,
      review_state: "pending",
    }),
  "the API unreachable": () => null,
  "patient_state_unavailable": (channel) =>
    decisionView({
      channel,
      status: "unavailable",
      decision: "hold",
      reasons: ["gate_unavailable", "patient_state_unavailable"],
      stop_class: "uncertain",
      policy: null,
      send_holding_line: false,
    }),
  "a released hold": (channel) =>
    decisionView({
      channel,
      decision: "hold",
      reasons: ["prohibited_claim"],
      stop_class: "uncertain",
      review_state: "released",
      released_content: "Reviewed reply.",
      // A server that says otherwise is overruled: a released hold owes no holding line.
      send_holding_line: true,
    }),
};

/** Whether the API, left to itself, owes a holding line on this hold. */
const OWES_HOLDING_LINE: Record<string, boolean> = {
  "a normal hold with send_holding_line true": true,
  "the API unreachable": false,
  "patient_state_unavailable": false,
  "a released hold": false,
};

function clientFor(view: WireDecision | null) {
  const mock = fetchMock((call) => {
    if (view === null) throw new TypeError("fetch failed");
    if (call.url.pathname.endsWith("/outcome")) return jsonResponse(201, view);
    return jsonResponse(200, view);
  });
  return { ...mock, govern: makeClient(mock.fetch, { maxRetries: 0 }) };
}

describe("isInSessionChannel", () => {
  it("classifies web_chat and app_message as in-session, and everything else as outbound", () => {
    expect(IN_SESSION_CHANNELS).toEqual(["web_chat", "app_message"]);
    for (const channel of IN_SESSION) expect(isInSessionChannel(channel), channel).toBe(true);
    for (const channel of OUTBOUND) expect(isInSessionChannel(channel), channel).toBe(false);
    for (const value of [undefined, null, 7, "", "WEB_CHAT", " web_chat"]) expect(isInSessionChannel(value)).toBe(false);
  });
});

describe("guard: the hold text by channel", () => {
  for (const channel of ALL) {
    const inSession = isInSessionChannel(channel);
    for (const [name, build] of Object.entries(HOLDS)) {
      const owed = OWES_HOLDING_LINE[name]!;
      const shows = inSession || owed;
      it(`${channel}: ${name} ${shows ? "shows the hold text" : "hands back nothing"}`, async () => {
        const view = build(channel);
        const { govern, calls } = clientFor(view);
        const reply = await govern.guard(() => DRAFT, { conversationId: "conv-1", turnId: "turn-1", channel, audience: "patient", patientRef: "p-1" });
        expect(reply.held).toBe(true);
        expect(reply.sendHoldingLine).toBe(owed);
        expect(reply.showHoldText).toBe(shows);
        expect(reply.text).toBe(shows ? HOLD : "");
        expect(reply.text).not.toContain("cures");
        expect(reply.degraded).toBe(view === null);

        // The automatic report follows what was handed over: delivered with the
        // hold text's hash when the patient saw it, not delivered otherwise.
        await govern.flushPendingAcks();
        const outcomes = outcomeCalls(calls);
        if (view === null) {
          expect(outcomes).toHaveLength(0);
        } else {
          expect(outcomes).toHaveLength(1);
          if (shows) {
            expect(outcomes[0]!.json).toMatchObject({ delivered: true, delivered_content_hash: await sha256Hex(HOLD) });
          } else {
            expect(outcomes[0]!.json).toMatchObject({ delivered: false });
            expect(outcomes[0]!.json).not.toHaveProperty("delivered_content_hash");
          }
        }
      });
    }
  }

  it("a replayed turn shows the hold text again in session, and nothing more on an outbound channel", async () => {
    for (const channel of ALL) {
      const { govern } = clientFor(HOLDS["a normal hold with send_holding_line true"]!(channel));
      const ctx = { conversationId: "conv-1", turnId: "turn-1", channel, audience: "patient" as const };
      const first = await govern.guard(() => DRAFT, ctx);
      const replay = await govern.guard(() => DRAFT, ctx);
      expect(first.sendHoldingLine, channel).toBe(true);
      expect(first.showHoldText, channel).toBe(true);
      // The one-per-decision dedup is on the holding line only.
      expect(replay.sendHoldingLine, channel).toBe(false);
      expect(replay.showHoldText, channel).toBe(isInSessionChannel(channel));
      expect(replay.text, channel).toBe(isInSessionChannel(channel) ? HOLD : "");
    }
  });

  it("ack() defaults to what was handed over", async () => {
    for (const channel of ["web_chat", "sms"] as Channel[]) {
      const { govern, calls } = clientFor(HOLDS["patient_state_unavailable"]!(channel));
      const reply = await govern.guard(() => DRAFT, { conversationId: "conv-1", turnId: "turn-1", channel, audience: "patient" });
      await reply.ack();
      const outcome = outcomeCalls(calls)[0]!.json as Record<string, unknown>;
      if (channel === "web_chat") {
        expect(outcome).toMatchObject({ delivered: true, delivered_content_hash: await sha256Hex(HOLD) });
      } else {
        expect(outcome).toMatchObject({ delivered: false });
        expect(outcome).not.toHaveProperty("delivered_content_hash");
      }
    }
  });

  it("an allow is untouched on every channel: showHoldText false, text the draft", async () => {
    for (const channel of ALL) {
      const { govern } = clientFor(decisionView({ channel, decision: "allow" }));
      const reply = await govern.guard(() => DRAFT, { conversationId: "conv-1", channel, audience: "patient" });
      expect(reply.showHoldText).toBe(false);
      expect(reply.text).toBe(DRAFT);
    }
  });
});

describe("guard: a clinician hold shows its notice on every channel", () => {
  // The channel rule is about contacting the patient; it does not apply to a
  // clinician audience, and no holding line is ever owed to one.
  const CLINICIAN_HOLDS = ["a normal hold with send_holding_line true", "the API unreachable"] as const;
  for (const channel of ["email", "web_chat", "app_message", UNKNOWN] as Channel[]) {
    for (const name of CLINICIAN_HOLDS) {
      it(`${channel}: ${name} shows the hold text to a clinician`, async () => {
        const built = HOLDS[name]!(channel);
        const view = built === null ? null : { ...built, audience: "clinician" as const };
        const { govern, calls } = clientFor(view);
        const reply = await govern.guard(() => DRAFT, { conversationId: "conv-1", turnId: "turn-1", channel, audience: "clinician" });
        expect(reply.held).toBe(true);
        expect(reply.sendHoldingLine).toBe(false);
        expect(reply.showHoldText).toBe(true);
        expect(reply.text).toBe(HOLD);
        expect(reply.degraded).toBe(view === null);

        await govern.flushPendingAcks();
        const outcomes = outcomeCalls(calls);
        if (view === null) {
          expect(outcomes).toHaveLength(0);
        } else {
          expect(outcomes).toHaveLength(1);
          expect(outcomes[0]!.json).toMatchObject({ delivered: true, delivered_content_hash: await sha256Hex(HOLD) });
        }
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

/** A hold that owes no holding line: in session it shows, outbound it does not. */
const plainHold = (channel: Channel) =>
  decisionView({ channel, decision: "hold", reasons: ["patient_state_unavailable", "gate_unavailable"], status: "unavailable", policy: null });

const params = {
  prompt: [],
  providerOptions: { anybioGovern: { conversationId: "conv-1", turnId: "turn-1" } },
} as unknown as LanguageModelCallOptions;

type WrapArgs = Parameters<NonNullable<ReturnType<typeof withGovern>["wrapGenerate"]>>[0];
type GenerateResult = Awaited<ReturnType<WrapArgs["doGenerate"]>>;
type StreamArgs = Parameters<NonNullable<ReturnType<typeof withGovern>["wrapStream"]>>[0];

const generateResult = {
  content: [{ type: "text", text: DRAFT }],
  finishReason: { unified: "stop", raw: "stop" },
  usage: {},
  warnings: [],
} as unknown as GenerateResult;

function streamParts(): StreamPart[] {
  return [
    { type: "stream-start", warnings: [] } as StreamPart,
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: DRAFT },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: {} } as unknown as StreamPart,
  ];
}

function textOfContent(content: readonly { type: string }[]): string {
  return content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

describe("the Vercel AI middleware follows the channel rule", () => {
  for (const channel of ["app_message", "email"] as Channel[]) {
    const shows = isInSessionChannel(channel);

    it(`wrapGenerate on ${channel}: ${shows ? "the hold text" : "no text"}, and an outcome to match`, async () => {
      const { govern, calls } = clientFor(plainHold(channel));
      const middleware = withGovern({ govern, channel, audience: "patient" });
      const result = await middleware.wrapGenerate!({
        doGenerate: async () => generateResult,
        doStream: async () => {
          throw new Error("unused");
        },
        params,
        model: {} as WrapArgs["model"],
      });
      expect(textOfContent(result.content)).toBe(shows ? HOLD : "");
      if (!shows) expect(result.content).toHaveLength(0);
      expect(result.providerMetadata?.[PROVIDER_METADATA_KEY]).toMatchObject({ held: true, sendHoldingLine: false, showHoldText: shows });
      await tick();
      const outcome = outcomeCalls(calls)[0]!.json;
      expect(outcome).toMatchObject({ delivered: shows });
      if (!shows) expect(outcome).not.toHaveProperty("delivered_content_hash");
    });

    it(`wrapStream on ${channel}: ${shows ? "one hold text block" : "no text parts"}`, async () => {
      const { govern, calls } = clientFor(plainHold(channel));
      const middleware = withGovern({ govern, channel, audience: "patient" });
      const { stream } = await middleware.wrapStream!({
        doGenerate: async () => generateResult,
        doStream: async () => ({
          stream: new ReadableStream<StreamPart>({
            start(controller) {
              for (const part of streamParts()) controller.enqueue(part);
              controller.close();
            },
          }),
        }),
        params,
        model: {} as StreamArgs["model"],
      });
      const parts = await collect(stream);
      const deltas = parts.filter((p): p is Extract<StreamPart, { type: "text-delta" }> => p.type === "text-delta");
      expect(deltas.map((p) => p.delta).join("")).toBe(shows ? HOLD : "");
      if (!shows) expect(parts.some((p) => p.type === "text-start" || p.type === "text-end")).toBe(false);
      const finish = parts.find((p) => p.type === "finish") as { providerMetadata?: Record<string, unknown> } | undefined;
      expect(finish?.providerMetadata?.[PROVIDER_METADATA_KEY]).toMatchObject({ showHoldText: shows });
      await tick();
      expect(outcomeCalls(calls)[0]!.json).toMatchObject({ delivered: shows });
    });
  }
});

describe("the LangChain adapters follow the channel rule", () => {
  const model = RunnableLambda.from(async (_input: string) => new AIMessage(DRAFT));

  for (const channel of ["web_chat", "voice"] as Channel[]) {
    const shows = isInSessionChannel(channel);

    it(`governed on ${channel}: ${shows ? "the hold text" : "empty text"}, and an outcome to match`, async () => {
      const { govern, calls } = clientFor(plainHold(channel));
      const gated = governed(model, { govern, channel, audience: "patient", conversationId: "conv-1" });
      const out = await gated.invoke("hello");
      expect(out).toBeInstanceOf(AIMessage);
      expect((out as BaseMessage).text).toBe(shows ? HOLD : "");
      expect((out as AIMessage).response_metadata[RESPONSE_METADATA_KEY]).toMatchObject({
        held: true,
        send_holding_line: false,
        show_hold_text: shows,
      });
      await tick();
      const outcome = outcomeCalls(calls)[0]!.json;
      expect(outcome).toMatchObject({ delivered: shows });
      if (!shows) expect(outcome).not.toHaveProperty("delivered_content_hash");
    });

    it(`the callback handler on ${channel} records the decision and renders no text of its own`, async () => {
      const { govern, calls } = clientFor(plainHold(channel));
      const seen: { id: string | null; held: boolean }[] = [];
      const handler = new GovernCallbackHandler({
        govern,
        channel,
        audience: "patient",
        conversationId: "conv-1",
        onDecision: ({ decision }) => seen.push({ id: decision.id, held: decision.decision !== "allow" }),
      });
      await handler.handleLLMEnd({ generations: [[{ text: DRAFT }]] }, "run-1");
      expect(seen).toEqual([{ id: DECISION_ID, held: true }]);
      // Recording only: a callback cannot withhold what the chain already
      // returned, and it reports nothing unless asked.
      expect(outcomeCalls(calls)).toHaveLength(0);
      expect(calls[0]!.json).toMatchObject({ channel });
    });
  }
});
