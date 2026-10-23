import { describe, expect, it } from "vitest";

import { isAutomationPaused } from "../src/index";
import type { HandoffRef, WireCareHandoff, WireDecision } from "../src/types";
import { parseEvent } from "../src/webhook";
import { DECISION_ID, DRAFT, decisionView, fetchMock, jsonResponse, makeClient } from "./helpers";

const HANDOFF_ID = "9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a";
const RESUMED_AT = "2026-09-18T00:00:00Z";

function wireRef(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    id: HANDOFF_ID,
    state: "claimed",
    version: 2,
    queue_label: "Care companion follow-up",
    assigned_to: "3a2b1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d",
    due_at: null,
    escalation_due_at: null,
    resolved_at: null,
    automation_resumed_at: null,
    pauses_automation: true,
    ...extra,
  };
}

function row(extra: Record<string, unknown>): WireCareHandoff {
  return {
    id: HANDOFF_ID,
    organization_id: 1,
    environment_id: "1e2d3c4b-5a69-4788-9a0b-1c2d3e4f5a6b",
    reason: "route_to_human",
    state: "claimed",
    queue_label: "Care companion follow-up",
    pauses_automation: true,
    automation_resumed_at: null,
    version: 2,
    created_at: "2026-09-17T00:00:00Z",
    updated_at: "2026-09-17T00:00:00Z",
    ...extra,
  } as WireCareHandoff;
}

async function decisionWith(handoff: Record<string, unknown>) {
  const view = decisionView({ handoff } as unknown as Partial<WireDecision>);
  const { fetch } = fetchMock(() => jsonResponse(200, view));
  return makeClient(fetch).evaluate({ conversationId: "conv-1", turnId: "turn-1", channel: "web_chat", audience: "patient", content: DRAFT });
}

describe("a hand-off pauses automation only when it says so", () => {
  it("paused: pauses_automation true and not resumed", async () => {
    const decision = await decisionWith(wireRef({}));
    expect(decision.handoff).toMatchObject({ id: HANDOFF_ID, pausesAutomation: true, automationResumedAt: null });
    expect(isAutomationPaused(decision.handoff)).toBe(true);
  });

  it("owned but not paused: a person owns the item and automation keeps running", async () => {
    const decision = await decisionWith(wireRef({ pauses_automation: false }));
    expect(decision.handoff).toMatchObject({ pausesAutomation: false, automationResumedAt: null });
    expect(isAutomationPaused(decision.handoff)).toBe(false);
  });

  it("resumed: a person released the hold", async () => {
    const decision = await decisionWith(wireRef({ automation_resumed_at: RESUMED_AT, state: "resolved" }));
    expect(decision.handoff).toMatchObject({ pausesAutomation: true, automationResumedAt: RESUMED_AT });
    expect(isAutomationPaused(decision.handoff)).toBe(false);
  });

  it("a server that predates the field reads as paused while not resumed", async () => {
    const legacy = wireRef({});
    delete legacy.pauses_automation;
    const decision = await decisionWith(legacy);
    expect(decision.handoff?.pausesAutomation).toBe(true);
    expect(isAutomationPaused(decision.handoff)).toBe(true);
  });

  it("guard carries the same field", async () => {
    const view = decisionView({ handoff: wireRef({ pauses_automation: false }) } as unknown as Partial<WireDecision>);
    const { fetch } = fetchMock(() => jsonResponse(200, view));
    const result = await makeClient(fetch).guard(() => DRAFT, { conversationId: "conv-1", channel: "web_chat", audience: "patient" });
    expect(result.handoff?.pausesAutomation).toBe(false);
    expect(isAutomationPaused(result.handoff)).toBe(false);
  });

  it("isAutomationPaused reads a wire hand-off row the same way", () => {
    expect(isAutomationPaused(row({}))).toBe(true);
    expect(isAutomationPaused(row({ pauses_automation: false }))).toBe(false);
    expect(isAutomationPaused(row({ automation_resumed_at: RESUMED_AT }))).toBe(false);
    expect(isAutomationPaused(row({ pauses_automation: false, automation_resumed_at: RESUMED_AT }))).toBe(false);
  });

  it("isAutomationPaused reads a HandoffRef by the rule, and no hand-off as not paused", () => {
    const ref: HandoffRef = {
      id: HANDOFF_ID,
      state: "queued",
      version: 1,
      queueLabel: "q",
      assignedTo: null,
      dueAt: null,
      escalationDueAt: null,
      resolvedAt: null,
      automationResumedAt: null,
      pausesAutomation: true,
    };
    expect(isAutomationPaused(ref)).toBe(true);
    expect(isAutomationPaused({ ...ref, pausesAutomation: false })).toBe(false);
    expect(isAutomationPaused({ ...ref, automationResumedAt: RESUMED_AT })).toBe(false);
    expect(isAutomationPaused(null)).toBe(false);
    expect(isAutomationPaused(undefined)).toBe(false);
  });
});

describe("the hand-off list says which items still owe a reply", () => {
  it("maps awaiting_reply to awaitingReply", async () => {
    const other = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    const { fetch } = fetchMock(() =>
      jsonResponse(200, {
        environment_id: "1e2d3c4b-5a69-4788-9a0b-1c2d3e4f5a6b",
        items: [row({}), row({ id: other, pauses_automation: false })],
        patient_names: {},
        total: 2,
        awaiting_reply: [other],
      }),
    );
    const list = await makeClient(fetch).handoffs.list();
    expect(list.awaitingReply).toEqual([other]);
    expect(list.items.map((item) => isAutomationPaused(item))).toEqual([true, false]);
  });

  it("reads an absent awaiting_reply as empty", async () => {
    const { fetch } = fetchMock(() => jsonResponse(200, { environment_id: "e", items: [], patient_names: {}, total: 0 }));
    const list = await makeClient(fetch).handoffs.list();
    expect(list.awaitingReply).toEqual([]);
  });
});

describe("the rest of the regenerated contract on hand-off, webhook and decision surfaces", () => {
  it("a decision carries its webhook delivery log", async () => {
    const delivery = { id: "d1", event: "decision.released", subject_version: 0, status: "delivered", attempts: 1, created_at: "2026-09-16T00:00:00Z", decision_id: DECISION_ID };
    const { fetch } = fetchMock(() => jsonResponse(200, decisionView({ webhook_deliveries: [delivery] } as unknown as Partial<WireDecision>)));
    const decision = await makeClient(fetch).getDecision(DECISION_ID);
    expect(decision.webhookDeliveries).toEqual([delivery]);
  });

  it("a hand-off webhook event carries pausesAutomation, absent reading as true", () => {
    const base = { id: "d2", event: "handoff.opened", handoff_id: HANDOFF_ID, state: "queued", version: 1, assigned: false };
    expect(parseEvent({ ...base, pauses_automation: false }, null)).toMatchObject({ type: "handoff.opened", pausesAutomation: false });
    expect(parseEvent({ ...base, pauses_automation: true }, null)).toMatchObject({ pausesAutomation: true });
    expect(parseEvent(base, null)).toMatchObject({ pausesAutomation: true });
  });

  it("a decision webhook event carries the model, its version and the stop class", () => {
    const base = { id: "d1", event: "decision.rejected", decision_id: DECISION_ID };
    expect(parseEvent({ ...base, model: "gpt-4o", model_version: "gpt-4o-2024-08-06", stop_class: "never_sendable" }, null)).toMatchObject({
      type: "decision.rejected",
      model: "gpt-4o",
      modelVersion: "gpt-4o-2024-08-06",
      stopClass: "never_sendable",
    });
    expect(parseEvent({ ...base, stop_class: "something_new" }, null)).toMatchObject({ stopClass: "uncertain", model: null, modelVersion: null });
    expect(parseEvent(base, null)).toMatchObject({ stopClass: null });
  });
});
