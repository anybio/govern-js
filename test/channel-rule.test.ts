import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { RunnableLambda } from "@langchain/core/runnables";
import { describe, expect, it } from "vitest";

import { sha256Hex } from "../src/crypto";
import { IN_SESSION_CHANNELS, isInSessionChannel } from "../src/index";
import { GovernCallbackHandler, RESPONSE_METADATA_KEY, governed } from "../src/langchain";
import { CHANNELS, OUTBOUND_CHANNELS, isOutboundChannel, type Channel, type WireDecision } from "../src/types";
import { PROVIDER_METADATA_KEY, withGovern, type LanguageModelCallOptions, type StreamPart } from "../src/vercel-ai";
import { DECISION_ID, DRAFT, HOLD, collect, decisionView, fetchMock, jsonResponse, makeClient, olderServer } from "./helpers";

/**
 * The channel rule. For a patient audience, the in-session channels
 * (`web_chat`, `app_message`, `voice`) show the hold text on every stopped
 * turn; the outbound ones (`sms`, `email`) and any value this version does
 * not know show it exactly when a holding line is owed, and hand the caller
 * nothing (`text` empty) otherwise. A clinician stop shows the hold text on
 * every channel.
 *
 * The cells are the API's: each row is a stop the API's own channel table
 * states, with the `(send_holding_line, show_hold_text)` pair it answers. The
 * SDK must hand back the same pair as `(sendHoldingLine, showHoldText)` when
 * the API sends `show_hold_text`, and the channel rule must reach the same
 * pair when a server that predates the field does not.
 */

const UNKNOWN = "carrier_pigeon" as Channel;

/** The API's channel classes, spelled out and not read from the SDK, so a flipped class fails here. */
const CHANNEL_CLASSES: readonly (readonly [Channel, boolean])[] = [
  ["sms", false],
  ["app_message", true],
  ["web_chat", true],
  ["voice", true],
  ["email", false],
];
/** Every class above, plus a value this version does not know, which reads as outbound. */
const EVERY: readonly (readonly [Channel, boolean])[] = [...CHANNEL_CLASSES, [UNKNOWN, false]];

const outcomeCalls = (calls: { url: URL; json: unknown }[]) => calls.filter((c) => c.url.pathname.endsWith("/outcome"));

/** What an adapter records for a hold: `released` with the hold text when it showed, `discarded` when it handed over nothing. */
const handedOverReport = async (shows: boolean) =>
  shows
    ? { kind: "released", at: expect.any(String), content_hash: await sha256Hex(HOLD) }
    : { kind: "discarded", at: expect.any(String), reason: "nothing_to_send" };

function clientFor(view: WireDecision | null) {
  const mock = fetchMock((call) => {
    if (view === null) throw new TypeError("fetch failed");
    if (call.url.pathname.endsWith("/outcome")) return jsonResponse(201, view);
    return jsonResponse(200, view);
  });
  return { ...mock, govern: makeClient(mock.fetch, { maxRetries: 0 }) };
}

type Pair = readonly [sendHoldingLine: boolean, showHoldText: boolean];

interface Row {
  /** The decision view the API sends on this channel. */
  view: (channel: Channel) => WireDecision;
  /** The API's `(send_holding_line, show_hold_text)` for the cell. */
  api: (inSession: boolean) => Pair;
}

const stopped = (channel: Channel, overrides: Partial<WireDecision>): WireDecision =>
  decisionView({ channel, decision: "hold", stop_class: "uncertain", ...overrides });

/** The patient-audience stops of the API's channel table, every one on every channel. */
const PATIENT_ROWS: Record<string, Row> = {
  "a normal hold, a holding line owed": {
    view: (channel) =>
      stopped(channel, { reasons: ["prohibited_claim", "held_for_review"], stop_class: "never_sendable", review_state: "pending", send_holding_line: true }),
    api: () => [true, true],
  },
  "the fail-closed hold with gate_unavailable alone": {
    view: (channel) => stopped(channel, { status: "unavailable", reasons: ["gate_unavailable"], policy: null, send_holding_line: true }),
    api: () => [true, true],
  },
  "the patient state unread, no holding line owed": {
    view: (channel) =>
      stopped(channel, { status: "unavailable", reasons: ["gate_unavailable", "patient_state_unavailable"], policy: null, send_holding_line: false }),
    api: (inSession) => [false, inSession],
  },
  "an opted-out patient, no holding line owed": {
    view: (channel) => stopped(channel, { decision: "block", reasons: ["opted_out"], stop_class: null, policy: null, send_holding_line: false }),
    api: (inSession) => [false, inSession],
  },
  "a revoked consent, no holding line owed": {
    view: (channel) => stopped(channel, { decision: "block", reasons: ["consent_revoked"], stop_class: null, policy: null, send_holding_line: false }),
    api: (inSession) => [false, inSession],
  },
  "a frequency-cap hold, no holding line owed": {
    view: (channel) => stopped(channel, { reasons: ["frequency_cap"], stop_class: null, policy: null, send_holding_line: false }),
    api: (inSession) => [false, inSession],
  },
  "a released hold": {
    view: (channel) =>
      stopped(channel, { reasons: ["prohibited_claim"], review_state: "released", released_content: "Reviewed reply.", send_holding_line: false }),
    api: () => [false, false],
  },
  "a rejected hold": {
    view: (channel) => stopped(channel, { reasons: ["prohibited_claim"], review_state: "rejected", send_holding_line: false }),
    api: () => [false, false],
  },
};

describe("isInSessionChannel", () => {
  it("classifies web_chat, app_message and voice as in-session, and everything else as outbound", () => {
    expect(IN_SESSION_CHANNELS).toEqual(["web_chat", "app_message", "voice"]);
    for (const [channel, inSession] of EVERY) expect(isInSessionChannel(channel), channel).toBe(inSession);
    for (const value of [undefined, null, 7, "", "WEB_CHAT", " web_chat", "VOICE"]) expect(isInSessionChannel(value)).toBe(false);
  });

  it("derives the known outbound channels from the same list: sms and email, and an unknown value is neither", () => {
    expect(OUTBOUND_CHANNELS).toEqual(["sms", "email"]);
    expect([...IN_SESSION_CHANNELS, ...OUTBOUND_CHANNELS].sort()).toEqual([...CHANNELS].sort());
    for (const [channel, inSession] of CHANNEL_CLASSES) expect(isOutboundChannel(channel), channel).toBe(!inSession);
    expect(isOutboundChannel(UNKNOWN)).toBe(false);
    expect(isInSessionChannel(UNKNOWN)).toBe(false);
  });
});

describe("guard: the hold text by channel, cell for cell with the API", () => {
  for (const [channel, inSession] of EVERY) {
    for (const [name, row] of Object.entries(PATIENT_ROWS)) {
      const [owed, shows] = row.api(inSession);
      it(`${channel}: ${name}: ${shows ? "shows the hold text" : "hands back nothing"}`, async () => {
        const view = row.view(channel);
        // The fixture says what the API says for this cell.
        expect([view.send_holding_line, view.show_hold_text]).toEqual([owed, shows]);

        const { govern, calls } = clientFor(view);
        const reply = await govern.guard(() => DRAFT, { conversationId: "conv-1", turnId: "turn-1", channel, audience: "patient", patientRef: "p-1" });
        expect(reply.held).toBe(true);
        expect([reply.sendHoldingLine, reply.showHoldText]).toEqual([owed, shows]);
        expect([reply.record!.sendHoldingLine, reply.record!.showHoldText]).toEqual([owed, shows]);
        expect(reply.text).toBe(shows ? HOLD : "");
        expect(reply.text).not.toContain("cures");
        // guard reports nothing itself: the caller records what it wrote.
        await govern.flushReports();
        expect(outcomeCalls(calls)).toHaveLength(0);
      });
    }

    it(`${channel}: an allow is untouched: neither flag, the draft as text`, async () => {
      const view = decisionView({ channel, decision: "allow", send_holding_line: false });
      expect(view.show_hold_text).toBe(false);
      const { govern } = clientFor(view);
      const reply = await govern.guard(() => DRAFT, { conversationId: "conv-1", channel, audience: "patient" });
      expect([reply.sendHoldingLine, reply.showHoldText]).toEqual([false, false]);
      expect(reply.text).toBe(DRAFT);
    });

    it(`${channel}: the API unreachable: no holding line, the hold text only in session`, async () => {
      const { govern } = clientFor(null);
      const reply = await govern.guard(() => DRAFT, { conversationId: "conv-1", turnId: "turn-1", channel, audience: "patient" });
      expect(reply.degraded).toBe(true);
      expect(reply.held).toBe(true);
      expect([reply.sendHoldingLine, reply.showHoldText]).toEqual([false, inSession]);
      expect(reply.text).toBe(inSession ? HOLD : "");
    });
  }
});

describe("guard: a server that predates show_hold_text gets the channel rule", () => {
  // The same cells with the field absent. The channel rule reaches the API's
  // pair on every row: it reads the review state as well, so a hold a
  // reviewer has released or rejected shows nothing on any channel.
  for (const [channel, inSession] of EVERY) {
    for (const [name, row] of Object.entries(PATIENT_ROWS)) {
      const [owed, shows] = row.api(inSession);
      it(`${channel}: ${name}`, async () => {
        const { govern } = clientFor(olderServer(row.view(channel)));
        const reply = await govern.guard(() => DRAFT, { conversationId: "conv-1", turnId: "turn-1", channel, audience: "patient" });
        expect([reply.sendHoldingLine, reply.showHoldText]).toEqual([owed, shows]);
        expect(reply.record!.showHoldText).toBe(shows);
        expect(reply.text).toBe(shows ? HOLD : "");
      });
    }
  }
});

describe("guard: the API's show_hold_text wins over the channel rule", () => {
  it("false where the channel rule says true: a stopped turn whose retry was accepted", async () => {
    // The one documented divergence: the stopped turn keeps send_holding_line
    // and stops saying show, because the retry's own decision answers.
    for (const [channel] of EVERY) {
      const view = stopped(channel, { reasons: ["clinical_claim", "held_for_review"], review_state: null, send_holding_line: true, show_hold_text: false, retryable: false });
      const local = await clientFor(olderServer(view)).govern.guard(() => DRAFT, { conversationId: "conv-1", turnId: "turn-1", channel, audience: "patient" });
      expect(local.showHoldText, channel).toBe(true);

      const reply = await clientFor(view).govern.guard(() => DRAFT, { conversationId: "conv-1", turnId: "turn-1", channel, audience: "patient" });
      expect([reply.sendHoldingLine, reply.showHoldText], channel).toEqual([true, false]);
      expect([reply.record!.sendHoldingLine, reply.record!.showHoldText], channel).toEqual([true, false]);
      expect(reply.text, channel).toBe("");
    }
  });

  it("true where the channel rule says false: a channel this version does not know, which the API knows to be in-session", async () => {
    for (const reasons of [["opted_out"], ["gate_unavailable", "patient_state_unavailable"]]) {
      const view = stopped(UNKNOWN, { decision: "block", reasons, policy: null, send_holding_line: false, show_hold_text: true });
      const local = await clientFor(olderServer(view)).govern.guard(() => DRAFT, { conversationId: "conv-1", turnId: "turn-1", channel: UNKNOWN, audience: "patient" });
      expect(local.showHoldText, reasons.join()).toBe(false);

      const reply = await clientFor(view).govern.guard(() => DRAFT, { conversationId: "conv-1", turnId: "turn-1", channel: UNKNOWN, audience: "patient" });
      expect([reply.sendHoldingLine, reply.showHoldText], reasons.join()).toEqual([false, true]);
      expect(reply.text).toBe(HOLD);
    }
  });

  it("on sms and email the hold text is the holding line: never shown where sendHoldingLine is false", async () => {
    for (const channel of ["sms", "email"] as Channel[]) {
      // A server that says show without a holding line, and one that offers a
      // holding line to a patient who opted out: the SDK's own check of the
      // contract says neither.
      for (const overrides of [
        { reasons: ["prohibited_claim"], review_state: "pending" as const, send_holding_line: false, show_hold_text: true },
        { decision: "block" as const, reasons: ["opted_out"], send_holding_line: true, show_hold_text: true },
      ]) {
        const reply = await clientFor(stopped(channel, overrides)).govern.guard(() => DRAFT, { conversationId: "conv-1", turnId: "turn-1", channel, audience: "patient" });
        expect([reply.sendHoldingLine, reply.showHoldText], channel).toEqual([false, false]);
        expect(reply.text).toBe("");
      }
    }
  });

  it("is never read on an allow", async () => {
    for (const [channel] of EVERY) {
      const reply = await clientFor(decisionView({ channel, decision: "allow", show_hold_text: true })).govern.guard(() => DRAFT, { conversationId: "conv-1", channel, audience: "patient" });
      expect(reply.showHoldText, channel).toBe(false);
      expect(reply.record!.showHoldText, channel).toBe(false);
      expect(reply.text).toBe(DRAFT);
    }
  });
});

describe("guard: a replayed turn", () => {
  it("shows the hold text again in session, and nothing more on an outbound or unknown channel", async () => {
    for (const [channel, inSession] of EVERY) {
      for (const view of [PATIENT_ROWS["a normal hold, a holding line owed"]!.view(channel), olderServer(PATIENT_ROWS["a normal hold, a holding line owed"]!.view(channel))]) {
        const { govern } = clientFor(view);
        const ctx = { conversationId: "conv-1", turnId: "turn-1", channel, audience: "patient" as const };
        const first = await govern.guard(() => DRAFT, ctx);
        const replay = await govern.guard(() => DRAFT, ctx);
        expect([first.sendHoldingLine, first.showHoldText], channel).toEqual([true, true]);
        // The one-per-decision memory is the holding line's. In session the
        // hold text is a reply, and the same reply again; elsewhere it is the
        // holding line, withheld with it.
        expect([replay.sendHoldingLine, replay.showHoldText], channel).toEqual([false, inSession]);
        expect([replay.record!.sendHoldingLine, replay.record!.showHoldText], channel).toEqual([false, inSession]);
        expect(replay.text, channel).toBe(inSession ? HOLD : "");
      }
    }
  });

  it("getDecision narrows Decision.showHoldText with the holding line", async () => {
    for (const [channel, inSession] of EVERY) {
      const { govern } = clientFor(PATIENT_ROWS["a normal hold, a holding line owed"]!.view(channel));
      const first = await govern.getDecision(DECISION_ID);
      const again = await govern.getDecision(DECISION_ID);
      expect([first.sendHoldingLine, first.showHoldText], channel).toEqual([true, true]);
      expect([again.sendHoldingLine, again.showHoldText], channel).toEqual([false, inSession]);
    }
  });
});

describe("guard: a clinician stop shows its notice on every channel", () => {
  // The channel rule is about contacting the patient; it does not apply to a
  // clinician audience, and no holding line is ever owed to one. `sms` and
  // `voice` accept the patient audience only.
  for (const channel of ["email", "web_chat", "app_message", UNKNOWN] as Channel[]) {
    const view = () => stopped(channel, { audience: "clinician", reasons: ["prohibited_claim", "held_for_review"], review_state: "pending", send_holding_line: false });
    for (const [name, build] of [
      ["the API's answer", () => view()],
      ["a server that predates show_hold_text", () => olderServer(view())],
      ["the API unreachable", () => null],
    ] as const) {
      it(`${channel}: ${name}`, async () => {
        const built = build();
        if (built) expect([built.send_holding_line, built.show_hold_text ?? true]).toEqual([false, true]);
        const { govern } = clientFor(built);
        const reply = await govern.guard(() => DRAFT, { conversationId: "conv-1", turnId: "turn-1", channel, audience: "clinician" });
        expect(reply.held).toBe(true);
        expect([reply.sendHoldingLine, reply.showHoldText]).toEqual([false, true]);
        expect(reply.text).toBe(HOLD);
        expect(reply.degraded).toBe(built === null);
      });
    }
  }

  it("a clinician hold a reviewer released or rejected shows nothing, from the API or from the channel rule", async () => {
    for (const review_state of ["released", "rejected"] as const) {
      const view = stopped("web_chat", { audience: "clinician", reasons: ["prohibited_claim"], review_state });
      for (const served of [view, olderServer(view)]) {
        const reply = await clientFor(served).govern.guard(() => DRAFT, { conversationId: "conv-1", turnId: "turn-1", channel: "web_chat", audience: "clinician" });
        expect([reply.sendHoldingLine, reply.showHoldText], review_state).toEqual([false, false]);
        expect(reply.text).toBe("");
      }
    }
  });
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
      const { govern, calls, waitForCall } = clientFor(plainHold(channel));
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
      await waitForCall("outcome");
      expect(outcomeCalls(calls)[0]!.json).toEqual(await handedOverReport(shows));
    });

    it(`wrapStream on ${channel}: ${shows ? "one hold text block" : "no text parts"}`, async () => {
      const { govern, calls, waitForCall } = clientFor(plainHold(channel));
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
      await waitForCall("outcome");
      expect(outcomeCalls(calls)[0]!.json).toEqual(await handedOverReport(shows));
    });
  }
});

describe("the LangChain adapters follow the channel rule", () => {
  const model = RunnableLambda.from(async (_input: string) => new AIMessage(DRAFT));

  for (const channel of ["voice", "sms"] as Channel[]) {
    const shows = isInSessionChannel(channel);

    it(`governed on ${channel}: ${shows ? "the hold text" : "empty text"}, and an outcome to match`, async () => {
      const { govern, calls, waitForCall } = clientFor(plainHold(channel));
      const gated = governed(model, { govern, channel, audience: "patient", conversationId: "conv-1" });
      const out = await gated.invoke("hello");
      expect(out).toBeInstanceOf(AIMessage);
      expect((out as BaseMessage).text).toBe(shows ? HOLD : "");
      expect((out as AIMessage).response_metadata[RESPONSE_METADATA_KEY]).toMatchObject({
        held: true,
        send_holding_line: false,
        show_hold_text: shows,
      });
      await waitForCall("outcome");
      expect(outcomeCalls(calls)[0]!.json).toEqual(await handedOverReport(shows));
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
