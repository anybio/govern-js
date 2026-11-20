// Generated from spec/openapi.json by scripts/generate-types.mjs. Do not edit.
/* eslint-disable */

export type paths = {
    "/api/v1/govern/applications": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["list_applications"];
        put?: never;
        /**
         * Create an application and mint its first key.
         * @description The application belongs to the request's project: the project selected in
         *     the console, or the key's own project. The body names no project; one that
         *     still sends `project_id` is refused with `code: project_field_removed`. A
         *     request with no project is refused with `code: project_required`, so every
         *     application has a project from the moment it exists.
         */
        post: operations["create_application"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/govern/applications/{application_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["get_application"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Patch an application. A change to the default mode or to any channel's
         *     mode is an audited event with the actor and the previous and new mode.
         */
        patch: operations["patch_application"];
        trace?: never;
    };
    "/api/v1/govern/applications/{application_id}/keys": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["list_application_keys"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/govern/applications/{application_id}/keys/rotate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Rotate the application's key: mint a new one and give the previous keys an
         *     overlap window, after which they are refused.
         */
        post: operations["rotate_application_key"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/govern/applications/{application_id}/observe-report": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The observe report: counts by decision, policy and channel over a window,
         *     would-have separated from enforced.
         */
        get: operations["observe_report"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/govern/applications/{application_id}/observe-report.csv": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The observe report as a CSV of the buckets its counts were summed from. */
        get: operations["observe_report_csv"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/govern/applications/{application_id}/observe-report.pdf": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The observe report as a PDF the account holder sends to a reviewer. */
        get: operations["observe_report_pdf"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/govern/applications/{application_id}/patients": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Purge every patient's state and ledger for an application (retention, or
         *     the end of the relationship). Decision records are untouched.
         */
        delete: operations["purge_application_patients"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/govern/applications/{application_id}/webhook-secret/rotate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Replace the application's webhook signing secret. The new secret is in
         *     this response only; deliveries attempted from now on are signed with it.
         */
        post: operations["rotate_webhook_secret"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/govern/decisions/{decision_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The decision with its review state; the first hold-resolution path. */
        get: operations["get_decision"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/govern/decisions/{decision_id}/outcome": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Record an outcome event for a decision: `released`, `delivered`,
         *     `discarded` or `failed`. One event per kind per decision, `failed`
         *     excepted: a replay that says the same thing is `200`, a different event of
         *     a kind already recorded is `409`.
         */
        post: operations["record_outcome"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/govern/disclosures": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Record the AI-identity disclosure shown at the start of a conversation.
         *     Once per conversation; a second call returns the same evidence with `200`.
         */
        post: operations["record_disclosure"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/govern/evaluate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Evaluate one turn of the application's AI output.
         * @description Enforce answers inline (`200`); observe accepts (`202`) and evaluates off
         *     the request path; a channel that is `off` answers `200` with
         *     `status = not_evaluated`. A replay of a `turn_id` returns the stored
         *     decision. `Idempotency-Key`, when sent, must equal `turn_id`.
         */
        post: operations["evaluate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/govern/handoffs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The application-scoped hand-offs of the organization and environment. */
        get: operations["list_handoffs"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/govern/handoffs/{handoff_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * One hand-off with its events and the decisions that opened or joined it.
         *     The inbound text is on this staff-and-application surface only.
         */
        get: operations["handoff_detail"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/govern/handoffs/{handoff_id}/claim": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Claim the hand-off. `expected_version` must be the current version. */
        post: operations["claim_handoff"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/govern/handoffs/{handoff_id}/contact-attempt": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Record a contact attempt on a claimed hand-off. */
        post: operations["contact_handoff"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/govern/handoffs/{handoff_id}/resolve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Resolve a claimed hand-off. */
        post: operations["resolve_handoff"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/govern/handoffs/{handoff_id}/resume": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Release the hold on a resolved hand-off. */
        post: operations["resume_handoff"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/govern/patients/consent": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Record consent granted or revoked for a patient of the key's application. */
        post: operations["record_patient_consent"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/govern/patients/opt-out": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Record a patient opting out, or back in. An opt-out the patient typed
         *     (STOP in their inbound message) cannot be undone here.
         */
        post: operations["record_patient_opt_out"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/govern/patients/state": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * The patient's state. A POST so the reference travels in the body, never
         *     in a path that a request log keeps.
         */
        post: operations["read_patient_state"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/govern/transcripts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Post a batch of past turns for observe-only evaluation. The batch is
         *     validated whole (nothing is stored if any turn is refused), held as a job,
         *     and processed off the request path; poll the job id. `Idempotency-Key`,
         *     when sent, replays the job it opened.
         */
        post: operations["submit_transcripts"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/govern/transcripts/{job_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** A transcript job's status and counts. */
        get: operations["transcript_job"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/govern/transcripts/{job_id}/turns": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The turns of a transcript job in batch order, each with the decision it
         *     produced or matched. Never the text.
         */
        get: operations["transcript_job_turns"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/govern/webhook-deliveries": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The webhook delivery log for the key's application: newest first, at most
         *     two hundred. Filter by `decision_id`, `handoff_id`, `status`.
         */
        get: operations["list_webhook_deliveries"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
};
export type webhooks = Record<string, never>;
export type components = {
    schemas: {
        ApplicationDto: {
            /**
             * @description Per-channel overrides, keyed by `sms` | `app_message` | `web_chat` |
             *     `voice` | `email`.
             */
            channel_policies: {
                [key: string]: components["schemas"]["ChannelPolicy"];
            };
            /** @description Which channels require a `granted` consent on record, resolved: the per-channel default with this application's overrides applied. Derived and read-only: `channel_policies` names only the deviations, so this answers "which channels require it" without the caller knowing the defaults. */
            consent_required_channels: string[];
            /** Format: date-time */
            created_at: string;
            default_mode: components["schemas"]["GovernMode"];
            /** Format: uuid */
            environment_id: string;
            frequency_cap?: components["schemas"]["FrequencyCap"] | null;
            /**
             * @description True when the stored cap cannot be read. The cap then holds every turn
             *     (fail-closed), so `frequency_cap: null` alone would read as "no cap"
             *     while the gate is holding everything.
             */
            frequency_cap_unreadable: boolean;
            handoff_routing?: components["schemas"]["RoutingPolicy"] | null;
            /** Format: uuid */
            id: string;
            name: string;
            /** Format: int32 */
            organization_id: number;
            /**
             * Format: int32
             * @description The project the application belongs to, set when it is created. Its
             *     active policy decides the application's turns, else the environment's
             *     default policy. `null` only for an older application in an environment
             *     that had no project to give it.
             */
            project_id?: number | null;
            /** @description The red-flag categories the inbound screen runs with. */
            red_flag_categories: string[];
            /** Format: date-time */
            updated_at: string;
            /** @description The last four characters of the webhook signing secret. */
            webhook_secret_hint?: string | null;
            /** Format: date-time */
            webhook_secret_rotated_at?: string | null;
            webhook_url?: string | null;
        };
        /** @description Key metadata. Never the hash, never the secret. */
        ApplicationKeyDto: {
            /** Format: uuid */
            application_id: string;
            /** Format: date-time */
            created_at: string;
            /**
             * Format: date-time
             * @description Set by rotation: when this key stops authenticating.
             */
            expires_at?: string | null;
            /** Format: uuid */
            id: string;
            /** @description The last four characters of the secret, for telling keys apart. */
            key_hint: string;
            /** Format: date-time */
            last_used_at?: string | null;
            /** Format: date-time */
            revoked_at?: string | null;
        };
        /**
         * @description One item of the applications list: the application, and its decision
         *     activity. Counts and a time only; no decision content.
         */
        ApplicationListItemDto: components["schemas"]["ApplicationDto"] & {
            /**
             * Format: int64
             * @description Decision records in the trailing seven days, every mode, status and
             *     decision value counted. A retried turn counts once. Equals the observe
             *     report's `totals.decisions` over the same seven days.
             */
            decisions_7d: number;
            /**
             * Format: date-time
             * @description When the application's most recent decision record was made (for a
             *     transcript turn, when the turn was sent). `null` when it has none.
             */
            last_decision_at?: string | null;
        };
        CareHandoff: {
            /**
             * Format: uuid
             * @description The Govern application whose patient this hand-off is about.
             */
            application_id?: string | null;
            /** Format: uuid */
            assigned_to?: string | null;
            /**
             * Format: date-time
             * @description The hold survives resolution until a person explicitly releases it.
             */
            automation_resumed_at?: string | null;
            /** Format: date-time */
            claimed_at?: string | null;
            /** Format: date-time */
            created_at: string;
            disposition?: string | null;
            /** Format: date-time */
            due_at?: string | null;
            /** Format: uuid */
            environment_id: string;
            /**
             * Format: uuid
             * @description Not used by Govern; null.
             */
            episode_id?: string | null;
            /** Format: date-time */
            escalated_at?: string | null;
            /** Format: date-time */
            escalation_due_at?: string | null;
            /** Format: uuid */
            id: string;
            /**
             * @description What the item is for. `general` is the messaging and follow-up item
             *     every automated source joins; staff-opened and discharge items carry
             *     their own kind. A patient has at most one active item of each kind.
             */
            kind: string;
            /** Format: int32 */
            organization_id: number;
            /** @description SHA-256 of the customer's opaque patient reference; never the reference. */
            patient_ref_hash?: string | null;
            /** @description Whether this item also pauses automated messaging to its subject. `automation_resumed_at == null` alone says only that a person owns the item (one per patient, whichever kind it is). Automation is paused while `automation_resumed_at == null && pauses_automation`. A red flag, an exhausted budget, a missing policy, an unknown wire outcome and the Govern route-to-human path all pause; an item that only owes a patient a reply does not. */
            pauses_automation: boolean;
            /**
             * Format: int32
             * @description The project of the episode the hand-off was opened from. Null for a
             *     hand-off opened without an episode, and for one about an application's
             *     patient.
             */
            project_id?: number | null;
            queue_label: string;
            reason: string;
            resolution_note?: string | null;
            /** Format: date-time */
            resolved_at?: string | null;
            /** Format: uuid */
            resolved_by?: string | null;
            routing_snapshot?: components["schemas"]["Value"] | null;
            state: string;
            /** Format: date-time */
            updated_at: string;
            /** Format: int32 */
            version: number;
            /**
             * Format: uuid
             * @description Null for Govern hand-offs; `application_id` and `patient_ref_hash` name the subject.
             */
            xuser_id?: string | null;
        };
        CareHandoffEvent: {
            /** Format: uuid */
            actor_user_id?: string | null;
            /** Format: date-time */
            created_at: string;
            /** Format: uuid */
            environment_id: string;
            event_type: string;
            evidence: components["schemas"]["Value"];
            /** Format: uuid */
            handoff_id: string;
            /** Format: uuid */
            id: string;
            note?: string | null;
            /** Format: int32 */
            organization_id: number;
            /**
             * Format: int32
             * @description The project of the event's hand-off.
             */
            project_id?: number | null;
            source_key: string;
        };
        ChannelBreakdown: components["schemas"]["Counts"] & {
            channel: string;
        };
        /** @description A per-channel binding: the policy scope, the mode, and the consent requirement for one channel. An absent field means the channel's default. */
        ChannelPolicy: {
            mode?: components["schemas"]["GovernMode"] | null;
            /**
             * Format: int32
             * @description The project whose active policy decides this channel; `null` means the
             *     application's own project. A policy belongs to one environment, so this
             *     must be a live project of the organization in the application's
             *     environment; any other is a `404`. Set from the console only: a request
             *     made with a key may send back the value already stored, and may not
             *     change it.
             */
            project_id?: number | null;
            /** @description Whether an outbound turn on this channel requires a `granted` consent on record; absent means the channel's default (`sms`, `voice` and `email` require it). */
            requires_consent?: boolean | null;
        };
        /**
         * @description One term the gate matched in the evaluated text.
         *
         *     The evaluated text is the submitted content with leading and trailing
         *     characters of the Unicode `White_Space` property removed (not the set
         *     JavaScript's `trim` removes). Wherever a response carries that text, index
         *     it rather than re-trimming. One entry per occurrence: a phrase that appears
         *     twice is two matches with two ranges.
         */
        ClaimMatch: {
            /** @description The vocabulary the entry belongs to. */
            list: components["schemas"]["MatchList"];
            /**
             * @description The policy entry that matched, as stored (lower-case). The matched
             *     text itself is at `range`, and may differ in case, inflection,
             *     hyphenation or apostrophe.
             */
            phrase: string;
            range?: components["schemas"]["MatchRange"] | null;
            /** @description The policy author's reason for the entry; null when it has none. */
            reason?: string | null;
            /** @description How the match was found. */
            source: components["schemas"]["MatchSource"];
        };
        /**
         * @description `POST /api/v1/govern/patients/consent`. The reference travels in the body,
         *     never in a path, so it is never in a request log.
         */
        ConsentRequest: {
            /**
             * Format: date-time
             * @description When the patient granted or revoked; default now.
             */
            at?: string | null;
            channel?: components["schemas"]["GovernChannel"] | null;
            patient_ref: string;
            state: components["schemas"]["ConsentState"];
        };
        /** @enum {string} */
        ConsentState: "granted" | "revoked";
        ContactRequest: {
            /** Format: int32 */
            expected_version: number;
            /** Format: date-time */
            next_due_at?: string | null;
            note: string;
            outcome: string;
        };
        /**
         * @description Counts keyed by the raw gate decision (`allow`, `flag`,
         *     `block_and_review`, `policy_missing`, `unavailable`; `rewrite` for turns
         *     recorded before `flag` replaced it) for observe turns, and
         *     by the binding answer (`allow`, `hold`, `block`) for enforce turns. An
         *     observe `flag` (or `rewrite`) for a clinician audience is counted as
         *     `flagged` instead: the clinician would have received the draft with its
         *     matches.
         */
        Counts: {
            enforced: {
                [key: string]: number;
            };
            would_have: {
                [key: string]: number;
            };
        };
        /**
         * @description A new application. It belongs to the request's project, which the body
         *     does not name: the project selected in the console, or the key's own
         *     project. That project's active policy, else the environment's default
         *     policy, decides the application's turns.
         */
        CreateApplicationRequest: {
            channel_policies?: {
                [key: string]: components["schemas"]["ChannelPolicy"];
            } | null;
            default_mode?: components["schemas"]["GovernMode"] | null;
            frequency_cap?: components["schemas"]["FrequencyCap"] | null;
            handoff_routing?: components["schemas"]["RoutingPolicy"] | null;
            name: string;
            /**
             * @description The red-flag categories the inbound screen runs with (`cardiac`,
             *     `respiratory`, `neuro_stroke`, `self_harm`). Default: all four.
             */
            red_flag_categories?: string[] | null;
            webhook_url?: string | null;
        };
        CreateApplicationResponse: {
            application: components["schemas"]["ApplicationDto"];
            key: components["schemas"]["MintedKeyDto"];
            /** @description The webhook signing secret, shown here once. */
            webhook_secret: components["schemas"]["MintedWebhookSecret"];
        };
        /** @enum {string} */
        DecisionStatus: "pending" | "decided" | "unavailable" | "not_evaluated";
        /**
         * @description The decision as the contract presents it, from `evaluate` and from the
         *     poll. `released_content` and `deliverable_content` are the only fields that
         *     can carry message text, and each does so under a stated condition.
         */
        DecisionView: {
            audience: components["schemas"]["GovernAudience"];
            channel: components["schemas"]["GovernChannel"];
            conversation_id: string;
            /** Format: date-time */
            created_at?: string | null;
            /** Format: date-time */
            decided_at?: string | null;
            decision: components["schemas"]["GovernDecision"];
            /**
             * Format: uuid
             * @description Absent only when the channel is `off`.
             */
            decision_id?: string | null;
            /**
             * @description Clinician audience only, on a `flagged` decision: the draft as
             *     evaluated, which is what to deliver. The service never rewrites a
             *     draft, so this is your own content, trimmed. Never present for a
             *     patient audience.
             */
            deliverable_content?: string | null;
            detected_claims: string[];
            disclosure_required: boolean;
            /**
             * @description The draft was delivered with flags: `allow` for a clinician audience
             *     under a policy whose outcome is `flag`. Deliver the draft unchanged and
             *     show the reader `matches`. `false` for a clean `allow` and for every
             *     `hold` and `block`.
             */
            flagged: boolean;
            handoff?: components["schemas"]["HandoffRef"] | null;
            /** @description The red-flag rules the inbound matched; rule ids and categories only. */
            inbound_flags: components["schemas"]["InboundFlag"][];
            /**
             * @description Each term behind a violation, positioned in the evaluated text. One
             *     entry per occurrence, in reading order. Each carries the policy entry
             *     (`phrase`), the list it belongs to, the policy author's `reason` (null
             *     when the entry has none), how it was found (`source`; always `term`
             *     today) and `range`, the span in UTF-16 code units with `end` exclusive.
             *
             *     The evaluated text is the `content` you sent with leading and trailing
             *     characters of the Unicode `White_Space` property removed. That is not
             *     what JavaScript's `String.prototype.trim` removes (it also removes
             *     U+FEFF and keeps U+0085), so do not re-trim to find it: when
             *     `deliverable_content` is present it is exactly the evaluated text, and
             *     `deliverable_content.slice(range.start, range.end)` is the matched
             *     text. Render a message-level flag for a match with no `range`. Empty on
             *     decisions recorded before matches were.
             */
            matches: components["schemas"]["ClaimMatch"][];
            mode: components["schemas"]["GovernMode"];
            /** @description The model the caller named for this turn, and its version. Null when the caller named none; never inferred. */
            model?: string | null;
            model_version?: string | null;
            outcome?: components["schemas"]["OutcomeView"] | null;
            policy?: components["schemas"]["PolicyRef"] | null;
            rationale?: string | null;
            reasons: string[];
            /** @description Present once a reviewer released the held content: what to deliver. */
            released_content?: string | null;
            /**
             * Format: uuid
             * @description The decision this turn retries, when it is a retry. Null otherwise.
             */
            retry_of?: string | null;
            /**
             * @description Your application may write ONE new draft for this turn and evaluate
             *     it with `retry_of` set to this `decision_id`.
             *
             *     `true` only when this turn was stopped in enforce mode, for a patient,
             *     because of the draft's own content (the `reasons` name a clinical
             *     claim the program may not make, or a missing disclaimer), the stop
             *     class is `uncertain`, the policy does not review every send, and the
             *     hold is still pending. It is `false` for a `never_sendable` stop, for
             *     every stop about the patient rather than the draft (an opt-out, a
             *     consent, a frequency cap, a missing disclosure), for a missing policy,
             *     for a turn that is itself a retry at the platform's limit, for a turn
             *     whose inbound routed the patient to a person, and once a reviewer has
             *     acted. Add the `reasons` and the policy's rules to your
             *     model's instructions; this service never writes the new draft.
             */
            retryable: boolean;
            review_state?: components["schemas"]["ReviewState"] | null;
            /**
             * @description Console deep link for the customer's own reviewers, present when the
             *     decision is in (or has been through) the review queue.
             */
            review_url?: string | null;
            /** Format: date-time */
            reviewed_at?: string | null;
            /**
             * @description A person must contact this patient. Independent of
             *     `decision`: a clean draft can be `allow` with `route_to_human: true`,
             *     and a violating one `hold` with it.
             */
            route_to_human: boolean;
            /**
             * @description Send your holding line to this patient now.
             *
             *     This turn was stopped and the patient is waiting on a reply that is not coming, so the application sends the fixed text its clinical owner wrote: a person will reply, when, and what to do if it is urgent. **The contract says when, never what**: the text is the application's own, it is never model-written, and this service does not send it on the application's behalf.
             *
             *     `false` whenever another send would be the wrong thing rather than merely unnecessary: an opt-out, a missing or revoked consent, and a frequency cap each stop the turn because this patient should not be messaged, and a holding line is a message. It is also `false` in observe, where nothing was stopped and the caller was told to deliver.
             *
             *     One per stopped turn: each `evaluate` is one turn, so a second stopped draft in the same conversation is a second turn with its own answer.
             */
            send_holding_line: boolean;
            /**
             * @description Show your hold text in place of the stopped draft.
             *
             *     `true` when this turn was stopped (`hold` or `block` in enforce, not
             *     released or rejected) and: the audience is `patient` and the channel is
             *     in-session (`web_chat`, `app_message`, `voice`), where the patient is
             *     waiting for the reply, whatever stopped the turn; or the audience is
             *     `patient`, the channel is outbound (`sms`, `email`) and
             *     `send_holding_line` is `true`; or the audience is `clinician`.
             *
             *     `false` on an outbound channel when no holding line is owed (send
             *     nothing), on every `allow`, once a reviewer has released or rejected
             *     the hold, once a retry of this turn or a turn that supersedes it has
             *     been accepted (that turn's own field answers), and always in observe.
             *     On a `retryable` turn, evaluate the retry first and show the hold text
             *     only if the retry is stopped too. On an in-session channel the hold
             *     text is the one reply: do not send a separate holding line there.
             */
            show_hold_text: boolean;
            status: components["schemas"]["DecisionStatus"];
            /**
             * @description Which of the two stopped classes this turn is: `never_sendable` | `uncertain`, null when nothing was stopped.
             *
             *     In **enforce** it describes the `hold` the caller received: a never-sendable turn has no release path, so the application's own reviewers are told to record a replacement rather than wait for one. In **observe** it is read beside `would_have` and describes what the stop would have been: `would_have` keeps its documented vocabulary (the raw gate decision), and this carries the class the same turn was classified with.
             */
            stop_class?: string | null;
            /**
             * Format: uuid
             * @description The decision that replaced this one: the turn that named it in
             *     `supersedes`, or its retry. Null while nothing has replaced it. Read
             *     from the `superseded` event in `outcome`.
             */
            superseded_by?: string | null;
            /**
             * @description The decisions this turn named in `supersedes` and replaced, in
             *     ascending id order. Empty when it named none. The decision a retry
             *     replaced is `retry_of`, not listed here.
             */
            supersedes: string[];
            turn_id: string;
            /**
             * @description Your reference for the patient turn, as sent on `evaluate` (or, on a
             *     retry sent without one, the reference of the decision it retries).
             *     Null when none was sent.
             */
            turn_ref?: string | null;
            /**
             * @description The signed webhook deliveries about this decision: the
             *     log, never the body.
             */
            webhook_deliveries: components["schemas"]["WebhookDeliveryView"][];
            /**
             * @description Observe: the raw gate decision (`allow` | `flag` | `block_and_review`
             *     | `policy_missing`) or `unavailable`. Null in enforce. Decisions
             *     recorded before `flag` replaced `rewrite` keep `rewrite`.
             */
            would_have?: string | null;
            /** @description Observe: the screen matched and would have routed; no task was opened. */
            would_have_routed: boolean;
        };
        DisclosureAttachment: {
            /** @description The caller's own assertion; informational. The gate reads the ref. */
            established?: boolean | null;
            /**
             * @description The reference returned when THIS conversation's disclosure was
             *     recorded. Any other value is ignored, and the turn is answered on
             *     this conversation's own evidence, so a reference borrowed from
             *     another conversation or application leaves the disclosure owed.
             */
            ref?: string | null;
        };
        DisclosureView: {
            /** Format: uuid */
            application_id: string;
            channel: components["schemas"]["GovernChannel"];
            conversation_id: string;
            /**
             * Format: uuid
             * @description The evidence row; the id a reviewer sees in the console.
             */
            evidence_id: string;
            /** Format: date-time */
            recorded_at: string;
            /**
             * @description Attach this as `disclosure.ref` on every evaluate for the conversation.
             *     `evaluate` also derives it from `conversation_id` when absent.
             */
            ref: string;
        };
        /**
         * @description One turn to evaluate. A field this schema does not name is ignored, not
         *     refused, so a misspelled `retry_of`, `turn_ref` or `supersedes` is a turn
         *     that retries, groups and supersedes nothing.
         */
        EvaluateRequest: {
            /**
             * Format: uuid
             * @description Optional; when present it must be the application the key is bound to.
             */
            application_id?: string | null;
            audience: components["schemas"]["GovernAudience"];
            channel: components["schemas"]["GovernChannel"];
            /** @description The draft the customer's AI produced. */
            content: string;
            conversation_id: string;
            disclosure?: components["schemas"]["DisclosureAttachment"] | null;
            inbound?: components["schemas"]["InboundMessage"] | null;
            /** @description Free JSON, stored and never evaluated. */
            metadata?: unknown;
            mode_hint?: components["schemas"]["GovernMode"] | null;
            /**
             * @description The model the caller's application ran for this turn, as the caller
             *     names it. Recorded, never interpreted: the platform does
             *     not run this model and has nothing to check the name against.
             */
            model?: string | null;
            /**
             * @description That model's version, as the caller names it. Independent of `model`:
             *     a caller that versions one and not the other is recorded as it is
             *     rather than refused.
             */
            model_version?: string | null;
            /** @description The customer's opaque patient identifier. Stored only as a SHA-256. */
            patient_ref?: string | null;
            /**
             * Format: uuid
             * @description The decision this turn retries: a new draft written because that
             *     decision came back `retryable`. It must name a decision of this
             *     application and this conversation whose view says `retryable: true`,
             *     and that has not been retried already; anything else is refused with
             *     `400`, except `409` for a second retry of the same decision and for a
             *     turn that was retryable until a reviewer released or rejected it, or
             *     until another turn named it in `supersedes`. Two requests for one retry
             *     under one `turn_id` record it once: the second is answered as a replay.
             *     The new draft is judged exactly as any other turn. Send it with a NEW
             *     `turn_id`. When the retry is `allow`, the hand-off the stopped turn
             *     opened is resolved with the disposition `resolved_by_retry`, provided
             *     that turn opened it, nothing else has joined it and nobody has claimed
             *     it or acted on it.
             */
            retry_of?: string | null;
            /**
             * @description The decisions this turn replaces, at most 8: earlier attempts at the
             *     same patient turn that were never heard (a speculative reply the voice
             *     platform discarded). Each must be a decision of this application and
             *     this conversation, named once, and not the decision in `retry_of`
             *     (`400` otherwise). An enforce decision still being decided, a decision
             *     with a `delivered` event, one a reviewer released or rejected, or one
             *     another turn already superseded is a `409`. In the same step as this
             *     turn is recorded, each named decision leaves the review queue if it was
             *     held, and its outcome records a `superseded` event naming this
             *     decision. When this turn is `allow`, the hand-off a named stopped turn
             *     opened is resolved with the disposition `resolved_by_supersession`
             *     (`resolved_by_retry` when the turn in `retry_of` shares it), on the
             *     conditions a retry's is; otherwise it stays open with a note naming
             *     this decision. A replay of this `turn_id` returns the stored decision
             *     and applies nothing again.
             */
            supersedes?: string[] | null;
            /**
             * @description The idempotency key per application: a replay returns the stored
             *     decision. Must not start with `govern:`, which is reserved for the
             *     rows the platform writes.
             */
            turn_id: string;
            /**
             * @description Your stable reference for the patient turn this draft answers: the
             *     same value on every speculative re-send and retry of that turn, so the
             *     attempts can be grouped. At most 128 printable characters. A retry
             *     sent without one takes the reference of the decision it retries.
             *     Stored as sent; never evaluated.
             */
            turn_ref?: string | null;
        };
        /**
         * @description One Govern decision that opened or joined an external hand-off: the
         *     evidence a person works from. `inbound_content` is the patient's own
         *     message, PHI-visible on this staff-authorised surface only.
         */
        ExternalDecisionEvidence: {
            conversation_id: string;
            /** Format: date-time */
            created_at: string;
            /** Format: uuid */
            decision_id: string;
            inbound_content?: string | null;
            inbound_flags: unknown;
            /** Format: date-time */
            inbound_received_at?: string | null;
            turn_id: string;
        };
        ExternalHandoffDetail: {
            decisions: components["schemas"]["ExternalDecisionEvidence"][];
            /** Format: uuid */
            environment_id: string;
            events: components["schemas"]["CareHandoffEvent"][];
            handoff: components["schemas"]["CareHandoff"];
            subject: components["schemas"]["ExternalSubject"];
        };
        /** @description The subject of an external hand-off, for its readers. */
        ExternalSubject: {
            /** Format: uuid */
            application_id: string;
            /** @description SHA-256 of the customer's opaque patient reference. */
            patient_ref_hash: string;
        };
        /**
         * @description The application's per-patient cap: at most `max_messages` per fixed window
         *     of `window_seconds`, counted from the first message of the window.
         */
        FrequencyCap: {
            /** Format: int32 */
            max_messages: number;
            /** Format: int64 */
            window_seconds: number;
        };
        FrequencyView: {
            /** Format: int32 */
            max_messages: number;
            /**
             * Format: int32
             * @description Messages left in the current window (the full cap once it has lapsed).
             */
            remaining: number;
            /** Format: int32 */
            window_count: number;
            /** Format: int64 */
            window_seconds: number;
            /** Format: date-time */
            window_started_at?: string | null;
        };
        /** @enum {string} */
        GovernAudience: "patient" | "clinician";
        /**
         * @description The channel vocabulary of the contract.
         * @enum {string}
         */
        GovernChannel: "sms" | "app_message" | "web_chat" | "voice" | "email";
        /**
         * @description The contract's three answers.
         * @enum {string}
         */
        GovernDecision: "allow" | "hold" | "block";
        /**
         * @description Per policy, per application: is the gate consulted, and is its answer
         *     binding? `Off` is not evaluated; `Observe` is evaluated and recorded as
         *     `would_have` while the caller is always told allow; `Enforce` returns the
         *     decision and it binds.
         * @enum {string}
         */
        GovernMode: "off" | "observe" | "enforce";
        HandoffList: {
            /** @description Which of these items carry a stopped draft nobody has answered yet. A patient has one open item, so a stop joins whatever they already have (a paused automation, a flagged inbound). The item keeps the reason it was opened for, and this lists what it now also owes. */
            awaiting_reply: string[];
            /** Format: uuid */
            environment_id: string;
            items: components["schemas"]["CareHandoff"][];
            patient_names: {
                [key: string]: string;
            };
            /** Format: int64 */
            total: number;
        };
        /** @description The hand-off a decision opened or joined, as the contract shows it. */
        HandoffRef: {
            /** Format: uuid */
            assigned_to?: string | null;
            /** Format: date-time */
            automation_resumed_at?: string | null;
            /** Format: date-time */
            due_at?: string | null;
            /** Format: date-time */
            escalation_due_at?: string | null;
            /** Format: uuid */
            id: string;
            /**
             * @description Whether this hand-off also pauses automated messaging to the subject.
             *     `automation_resumed_at == null` says a person owns it;
             *     this says whether the application should stop sending meanwhile. The
             *     two are read together: still paused is
             *     `automation_resumed_at == null && pauses_automation`.
             */
            pauses_automation: boolean;
            queue_label: string;
            /** Format: date-time */
            resolved_at?: string | null;
            /** @description `queued` | `claimed` | `resolved`. */
            state: string;
            /** Format: int32 */
            version: number;
        };
        /**
         * @description One red-flag rule the inbound matched. Rule id and category only; never
         *     the text.
         */
        InboundFlag: {
            category: string;
            rule_id: string;
        };
        /** @description The patient's message this turn answers. */
        InboundMessage: {
            content: string;
            /** Format: date-time */
            received_at: string;
        };
        /**
         * @description Which vocabulary a match came from.
         * @enum {string}
         */
        MatchList: "prohibited_claims" | "requires_disclaimer_for" | "wellness_clinical_terms" | "medication_instructions";
        /**
         * @description Where a match sits in the evaluated text, in UTF-16 code units (the unit
         *     of JavaScript string indices). `start` is inclusive and `end` exclusive, so
         *     `text.slice(start, end)` is the matched span.
         */
        MatchRange: {
            end: number;
            start: number;
        };
        /**
         * @description How a match was found.
         * @enum {string}
         */
        MatchSource: "term" | "semantic";
        /** @description A key at mint time: the metadata plus the secret, which is shown once. */
        MintedKeyDto: components["schemas"]["ApplicationKeyDto"] & {
            /** @description The raw key. This is its only appearance; store it server-side. */
            secret: string;
        };
        /** @description A freshly minted signing secret: the plaintext, shown once, and when. */
        MintedWebhookSecret: {
            /** Format: date-time */
            rotated_at: string;
            /** @description The secret. This is its only appearance; store it server-side. */
            webhook_secret: string;
            /** @description Its last four characters, for telling secrets apart. */
            webhook_secret_hint: string;
        };
        /** @description The same counts, per model and version the caller named. A bucket with both fields null counts the turns whose caller named no model. Send a stable model name so the report stays readable. */
        ModelBreakdown: components["schemas"]["Counts"] & {
            model?: string | null;
            model_version?: string | null;
        };
        ObserveReport: components["schemas"]["Counts"] & {
            /** Format: uuid */
            application_id: string;
            by_channel: components["schemas"]["ChannelBreakdown"][];
            by_model: components["schemas"]["ModelBreakdown"][];
            by_policy: components["schemas"]["PolicyBreakdown"][];
            by_stop_class: components["schemas"]["StopClassBreakdown"][];
            /** Format: date-time */
            from: string;
            rates: components["schemas"]["Rates"];
            /** Format: date-time */
            to: string;
            totals: components["schemas"]["Totals"];
        };
        /**
         * @description `POST /api/v1/govern/patients/opt-out`. `opted_out: false` records the
         *     patient opting back in, which the application may do only for an opt-out
         *     it recorded itself.
         */
        OptOutRequest: {
            /** Format: date-time */
            at?: string | null;
            channel?: components["schemas"]["GovernChannel"] | null;
            opted_out: boolean;
            patient_ref: string;
        };
        /** @description One event in a decision's outcome trail. */
        OutcomeEvent: {
            /**
             * Format: date-time
             * @description When it happened, as the writer said.
             */
            at: string;
            /** @description SHA-256 hex of the text; on `released` and `delivered` only. */
            content_hash?: string | null;
            delivery_ref?: string | null;
            /**
             * @description Whether `content_hash` matches the content the record says was
             *     deliverable. `null` with no hash, or when there was nothing to compare
             *     against. Computed when the event is recorded; a later release does not
             *     change it.
             */
            hash_matches_release?: boolean | null;
            kind: components["schemas"]["OutcomeKind"];
            reason?: string | null;
            /**
             * Format: date-time
             * @description When the service recorded it.
             */
            recorded_at: string;
            source: components["schemas"]["OutcomeSource"];
            /**
             * Format: uuid
             * @description The decision that replaced this one; on `superseded` only.
             */
            superseded_by?: string | null;
        };
        /**
         * @description What happened to a decision's reply: the kind of an event, and, for the
         *     trail as a whole, its derived `state`.
         * @enum {string}
         */
        OutcomeKind: "released" | "delivered" | "discarded" | "superseded" | "failed";
        OutcomeRequest: {
            /**
             * Format: date-time
             * @description When it happened.
             */
            at: string;
            /**
             * @description SHA-256, hex, of the UTF-8 text released or delivered. Required for
             *     `released` and `delivered`; refused on any other kind.
             */
            content_hash?: string | null;
            /** @description Your own reference for the delivery (a message id, a row id). */
            delivery_ref?: string | null;
            /**
             * @description `released`, `delivered`, `discarded` or `failed`. `superseded` is
             *     reserved for the service and refused here.
             */
            kind: components["schemas"]["OutcomeKind"];
            /**
             * @description A short reason code, for example why a reply was discarded or why an
             *     attempt failed. Never message text.
             */
            reason?: string | null;
        };
        /**
         * @description Who wrote an event.
         * @enum {string}
         */
        OutcomeSource: "caller" | "retry" | "supersedes" | "channel";
        /**
         * @description A decision's outcome: the state its events add up to, and the events in
         *     the order they were recorded.
         */
        OutcomeView: {
            events: components["schemas"]["OutcomeEvent"][];
            /**
             * @description The kind that decides where the outcome stands, derived from the
             *     events and never stored: `delivered` if a delivered event exists, else
             *     `superseded`, else `discarded`, else `failed`, else `released`.
             */
            state: components["schemas"]["OutcomeKind"];
        };
        /**
         * @description Every field optional; only the ones present change. `channel_policies`
         *     replaces the whole map when present (send the full map back).
         */
        PatchApplicationRequest: {
            channel_policies?: {
                [key: string]: components["schemas"]["ChannelPolicy"];
            } | null;
            default_mode?: components["schemas"]["GovernMode"] | null;
            frequency_cap?: components["schemas"]["FrequencyCap"] | null;
            handoff_routing?: components["schemas"]["RoutingPolicy"] | null;
            name?: string | null;
            /** @description Replaces the whole list when present; must not be empty. */
            red_flag_categories?: string[] | null;
            webhook_url?: string | null;
        };
        PatientEventView: {
            channel?: string | null;
            /** Format: uuid */
            decision_id?: string | null;
            /** Format: uuid */
            id: string;
            kind: string;
            /** Format: date-time */
            occurred_at: string;
            /** Format: date-time */
            recorded_at: string;
            source: string;
        };
        /**
         * @description `POST /api/v1/govern/patients/state`: a read, as a POST so the reference
         *     stays out of the URL.
         */
        PatientStateRequest: {
            patient_ref: string;
        };
        /** @description The state as the contract shows it. The reference itself is never in it. */
        PatientStateView: {
            /** Format: uuid */
            application_id: string;
            /** Format: date-time */
            consent_changed_at?: string | null;
            /** @description `unknown` | `granted` | `revoked`. */
            consent_state: string;
            /** @description The most recent transitions, newest first (at most twenty). */
            events: components["schemas"]["PatientEventView"][];
            frequency?: components["schemas"]["FrequencyView"] | null;
            /** Format: date-time */
            last_contact_at?: string | null;
            opted_out: boolean;
            /** Format: date-time */
            opted_out_changed_at?: string | null;
            opted_out_source?: string | null;
            patient_ref_hash: string;
        };
        PolicyBreakdown: components["schemas"]["Counts"] & {
            /** Format: uuid */
            policy_id?: string | null;
            policy_name?: string | null;
            /** Format: int32 */
            policy_version?: number | null;
        };
        PolicyRef: {
            /** Format: uuid */
            id: string;
            name: string;
            /** Format: int32 */
            version: number;
        };
        PurgeResponse: {
            /** Format: uuid */
            application_id: string;
            /** Format: int64 */
            patient_events_removed: number;
            /** Format: int64 */
            patient_states_removed: number;
        };
        /**
         * @description Fractions in `[0, 1]`, never percentages. Each is `null` when its
         *     denominator is zero.
         */
        Rates: {
            /**
             * Format: double
             * @description The share of answered enforce turns whose answer was not `allow`, over
             *     `totals.answered_enforce`. Turns the gate did not answer are on
             *     neither side of it.
             */
            enforced_held?: number | null;
            /**
             * Format: double
             * @description The share of every record in the window that the gate did not answer:
             *     `totals.unavailable` over `totals.decisions`.
             */
            unanswered?: number | null;
            /**
             * Format: double
             * @description The share of answered observe turns that would have been delivered
             *     with flags: a `flag` for a clinician audience, over
             *     `totals.answered_observe`.
             */
            would_have_flagged?: number | null;
            /**
             * Format: double
             * @description The share of answered observe turns whose would-have answer was not
             *     `allow`, over `totals.answered_observe`. Turns the gate did not answer
             *     are on neither side of it. A `flag` for a clinician audience is not
             *     withheld (the clinician receives the draft with its matches) and is
             *     counted in `would_have_flagged` instead; a `flag` for a patient is
             *     withheld.
             */
            would_have_withheld?: number | null;
        };
        RecordDisclosureRequest: {
            /**
             * Format: uuid
             * @description Optional; when present it must be the application the key is bound to.
             */
            application_id?: string | null;
            /**
             * Format: date-time
             * @description When it was shown.
             */
            at: string;
            channel: components["schemas"]["GovernChannel"];
            conversation_id: string;
            /** @description The disclosure text the patient was shown, verbatim. */
            text_shown: string;
        };
        ResolveRequest: {
            disposition: string;
            /** Format: int32 */
            expected_version: number;
            note: string;
            resume_automation: boolean;
        };
        ResumeRequest: {
            /** Format: int32 */
            expected_version: number;
            note: string;
        };
        /** @enum {string} */
        ReviewState: "pending" | "released" | "rejected";
        RotateKeyBody: {
            /**
             * Format: int64
             * @description How long the previous keys keep authenticating after this rotation.
             *     Default one day; at most seven. Zero refuses the previous keys at once.
             */
            overlap_seconds?: number | null;
        };
        RotateKeyResponse: {
            key: components["schemas"]["MintedKeyDto"];
            /**
             * Format: date-time
             * @description When every previous key of the application stops authenticating.
             */
            previous_keys_expire_at: string;
        };
        RoutingPolicy: {
            backup_user_ids: string[];
            /** @description Operator-facing note; free text. */
            coverage_note: string;
            /**
             * Format: int64
             * @description Additional elapsed time after the response deadline before backup routing.
             */
            escalation_seconds: number;
            primary_user_ids: string[];
            queue_label: string;
            /** Format: int64 */
            response_seconds: number;
        };
        /**
         * @description The same counts, per stop class: `never_sendable` or `uncertain` for the
         *     turns that were stopped (in observe, that would have been stopped), and a
         *     bucket with a null class for the turns that were not, or not yet answered.
         */
        StopClassBreakdown: components["schemas"]["Counts"] & {
            stop_class?: string | null;
        };
        Totals: {
            /**
             * Format: int64
             * @description Enforce records the gate answered: neither pending nor unavailable.
             *     The denominator of `rates.enforced_held`.
             */
            answered_enforce: number;
            /**
             * Format: int64
             * @description Observe records the gate answered: neither pending nor unavailable.
             *     The denominator of `rates.would_have_withheld`.
             */
            answered_observe: number;
            /**
             * Format: int64
             * @description Every decision record in the window, any mode or status.
             */
            decisions: number;
            /** Format: int64 */
            enforce: number;
            /** Format: int64 */
            observe: number;
            /** Format: int64 */
            pending: number;
            /**
             * Format: int64
             * @description Records that came from a transcript batch rather than a
             *     live call; always observe, counted in `observe` as well.
             */
            transcript: number;
            /**
             * Format: int64
             * @description Records the gate did not answer, in either mode. The caller received
             *     its mode's fallback; these records are in neither rate.
             */
            unavailable: number;
            /**
             * Format: int64
             * @description Answered observe records that would have been delivered to a
             *     clinician with flags: the numerator of `rates.would_have_flagged`.
             */
            would_have_flagged: number;
            /**
             * Format: int64
             * @description Answered observe records whose would-have answer withheld the draft:
             *     the numerator of `rates.would_have_withheld`.
             */
            would_have_withheld: number;
        };
        TranscriptBatch: {
            /**
             * Format: uuid
             * @description Optional; when present it must be the application the key is bound to.
             */
            application_id?: string | null;
            /** @description One to 1,000 turns; `turn_id` unique within the batch. */
            turns: components["schemas"]["TranscriptTurn"][];
        };
        /** @enum {string} */
        TranscriptJobStatus: "queued" | "running" | "completed" | "failed";
        /** @description A job as the contract presents it. Counts, never text. */
        TranscriptJobView: {
            /**
             * Format: int64
             * @description Turns a failed job gave up on: never evaluated, no decision, their
             *     text cleared with the job. Only ever non-zero when `status` is
             *     `failed`.
             */
            abandoned: number;
            /** Format: uuid */
            application_id: string;
            /** Format: int64 */
            duplicate: number;
            /** @description A code when `status` is `failed`. */
            error?: string | null;
            /** Format: int64 */
            evaluated: number;
            /** Format: date-time */
            finished_at?: string | null;
            /** Format: uuid */
            job_id: string;
            /**
             * Format: int64
             * @description Turns processed so far: `evaluated + duplicate`.
             */
            processed: number;
            /** Format: date-time */
            started_at?: string | null;
            status: components["schemas"]["TranscriptJobStatus"];
            /** Format: date-time */
            submitted_at: string;
            /**
             * Format: int64
             * @description Turns in the batch.
             */
            total: number;
            /**
             * Format: int64
             * @description Evaluated turns the gate did not answer for.
             */
            unavailable: number;
            /**
             * @description Raw gate decisions over the evaluated turns that are decided:
             *     `allow`, `flag` (`rewrite` before it replaced it), `block_and_review`, `policy_missing`,
             *     `unavailable`.
             */
            would_have: {
                [key: string]: number;
            };
        };
        /** @description One past turn as the customer posts it. */
        TranscriptTurn: {
            audience: components["schemas"]["GovernAudience"];
            channel: components["schemas"]["GovernChannel"];
            /** @description The text that went out. */
            content: string;
            conversation_id: string;
            /** @description The model that produced the turn, and its version, as the caller names them. Optional; recorded on the decision, never interpreted. Batches from before and after a model change are told apart by these. */
            model?: string | null;
            model_version?: string | null;
            /**
             * Format: date-time
             * @description When it went out. The observe report windows on it.
             */
            sent_at: string;
            /**
             * @description The idempotency key per application: a turn the application already
             *     has a decision for is a `duplicate`. Must not start with `govern:`,
             *     which is reserved for the rows the platform writes.
             */
            turn_id: string;
        };
        /** @description One turn of a job, with the decision it produced or matched. */
        TranscriptTurnView: {
            audience: string;
            channel: string;
            conversation_id: string;
            /** Format: uuid */
            decision_id?: string | null;
            decision_status?: components["schemas"]["DecisionStatus"] | null;
            disposition?: components["schemas"]["TurnDisposition"] | null;
            /** Format: int32 */
            position: number;
            reasons: string[];
            /** Format: date-time */
            sent_at: string;
            turn_id: string;
            would_have?: string | null;
        };
        /** @enum {string} */
        TurnDisposition: "evaluated" | "duplicate" | "abandoned";
        Value: unknown;
        VersionRequest: {
            /** Format: int32 */
            expected_version: number;
        };
        /**
         * @description A delivery as the contract shows it on the decision. Counts and codes,
         *     never the body.
         */
        WebhookDeliveryView: {
            /** Format: int32 */
            attempts: number;
            /** Format: date-time */
            created_at: string;
            /** Format: uuid */
            decision_id?: string | null;
            /** Format: date-time */
            delivered_at?: string | null;
            event: string;
            /** Format: uuid */
            handoff_id?: string | null;
            /** Format: uuid */
            id: string;
            /** Format: date-time */
            last_attempt_at?: string | null;
            last_error?: string | null;
            /** Format: int32 */
            last_status_code?: number | null;
            /** Format: date-time */
            next_attempt_at?: string | null;
            /** @description `pending` | `delivered` | `exhausted` | `skipped`. */
            status: string;
            /**
             * Format: int32
             * @description The revision of the subject this delivery is about: the hand-off's
             *     `version` at the change, or `0` for an event keyed to the subject's
             *     whole lifetime. Two deliveries of one event differ here.
             */
            subject_version: number;
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
};
export type $defs = Record<string, never>;
export interface operations {
    list_applications: {
        parameters: {
            query?: never;
            header?: {
                /** @description List this project's applications only. It must be a live project of the organization in this environment. Omit it for every project's. */
                "X-Project-Id"?: number | null;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Applications in the caller's organization and environment, each with its decision activity; under a project, that project's only */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApplicationListItemDto"][];
                };
            };
            /** @description `X-Project-Id` is not one positive project id (`code: invalid_project_id`), or a `project_id` or `project_key` query parameter was sent (`code: project_field_removed`) */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Requires a signed-in member of the organization or an Admin developer key */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The request's project is not a live project of this organization in this environment (`code: project_not_in_scope`) */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    create_application: {
        parameters: {
            query?: never;
            header?: {
                /** @description The project the application belongs to, for a signed-in console session. It must be a live project of the organization in this environment. A request with no project is refused with `code: project_required`. */
                "X-Project-Id"?: number | null;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateApplicationRequest"];
            };
        };
        responses: {
            /** @description Application created in the request's project; the key secret appears only here */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CreateApplicationResponse"];
                };
            };
            /** @description Invalid name, channel or webhook URL; `code: project_field_removed`, the body names a project; or `code: project_required`, the request has no project */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Requires an organization admin session or an Admin developer key; or `code: channel_project_console_only`, a key named a `channel_policies` project */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The request's project, or a `channel_policies` project, is not a live project of this organization in this environment */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description An application with this name already exists in this environment */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    get_application: {
        parameters: {
            query?: never;
            header?: {
                /** @description The console's selected project. An application of another project answers as one that does not exist. */
                "X-Project-Id"?: number | null;
            };
            path: {
                /** @description Application id */
                application_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApplicationDto"];
                };
            };
            /** @description Requires a signed-in member of the organization or an Admin developer key */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No such application in this organization and environment, or an application of another project (for a credential, and for the console with `X-Project-Id`), which answers the same */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    patch_application: {
        parameters: {
            query?: never;
            header?: {
                /** @description The console's selected project. An application of another project answers as one that does not exist. */
                "X-Project-Id"?: number | null;
            };
            path: {
                /** @description Application id */
                application_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PatchApplicationRequest"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApplicationDto"];
                };
            };
            /** @description Invalid name, channel or webhook URL; or `code: project_field_removed`, the body names a project (an application does not move between projects) */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description `code: channel_project_console_only`: a key's write would change a `channel_policies` project */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No such application in this organization and environment, or an application of another project (for a credential, and for the console with `X-Project-Id`), which answers the same, or a `channel_policies` project is not a live project of this organization in this environment */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description An application with this name already exists in this environment */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    list_application_keys: {
        parameters: {
            query?: never;
            header?: {
                /** @description The console's selected project. An application of another project answers as one that does not exist. */
                "X-Project-Id"?: number | null;
            };
            path: {
                /** @description Application id */
                application_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Key metadata, newest first; never a secret */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApplicationKeyDto"][];
                };
            };
            /** @description No such application in this organization and environment, or an application of another project (for a credential, and for the console with `X-Project-Id`), which answers the same */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    rotate_application_key: {
        parameters: {
            query?: never;
            header?: {
                /** @description The console's selected project. An application of another project answers as one that does not exist. */
                "X-Project-Id"?: number | null;
            };
            path: {
                /** @description Application id */
                application_id: string;
            };
            cookie?: never;
        };
        /** @description Optional; defaults to a one-day overlap */
        requestBody: {
            content: {
                "application/json": components["schemas"]["RotateKeyBody"];
            };
        };
        responses: {
            /** @description New key minted; the secret appears only here */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RotateKeyResponse"];
                };
            };
            /** @description overlap_seconds out of range */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No such application in this organization and environment, or an application of another project (for a credential, and for the console with `X-Project-Id`), which answers the same */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    observe_report: {
        parameters: {
            query?: {
                /** @description Inclusive start, RFC 3339; default fourteen days before `to` */
                from?: string;
                /** @description Exclusive end, RFC 3339; default now */
                to?: string;
            };
            header?: {
                /** @description The console's selected project. An application of another project answers as one that does not exist. */
                "X-Project-Id"?: number | null;
            };
            path: {
                /** @description Application id */
                application_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ObserveReport"];
                };
            };
            /** @description Window empty, inverted or longer than the maximum */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Requires a signed-in member of the organization or an Admin developer key */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No such application in this organization and environment, or an application of another project (for a credential, and for the console with `X-Project-Id`), which answers the same */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    observe_report_csv: {
        parameters: {
            query?: {
                /** @description Inclusive start, RFC 3339; default fourteen days before `to` */
                from?: string;
                /** @description Exclusive end, RFC 3339; default now */
                to?: string;
            };
            header?: {
                /** @description The console's selected project. An application of another project answers as one that does not exist. */
                "X-Project-Id"?: number | null;
            };
            path: {
                /** @description Application id */
                application_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description One line per (policy, version, channel, mode, source, status, outcome) bucket, with `would_have` and `enforced` in columns of their own */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/csv": unknown;
                };
            };
            /** @description Window empty, inverted or longer than the maximum */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Requires a signed-in member of the organization or an Admin developer key */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No such application in this organization and environment, or an application of another project (for a credential, and for the console with `X-Project-Id`), which answers the same */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    observe_report_pdf: {
        parameters: {
            query?: {
                /** @description Inclusive start, RFC 3339; default fourteen days before `to` */
                from?: string;
                /** @description Exclusive end, RFC 3339; default now */
                to?: string;
            };
            header?: {
                /** @description The console's selected project. An application of another project answers as one that does not exist. */
                "X-Project-Id"?: number | null;
            };
            path: {
                /** @description Application id */
                application_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The report as a document carrying the organization, the application, the environment, the window, the generation time, and the policy name and version behind each count */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/pdf": unknown;
                };
            };
            /** @description Window empty, inverted or longer than the maximum */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Requires a signed-in member of the organization or an Admin developer key */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No such application in this organization and environment, or an application of another project (for a credential, and for the console with `X-Project-Id`), which answers the same */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    purge_application_patients: {
        parameters: {
            query?: never;
            header?: {
                /** @description The console's selected project. An application of another project answers as one that does not exist. */
                "X-Project-Id"?: number | null;
            };
            path: {
                /** @description Application id */
                application_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PurgeResponse"];
                };
            };
            /** @description No such application in this organization and environment, or an application of another project (for a credential, and for the console with `X-Project-Id`), which answers the same */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    rotate_webhook_secret: {
        parameters: {
            query?: never;
            header?: {
                /** @description The console's selected project. An application of another project answers as one that does not exist. */
                "X-Project-Id"?: number | null;
            };
            path: {
                /** @description Application id */
                application_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Rotated; the secret appears only here */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MintedWebhookSecret"];
                };
            };
            /** @description Requires an organization admin session or an Admin developer key */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No such application in this organization and environment, or an application of another project (for a credential, and for the console with `X-Project-Id`), which answers the same */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    get_decision: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Decision id */
                decision_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DecisionView"];
                };
            };
            /** @description Not an application key */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No such decision for this application */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    record_outcome: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Decision id */
                decision_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["OutcomeRequest"];
            };
        };
        responses: {
            /** @description The same event was already recorded */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DecisionView"];
                };
            };
            /** @description Event recorded */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DecisionView"];
                };
            };
            /** @description `superseded` sent by a caller; a hash missing on released or delivered, sent on another kind, or not 64 hex characters; a blank, oversized or control-character delivery_ref or reason */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not an application key */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No such decision for this application */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description A different event of this kind is already recorded */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description An unknown kind, or a body that is not the request shape */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    record_disclosure: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RecordDisclosureRequest"];
            };
        };
        responses: {
            /** @description The conversation's evidence already exists */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DisclosureView"];
                };
            };
            /** @description Evidence recorded; attach `ref` on every evaluate for the conversation */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DisclosureView"];
                };
            };
            /** @description Blank or oversized text, or an invalid conversation id */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not an application key, or a key not bound to the named application */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The evidence could not be recorded; retry */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    evaluate: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["EvaluateRequest"];
            };
        };
        responses: {
            /** @description Decided inline (enforce), replayed, or not evaluated (channel off) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DecisionView"];
                };
            };
            /** @description Accepted (observe); evaluated off the request path, poll the decision id */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DecisionView"];
                };
            };
            /** @description Invalid identifiers, content, metadata or `turn_ref`, an audience not allowed on the channel, a `retry_of` that names no retryable decision of this conversation or names one for another `patient_ref`, or a `supersedes` over 8 ids, naming a decision twice, naming the `retry_of` decision, or naming a decision of another application, conversation or `patient_ref` */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not an application key, or a key not bound to the named application */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description A `retry_of` that was already retried, or that names a turn that was retryable until a reviewer released or rejected it, another turn named it in `supersedes`, or a `delivered` event was reported on it; a `supersedes` naming an enforce decision still being decided, a decision that was delivered, one a reviewer released or rejected, or one another turn already superseded */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description A body that does not match the schema: an unknown channel or audience token, a missing or mistyped field. A field the schema does not name is ignored, not refused: check the spelling of `retry_of`, `turn_ref` and `supersedes` */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    list_handoffs: {
        parameters: {
            query?: {
                /** @description Staff may narrow to one application; a key is always its own */
                application_id?: string;
                assigned_to?: string;
                limit?: number;
                offset?: number;
                overdue?: boolean;
                /** @description created (default) | due */
                sort?: string;
                /** @description queued | claimed | resolved */
                status?: string;
            };
            header?: {
                /** @description List the hand-offs of this project's applications only; a staff `application_id` of another project lists nothing. Omit it for every project's. */
                "X-Project-Id"?: number | null;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HandoffList"];
                };
            };
            /** @description A `project_id` or `project_key` query parameter (`code: project_field_removed`), or a malformed `X-Project-Id` (`code: invalid_project_id`) */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not an application key or a staff session of the organization */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description `X-Project-Id` names no live project of this organization and environment (`code: project_not_in_scope`) */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    handoff_detail: {
        parameters: {
            query?: never;
            header?: {
                /** @description The console's selected project. A hand-off of another project's application answers as one that does not exist. */
                "X-Project-Id"?: number | null;
            };
            path: {
                /** @description Hand-off id */
                handoff_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExternalHandoffDetail"];
                };
            };
            /** @description Not an application key or a staff session of the organization */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No such external hand-off in this organization and environment, or, for staff, one of another project's application */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    claim_handoff: {
        parameters: {
            query?: never;
            header?: {
                /** @description The console's selected project. A hand-off of another project's application answers as one that does not exist. */
                "X-Project-Id"?: number | null;
            };
            path: {
                /** @description Hand-off id */
                handoff_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["VersionRequest"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CareHandoff"];
                };
            };
            /** @description Staff only, and only staff the routing names */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The hand-off changed; refresh before acting */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    contact_handoff: {
        parameters: {
            query?: never;
            header?: {
                /** @description The console's selected project. A hand-off of another project's application answers as one that does not exist. */
                "X-Project-Id"?: number | null;
            };
            path: {
                /** @description Hand-off id */
                handoff_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ContactRequest"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CareHandoff"];
                };
            };
            /** @description Missing outcome, note, or next due time */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    resolve_handoff: {
        parameters: {
            query?: never;
            header?: {
                /** @description The console's selected project. A hand-off of another project's application answers as one that does not exist. */
                "X-Project-Id"?: number | null;
            };
            path: {
                /** @description Hand-off id */
                handoff_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ResolveRequest"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CareHandoff"];
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    resume_handoff: {
        parameters: {
            query?: never;
            header?: {
                /** @description The console's selected project. A hand-off of another project's application answers as one that does not exist. */
                "X-Project-Id"?: number | null;
            };
            path: {
                /** @description Hand-off id */
                handoff_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ResumeRequest"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CareHandoff"];
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    record_patient_consent: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ConsentRequest"];
            };
        };
        responses: {
            /** @description The patient's current state */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PatientStateView"];
                };
            };
            /** @description Invalid patient reference */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not an application key */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    record_patient_opt_out: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["OptOutRequest"];
            };
        };
        responses: {
            /** @description The patient's current state */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PatientStateView"];
                };
            };
            /** @description Invalid patient reference */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not an application key */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The patient opted out in their own words; only a START from the patient opts them back in */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    read_patient_state: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PatientStateRequest"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PatientStateView"];
                };
            };
            /** @description Invalid patient reference */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not an application key */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    submit_transcripts: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TranscriptBatch"];
            };
        };
        responses: {
            /** @description Replayed: a job with this Idempotency-Key already exists */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TranscriptJobView"];
                };
            };
            /** @description Accepted; the job is being processed */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TranscriptJobView"];
                };
            };
            /** @description An empty or oversized batch, a repeated turn_id, an invalid turn, or a sent_at in the future */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not an application key, or a key not bound to the named application */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    transcript_job: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Transcript job id */
                job_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TranscriptJobView"];
                };
            };
            /** @description Not an application key */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No such job for this application */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    transcript_job_turns: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Transcript job id */
                job_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TranscriptTurnView"][];
                };
            };
            /** @description Not an application key */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No such job for this application */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    list_webhook_deliveries: {
        parameters: {
            query?: {
                /** @description Only deliveries about this decision */
                decision_id?: string;
                /** @description Only deliveries about this hand-off */
                handoff_id?: string;
                /** @description pending | delivered | exhausted | skipped */
                status?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WebhookDeliveryView"][];
                };
            };
            /** @description Not an application key */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
}
