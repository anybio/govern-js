import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { GOVERN_PATHS } from "../src/client";
import { REASONS } from "../src/types";
import { SDK_VERSION } from "../src/version";
import { TARGETS, generateTypes } from "../scripts/lib/generate-types.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("generated types", () => {
  for (const target of TARGETS) {
    it(`${target.out} is what ${target.spec} generates (run pnpm generate:types after changing the spec)`, async () => {
      const spec = readFileSync(resolve(root, target.spec), "utf8");
      const expected = await generateTypes(spec, target);
      const committed = readFileSync(resolve(root, target.out), "utf8");
      expect(committed).toBe(expected);
    });
  }
});

describe("routes the client calls exist in the spec", () => {
  const doc = JSON.parse(readFileSync(resolve(root, "spec/openapi.json"), "utf8")) as {
    paths: Record<string, unknown>;
  };

  // Every route the client can call must exist in the document.
  const called = [
    GOVERN_PATHS.evaluate,
    GOVERN_PATHS.decision("{decision_id}"),
    GOVERN_PATHS.outcome("{decision_id}"),
    GOVERN_PATHS.disclosures,
    GOVERN_PATHS.transcripts,
    GOVERN_PATHS.transcriptJob("{job_id}"),
    GOVERN_PATHS.transcriptTurns("{job_id}"),
    GOVERN_PATHS.patientConsent,
    GOVERN_PATHS.patientOptOut,
    GOVERN_PATHS.patientState,
    GOVERN_PATHS.webhookDeliveries,
    GOVERN_PATHS.handoffs,
    GOVERN_PATHS.handoff("{handoff_id}"),
    GOVERN_PATHS.handoffClaim("{handoff_id}"),
    GOVERN_PATHS.handoffContact("{handoff_id}"),
    GOVERN_PATHS.handoffResolve("{handoff_id}"),
    GOVERN_PATHS.handoffResume("{handoff_id}"),
  ].map(decodeURIComponent);

  it("every route the client calls is in spec/openapi.json", () => {
    for (const path of called) expect(Object.keys(doc.paths), path).toContain(path);
  });

  it("every path in the document is under /api/v1/govern/", () => {
    for (const path of Object.keys(doc.paths)) {
      expect(path.startsWith("/api/v1/govern/")).toBe(true);
    }
  });
});

describe("the decision fields the gate's red-flag screen rides on", () => {
  const doc = JSON.parse(readFileSync(resolve(root, "spec/openapi.json"), "utf8")) as {
    components: { schemas: Record<string, { properties?: Record<string, unknown>; required?: string[] }> };
  };
  const view = doc.components.schemas.DecisionView!;

  // `toDecision` reads these off the typed wire, so a rename in the document
  // breaks the build. This is the other half of that: the document itself must
  // keep declaring them. A field that quietly disappears reads as `false`, and
  // `routeToHuman: false` means "no red flag" to every caller.
  it("route_to_human, would_have_routed, inbound_flags and handoff are declared", () => {
    for (const field of ["route_to_human", "would_have_routed", "inbound_flags", "handoff"]) {
      expect(Object.keys(view.properties ?? {}), field).toContain(field);
    }
  });

  it("the three that carry a verdict are required, so absent can only mean an older server", () => {
    for (const field of ["route_to_human", "would_have_routed", "inbound_flags"]) {
      expect(view.required ?? [], field).toContain(field);
    }
  });
});

describe("the holding line, stop class and model fields", () => {
  const doc = JSON.parse(readFileSync(resolve(root, "spec/openapi.json"), "utf8")) as {
    components: { schemas: Record<string, { properties?: Record<string, unknown>; required?: string[] }> };
  };

  // Read off the typed wire by `toDecision`; this holds the document to them,
  // because an absent `send_holding_line` reads as "no holding line owed".
  it("are declared on the decision view, and send_holding_line is required", () => {
    const view = doc.components.schemas.DecisionView!;
    for (const field of ["send_holding_line", "stop_class", "model", "model_version"]) {
      expect(Object.keys(view.properties ?? {}), field).toContain(field);
    }
    expect(view.required ?? []).toContain("send_holding_line");
  });

  it("model and model_version are declared on the evaluate request", () => {
    const request = doc.components.schemas.EvaluateRequest!;
    for (const field of ["model", "model_version"]) {
      expect(Object.keys(request.properties ?? {}), field).toContain(field);
    }
  });
});

describe("the hold text and the retry fields", () => {
  const doc = JSON.parse(readFileSync(resolve(root, "spec/openapi.json"), "utf8")) as {
    components: { schemas: Record<string, { properties?: Record<string, unknown>; required?: string[] }> };
  };

  // `toDecision` reads these off the typed wire, and an absent
  // `show_hold_text` falls back to the channel rule: the document must keep
  // them required, so absent can only mean an older server.
  it("show_hold_text and retryable are required on the decision view, and retry_of is declared", () => {
    const view = doc.components.schemas.DecisionView!;
    for (const field of ["show_hold_text", "retryable"]) expect(view.required ?? [], field).toContain(field);
    expect(Object.keys(view.properties ?? {})).toContain("retry_of");
  });

  it("retry_of is declared on the evaluate request", () => {
    expect(Object.keys(doc.components.schemas.EvaluateRequest!.properties ?? {})).toContain("retry_of");
  });
});

describe("the turn reference and the superseded attempts", () => {
  const doc = JSON.parse(readFileSync(resolve(root, "spec/openapi.json"), "utf8")) as {
    components: { schemas: Record<string, { properties?: Record<string, unknown>; required?: string[] }> };
  };

  // `evaluate` sends `turn_ref` and `supersedes`, and the API ignores a field
  // its schema does not name: the document must keep declaring both, or a
  // rename would leave every turn grouping and superseding nothing.
  it("turn_ref and supersedes are declared on the evaluate request", () => {
    const request = doc.components.schemas.EvaluateRequest!;
    for (const field of ["turn_ref", "supersedes"]) {
      expect(Object.keys(request.properties ?? {}), field).toContain(field);
    }
  });

  // `WireDecision` marks `supersedes` optional because the document requires
  // it and an older server omits it; `turn_ref` and `superseded_by` are
  // optional in the document itself. Hold the document to both halves.
  it("turn_ref, supersedes and superseded_by are declared on the decision view, and only supersedes is required", () => {
    const view = doc.components.schemas.DecisionView!;
    for (const field of ["turn_ref", "supersedes", "superseded_by"]) {
      expect(Object.keys(view.properties ?? {}), field).toContain(field);
    }
    expect(view.required ?? []).toContain("supersedes");
    for (const field of ["turn_ref", "superseded_by"]) expect(view.required ?? [], field).not.toContain(field);
  });
});

describe("the hand-off pause and the reply still owed", () => {
  const doc = JSON.parse(readFileSync(resolve(root, "spec/openapi.json"), "utf8")) as {
    components: { schemas: Record<string, { properties?: Record<string, unknown>; required?: string[] }> };
  };

  // `isAutomationPaused` reads `pauses_automation` beside `automation_resumed_at`;
  // this holds the document to both on every hand-off shape the SDK maps.
  it("pauses_automation is required on the hand-off and its reference", () => {
    for (const name of ["HandoffRef", "CareHandoff"]) {
      const schema = doc.components.schemas[name]!;
      expect(schema.required ?? [], name).toContain("pauses_automation");
      expect(Object.keys(schema.properties ?? {}), name).toContain("automation_resumed_at");
    }
  });

  it("awaiting_reply is required on the hand-off list", () => {
    expect(doc.components.schemas.HandoffList!.required ?? []).toContain("awaiting_reply");
  });
});

describe("the reason codes the SDK publishes", () => {
  it("are the API's snake_case codes, plus the three the SDK adds itself", () => {
    // The API's reason codes. Update both together.
    const api = [
      "policy_missing",
      "gate_unavailable",
      "prohibited_claim",
      "medication_instruction",
      "missing_disclaimer",
      "clinical_claim",
      "review_required",
      "patient_rewrite_withheld",
      "disclosure_missing",
      "held_for_review",
      "rewritten",
      "not_evaluated",
      "opted_out",
      "consent_missing",
      "consent_revoked",
      "frequency_cap",
      "patient_state_unavailable",
    ];
    // The SDK's own three: one for a decision value it cannot read, one for
    // a call the API refused, one for a turn the API refused with 409.
    // None is ever sent by the API.
    const sdkOnly = ["unknown_decision", "client_misconfigured", "turn_conflict"];
    expect([...Object.values(REASONS)].sort()).toEqual([...api, ...sdkOnly].sort());
  });
});

describe("version", () => {
  it("SDK_VERSION matches package.json", () => {
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version: string };
    expect(SDK_VERSION).toBe(pkg.version);
  });
});
