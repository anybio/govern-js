#!/usr/bin/env node
// A mock of the AnyBio Govern API for local development and the example app.
//
// Implements evaluate, decisions, outcomes and disclosures with the wire
// shapes of the real API and a synthetic policy that blocks one phrase. It
// also exposes a few /__mock/ routes that stand in for a reviewer releasing
// or rejecting a held decision, one that backdates a decision as if an
// earlier process had made it, and one that answers an enforce evaluation
// GOVERN_MOCK_ENFORCE_HOLD keeps pending. In-memory; nothing persists across
// restarts.
//
// Beside the draft, an `inbound` (which needs `patient_ref`, as on the API)
// runs a scripted red-flag screen: a match sets `route_to_human`, lists the
// rule in `inbound_flags` and opens (or joins) one hand-off per patient that
// pauses automation. A patient-audience hold in enforce carries
// `send_holding_line: true`; the mock keeps no patient state, so nothing
// stops it. `show_hold_text` follows the API's rule: on a stopped turn, true
// for a clinician, for a patient in session (`web_chat`, `app_message`,
// `voice`), and for a patient on `sms` or `email` when the holding line is
// owed.
//
// `stop_class` is `never_sendable` for a stop on a prohibited claim or a
// medication instruction and `uncertain` for any other stop. `retryable`
// follows the API's rule: a patient-audience hold or block in enforce, still
// pending review, `uncertain`, whose every reason is `clinical_claim` or
// `missing_disclaimer` (at least one of them), alone or beside `flagged`,
// `patient_flag_withheld` and `held_for_review`, on a turn that is not itself
// a retry and did not route the patient to a person. `retry_of` is accepted
// only for a retryable decision of the same conversation, recorded for the
// same `patient_ref`: another conversation, another patient reference (or
// one where the decision has none, or none where it has one) and a decision
// that was never retryable are a 400, whatever happened to it since. A
// decision that was retryable when it was decided and has moved since is a
// 409, the first that applies of: another turn superseded it (`supersedes`),
// it was already retried, a `delivered` event is on record, a reviewer
// released or rejected it. Accepting it takes the stopped turn out of review in
// the same step: `review_state` null, `retryable` false, `show_hold_text`
// false, and `send_holding_line` kept, as on the API, and writes the stopped
// turn's `superseded` outcome event (source `retry`).
//
// `turn_ref` (at most 128 characters) is stored and shown on the view; a
// retry without one takes its parent's. `supersedes` (at most 8 decision ids)
// names the earlier attempts at the turn that nobody heard, and is refused
// whole, before anything is recorded, by the first rule that applies, in the
// API's order: 400 for more than 8 ids, an id named twice, the `retry_of`
// decision named, or an id that is not a decision of this conversation; 400
// for a decision recorded for another `patient_ref` (or with one when this
// turn sends none, or without one when it does); 409 for an enforce decision
// still being decided (only with GOVERN_MOCK_ENFORCE_HOLD: otherwise the
// mock decides enforce inline), one with a `delivered` event, one a reviewer
// released or rejected, and one a retry or another turn already replaced. Accepted, each is taken out of
// review as a retry's parent is and gets a `superseded` event (source
// `supersedes`), and the view lists them in ascending id order. A replayed
// `turn_id` returns the stored decision and applies nothing again. A held
// turn opens no hand-off here, so there is nothing for a supersession to
// settle; the API settles the stopped turn's item.
//
// Outcomes are an append-only trail of events, as on the API: `released`,
// `delivered`, `discarded` and `failed` from the caller, one per kind per
// decision except `failed`. The same event again is a 200; a different event
// of a kind already recorded is a 409. `released` and `delivered` need the
// SHA-256 of the text (400 without it, and on any other kind), `superseded`
// from a caller is a 400, and an unknown kind or the retired body is a 422.
// The view's `outcome` is `{ state, events }`, the state derived as
// delivered, else superseded, else discarded, else failed, else released.
//
//   node examples/mock-server/server.mjs
//
// Environment:
//   PORT                          default 8787
//   GOVERN_MOCK_MODE              off | observe | enforce (default enforce)
//   GOVERN_MOCK_PROHIBITED        the phrase the synthetic policy blocks (default "cure")
//   GOVERN_MOCK_CLINICAL_RULES    "true" adds two scripted rules: a draft that tells the
//                                 patient to start, stop, skip or change a medication or a
//                                 dose (medication_instruction), and a symptom read as a
//                                 diagnosis (clinical_claim). Default false.
//   GOVERN_MOCK_REQUIRE_DISCLOSURE  "false" to stop requiring the disclosure (default true)
//   GOVERN_MOCK_ENFORCE_HOLD      "true" keeps each enforce evaluation pending and unanswered,
//                                 as while the gate is still answering, until
//                                 POST /__mock/decisions/:id/decide answers it (default false:
//                                 decided inline)
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
const CLINICAL_RULES = process.env.GOVERN_MOCK_CLINICAL_RULES === "true";
const CONSOLE_ORIGIN = process.env.GOVERN_MOCK_CONSOLE_ORIGIN ?? "https://console.example";
const ENFORCE_HOLD = process.env.GOVERN_MOCK_ENFORCE_HOLD === "true";

/** Scripted stand-ins for two policy rules, active with GOVERN_MOCK_CLINICAL_RULES=true. */
const MEDICATION_INSTRUCTION =
  /\b(take|taking|skip|stop|start|double|increase|decrease|cut)\b[^.!?]{0,40}\b(dose|doses|pill|pills|medication|medicine|tablet|tablets|blood thinner|water pill)\b/i;
const DIAGNOSIS_CLAIM = /\b(sounds like|means you have|you (probably|likely) have)\b/i;

/** The scripted red-flag screen run on `inbound`. Rule ids and categories only reach the wire. */
const RED_FLAGS = [
  { rule_id: "mock.cardiac.chest_pain", category: "cardiac", pattern: /\bchest (pain|pressure|tightness)\b/i },
  {
    rule_id: "mock.respiratory.breathing",
    category: "respiratory",
    pattern: /\b(can'?t|cannot|can not) (breathe|catch my breath)\b/i,
  },
  {
    rule_id: "mock.neuro_stroke.face_or_speech",
    category: "neuro_stroke",
    pattern: /\b(face (is )?(drooping|numb)|slurred speech|speech is slurred|numb on one side)\b/i,
  },
  { rule_id: "mock.self_harm.statement", category: "self_harm", pattern: /\b(hurt|harm|kill) myself\b/i },
];

const APPLICATION_ID = "00000000-0000-4000-8000-00000000a991";
const POLICY = { id: "00000000-0000-4000-8000-0000000090c1", name: "synthetic", version: 1 };
const CHANNELS = new Set(["sms", "app_message", "web_chat", "voice", "email"]);
/** The patient is in the session waiting for the reply; every other channel is outbound. */
const IN_SESSION = new Set(["web_chat", "app_message", "voice"]);
const AUDIENCES = new Set(["patient", "clinician"]);
/** A retryable stop names the draft's own content, one of these at least... */
const CONTENT_REASONS = new Set(["clinical_claim", "missing_disclaimer"]);
/** ...and nothing beyond these. */
const RETRYABLE_REASONS = new Set([...CONTENT_REASONS, "flagged", "patient_flag_withheld", "held_for_review"]);
/** Deterministic floors: a stop on one of these is never sendable. */
const NEVER_SENDABLE_REASONS = new Set(["prohibited_claim", "medication_instruction"]);
/** Every outcome kind; a caller records all but `superseded`. */
const OUTCOME_KINDS = new Set(["released", "delivered", "discarded", "superseded", "failed"]);
/** The kinds that carry the hash of the text. */
const HASHED_KINDS = new Set(["released", "delivered"]);
/** The order the state is derived in: the first kind present wins. */
const STATE_ORDER = ["delivered", "superseded", "discarded", "failed", "released"];
const MAX_TURN_REF_CHARS = 128;
const MAX_SUPERSEDES = 8;
const MAX_REF_CHARS = 256;

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
/** @type {Map<string, any>} patient_ref hash -> the patient's open hand-off */
const handoffs = new Map();
/** @type {Map<string, () => void>} decision id -> what answers it, for an enforce evaluation GOVERN_MOCK_ENFORCE_HOLD keeps pending */
const undecided = new Map();

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

function conflict(message) {
  const error = new Error(message);
  error.status = 409;
  error.kind = "CONFLICT_ERROR";
  return error;
}

function unprocessable(message) {
  const error = new Error(message);
  error.status = 422;
  error.kind = "UNPROCESSABLE_ENTITY_ERROR";
  return error;
}

/**
 * A stopped turn: held or blocked in enforce, answered, and not yet released,
 * rejected, retried or superseded.
 */
function stopped(record) {
  return (
    record.mode === "enforce" &&
    (record.decision === "hold" || record.decision === "block") &&
    (record.status === "decided" || record.status === "unavailable") &&
    record.review_state !== "released" &&
    record.review_state !== "rejected" &&
    !record.retried_by &&
    !record.superseded_by
  );
}

/** A decision a reviewer released or rejected. */
function reviewed(record) {
  return record.review_state === "released" || record.review_state === "rejected";
}

function retryable(record) {
  return (
    stopped(record) &&
    record.status === "decided" &&
    record.audience === "patient" &&
    record.review_state === "pending" &&
    record.stop_class === "uncertain" &&
    !record.retry_of &&
    record.route_to_human !== true &&
    record.reasons.some((reason) => CONTENT_REASONS.has(reason)) &&
    record.reasons.every((reason) => RETRYABLE_REASONS.has(reason))
  );
}

/** A `delivered` event is on record: the reply was heard, and nothing replaces it. */
function delivered(record) {
  return record.outcome_events.some((event) => event.kind === "delivered");
}

/**
 * The decision a turn's `retry_of` names, when the API would accept it: a
 * retryable decision of the same conversation, recorded for the same
 * `patient_ref`. Throws the API's refusal otherwise, in its order: 400 for
 * another conversation, another patient reference, or a stop that was never
 * retryable (whatever a reviewer or another turn did with it since); then,
 * for one that was retryable when it was decided and has moved since, 409:
 * superseded by another turn's `supersedes`, already retried, delivered,
 * acted on by a reviewer. `undefined` when the turn names none.
 */
function acceptedRetry(body, conversationId, patientRefHash) {
  if (body.retry_of === undefined || body.retry_of === null) return undefined;
  const target = typeof body.retry_of === "string" ? decisions.get(body.retry_of.toLowerCase()) : undefined;
  if (!target || target.conversation_id !== conversationId) {
    throw badRequest("retry_of does not name a decision of this conversation");
  }
  if (target.patient_ref_hash !== patientRefHash) throw badRequest("retry_of must name a decision for the same patient_ref");
  // As it was decided: still waiting for review, not retried, not superseded.
  if (!retryable({ ...target, review_state: "pending", retried_by: undefined, superseded_by: null })) {
    throw badRequest("retry_of must name a retryable decision in this conversation");
  }
  // The caller's view is stale: the record moved after the stop was decided.
  if (target.superseded_by && target.superseded_source === "supersedes") {
    throw conflict("retry_of names a decision another turn has already superseded");
  }
  if (target.retried_by) throw conflict("retry_of names a decision that was already retried");
  if (delivered(target)) throw conflict("retry_of names a decision that was delivered");
  if (reviewed(target)) throw conflict("retry_of names a decision a reviewer has already acted on");
  return target;
}

/** `turn_ref` as the API takes it: absent, or a non-blank string of at most 128 characters. */
function turnRefOf(body) {
  if (body.turn_ref === undefined || body.turn_ref === null) return null;
  if (typeof body.turn_ref !== "string" || body.turn_ref.trim() === "") throw badRequest("turn_ref must be a non-empty string");
  if ([...body.turn_ref].length > MAX_TURN_REF_CHARS) throw badRequest(`turn_ref must be at most ${MAX_TURN_REF_CHARS} characters`);
  return body.turn_ref;
}

/** The SHA-256 of a turn's patient reference, as the API keeps it; null without one. */
function patientRefHashOf(body) {
  return typeof body.patient_ref === "string" && body.patient_ref.trim() !== "" ? sha256(body.patient_ref.trim()) : null;
}

/**
 * The shape of a turn's `supersedes`: a list of at most 8 ids, each named
 * once, lowercased; empty when the turn names none. Checked on a replay of a
 * `turn_id` as every other field is (400).
 */
function supersedesShape(body) {
  if (body.supersedes === undefined || body.supersedes === null) return [];
  if (!Array.isArray(body.supersedes)) throw badRequest("supersedes must be a list of decision ids");
  if (body.supersedes.length > MAX_SUPERSEDES) throw badRequest(`supersedes may name at most ${MAX_SUPERSEDES} decisions`);
  const ids = body.supersedes.map((id) => (typeof id === "string" ? id.toLowerCase() : id));
  if (new Set(ids).size !== ids.length) throw badRequest("supersedes names a decision twice");
  return ids;
}

/**
 * The decisions a turn's `supersedes` names, when the API would accept them,
 * checked whole before anything is recorded. The refusals go row by row, in
 * the API's order, so when more than one applies the first is the answer:
 * the list's shape and the conversation (400), the patient reference (400),
 * then a decision still being decided, delivered, reviewed or already
 * replaced (409).
 */
function acceptedSupersedes(ids, conversationId, retryOf, patientRefHash) {
  if (ids.length === 0) return [];
  if (typeof retryOf === "string" && ids.includes(retryOf.toLowerCase())) {
    throw badRequest("supersedes names the retry_of decision, which the retry already supersedes");
  }
  const named = ids.map((id) => (typeof id === "string" ? decisions.get(id) : undefined));
  if (named.some((target) => !target || target.conversation_id !== conversationId)) {
    throw badRequest("supersedes names a decision that is not of this conversation");
  }
  if (named.some((target) => target.patient_ref_hash !== patientRefHash)) {
    throw badRequest("supersedes must name decisions for the same patient_ref");
  }
  if (named.some((target) => target.mode === "enforce" && target.status === "pending")) {
    throw conflict("supersedes names a decision still being decided");
  }
  if (named.some(delivered)) throw conflict("supersedes names a decision that was delivered");
  if (named.some(reviewed)) throw conflict("supersedes names a decision a reviewer has already acted on");
  if (named.some((target) => target.superseded_by || target.retried_by)) {
    throw conflict("supersedes names a decision another turn already superseded");
  }
  return named;
}

/**
 * Take a replaced decision out of review, as accepting a retry does, and
 * write its `superseded` event.
 */
function supersede(target, by, source) {
  target.superseded_by = by;
  target.superseded_source = source;
  target.review_state = null;
  const at = now();
  target.outcome_events.push({
    kind: "superseded",
    source,
    at,
    recorded_at: at,
    content_hash: null,
    delivery_ref: null,
    reason: null,
    hash_matches_release: null,
    superseded_by: by,
  });
  console.log(`superseded decision=${target.id} by=${by} source=${source}`);
}

/** The outcome trail as the view shows it, or null before the first event. */
function outcomeOf(record) {
  const events = record.outcome_events;
  if (events.length === 0) return null;
  const state = STATE_ORDER.find((kind) => events.some((event) => event.kind === kind));
  return { state, events: events.map((event) => ({ ...event })) };
}

function view(record) {
  // Owed while the hold is unreviewed, and kept by a turn a retry or a later
  // turn replaced; the mock has no patient state that could stop it.
  const owed = record.send_holding_line === true && (record.review_state === "pending" || Boolean(record.superseded_by));
  const shows = stopped(record) && (record.audience === "clinician" || IN_SESSION.has(record.channel) || owed);
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
    stop_class: record.stop_class ?? null,
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
    outcome: outcomeOf(record),
    send_holding_line: owed,
    show_hold_text: shows,
    retryable: retryable(record),
    retry_of: record.retry_of ?? null,
    turn_ref: record.turn_ref,
    supersedes: record.supersedes,
    superseded_by: record.superseded_by ?? null,
    route_to_human: record.route_to_human === true,
    would_have_routed: record.would_have_routed === true,
    inbound_flags: record.inbound_flags ?? [],
    handoff: record.handoff ?? null,
    // The mock sends no webhooks.
    webhook_deliveries: [],
  };
}

/** The scripted red-flag screen. Returns the matched rules, ids and categories only. */
function screenInbound(content) {
  return RED_FLAGS.filter((flag) => flag.pattern.test(content)).map(({ rule_id, category }) => ({ rule_id, category }));
}

/** One open hand-off per patient: a match opens it, a later match joins it. */
function openOrJoinHandoff(patientRef) {
  const key = sha256(patientRef);
  const existing = handoffs.get(key);
  if (existing) return existing;
  const created = {
    id: randomUUID(),
    state: "queued",
    version: 1,
    queue_label: "care-team",
    assigned_to: null,
    due_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    resolved_at: null,
    automation_resumed_at: null,
    pauses_automation: true,
  };
  handoffs.set(key, created);
  console.log(`handoff opened handoff=${created.id}`);
  return created;
}

function inboundOf(body) {
  if (body.inbound === undefined || body.inbound === null) return null;
  const inbound = body.inbound;
  if (typeof inbound !== "object" || typeof inbound.content !== "string" || inbound.content.trim() === "") {
    throw badRequest("inbound.content is required");
  }
  if (typeof inbound.received_at !== "string" || Number.isNaN(Date.parse(inbound.received_at))) {
    throw badRequest("inbound.received_at must be RFC 3339");
  }
  if (typeof body.patient_ref !== "string" || body.patient_ref.trim() === "") {
    throw badRequest("inbound requires patient_ref");
  }
  return inbound.content;
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
  if (CLINICAL_RULES && MEDICATION_INSTRUCTION.test(text)) {
    raw = "block_and_review";
    reasons.push("medication_instruction");
  }
  if (CLINICAL_RULES && DIAGNOSIS_CLAIM.test(text)) {
    raw = "block_and_review";
    reasons.push("clinical_claim");
  }
  let disclosureRequired = false;
  // Note what is NOT read here: the request's `disclosure.ref`. The answer is
  // the evidence this conversation holds, so a presented reference decides
  // nothing and is ignored, never refused, whatever it says.
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
  const inboundContent = inboundOf(body);
  const turnRef = turnRefOf(body);
  // The list's shape, like every field here, is checked on a replay too; what it names is not applied again.
  const supersedes = supersedesShape(body);

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
      show_hold_text: false,
      retryable: false,
      retry_of: null,
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

  // Refused before anything is recorded, as on the API.
  const patientRefHash = patientRefHashOf(body);
  const retried = acceptedRetry(body, conversationId, patientRefHash);
  const replaced = acceptedSupersedes(supersedes, conversationId, body.retry_of, patientRefHash);
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
    outcome_events: [],
    stop_class: null,
    retry_of: retried ? retried.id : null,
    // A retry without its own reference takes its parent's.
    turn_ref: turnRef ?? retried?.turn_ref ?? null,
    // Ascending, as the API lists them.
    supersedes: replaced.map((target) => target.id).sort(),
    superseded_by: null,
    patient_ref_hash: patientRefHash,
  };
  // Accepting a retry takes the stopped turn out of review in the same step,
  // and records it superseded: from here the retry's own decision answers.
  if (retried) {
    retried.retried_by = id;
    supersede(retried, id, "retry");
    console.log(`retry accepted decision=${id} retry_of=${retried.id}`);
  }
  for (const target of replaced) supersede(target, id, "supersedes");
  decisions.set(id, record);
  byTurn.set(turnId, id);
  originals.set(id, body.content.trim());

  const verdict = gate(body.content, body.audience, conversationId);
  const flags = inboundContent === null ? [] : screenInbound(inboundContent);
  const finalize = () => {
    record.status = "decided";
    record.decided_at = now();
    record.reasons = [...verdict.reasons];
    record.detected_claims = verdict.claims;
    record.disclosure_required = verdict.disclosureRequired;
    record.rationale =
      verdict.raw === "allow"
        ? null
        : verdict.reasons.some((reason) => reason !== "disclosure_missing")
          ? "The draft names a claim the synthetic policy stops."
          : "No AI-identity disclosure is on record for this conversation.";
    record.stop_class =
      verdict.raw === "allow" ? null : verdict.reasons.some((reason) => NEVER_SENDABLE_REASONS.has(reason)) ? "never_sendable" : "uncertain";
    record.inbound_flags = flags;
    if (MODE === "observe") {
      record.decision = "allow";
      record.would_have = verdict.raw;
      record.would_have_routed = flags.length > 0;
      // A turn that superseded this one inside the observe window has
      // already taken it out of review; it stays out.
      if (verdict.raw !== "allow" && !record.superseded_by) record.review_state = "pending";
    } else {
      if (flags.length > 0) {
        record.route_to_human = true;
        record.handoff = openOrJoinHandoff(body.patient_ref.trim());
      }
      if (verdict.raw === "allow") {
        record.decision = "allow";
      } else {
        record.decision = "hold";
        record.reasons.push("held_for_review");
        if (!record.superseded_by) record.review_state = "pending";
        record.send_holding_line = body.audience === "patient";
      }
    }
    const flagged = flags.length > 0 ? ` inbound_flags=${flags.map((flag) => flag.rule_id).join(",")}` : "";
    console.log(`evaluate decision=${id} mode=${MODE} decision=${record.decision} would_have=${record.would_have ?? "-"} reasons=${record.reasons.join(",") || "-"}${flagged}`);
  };

  if (MODE === "observe") {
    send(res, 202, view(record));
    setTimeout(finalize, 300);
  } else if (ENFORCE_HOLD) {
    // The gate is still answering: the decision is pending, and the turn
    // unanswered, until a test answers it with /__mock/decisions/:id/decide.
    undecided.set(id, () => {
      finalize();
      if (!res.destroyed) send(res, 200, view(record));
    });
  } else {
    finalize();
    send(res, 200, view(record));
  }
}

function handleGetDecision(res, id) {
  const record = decisions.get(id.toLowerCase());
  if (!record) return send(res, 404, errorBody("NOT_FOUND_ERROR", "Govern decision not found"));
  send(res, 200, view(record));
}

/** The characters the API trims from either end of a short text: Unicode White_Space. */
const WHITE_SPACE = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

function trimAsApi(value) {
  let start = 0;
  let end = value.length;
  while (start < end && WHITE_SPACE.has(value.charCodeAt(start))) start++;
  while (end > start && WHITE_SPACE.has(value.charCodeAt(end - 1))) end--;
  return value.slice(start, end);
}

/** A `delivery_ref` or `reason` as the API takes it: absent, or trimmed, non-blank, bounded, with no control characters. */
function shortText(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw unprocessable(`${label} must be a string`);
  const trimmed = trimAsApi(value);
  if (trimmed === "" || [...trimmed].length > MAX_REF_CHARS || /[\u0000-\u001f\u007f-\u009f]/.test(trimmed)) {
    throw badRequest(`${label} must be non-blank, at most ${MAX_REF_CHARS} characters, with no control characters`);
  }
  return trimmed;
}

/**
 * One outcome event. The decision is looked up first (404), then the body:
 * its shape (422), then its values (400). One event per kind, `failed`
 * excepted: the same event again answers 200 and records nothing, a
 * different one of a kind already recorded is a 409.
 */
async function handleOutcome(req, res, id) {
  const record = decisions.get(id.toLowerCase());
  if (!record) return send(res, 404, errorBody("NOT_FOUND_ERROR", "Govern decision not found"));
  const body = await readJson(req);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw unprocessable("the body is not an outcome event");
  if (typeof body.kind !== "string" || !OUTCOME_KINDS.has(body.kind)) {
    throw unprocessable("kind must be released, delivered, discarded or failed");
  }
  if (typeof body.at !== "string" || Number.isNaN(Date.parse(body.at))) throw unprocessable("at must be an RFC 3339 date-time");
  if (body.kind === "superseded") throw badRequest("superseded is recorded by the service and cannot be reported");
  let hash = null;
  if (body.content_hash !== undefined && body.content_hash !== null) {
    if (!HASHED_KINDS.has(body.kind)) throw badRequest(`content_hash is not accepted on ${body.kind}`);
    hash = trimAsApi(String(body.content_hash)).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) throw badRequest("content_hash must be the SHA-256 of the UTF-8 text, as 64 hex characters");
  }
  if (HASHED_KINDS.has(body.kind) && !hash) throw badRequest(`content_hash is required on ${body.kind}`);
  const event = {
    kind: body.kind,
    source: "caller",
    at: new Date(body.at).toISOString(),
    content_hash: hash,
    delivery_ref: shortText(body.delivery_ref, "delivery_ref"),
    reason: shortText(body.reason, "reason"),
  };
  const same = (recorded) =>
    recorded.at === event.at &&
    recorded.content_hash === event.content_hash &&
    recorded.delivery_ref === event.delivery_ref &&
    recorded.reason === event.reason;
  const ofKind = record.outcome_events.filter((recorded) => recorded.kind === event.kind);
  if (ofKind.some(same)) {
    console.log(`outcome replay decision=${record.id} kind=${event.kind}`);
    return send(res, 200, view(record));
  }
  if (event.kind !== "failed" && ofKind.length > 0) {
    return send(res, 409, errorBody("CONFLICT_ERROR", `a different ${event.kind} event is already recorded for this decision`));
  }
  // Compared with what the record says was deliverable: the released content
  // after a review, else the draft the gate allowed.
  const deliverable = record.review_state === "released" || record.decision === "allow" ? originals.get(record.id) : null;
  record.outcome_events.push({
    ...event,
    recorded_at: now(),
    hash_matches_release: hash && deliverable ? sha256(deliverable) === hash : null,
    superseded_by: null,
  });
  console.log(`outcome decision=${record.id} kind=${event.kind} state=${outcomeOf(record).state}`);
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

/**
 * Moves a decision's creation back in time, standing in for a decision an
 * earlier process made. Body: { "ms": <milliseconds> }.
 */
async function handleBackdate(req, res, id) {
  const record = decisions.get(id.toLowerCase());
  if (!record) return send(res, 404, errorBody("NOT_FOUND_ERROR", "Govern decision not found"));
  const body = await readJson(req);
  if (!body || typeof body !== "object" || !Number.isInteger(body.ms) || body.ms < 0) {
    throw badRequest("ms must be a non-negative integer");
  }
  const back = (iso) => (iso ? new Date(Date.parse(iso) - body.ms).toISOString() : iso);
  record.created_at = back(record.created_at);
  record.decided_at = back(record.decided_at);
  send(res, 200, view(record));
}

/** Answers an enforce evaluation GOVERN_MOCK_ENFORCE_HOLD kept pending: the gate decides now. */
function handleDecide(res, id) {
  const key = id.toLowerCase();
  const answer = undecided.get(key);
  if (!answer) return send(res, 409, errorBody("CONFLICT_ERROR", "the decision is not waiting for its gate"));
  undecided.delete(key);
  answer();
  send(res, 200, view(decisions.get(key)));
}

/** Reviewer stand-ins. */
function handleReview(res, id, action) {
  const record = decisions.get(id.toLowerCase());
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
    clinical_rules: CLINICAL_RULES,
    decisions: [...decisions.values()].map(view),
    disclosures: [...disclosures.values()],
    handoffs: [...handoffs.values()],
  });
}

function handleReset(res) {
  // An evaluation GOVERN_MOCK_ENFORCE_HOLD is keeping pending is answered first, so no request is left waiting.
  for (const answer of undecided.values()) answer();
  undecided.clear();
  decisions.clear();
  byTurn.clear();
  originals.clear();
  disclosures.clear();
  handoffs.clear();
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
      if (method === "POST" && (match = path.match(/^\/__mock\/decisions\/([^/]+)\/backdate$/))) {
        return await handleBackdate(req, res, match[1]);
      }
      if (method === "POST" && (match = path.match(/^\/__mock\/decisions\/([^/]+)\/decide$/))) {
        return handleDecide(res, match[1]);
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
  console.log(`govern mock listening on http://localhost:${PORT} mode=${MODE} prohibited="${PROHIBITED}" clinical_rules=${CLINICAL_RULES} require_disclosure=${REQUIRE_DISCLOSURE}`);
  console.log(`point the SDK at it with ANYBIO_GOVERN_BASE_URL=http://localhost:${PORT} and any key starting with gk_`);
});
