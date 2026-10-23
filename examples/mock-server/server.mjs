#!/usr/bin/env node
// A mock of the AnyBio Govern API for local development and the example app.
//
// Implements evaluate, decisions, outcomes and disclosures with the wire
// shapes of the real API and a synthetic policy that blocks one phrase. It
// also exposes a few /__mock/ routes that stand in for a reviewer releasing
// or rejecting a held decision. In-memory; nothing persists across restarts.
//
//   node examples/mock-server/server.mjs
//
// Environment:
//   PORT                          default 8787
//   GOVERN_MOCK_MODE              off | observe | enforce (default enforce)
//   GOVERN_MOCK_PROHIBITED        the phrase the synthetic policy blocks (default "cure")
//   GOVERN_MOCK_REQUIRE_DISCLOSURE  "false" to stop requiring the disclosure (default true)
//   GOVERN_MOCK_CONSOLE_ORIGIN    origin used in review_url (default https://console.example)
//
// Any bearer token starting with gk_ authenticates. Log lines carry ids,
// codes and statuses; never message text.

import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 8787);
const MODE = process.env.GOVERN_MOCK_MODE ?? "enforce";
const PROHIBITED = (process.env.GOVERN_MOCK_PROHIBITED ?? "cure").toLowerCase();
const REQUIRE_DISCLOSURE = process.env.GOVERN_MOCK_REQUIRE_DISCLOSURE !== "false";
const CONSOLE_ORIGIN = process.env.GOVERN_MOCK_CONSOLE_ORIGIN ?? "https://console.example";

const APPLICATION_ID = "00000000-0000-4000-8000-00000000a991";
const POLICY = { id: "00000000-0000-4000-8000-0000000090c1", name: "synthetic", version: 1 };
const CHANNELS = new Set(["sms", "app_message", "web_chat", "voice", "email"]);
const AUDIENCES = new Set(["patient", "clinician"]);

if (!["off", "observe", "enforce"].includes(MODE)) {
  console.error(`GOVERN_MOCK_MODE must be off, observe or enforce (got ${MODE})`);
  process.exit(2);
}

/** @type {Map<string, any>} decision id -> record */
const decisions = new Map();
/** @type {Map<string, string>} turn id -> decision id */
const byTurn = new Map();
/** @type {Map<string, string>} decision id -> original text (the mock's stand-in for the compliance check row) */
const originals = new Map();
/** @type {Map<string, any>} conversation id -> disclosure view */
const disclosures = new Map();

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const now = () => new Date().toISOString();

function errorBody(kind, message) {
  return { kind, error_message: message, code: null, details: [] };
}

function send(res, status, body, extraHeaders = {}) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type, idempotency-key",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    ...extraHeaders,
  });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function authenticate(req) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  return token.startsWith("gk_");
}

function identifier(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw badRequest(`${label} is required`);
  if ([...value].length > 256) throw badRequest(`${label} must be at most 256 characters`);
  return value.trim();
}

// The API composes each stored reference from the identifier the caller chose
// and the reference column is bounded, so the identifiers are bounded too:
// `govern:{uuid}:conversation:{id}:disclosure` and `govern:{uuid}:turn:{id}`
// inside 255 characters.
const MAX_CONVERSATION_ID_CHARS = 187;
const MAX_TURN_ID_CHARS = 206;
/** Turn ids the platform writes for its own rows start here; a caller's may not. */
const RESERVED_TURN_ID_PREFIX = "govern:";

function conversationIdentifier(value) {
  const id = identifier(value, "conversation_id");
  if ([...id].length > MAX_CONVERSATION_ID_CHARS) {
    throw badRequest(`conversation_id must be at most ${MAX_CONVERSATION_ID_CHARS} characters`);
  }
  return id;
}

function turnIdentifier(value, label = "turn_id") {
  const id = identifier(value, label);
  if (id.startsWith(RESERVED_TURN_ID_PREFIX)) {
    throw badRequest(`${label} must not start with the reserved prefix '${RESERVED_TURN_ID_PREFIX}'`);
  }
  if ([...id].length > MAX_TURN_ID_CHARS) {
    throw badRequest(`${label} must be at most ${MAX_TURN_ID_CHARS} characters`);
  }
  return id;
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  error.kind = "BAD_REQUEST_ERROR";
  return error;
}

function view(record) {
  return {
    decision_id: record.id,
    status: record.status,
    decision: record.decision,
    mode: record.mode,
    channel: record.channel,
    audience: record.audience,
    conversation_id: record.conversation_id,
    turn_id: record.turn_id,
    would_have: record.would_have,
    policy: record.policy,
    reasons: record.reasons,
    rationale: record.rationale,
    detected_claims: record.detected_claims,
    disclosure_required: record.disclosure_required,
    review_url: record.review_state ? `${CONSOLE_ORIGIN}/reviews?id=${record.id}` : null,
    review_state: record.review_state,
    deliverable_content: record.deliverable_content,
    released_content: record.review_state === "released" ? (originals.get(record.id) ?? null) : null,
    created_at: record.created_at,
    decided_at: record.decided_at,
    reviewed_at: record.reviewed_at,
    outcome: record.outcome,
    // Present on the stack head (hand-offs, webhooks); the mock never routes.
    route_to_human: false,
    would_have_routed: false,
    inbound_flags: [],
    handoff: null,
    webhook_deliveries: [],
  };
}

/** The synthetic gate: one prohibited phrase, plus the disclosure rule. */
function gate(text, audience, conversationId) {
  const lower = text.toLowerCase();
  const reasons = [];
  const claims = [];
  let raw = "allow";
  if (lower.includes(PROHIBITED)) {
    raw = "block_and_review";
    reasons.push("prohibited_claim");
    claims.push(PROHIBITED);
  }
  let disclosureRequired = false;
  // Note what is NOT read here: the request's `disclosure.ref`. The answer is
  // the evidence this conversation holds, so a presented reference decides
  // nothing and is ignored rather than refused, whatever it says.
  if (REQUIRE_DISCLOSURE && audience === "patient" && !disclosures.has(conversationId)) {
    raw = "block_and_review";
    reasons.push("disclosure_missing");
    disclosureRequired = true;
  }
  return { raw, reasons, claims, disclosureRequired };
}

async function handleEvaluate(req, res) {
  const body = await readJson(req);
  const conversationId = conversationIdentifier(body.conversation_id);
  const turnId = turnIdentifier(body.turn_id);
  const idempotency = req.headers["idempotency-key"];
  // A header in the reserved range is refused by this check: `turn_id` was
  // already validated above, so an `Idempotency-Key` that starts with
  // `govern:` cannot equal it. Same as the API.
  if (typeof idempotency === "string" && idempotency.trim() && idempotency.trim() !== turnId) {
    throw badRequest("Idempotency-Key must equal turn_id");
  }
  if (typeof body.content !== "string" || body.content.trim() === "") throw badRequest("content is required");
  if (!CHANNELS.has(body.channel)) throw badRequest("channel is invalid");
  if (!AUDIENCES.has(body.audience)) throw badRequest("audience is invalid");
  if ((body.channel === "sms" || body.channel === "voice") && body.audience !== "patient") {
    throw badRequest(`audience '${body.audience}' is not allowed on channel '${body.channel}'`);
  }
  if (body.application_id && body.application_id !== APPLICATION_ID) {
    const error = new Error("Forbidden: this key is not bound to the named application");
    error.status = 403;
    error.kind = "PERMISSION_DENIED_ERROR";
    throw error;
  }

  if (MODE === "off") {
    send(res, 200, {
      decision_id: null,
      status: "not_evaluated",
      decision: "allow",
      mode: "off",
      channel: body.channel,
      audience: body.audience,
      conversation_id: conversationId,
      turn_id: turnId,
      would_have: null,
      policy: null,
      reasons: ["not_evaluated"],
      rationale: null,
      detected_claims: [],
      disclosure_required: false,
      review_url: null,
      review_state: null,
      deliverable_content: null,
      released_content: null,
      created_at: null,
      decided_at: null,
      reviewed_at: null,
      outcome: null,
    });
    return;
  }

  const existingId = byTurn.get(turnId);
  if (existingId) {
    const existing = decisions.get(existingId);
    send(res, existing.status === "pending" ? 202 : 200, view(existing));
    console.log(`evaluate replay decision=${existing.id} decision=${existing.decision}`);
    return;
  }

  const id = randomUUID();
  const record = {
    id,
    status: "pending",
    decision: MODE === "observe" ? "allow" : "hold",
    mode: MODE,
    channel: body.channel,
    audience: body.audience,
    conversation_id: conversationId,
    turn_id: turnId,
    would_have: null,
    policy: POLICY,
    reasons: [],
    rationale: null,
    detected_claims: [],
    disclosure_required: false,
    review_state: null,
    deliverable_content: null,
    created_at: now(),
    decided_at: null,
    reviewed_at: null,
    outcome: null,
  };
  decisions.set(id, record);
  byTurn.set(turnId, id);
  originals.set(id, body.content.trim());

  const verdict = gate(body.content, body.audience, conversationId);
  const finalize = () => {
    record.status = "decided";
    record.decided_at = now();
    record.reasons = [...verdict.reasons];
    record.detected_claims = verdict.claims;
    record.disclosure_required = verdict.disclosureRequired;
    record.rationale =
      verdict.raw === "allow"
        ? null
        : verdict.claims.length > 0
          ? "The draft names a prohibited claim under the synthetic policy."
          : "No AI-identity disclosure is on record for this conversation.";
    if (MODE === "observe") {
      record.decision = "allow";
      record.would_have = verdict.raw;
      if (verdict.raw !== "allow") record.review_state = "pending";
    } else if (verdict.raw === "allow") {
      record.decision = "allow";
    } else {
      record.decision = "hold";
      record.reasons.push("held_for_review");
      record.review_state = "pending";
    }
    console.log(`evaluate decision=${id} mode=${MODE} decision=${record.decision} would_have=${record.would_have ?? "-"} reasons=${record.reasons.join(",") || "-"}`);
  };

  if (MODE === "observe") {
    send(res, 202, view(record));
    setTimeout(finalize, 300);
  } else {
    finalize();
    send(res, 200, view(record));
  }
}

function handleGetDecision(res, id) {
  const record = decisions.get(id);
  if (!record) return send(res, 404, errorBody("NOT_FOUND_ERROR", "Govern decision not found"));
  send(res, 200, view(record));
}

async function handleOutcome(req, res, id) {
  const record = decisions.get(id);
  if (!record) return send(res, 404, errorBody("NOT_FOUND_ERROR", "Govern decision not found"));
  const body = await readJson(req);
  if (typeof body.delivered !== "boolean") throw badRequest("delivered is required");
  if (typeof body.delivered_at !== "string" || Number.isNaN(Date.parse(body.delivered_at))) throw badRequest("delivered_at must be RFC 3339");
  let hash = null;
  if (body.delivered_content_hash !== undefined && body.delivered_content_hash !== null) {
    hash = String(body.delivered_content_hash).trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw badRequest("delivered_content_hash must be the SHA-256 of the delivered UTF-8 text, as 64 hex characters");
    }
  }
  if (body.delivered && !hash) throw badRequest("delivered_content_hash is required when delivered is true");
  const deliveryRef = body.delivery_ref ?? null;
  const report = { delivered: body.delivered, delivered_at: body.delivered_at, delivered_content_hash: hash, delivery_ref: deliveryRef };
  if (record.outcome) {
    const same =
      record.outcome.delivered === report.delivered &&
      record.outcome.delivered_at === report.delivered_at &&
      record.outcome.delivered_content_hash === report.delivered_content_hash &&
      record.outcome.delivery_ref === report.delivery_ref;
    if (same) return send(res, 200, view(record));
    return send(res, 409, errorBody("CONFLICT_ERROR", "an outcome is already recorded for this decision"));
  }
  const deliverable =
    record.review_state === "released" ? originals.get(id) : record.decision === "allow" ? originals.get(id) : null;
  record.outcome = {
    ...report,
    recorded_at: now(),
    hash_matches_release: body.delivered && hash && deliverable ? sha256(deliverable) === hash : null,
  };
  console.log(`outcome decision=${id} delivered=${body.delivered} hash_matches=${record.outcome.hash_matches_release}`);
  send(res, 201, view(record));
}

async function handleDisclosure(req, res) {
  const body = await readJson(req);
  const conversationId = conversationIdentifier(body.conversation_id);
  if (!CHANNELS.has(body.channel)) throw badRequest("channel is invalid");
  if (typeof body.text_shown !== "string" || body.text_shown.trim() === "") throw badRequest("text_shown is required");
  if (body.text_shown.length > 2000) throw badRequest("text_shown must be at most 2000 characters");
  const ref = `govern:${APPLICATION_ID}:conversation:${conversationId}:disclosure`;
  const existing = disclosures.get(conversationId);
  // 200 describes the evidence on record, not this call: its channel and the
  // time it was recorded, which is what the API answers on a replay.
  if (existing) return send(res, 200, existing);
  const created = {
    ref,
    application_id: APPLICATION_ID,
    conversation_id: conversationId,
    channel: body.channel,
    evidence_id: randomUUID(),
    recorded_at: now(),
  };
  disclosures.set(conversationId, created);
  console.log(`disclosure recorded conversation=${conversationId}`);
  send(res, 201, created);
}

/** Reviewer stand-ins. */
function handleReview(res, id, action) {
  const record = decisions.get(id);
  if (!record) return send(res, 404, errorBody("NOT_FOUND_ERROR", "Govern decision not found"));
  if (record.review_state !== "pending") return send(res, 409, errorBody("CONFLICT_ERROR", "the decision is not held"));
  record.review_state = action === "release" ? "released" : "rejected";
  record.reviewed_at = now();
  console.log(`review decision=${id} state=${record.review_state}`);
  send(res, 200, view(record));
}

function handleState(res) {
  send(res, 200, {
    mode: MODE,
    prohibited: PROHIBITED,
    require_disclosure: REQUIRE_DISCLOSURE,
    decisions: [...decisions.values()].map(view),
    disclosures: [...disclosures.values()],
  });
}

function handleReset(res) {
  decisions.clear();
  byTurn.clear();
  originals.clear();
  disclosures.clear();
  send(res, 200, { ok: true });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;
  const method = req.method ?? "GET";
  try {
    if (method === "OPTIONS") return send(res, 204);
    if (path === "/health") return send(res, 200, { ok: true, mode: MODE });

    let match;
    if (path.startsWith("/__mock/")) {
      if (method === "GET" && path === "/__mock/state") return handleState(res);
      if (method === "POST" && path === "/__mock/reset") return handleReset(res);
      if (method === "POST" && (match = path.match(/^\/__mock\/decisions\/([^/]+)\/(release|reject)$/))) {
        return handleReview(res, match[1], match[2]);
      }
      return send(res, 404, errorBody("NOT_FOUND_ERROR", "no such mock route"));
    }

    if (!path.startsWith("/api/v1/govern/")) return send(res, 404, errorBody("NOT_FOUND_ERROR", "not found"));
    if (!authenticate(req)) {
      return send(res, 403, { error: "Forbidden: this endpoint accepts a Govern application key only" });
    }

    if (method === "POST" && path === "/api/v1/govern/evaluate") return await handleEvaluate(req, res);
    if (method === "POST" && path === "/api/v1/govern/disclosures") return await handleDisclosure(req, res);
    if ((match = path.match(/^\/api\/v1\/govern\/decisions\/([^/]+)$/)) && method === "GET") {
      return handleGetDecision(res, decodeURIComponent(match[1]));
    }
    if ((match = path.match(/^\/api\/v1\/govern\/decisions\/([^/]+)\/outcome$/)) && method === "POST") {
      return await handleOutcome(req, res, decodeURIComponent(match[1]));
    }
    return send(res, 404, errorBody("NOT_FOUND_ERROR", "not found"));
  } catch (error) {
    const status = error.status ?? 500;
    const kind = error.kind ?? (error.message === "invalid json" ? "INVALID_PAYLOAD_ERROR" : "AXUM_ERROR");
    if (status >= 500) console.error(`error ${method} ${path}: ${error.message}`);
    send(res, status === 500 && error.message === "invalid json" ? 400 : status, errorBody(kind, error.message));
  }
});

server.listen(PORT, () => {
  console.log(`govern mock listening on http://localhost:${PORT} mode=${MODE} prohibited="${PROHIBITED}" require_disclosure=${REQUIRE_DISCLOSURE}`);
  console.log(`point the SDK at it with ANYBIO_GOVERN_BASE_URL=http://localhost:${PORT} and any key starting with gk_`);
});
