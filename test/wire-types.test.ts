import { describe, expect, expectTypeOf, it } from "vitest";

import type { Handoff, HandoffDetail, HandoffList, WireCareHandoff, WireDecision, WireHandoffDetail, WireHandoffList } from "../src/index";
import { decisionView, olderServer } from "./helpers";

/**
 * The fields the API document requires that a server predating them omits
 * are optional in the exported types, so a caller's code must handle their
 * absence to compile. These checks run in `pnpm typecheck`; the runtime
 * assertions only keep the fixtures honest.
 */

/** A hand-off row as a server that predates `kind` sends it. */
const olderRow = {
  id: "3c2b1a09-8f7e-4d6c-9b5a-493827160514",
  organization_id: 1,
  environment_id: "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d",
  reason: "red_flag",
  state: "queued",
  queue_label: "care-team",
  pauses_automation: true,
  version: 1,
  created_at: "2026-09-16T00:00:00Z",
  updated_at: "2026-09-16T00:00:00Z",
};

describe("the hand-off types accept a row without kind", () => {
  it("Handoff and WireCareHandoff: kind is optional, and providing it still compiles", () => {
    const older: Handoff = olderRow;
    const current: Handoff = { ...olderRow, kind: "general" };
    const wire: WireCareHandoff = olderRow;
    expectTypeOf<Handoff["kind"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<WireCareHandoff>().toEqualTypeOf<Handoff>();
    // @ts-expect-error kind may be absent, so it must be checked before use
    const unchecked = (row: Handoff): string => row.kind.toUpperCase();
    const checked = (row: Handoff): string => row.kind?.toUpperCase() ?? "UNKNOWN";
    expect([checked(older), checked(current), wire.kind]).toEqual(["UNKNOWN", "GENERAL", undefined]);
    expect(() => unchecked(older)).toThrow(TypeError);
  });

  it("the hand-off detail and the list carry the same row type", () => {
    const detail: HandoffDetail = {
      environment_id: olderRow.environment_id,
      handoff: olderRow,
      events: [],
      subject: { application_id: "00000000-0000-4000-8000-00000000a991", patient_ref_hash: "0".repeat(64) },
      decisions: [],
    };
    const list: WireHandoffList = { environment_id: olderRow.environment_id, items: [olderRow], total: 1, patient_names: {}, awaiting_reply: [] };
    expectTypeOf<WireHandoffDetail["handoff"]>().toEqualTypeOf<Handoff>();
    expectTypeOf<WireHandoffList["items"]>().toEqualTypeOf<Handoff[]>();
    expectTypeOf<HandoffList["items"]>().toEqualTypeOf<Handoff[]>();
    expectTypeOf<HandoffList["raw"]>().toEqualTypeOf<WireHandoffList>();
    expect([detail.handoff.kind, list.items[0]?.kind]).toEqual([undefined, undefined]);
  });
});

describe("the decision view type accepts a view without the fields an older server omits", () => {
  it("flagged, matches, show_hold_text, retryable and supersedes are optional, and providing them still compiles", () => {
    const { flagged: _flagged, matches: _matches, ...withoutFlags } = olderServer(decisionView());
    const older: WireDecision = withoutFlags;
    const current: WireDecision = decisionView({ flagged: true, matches: [], show_hold_text: false, retryable: false, supersedes: [] });
    expectTypeOf<WireDecision["flagged"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<WireDecision["show_hold_text"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<WireDecision["retryable"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<WireDecision["supersedes"]>().toEqualTypeOf<string[] | undefined>();
    expectTypeOf<NonNullable<WireDecision["matches"]>>().toBeArray();
    // @ts-expect-error matches may be absent, so it must be checked before use
    const unchecked = (view: WireDecision): number => view.matches.length;
    const checked = (view: WireDecision): number => view.matches?.length ?? 0;
    expect([checked(older), checked(current)]).toEqual([0, 0]);
    expect(() => unchecked(older)).toThrow(TypeError);
    expect([older.flagged, older.show_hold_text, older.retryable, older.supersedes]).toEqual([undefined, undefined, undefined, undefined]);
  });
});
