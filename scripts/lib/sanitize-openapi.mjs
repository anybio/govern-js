// The sanitizing step for spec/openapi.json. The document's descriptions are
// the API's own doc comments, and they ship to users twice: in
// spec/openapi.json and as JSDoc in the generated declaration files. This step
// keeps them to contract text: no tracker references, no implementation
// symbols, no internal design notes.
//
// Deterministic: the same input always produces the same output, so a
// regeneration that changes nothing produces no diff.

/**
 * Replacement text for descriptions that need more than a mechanical rule,
 * keyed by JSON pointer (without the leading slash). A pointer that no longer
 * exists in the document fails the extraction, so a renamed schema is noticed.
 */
export const OVERRIDES = {
  "components/schemas/ApplicationDto/properties/consent_required_channels/description":
    "Which channels require a `granted` consent on record, resolved: the per-channel default with this application's overrides applied. Derived and read-only: `channel_policies` names only the deviations, so this answers \"which channels require it\" without the caller knowing the defaults.",
  "components/schemas/CareHandoff/properties/episode_id/description": "Not used by Govern; null.",
  "components/schemas/CareHandoff/properties/pauses_automation/description":
    "Whether this item also pauses automated messaging to its subject. `automation_resumed_at == null` alone says only that a person owns the item (one per patient, whichever kind it is). Automation is paused while `automation_resumed_at == null && pauses_automation`. A red flag, an exhausted budget, a missing policy, an unknown wire outcome and the Govern route-to-human path all pause; an item that only owes a patient a reply does not.",
  "components/schemas/CareHandoff/properties/xuser_id/description":
    "Null for Govern hand-offs; `application_id` and `patient_ref_hash` name the subject.",
  "components/schemas/ChannelPolicy/description":
    "A per-channel binding: the policy scope, the mode, and the consent requirement for one channel. An absent field means the channel's default.",
  "components/schemas/ChannelPolicy/properties/requires_consent/description":
    "Whether an outbound turn on this channel requires a `granted` consent on record; absent means the channel's default (`sms`, `voice` and `email` require it).",
  "components/schemas/DecisionView/properties/send_holding_line/description":
    "Send your holding line to this patient now.\n\nThis turn was stopped and the patient is waiting on a reply that is not coming, so the application sends the fixed text its clinical owner wrote: a person will reply, when, and what to do if it is urgent. **The contract says when, never what**: the text is the application's own, it is never model-written, and this service does not send it on the application's behalf.\n\n`false` whenever another send would be the wrong thing rather than merely unnecessary: an opt-out, a missing or revoked consent, and a frequency cap each stop the turn because this patient should not be messaged, and a holding line is a message. It is also `false` in observe, where nothing was stopped and the caller was told to deliver.\n\nOne per stopped turn: each `evaluate` is one turn, so a second stopped draft in the same conversation is a second turn with its own answer.",
  "components/schemas/DecisionView/properties/stop_class/description":
    "Which of the two stopped classes this turn is: `never_sendable` | `uncertain`, null when nothing was stopped.\n\nIn **enforce** it describes the `hold` the caller received: a never-sendable turn has no release path, so the application's own reviewers are told to record a replacement rather than wait for one. In **observe** it is read beside `would_have` and describes what the stop would have been: `would_have` keeps its documented vocabulary (the raw gate decision), and this carries the class the same turn was classified with.",
  "components/schemas/GovernChannel/description": "The channel vocabulary of the contract.",
  "components/schemas/HandoffList/properties/awaiting_reply/description":
    "Which of these items carry a stopped draft nobody has answered yet. A patient has one open item, so a stop joins whatever they already have (a paused automation, a flagged inbound). The item keeps the reason it was opened for, and this lists what it now also owes.",
  "components/schemas/ModelBreakdown/description":
    "The same counts, per model and version the caller named. A bucket with both fields null counts the turns whose caller named no model. Send a stable model name so the report stays readable.",
  "components/schemas/RoutingPolicy/properties/coverage_note/description": "Operator-facing note; free text.",
  "components/schemas/TranscriptBatch/properties/turns/description":
    "One to 1,000 turns; `turn_id` unique within the batch.",
  "components/schemas/TranscriptTurn/properties/model/description":
    "The model that produced the turn, and its version, as the caller names them. Optional; recorded on the decision, never interpreted. Batches from before and after a model change are told apart by these.",
};

/** Mechanical rules applied to every string in the document, in order. */
export const RULES = [
  // Tracker references: " (anybio#123)", " (anybio#123, anybio#456)".
  [/\s*\(anybio#\d+(?:,\s*(?:anybio)?#\d+)*\)/g, ""],
  // Implementation-language option types, as a JSON caller reads them.
  [/`Some\(None\)`/g, "`null`"],
  [/`None`/g, "`null`"],
  // Doc-link syntax to a sibling field: [`Self::would_have`] -> `would_have`.
  [/\[`Self::(\w+)`\]/g, "`$1`"],
  // Em-dashes, per the house style for published text.
  [/\s+—\s+/g, "; "],
];

/** Text that must never be published in the document. */
export const UNPUBLISHABLE = [
  /anybio#/,
  /anybio-kb/,
  /anybio\/anybio/,
  /\bbe\/src\b/,
  /\bSome\(/,
  /\bNone\b/,
  /::/,
  /\[`/,
  /—/,
  /\bdevelop\b/,
  /\b(?:chore|feat|fix)\//,
  /\b[0-9a-f]{40}\b/,
];

function sanitizeString(value) {
  let out = value;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}

function mapStrings(node) {
  if (typeof node === "string") return sanitizeString(node);
  if (Array.isArray(node)) return node.map(mapStrings);
  if (node && typeof node === "object") {
    const out = {};
    for (const [key, value] of Object.entries(node)) out[key] = mapStrings(value);
    return out;
  }
  return node;
}

function setPointer(doc, pointer, value) {
  const parts = pointer.split("/");
  let node = doc;
  for (const part of parts.slice(0, -1)) {
    if (!node || typeof node !== "object" || !(part in node)) {
      throw new Error(`sanitize-openapi: override target does not exist: ${pointer}`);
    }
    node = node[part];
  }
  const last = parts[parts.length - 1];
  if (!node || typeof node !== "object" || typeof node[last] !== "string") {
    throw new Error(`sanitize-openapi: override target is not a string: ${pointer}`);
  }
  node[last] = value;
}

/** Apply the overrides, then the rules. Returns a new document. */
export function sanitizeDocument(doc) {
  const copy = JSON.parse(JSON.stringify(doc));
  for (const [pointer, text] of Object.entries(OVERRIDES)) setPointer(copy, pointer, text);
  return mapStrings(copy);
}

/** Every string in the document that still matches an unpublishable pattern, as "pointer: pattern". */
export function findUnpublishable(doc) {
  const problems = [];
  const walk = (node, pointer) => {
    if (typeof node === "string") {
      for (const pattern of UNPUBLISHABLE) {
        if (pattern.test(node)) problems.push(`${pointer}: ${pattern}`);
      }
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) walk(value, `${pointer}/${key}`);
    }
  };
  walk(doc, "");
  return problems;
}
