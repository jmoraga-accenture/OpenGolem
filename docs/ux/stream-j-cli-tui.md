# Stream J — UX Review: CLI and TUI Interaction Model
*Status: Approved | Produced: 2026-04-06*
*UX/Interaction Designer: Claude Code | Scope: TUI interface + Telegram channel UX*

---

## Inputs Read

Before producing this review, the following documents were read in full:

- `docs/ARCHITECTURE.md` §1.3, §3.1, §3.6
- `docs/TEAM.md` — Voice of Customer role description
- `docs/specs/orchestrator-spec.md` §2.9 (health endpoint), §3.1 (startup), §3.3 (task dispatch including `[BLOCKED]` routing)
- `docs/specs/channel-adapters-spec.md` — TUI adapter section (including health dashboard, AC-13, AC-14), Telegram adapter section
- `docs/DECISIONS.md` — Decision 30 (TUI + Telegram as v1.0 defaults)
- `CLAUDE.md` — Quick Context, Key Files
- `README.md` — current user-facing setup documentation
- `src/channels/tui.ts` — current TUI implementation
- `src/channels/telegram.ts` — current Telegram implementation

---

## Scope and Method

This review covers three areas: the TUI interface, the Telegram channel interaction model, and security state legibility. For each area, findings are presented as: **current state** (what v0.1 implements or the spec implies), **recommended change**, and **VoC rationale** (why this matters across the grandparent-to-enterprise spectrum).

ASCII diagrams are used where they clarify structure. This document produces no code and modifies no existing file.

---

## 1. The TUI Interface

### 1.1 The `opengolem>` Prompt

**Current state**

The v0.1 TUI is a plain readline prompt: `opengolem> `. When a response arrives from the agent container, it is written to stdout with a leading newline, then the prompt is re-displayed. There is no status line, no active-channel indicator, no security mode indicator, and no block count. The prompt is visually identical whether the system is in Golem Guard mode (default), Supervised mode, or Power mode, and whether Cato has blocked zero or twenty requests this session.

The v1.0 spec (channel-adapters-spec.md §TUI Additional) specifies a split-pane health panel toggled by Ctrl-D, but does not specify what the non-panel prompt line should communicate. The orchestrator spec (§3.0) defines three security modes that materially affect what an operator can expect from the system, but the prompt surface is unspecified.

**Recommended change**

Introduce a minimal one-line status hint that appears immediately below the prompt on startup and on any status change. This is not a persistent status bar — it is a single advisory line that clears when the user begins typing and reappears when the next response completes.

The status hint communicates three signals in compact form:

```
[golem_guard | tui telegram] blocks: 0
opengolem>
```

Anatomy of the status hint:

```
[<security-mode>  |  <active channels>]  blocks: <session-block-count>
```

- `<security-mode>` uses the canonical mode names from §3.0: `golem_guard`, `supervised`, `power`. These are short, machine-readable identifiers that also communicate meaningfully to a non-expert: "golem guard" implies protection; "supervised" implies a human is in the loop; "power" implies fewer restrictions.
- `<active channels>` lists only registered, connected channels (e.g. `tui telegram`). If Telegram disconnects, it drops from this line in real time.
- `blocks: <n>` is the count of Cato blocks in the current session. It starts at 0 and increments. The number is not hyperlinked or interactive — the operator uses Ctrl-D to drill into block details.

The status hint is not re-drawn on every keypress. It is drawn: at startup, on any channel connection status change, on any block event, and after each agent response completes.

**VoC rationale**

For the grandparent-level operator: a single-line hint is not overwhelming. It answers "is it working?" (channels visible) and "is it safe?" (mode visible) at a glance. The word "blocks" requires no technical knowledge — it simply means "things that were stopped."

For the enterprise operator: the security mode name in the prompt line makes it unambiguous which posture is active. This matters for compliance documentation and incident review. If an operator ran a session in `power` mode by accident, the hint would have shown that throughout the session, providing a clear record of intent.

---

### 1.2 The Health Panel (Ctrl-D Toggle)

**Current state**

The v0.1 implementation has no health panel. The v1.0 spec (channel-adapters-spec.md AC-13, AC-14) specifies that Ctrl-D toggles a read-only health panel pane showing:

- Per-adapter connection status
- Token Broker status
- Cato status
- Active container count
- Recent audit events (last N from in-memory window)
- Most recent hansei report summary (if ingested)

The spec does not define information hierarchy within the panel — it does not say which of these items must be above the fold, how they should be grouped, or what level of detail is shown by default vs. on drill-down.

**Recommended information hierarchy for the health panel**

The panel should follow a three-tier structure: system status (above fold, always visible), operational context (below fold, scrollable), and governance surface (separate section, clearly labeled).

```
+--------------------------------------------------+
|  SYSTEM STATUS                                   |
|  Orchestrator  [ok]    uptime: 4h 22m            |
|  Token Broker  [ok]                              |
|  Cato          [ok]                              |
|                                                  |
|  CHANNELS                                        |
|  tui           [connected]                       |
|  telegram      [connected]  @botname             |
|                                                  |
|  TASKS                                           |
|  Active containers: 0                            |
|  Queue depth:       0                            |
|  Session blocks:    0                            |
+--------------------------------------------------+
  -- press D again to close; scroll for audit log --
```

Below the fold (requires scroll):

```
+--------------------------------------------------+
|  RECENT AUDIT EVENTS (last 10)                   |
|  04-06 14:33  task_complete    group/main  ok     |
|  04-06 14:32  container_spawn  group/main         |
|  04-06 14:32  task_start       group/main         |
|  04-06 14:31  message_received group/main         |
+--------------------------------------------------+

+--------------------------------------------------+
|  GOVERNANCE                                      |
|  Last hansei report:  2026-04-05 06:00           |
|  KPI summary:  security_failures: 0/call         |
|                data_leaks: 0/call                |
|                behavioral_change: 0.0%           |
|  (full report: data/hansei/inbox/)               |
+--------------------------------------------------+
```

Design rules for the panel:

1. Component status uses only three values: `[ok]`, `[degraded]`, `[unreachable]`. Not `"ok" | "unreachable"` as in the current spec schema — the word "degraded" is needed for the case where the component is reachable but returning errors. The orchestrator health response schema (`"ok" | "degraded" | "halted"`) should be the source of truth; the panel maps from that.

2. Channel entries show the connection label from the adapter health interface (`connected`, `connecting`, `disconnected`, `error`). The `@botname` annotation on Telegram confirms to the operator which bot is connected — this is operationally critical (operators can have multiple bots; knowing which one is active prevents support confusion).

3. The "TASKS" section is above the fold because it is the primary operational pulse. An operator glancing at the panel to answer "is anything happening right now?" should not need to scroll.

4. The hansei report summary is in a clearly labeled "GOVERNANCE" section at the bottom of the panel. It is not buried in audit events and it is not above the fold. The VoC rationale: a grandparent operator should be able to ignore this section entirely without missing anything urgent; an enterprise operator should be able to find it easily during a governance review.

5. The panel is read-only (per spec). No cursor, no interactive elements. The hint at the bottom of the first section ("press D again to close; scroll for audit log") tells the operator how to navigate without requiring them to have read a manual.

**VoC rationale**

For the grandparent-level operator: the three-section structure maps to three questions they might ask — "is it running?" (SYSTEM STATUS), "is it connected?" (CHANNELS + TASKS), "is anything worrying happening?" (GOVERNANCE). Each question has a clear visual zone.

For the enterprise operator: the panel provides enough information to answer a basic incident question in under 30 seconds without leaving the terminal. The governance section with hansei report access is the enterprise operator's primary audit surface at the TUI level; placing it in a named section (not buried in audit events) makes it findable.

---

### 1.3 The `/health` Endpoint Output

**Current state**

The v0.1 health endpoint (`GET http://127.0.0.1:3003/health`) returns a JSON object. The README documents it as "system state." The v1.0 spec (orchestrator-spec.md §2.9) defines the schema:

```json
{
  "status": "ok" | "degraded" | "halted",
  "components": {
    "tokenBroker": "ok" | "unreachable",
    "cato": "ok" | "unreachable",
    "escalationSocket": "ok" | "error"
  },
  "activeContainers": 0,
  "queueDepth": 0,
  "lastHanseiReport": "<ISO-8601-or-null>",
  "uptime": 0
}
```

The schema is clean and machine-readable. However, as a document for human inspection (`npm run status` in the CLI), it has two information gaps.

**Finding 1: No security mode in the health response**

The health endpoint does not expose the active security mode. An operator running `npm run status` cannot confirm which mode is active without checking the `.env` file or group configuration directly.

Recommended addition: `"securityMode": "golem_guard" | "supervised" | "power"` at the top level of the health response. This is not a security-sensitive field (the mode is visible in logs and configuration); it is an operational status indicator.

**Finding 2: Component status vocabulary mismatch**

The top-level `status` field has three values (`ok | degraded | halted`) but the components object has only two (`ok | unreachable`). This means a degraded component (reachable but returning errors) is indistinguishable from a healthy component at the component level, while the top-level `degraded` state has nowhere to attach to a specific component.

Recommended change: add `"degraded"` to the component status vocabulary, matching the top-level schema:

```json
"components": {
  "tokenBroker": "ok" | "degraded" | "unreachable",
  "cato": "ok" | "degraded" | "unreachable",
  "escalationSocket": "ok" | "degraded" | "error"
}
```

**Finding 3: `npm run status` output format**

The current implementation prints raw JSON to the terminal. For an operator who is not a developer, a raw JSON blob is not legible at a glance.

Recommended: the `npm run status` CLI command should format the output as a human-readable summary, with the raw JSON available via `--json` flag:

```
OpenGolem status
  Overall:         ok
  Uptime:          4h 22m
  Security mode:   golem_guard

  Token Broker:    ok
  Cato:            ok
  Escalation:      ok

  Active tasks:    0
  Queue depth:     0
  Last report:     2026-04-05 06:00
```

**VoC rationale**

For the grandparent-level operator: the formatted summary answers "is everything ok?" without requiring JSON literacy. The security mode line reassures them that the protection layer is active.

For the enterprise operator: the security mode in the health output enables automated monitoring (alerting if the mode changes to `power` unexpectedly) and provides a quick audit confirmation during incident review.

---

### 1.4 Error Messages

**Current state**

A survey of the v0.1 source and the v1.0 spec reveals three categories of error output with different audiences and different current quality:

**Category A: Internal log errors (logger.error, logger.warn)**
Examples from `src/channels/telegram.ts`:
- `'Telegram enabled (OPENGOLEM_CHANNELS) but TELEGRAM_BOT_TOKEN is not set'`
- `'Failed to send Telegram message'`
- `'Telegram: refuse outbound message (invalid chat id or group sends disabled — set TELEGRAM_ALLOW_GROUPS=1 for supergroups/groups)'`

Assessment: These are log-level messages for the operator's terminal or log file. They are clear and include the remediation step. These are acceptable as-is for a developer or technical operator. They are not user-facing.

**Category B: Console output (console.log) visible to the TUI operator**
Example from `src/channels/telegram.ts` (connect method, lines 529–532):
```
Telegram bot: @botname
Groups enabled — use TELEGRAM_VALID_USERS or sender-allowlist.json for each tg: group; send /chatid in any allowed chat for IDs
```

Assessment: The groups-enabled hint leaks implementation internals (`sender-allowlist.json`, `tg:` prefix, `TELEGRAM_VALID_USERS`). For a non-expert operator, "sender-allowlist.json" requires knowledge of what that file is, where it lives, and how to edit it. The `tg:` prefix is an internal identifier format that is not explained.

**Category C: User-facing messages delivered to the channel (via Alef)**
The `[BLOCKED]` and `[FLAG]` templates are defined behaviorally in the spec (architecture §3.5) and are composed by Alef in the detected user language. The spec states: "The explanation names the risk class and explains it — it does not reproduce payload content."

The current v0.1 implementation forwards Cato's `reason` field (e.g. `"Prompt contains filesystem escape sequence"`) as part of the explanation. This is a Category A message (internal log vocabulary) leaking into a Category C surface (user-facing channel output).

**Recommendations**

For Category B (console startup hints): replace implementation-internal references with outcome-oriented language.

Current:
```
Groups enabled — use TELEGRAM_VALID_USERS or sender-allowlist.json for each tg: group; send /chatid in any allowed chat for IDs
```

Recommended:
```
Telegram: group messages are enabled.
  To restrict who can message the assistant, run: npm run setup telegram
  To find a chat's ID, send /chatid in the chat.
```

For Category C (`[BLOCKED]` message templates): the user-facing explanation should map Cato's internal risk codes to a brief, plain-language description. The internal `reason` string (e.g. `"Prompt contains filesystem escape sequence"`) must not appear in the user-facing message.

Recommended mapping structure (Alef translates these to the user's language):

| CatoRiskCode (internal) | User-facing explanation |
|-------------------------|------------------------|
| `PATH_TRAVERSAL` | "This request tried to access files it isn't permitted to reach. The action was stopped." |
| `PROMPT_INJECTION` | "This request appeared to contain instructions designed to override the assistant's guidelines. The action was stopped." |
| `RATE_EXCEEDED` | "The assistant received too many requests in a short time. Please wait a moment and try again." |
| `SCOPE_VIOLATION` | "This request tried to use a capability that isn't enabled for your account. The action was stopped." |
| `MEMORY_WRITE_BLOCKED` | "The assistant's attempt to update its memory was reviewed and blocked. No change was made." |
| (unknown/fallback) | "This action was stopped by the safety layer. No further information is available." |

The fallback row is important: it prevents the system from exposing a risk code or internal identifier when Cato returns a code that has no mapping. This protects both the operator's security posture and the user experience.

**VoC rationale**

For the grandparent-level operator: "Prompt contains filesystem escape sequence" means nothing. "This request tried to access files it isn't permitted to reach" is understandable and actionable. The user can decide whether to rephrase their request or contact the system operator.

For the enterprise operator: the mapped explanation is sufficient for an audit trail — "scope violation" or "prompt injection attempt" is meaningful in a compliance context. The internal risk code is preserved in the audit log for technical review; it does not need to appear in the user-facing message.

---

## 2. The Telegram Channel Interaction Model

### 2.1 Two-Step Setup Legibility

**Current state**

The README documents Telegram setup in the Configuration reference table (one row: `TELEGRAM_BOT_TOKEN — Bot token from @BotFather`) and the Channel notes section (one paragraph). The CLAUDE.md documents the setup variables in a table but provides no narrative flow.

The current documentation structure requires the operator to:
1. Understand that `@BotFather` is a Telegram bot that issues tokens
2. Know to set `OPENGOLEM_CHANNELS=tui,telegram` (not just `TELEGRAM_BOT_TOKEN`)
3. Understand that both `.env` edits and the channels variable are required
4. Understand the difference between DM-only mode and group mode (and why)

None of these steps are wrong, but they are described in a reference table, not as a sequential flow. A non-expert operator reading the README would find the variables in the configuration table and the channel notes in a separate section, with no explicit statement of "do these steps in order."

**Recommended documentation structure for Telegram setup**

The `/setup` skill is the right vehicle for step-by-step setup (this is an operational skill, always on main). The README should describe what Telegram gives you in one sentence, then point to `/setup`. However, for operators who read the README before running setup, a minimal ordered flow should appear inline:

```
## Adding Telegram

1. Go to https://t.me/botfather in Telegram, create a bot, copy the token.
2. In .env, add: TELEGRAM_BOT_TOKEN=<your-token>
3. In .env, set: OPENGOLEM_CHANNELS=tui,telegram
4. Restart OpenGolem.

The assistant is now reachable via Telegram DMs. To find your chat ID,
send /chatid to your bot. Group messages require TELEGRAM_ALLOW_GROUPS=1
and explicit user allowlists — see the /setup skill for the group flow.
```

This is four steps. The current documentation implies the same steps but does not sequence them. The note about groups is a one-liner that defers complexity to the `/setup` skill rather than front-loading it.

**VoC rationale**

For the grandparent-level operator: "Go to @BotFather" is the kind of instruction that needs to be a URL or a human-readable step, not a config table entry. The four-step flow above can be completed without technical knowledge. Each step has one action.

For the enterprise operator: the explicit sequencing makes it auditable. An enterprise operator who is deploying for a team can hand the four-step flow to a non-technical administrator. The note about group allowlists tells them where to find the more complex security configuration rather than burying it in the same section.

---

### 2.2 The `[FLAG]` and `[BLOCKED]` Message Templates

**Current state**

The architecture spec (§3.5) defines:
- `[FLAG]` — Alef's own voice when asserting against a user instruction. This is Alef's character layer; it is not a Cato block.
- `[BLOCKED]` — Alef translating a Cato enforcement decision into a user-readable explanation. The explanation "names the risk class and explains it — it does not reproduce payload content."

The display tags are configurable per group (`flag_display_tag`, `blocked_display_tag`), with defaults `[FLAG]` and `[BLOCKED]`. The audit log always uses the canonical English forms regardless of display configuration.

**Finding: The tags communicate mechanism, not meaning**

`[FLAG]` and `[BLOCKED]` are brackets-plus-allcaps identifiers — a software developer's natural notation for a tagged event. To a user without OpenGolem context, they read as error codes.

A grandparent receiving `[BLOCKED] This request tried to access files it isn't permitted to reach.` may not understand why their message was "blocked" — was there a problem with their account? Did they do something wrong? Is the assistant broken?

A better default framing presents the tag as a label on a system-generated message, not as a code prefix on a response from the assistant.

**Recommended template structure**

For `[FLAG]` (Alef's pushback, character layer):
```
I want to flag something about this request.

[explains the concern in Alef's voice]

You can ask me to proceed anyway or modify your request.
```

The `[FLAG]` tag should appear in the audit log but not necessarily as a prefix in the user-facing message. The VoC lens: the user cares about the content of the flag, not the internal label. The tag should be in the audit trail; it need not be the first thing the user sees.

For `[BLOCKED]` (Cato enforcement, system layer):
```
This message was stopped by the safety layer.

Reason: [mapped explanation from risk code, in user's language]

If you think this is a mistake, contact your system administrator.
```

The `[BLOCKED]` tag similarly appears in the audit log. The user-facing message is composed by Alef (per architecture §3.5) and Alef knows to translate it into the user's language.

**Note on configurable display tags**

The current spec allows operators to suppress the tag entirely for "less visual noise." This is valid for an experienced operator who wants a cleaner chat experience. The recommendation above separates the audit log tag (always preserved) from the user-facing phrasing (configurable and user-oriented). This separation is already implied by the spec's design; this review recommends making it explicit in the behavioral spec.

**VoC rationale**

For the grandparent-level operator: "This message was stopped by the safety layer" is understandable. "Reason: This request tried to access files it isn't permitted to reach" is understandable. "Contact your system administrator" tells them what to do if they're confused. `[BLOCKED]` as a prefix tells them nothing.

For the enterprise operator: the format above provides a consistent, parseable structure for an audit trail. The reason mapping (see §1.4 above) gives the enterprise user enough information to understand the category of event without exposing internal risk codes.

---

### 2.3 Sender Allowlist: Operator Experience

**Current state**

The current v0.1 implementation enforces sender allowlists at the orchestrator level (not the adapter level, which is correct per spec). The README documents `TELEGRAM_VALID_USERS` as "optional comma-separated Telegram user IDs; unset = no env gate." The group-level allowlist via `sender-allowlist.json` is mentioned in CLAUDE.md but not in the README. A non-expert operator has two separate mechanisms to discover and configure.

The adapter spec (channel-adapters-spec.md, §Behavioral Contract) specifies that the adapter delivers all messages regardless of sender identity — allowlist enforcement is the orchestrator's responsibility. This is architecturally correct. But from the operator's perspective, the two-mechanism setup (env var + JSON file) and the absence of a clear failure mode description creates confusion.

**Finding 1: No legible failure mode for unlisted users**

When an unlisted user sends a message to the Telegram bot, the current behavior is: the message is delivered to the orchestrator, the orchestrator applies the allowlist check, and if the sender is not allowed, the message is silently dropped. The user receives no acknowledgment. The operator receives a log entry.

Silent dropping is the correct security behavior — you do not want to confirm to an unlisted sender that the bot exists and is filtering them. However, the operator experience is undefined: does the operator get notified? Where? How do they know an unlisted user tried to contact the bot?

**Recommended failure mode for unlisted users**

Two separate concerns:
- What does the unlisted user receive? Nothing (current, correct).
- What does the operator see?

Recommended: the TUI should display a brief advisory when an unlisted user contacts the bot, surfaced in the session output (not just the log file):

```
[Security] Telegram: message from unlisted sender 1234567890 dropped.
           To allow this user, add them to TELEGRAM_VALID_USERS or run:
           npm run setup telegram add-user
```

This advisory is TUI-only (not sent to any channel) and is not stored in the audit log (the dropped-message event is already logged as a structured entry; the TUI advisory is a human-readable surface of that event).

**Finding 2: Two-mechanism allowlist setup**

`TELEGRAM_VALID_USERS` (env var, comma-separated IDs) and `sender-allowlist.json` (file, per-group JID map) serve different scopes: env var is a global gate; the JSON file is per-group. This distinction is not explained in the README.

Recommended documentation clarification:

```
TELEGRAM_VALID_USERS applies globally — all listed user IDs can
message the bot from any chat. The per-group allowlist
(sender-allowlist.json) is more granular: it restricts which users
can interact with each specific group context. For most single-user
setups, TELEGRAM_VALID_USERS is sufficient.
```

**VoC rationale**

For the grandparent-level operator: "Why is no one else getting responses?" is the support question that arises when an allowlist is silently enforced with no operator feedback. The TUI advisory turns a mysterious silence into an explainable event.

For the enterprise operator: the advisory provides an immediate audit signal for unauthorized access attempts. The `npm run setup telegram add-user` command (to be implemented by the `/setup` skill) gives the operator a documented remediation path that does not require them to directly edit a JSON file.

---

## 3. Security State Legibility

### 3.1 Supervised Mode: Pending-Approval State in the TUI

**Current state**

The v1.0 spec (ARCHITECTURE.md §3.0) defines Supervised mode as: "failed check → soft block — outbound call or action is held until the user confirms or cancels on the channel." The orchestrator spec (§3.1) says the orchestrator "implements Supervised user-confirm/cancel flows for Inspector soft blocks (channel adapter round-trip)." No spec currently defines what the TUI operator sees during the pending-approval window.

This is a significant gap. In Supervised mode, the system pauses an agent action and waits for human confirmation. The TUI operator is the human. If there is no unambiguous UI signal that the system is waiting, the operator may:
- Think the system is hung or the agent is slow
- Send another message (creating a queued message behind the pending approval)
- Close the terminal (potentially orphaning the pending task)
- Not realize they are in Supervised mode at all

**Recommended pending-approval state design**

When the orchestrator enters the pending-approval window (a Call Inspector soft block in Supervised mode), the TUI should display a dedicated prompt that replaces the normal `opengolem>` prompt for the duration of the pending window:

```
[APPROVAL NEEDED]
The assistant is about to take an action that requires your confirmation.

  Action:  Make an API call to an external service
  Risk:    This call was flagged by the safety inspector (advisory)
  Group:   main

  Type YES to proceed, NO to cancel, or DETAILS for more information.

supervised> _
```

Design rules for the pending-approval prompt:

1. The `[APPROVAL NEEDED]` header must be visually distinct from normal output. In a terminal context, this means a full-width separator line above and below, not just a bracketed prefix.

2. The "Action" field uses a human-readable description of what the agent is trying to do, not the internal check type. The orchestrator's check payload includes `action: "AGENT_PROMPT"` etc. — these internal codes must be translated to plain English before display.

3. The "Risk" field contains the advisory explanation (same risk-code mapping as §1.4 above), not the raw Cato reason string.

4. The "Group" field tells the operator which context this applies to (important if they have multiple groups).

5. The prompt changes to `supervised>` to signal that the operator is in an interactive-approval flow, not the normal chat flow.

6. While the `supervised>` prompt is active, the normal `opengolem>` prompt is suspended. Any text entered that is not `YES`, `NO`, or `DETAILS` is acknowledged with: "Type YES to proceed or NO to cancel."

7. On `DETAILS`, the full advisory panel appears (same content as the Ctrl-D health panel TASKS section, plus the full inspection result). On `YES` or `NO`, the normal prompt resumes.

**VoC rationale**

For the grandparent-level operator: the word "supervised" in a configuration variable means nothing. A full-screen prompt that says "The assistant is about to take an action that requires your confirmation" is clear and actionable. The YES/NO interface requires no technical knowledge.

For the enterprise operator: the `[APPROVAL NEEDED]` event must appear in the audit log as a `supervisor_prompt` event with the outcome (approved/cancelled) and timestamp. The structured prompt design makes this auditable: what was asked, what was decided, and when.

---

### 3.2 Cato Block: Operator View in the TUI

**Current state**

When Cato issues `allow: false`, the orchestrator (per spec §3.3 step 3): calls `revokeToken`, writes `cato_block` to the audit log, and routes a `[BLOCKED]` explanation to the user via the channel adapter. In the TUI, this means the `[BLOCKED]` message appears in the normal chat flow — the same surface as agent responses.

There is no distinction between: (a) Alef responding with a `[FLAG]` message (Alef's own character layer) and (b) a Cato hard block routed to the user (a security enforcement event). From the operator's perspective at the TUI, they look identical: text in the chat stream.

**Finding: Security enforcement is visually indistinguishable from normal conversation**

A Cato block is not a conversational response. It is a security event. The operator should see it differently from a normal agent response.

**Recommended design: TUI block notification**

When a Cato block occurs, the TUI should produce two distinct outputs:

**In the chat stream (user-facing):** the `[BLOCKED]` message as formatted by Alef (per spec). This is what the user sending through Telegram or TUI sees. It is conversational.

**In the operator panel (TUI-only):** a brief system notification above the prompt line:

```
----[ SECURITY EVENT ]----
Cato block at 14:33:02 | group: main | code: PROMPT_INJECTION
No payload content recorded. Audit entry: #4821
--------------------------
opengolem>
```

Design rules for the operator notification:

1. It is clearly labeled as a system event, visually separated from the chat stream with a full-width delimiter.
2. It shows the block timestamp, the group, and the risk code (internal code is appropriate here — the operator is not the user; they can handle technical labels).
3. It explicitly states "No payload content recorded" — this reassures the operator that the blocked content has not been logged, which may be important for privacy/compliance reasons.
4. It provides the audit log entry ID so the operator can look up the structured event later.
5. It does not reproduce the payload. This is consistent with both the spec requirement and privacy hygiene.

**VoC rationale**

For the grandparent-level operator: the labeled box makes it clear that something was stopped by the system, not that the assistant gave an unusual response. The distinction between "the assistant said no" and "the security layer stopped something" is important to preserve.

For the enterprise operator: the audit entry ID in the notification provides an immediate reference for incident investigation. The `No payload content recorded` line is a compliance statement — it signals that the system behaved according to its privacy design, which is relevant in regulated environments.

---

## Summary of Recommendations

| # | Surface | Recommendation | Priority |
|---|---------|---------------|----------|
| R1 | TUI prompt | Add one-line status hint below prompt: mode, active channels, session block count | High |
| R2 | Health panel | Define three-tier hierarchy: System Status / Tasks above fold; Audit Events / Governance below fold | High |
| R3 | Health endpoint | Add `securityMode` field to response schema; align component status vocabulary to three values | Medium |
| R4 | `npm run status` | Default to human-readable summary; `--json` flag for raw JSON | Medium |
| R5 | Error messages | Map Cato risk codes to plain-language descriptions for user-facing `[BLOCKED]` messages; block internal `reason` strings from reaching the user channel | High |
| R6 | Console startup hints | Replace internal identifiers (`sender-allowlist.json`, `tg:` prefix) with outcome-oriented language and command references | Medium |
| R7 | Telegram setup docs | Add explicit four-step ordered setup flow to README; point to `/setup` skill for group complexity | High |
| R8 | `[FLAG]` / `[BLOCKED]` templates | Separate audit-log tag from user-facing phrasing; frame as labeled system messages rather than code-prefixed responses | High |
| R9 | Allowlist failure mode | Add TUI advisory when unlisted Telegram sender is dropped; provide `npm run setup telegram add-user` remediation path | Medium |
| R10 | Supervised mode TUI | Define dedicated `supervised>` approval prompt that replaces normal prompt during pending-approval window | High |
| R11 | Cato block TUI notification | Add operator-facing security event notification (labeled box above prompt) distinct from user-facing `[BLOCKED]` channel message | High |

---

## Open Questions for PM

The following items require Jim's review before any recommendation is acted upon:

1. **R1 (status hint):** Should the status hint include a queue depth indicator (e.g. `queue: 2`) or is the health panel (Ctrl-D) the right surface for that? The tradeoff is between always-visible pulse information and prompt clutter.

 **From Jim:** queue depth in status hint

2. **R8 (`[FLAG]` audit tag vs. display tag):** The spec already separates audit log tags from display configuration. This review recommends making that separation explicit in the behavioral spec. Does the Spec Writer need a new ADR for this, or is it covered by the existing "configurable display markers" design in ARCHITECTURE.md §3.5?

 **From Jim:** If it's not clear to you then it needs fixing no matter what. I suggest changing ARCHITECTURE.md §3.5 and creating an ADR pointing at the changes

3. **R9 (unlisted sender TUI advisory):** The recommended advisory appears in the TUI only. Should it also appear in the audit log as a `sender_blocked` event type distinct from the existing `message_received` event (which logs a hash of the sender, not a block outcome)? This is an audit log schema question for the orchestrator spec, not just a UX question.

 **From Jim:** Agreed

4. **R10 (supervised mode prompt):** The architecture defines Supervised mode as a Call Inspector soft-block with a "channel adapter round-trip." The TUI design above treats this as a prompt-level interaction. Is the intent that the user confirms via the same channel (i.e., the Telegram user approves their own action, not the TUI operator approves it on their behalf)? If so, the TUI approval prompt is for the case where TUI is the active channel. The recommendation above assumes TUI-as-channel; if Supervised mode is per-group and the group uses Telegram, the approval prompt appears in Telegram instead. Clarification from the Architect is needed.


 **From Jim:** per channel, remember that each channel is an instance with its own permissions and rules (and evolving Golem). True supervisor/admin help is needed for changes that will affect the "root" Golem and behaviors, skills, permissions, etc affecting all channels



---

*Produced: 2026-04-06 | Awaiting PM approval*
