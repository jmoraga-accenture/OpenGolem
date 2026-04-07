# UX Review: TUI and CLI Interaction Model
*M4 — Stream J | UX/Interaction Designer | 2026-04-07*
*Status: Approved by Jim 2026-04-07*

---

## Inputs Read

| Document | Section |
|----------|---------|
| `docs/specs/channel-adapters-spec.md` | Full document — TUI adapter, health dashboard, acceptance criteria |
| `docs/ARCHITECTURE.md` | §1.3 Startup dependencies, §3.0 Security mode model, §3.1 Orchestrator, §3.5 Alef |
| `docs/specs/orchestrator-spec.md` | §2.5 Container spawn/teardown, §2.6 Audit log, §3.1 Task dispatch sequence, §3.3 Cato block path |
| `src/channels/tui.ts` | Full implementation |
| `src/channels/tui.test.ts` | Full test file |
| `docs/ux/ux-review-setup-onboarding.md` | M3 — for format and tone |
| `docs/ux/ux-review-dashboard.md` | M5 — for format and tone |
| `docs/ux/stream-j-cli-tui.md` | Stream J approved review — source material for this review |

---

## Executive Summary

The TUI is OpenGolem's primary local interface and the sole surface on which the health dashboard renders. The v0.1 implementation (`src/channels/tui.ts`) delivers a minimal, functional readline prompt with clean non-TTY degradation. It is a correct starting point. It is not a complete v1.0 experience.

Four structural gaps drive the risk at the TUI layer:

1. **The prompt communicates nothing about system state.** The `opengolem>` prompt is visually identical whether the system is fully healthy, in safe-hold with all messages queuing silently, or in Power security mode with reduced inspection. A user who does not know to press Ctrl-D for the health panel has no ambient signal about the system's operating condition.

2. **The health panel is specified but not implemented, and the spec leaves information hierarchy undefined.** Channel-adapters-spec.md AC-13 and AC-14 define toggle behavior and read-only access; they do not specify what content is above the fold, how to group six disparate data items, or what a user without container/security knowledge should do with them.

3. **The administrative command surface has no discovery path.** Commands (`npm run dev`, `npm run status`, `/debug`, `/setup`, skills) are scattered across `CLAUDE.md`, `README.md`, and the skills catalog with no single point of entry. A user who does not know what commands exist cannot find them.

4. **Error messages for the three failure modes that matter most — container TTL expiry, Cato block, and broker unavailability — are either unspecified or use internal vocabulary at the user-facing surface.** Each of these events is distinguishable and recoverable, but only if the message tells the user something actionable.

The recommendations below are specific and bounded. None requires architectural change.

---

## Cognitive Load Assessment by User Segment

The target user spectrum is:

- **Power user:** understands containers, Linux processes, API keys, and security policy concepts. May be running OpenGolem for a team. Reads logs. Comfortable at the terminal.
- **Non-technical user:** wants to chat with their AI assistant. Does not know what a container is. Has set up a bot before but only with step-by-step instructions. Treats the `opengolem>` prompt as a conversation window, not a system console.

Both segments reach the TUI. The health panel toggle (Ctrl-D) is used predominantly by power users; the prompt and error messages are the non-technical user's primary surface.

---

## The `opengolem>` Prompt

### Current state

The v0.1 implementation (`tui.ts` line 49) sets the prompt to the fixed string `opengolem> ` and re-prompts after each response. There is no status line, no channel indicator, no security mode indicator, and no block count. The prompt is visually identical across all system states: healthy, safe-hold, Power mode, or Supervised mode awaiting confirmation.

The v1.0 spec (channel-adapters-spec.md) specifies the health panel toggle but does not specify what the non-panel prompt communicates. The orchestrator spec §3.0 defines three security modes that materially affect what a user can expect from the system, but the prompt is unspecified.

### Load by segment

**Non-technical user:** Low friction when the system is healthy. High friction on any abnormal state: they have no signal that something is wrong until they send a message that silently queues or returns an error they cannot parse.

**Power user:** The absence of the security mode in the prompt is a meaningful gap for compliance and incident review. A session run in Power mode by accident has no artifact indicating this unless the user opened the health panel. The audit log records the mode per task, but there is no ambient signal during the session.

### Annotated prompt-line information architecture

The prompt line should carry three ambient signals without cluttering the chat stream. These signals appear as a single status hint drawn at startup, after each agent response, and on any state change. The hint clears when the user begins typing.

```
[golem_guard | tui]  blocks: 0
opengolem>
```

Anatomy:

```
[<security-mode>  |  <active-channels>]  blocks: <session-block-count>
opengolem>
```

- `<security-mode>` uses the canonical mode names from ARCHITECTURE.md §3.0: `golem_guard`, `supervised`, `power`. These double as mnemonics: "golem guard" implies protection; "supervised" implies human-in-the-loop; "power" implies fewer restrictions. The non-technical user does not need to understand the mechanism — the label is enough to prompt a question if it looks unexpected.
- `<active-channels>` lists only registered, connected channels (e.g. `tui telegram`). If Telegram disconnects, it drops from the hint in real time. This answers "is my bot connected?" without requiring the user to open the health panel.
- `blocks: <n>` is the session count of Cato blocks. It starts at 0 and increments on each `cato_block` event. It is not interactive. The user presses Ctrl-D to see block details.

The hint is not redrawn on every keypress. It is drawn: at startup (immediately before the first prompt), on any channel connection status change, on any block event, and after each agent response completes.

**Startup suppression:** The `opengolem>` prompt must not appear until the orchestrator has confirmed that Token Broker and Cato are both healthy (orchestrator-spec.md §3.1, steps 4–5 complete). While the dependency check runs, show a pre-prompt status block instead of an empty screen:

```
OpenGolem starting...
  Token Broker:  checking...
  Cato:          checking...
```

Replace with the ready block when startup is complete:

```
OpenGolem ready.
  Token Broker:  ok
  Cato:          ok
  Channels:      tui

[golem_guard | tui]  blocks: 0
opengolem>
```

This eliminates the silent-queue ambiguity described in M3 (ux-review-setup-onboarding.md R12): a user who starts OpenGolem before the broker or Cato are ready currently sees either a blank screen or the prompt, with no indication that messages will queue silently. Suppressing the prompt until readiness eliminates this ambiguous state.

---

## The Health Panel (Ctrl-D Toggle)

### Current state

The v0.1 implementation has no health panel. Channel-adapters-spec.md AC-13 and AC-14 specify that Ctrl-D toggles a read-only panel, and name six data items it must display:

- Per-adapter connection status
- Token Broker status
- Cato status
- Active container count
- Recent audit events (last N from in-memory window)
- Most recent hansei report summary

The spec does not define information hierarchy within the panel: which items are above the fold, how items are grouped, or what level of detail is shown by default.

### Information hierarchy assessment

The six data items fall into three natural groups that answer three distinct questions:

| Question | Data items |
|----------|-----------|
| "Is the system operational?" | Token Broker status, Cato status, per-adapter connection status |
| "What is happening right now?" | Active container count, queue depth, session block count |
| "Is there anything to review?" | Most recent hansei report summary |

The operational question must be above the fold. The runtime question is the primary operational pulse. The governance question is for the power user or administrator; it should be reachable but not mandatory to scroll past before seeing operational status.

Recent audit events (the sixth spec item) are below the fold by nature — they are a scrollable log, not a summary view.

### Annotated wireframe: split-pane layout

When Ctrl-D is pressed, the terminal renders a vertically split or panel-above layout. Because OpenGolem uses readline (no external UI framework), the implementation uses ANSI sequences and a fixed-height panel block rather than true split-pane rendering. The panel occupies the top portion of the screen; the chat prompt continues below.

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
  -- press Ctrl-D again to close | scroll: j/k or arrow keys --

[below fold — requires scroll]

+--------------------------------------------------+
|  RECENT AUDIT EVENTS (last 10)                   |
|  04-07 14:33  task_complete    group/main  ok    |
|  04-07 14:32  container_spawn  group/main        |
|  04-07 14:31  task_start       group/main        |
|  04-07 14:31  message_received group/main        |
+--------------------------------------------------+

+--------------------------------------------------+
|  GOVERNANCE                                      |
|  Last hansei report:  2026-04-05 06:00           |
|  Unread reports:  0                              |
|  (full report: data/hansei/inbox/)               |
+--------------------------------------------------+
```

### Panel content ordering rationale

**SYSTEM STATUS is first** because it answers the most fundamental question: is the infrastructure that the system depends on actually running? If Token Broker or Cato shows `[unreachable]`, every other number on the panel is unreliable. The user needs this signal before they look at task or governance data.

**CHANNELS is second** because the user's first self-diagnostic question after "is it running?" is "is my channel connected?" For a non-technical user who is not receiving Telegram responses, seeing `telegram [disconnected]` in the channels row is the answer they need. The `@botname` annotation on the Telegram row is operationally critical — operators can have multiple bots; knowing which one is active prevents misidentification.

**TASKS is third and above the fold** because it is the operational pulse: "is anything processing right now?" A user who opened the panel to check why their message is taking a long time should see `Active containers: 1, Queue depth: 2` without scrolling.

**RECENT AUDIT EVENTS is below the fold.** It is valuable for power users diagnosing a sequence of events, but it is a log — not a summary. A non-technical user who sees ten timestamped event rows without context will not benefit from them. Power users who want the audit log know to scroll.

**GOVERNANCE is last.** The hansei report section is an administrator function. A non-technical user does not need it. A power user who is both the operator and the administrator will find it in a clearly labeled section at the bottom of the panel without it intruding on the operational view.

### Component status vocabulary

The panel uses three status values: `[ok]`, `[degraded]`, `[unreachable]`. Not two (`ok | unreachable` as the current spec schema). The word `degraded` covers the case where a component is reachable but returning errors — a state that exists in practice and that the two-value schema cannot express at the component level. This aligns with the orchestrator health response schema (`ok | degraded | halted`) and eliminates the vocabulary mismatch identified in stream-j-cli-tui.md §1.3.

### Ctrl-D affordance legibility

**The keyboard shortcut is not discoverable by default.** A non-technical user who has never seen documentation for the TUI will not press Ctrl-D. The status hint line (above) includes no reference to the health panel.

**Recommendation:** Add a one-time discovery nudge on first startup, displayed between the ready block and the first prompt:

```
OpenGolem ready.
  Token Broker:  ok
  Cato:          ok
  Channels:      tui

  Tip: press Ctrl-D to view system health. Press Ctrl-D again to close.

[golem_guard | tui]  blocks: 0
opengolem>
```

The nudge appears once only (persisted in a local state file or `data/tui-tips-shown`). On subsequent startups, it is suppressed. The health panel hint in the panel footer (`press Ctrl-D again to close`) provides ongoing orientation for users who opened the panel and need to close it.

### Panel is read-only

Per channel-adapters-spec.md AC-14: the panel accepts no user input. The scroll keys (`j/k` or arrow keys) are navigation only. Any other key closes the panel and returns to the chat prompt. The footer hint communicates this behavior without requiring the user to have read it before.

---

## Administrative Command Surface

### Current state

The administrative command surface for OpenGolem is spread across four locations with no single discovery point:

| Command | Where documented | How to discover |
|---------|-----------------|-----------------|
| `npm run dev` | README.md quick start | Read the README |
| `npm run build` | README.md, CLAUDE.md | Read either |
| `npm run status` | `package.json` scripts | Inspect package.json or know to run it |
| `npm test` | README.md, CLAUDE.md | Read either |
| `./container/build.sh` | README.md | Read the README |
| `/setup`, `/debug`, `/add-telegram`, etc. | CLAUDE.md skills table | Read CLAUDE.md |
| `systemctl --user start opengolem` | CLAUDE.md | Read CLAUDE.md |
| `launchctl load ...` | CLAUDE.md | Read CLAUDE.md |

A non-technical user who starts with `README.md` will find `npm run dev`, `npm test`, and `./container/build.sh`. They will not find `npm run status`. They will not find the skills unless they also read `CLAUDE.md`, which is a developer reference, not a user guide.

A power user who reads `CLAUDE.md` will find the skills table and the service management commands, but they will need to infer that `npm run status` exists from `package.json`.

### What commands exist

The administrative command surface, fully enumerated:

**Lifecycle:**
- `npm run dev` — Start with hot reload (development)
- `npm run build` — Compile TypeScript
- `npm run status` — Human-readable system status summary
- `npm test` — Run test suite
- `./container/build.sh` — Build the agent container image

**Service management (Linux/systemd):**
- `systemctl --user start opengolem`
- `systemctl --user stop opengolem`
- `systemctl --user restart opengolem`

**Service management (macOS/launchd):**
- `launchctl load ~/Library/LaunchAgents/com.opengolem.plist`
- `launchctl unload ~/Library/LaunchAgents/com.opengolem.plist`

**WSL / no systemd:**
- `bash start-opengolem.sh`

**Skills (invoked via Claude Code slash commands):**
- `/setup` — First-time installation, authentication, service configuration
- `/debug` — Container issues, logs, troubleshooting
- `/customize` — Adding channels, integrations, changing behavior
- `/add-telegram` — Feature skill: add Telegram channel
- `/claw` — Utility skill: install command-line agent tool
- Others listed in CLAUDE.md

**In-channel commands (sent as chat messages):**
- `/chatid` — Returns the Telegram chat ID for allowlist configuration
- `/compact` — Manual context compaction (if add-compact skill applied)

### How commands are discovered

Currently: they are not. The user must know to look in `CLAUDE.md` or `package.json`. There is no `--help` flag, no `npm run help`, and no in-TUI command listing.

### Recommendations for command discovery

**R1 — Add `npm run help` to `package.json`**

A `help` script that prints the administrative command surface to the terminal, grouped by category. Format:

```
OpenGolem — administrative commands

  Lifecycle:
    npm run dev            Start with hot reload (development)
    npm run build          Compile TypeScript
    npm run status         System status summary
    npm test               Run test suite (729 tests)
    ./container/build.sh   Build the agent container image

  Service management (Linux):
    systemctl --user start opengolem
    systemctl --user stop opengolem
    systemctl --user restart opengolem

  Service management (macOS):
    launchctl load ~/Library/LaunchAgents/com.opengolem.plist
    launchctl unload ~/Library/LaunchAgents/com.opengolem.plist

  Skills (run in Claude Code):
    /setup        First-time setup and service configuration
    /debug        Container and log troubleshooting
    /customize    Add channels and integrations
    /add-telegram Add Telegram as a channel

  For full skills catalog: see CLAUDE.md → Skills
```

**R2 — Show a command reminder in the health panel footer**

Below the GOVERNANCE section (or in the panel footer), add a one-line reference:

```
  Commands: npm run help | npm run status | Ctrl-D to close
```

This surfaces the two most immediately useful commands for a non-technical user without requiring them to leave the terminal.

**R3 — Add a commands section to README.md**

The README currently lists development commands (`npm run dev`, `npm run build`, `npm test`) in the quick start, but does not list `npm run status` or explain the skills invocation model. Add an "Administrative commands" section after the quick start that cross-references the skills catalog and the `npm run help` output.

### How errors are surfaced

**For `npm run status`:** The command currently returns raw JSON (per `package.json`, `scripts.status`). This is not legible to a non-technical user. The command should default to the human-readable summary format recommended in stream-j-cli-tui.md §1.3:

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

Raw JSON available via `npm run status -- --json`.

**For skill application errors:** When a skill is rejected (missing `apply_permission`, validation failure), the error should name the failing field and tell the administrator how to fix it. The channel-adapters-spec.md AC-15 criterion specifies that a missing `apply_permission` field produces an error identifying the field. That is necessary but not sufficient — the error should also specify what value is required and where to add it.

**For service management errors (systemd/launchd):** These are platform-native errors. OpenGolem cannot improve them, but the README should note that `journalctl --user -u opengolem` (Linux) and `log show --predicate` (macOS) are the diagnostic paths.

---

## Error Message Clarity

### Container TTL expiry

When a container exceeds its TTL, the orchestrator tears it down and routes a timeout notification to the user via the channel adapter (orchestrator-spec.md §2.5). The spec states the orchestrator "may include partial output" but does not specify the message text.

**Current gap:** The TTL expiry notification text is unspecified. Without specifying it, the developer will write whatever they think is appropriate. The most common result is an internal label (e.g. `"container_ttl_expired"`, `"task timed out"`) that is meaningful to a developer but not to a non-technical user.

**Recommended TTL expiry notification (user-facing, in the chat stream):**

```
Your request took longer than the allowed time and was stopped automatically.

If you were in the middle of a complex task, you can continue by sending your
next message — Alef will pick up from the context in memory.

If this happens repeatedly, ask your system administrator to increase the task
time limit.
```

**Recommended TTL expiry notification (operator-facing, TUI system event notification above the prompt line):**

```
----[ TASK TIMEOUT ]----
Container TTL expired at 14:33:02 | group: main | task: task-abc123
Token revoked. Partial output discarded.
Audit entry: container_ttl_expired #4822
------------------------
```

Design rules for the operator notification: visually separated from the chat stream with a full-width delimiter; includes the timestamp, group, and task reference; explicitly states that the token was revoked and partial output was discarded; provides the audit event reference. This gives the power user everything they need for incident investigation without reproducing payload content.

### Cato block

When Cato issues `allow: false`, the orchestrator revokes the token, writes `cato_block` to the audit log, and routes a `[BLOCKED]` explanation to the user (orchestrator-spec.md §3.1 steps and §3.3). In the TUI, the `[BLOCKED]` message appears in the chat stream — visually identical to an agent response.

**Current gap:** Security enforcement is visually indistinguishable from normal conversation in the TUI. A Cato block is not a conversational response; it is a security event. The operator should see it differently.

**Recommended Cato block design — two distinct outputs:**

In the chat stream (user-facing), Alef composes the `[BLOCKED]` explanation in the user's language, using the configured display tag (default: `[BLOCKED]`) and the risk-code-to-plain-language mapping (see stream-j-cli-tui.md §1.4 recommendations table). The user sees a conversational message that names the risk class without reproducing the blocked payload.

In the TUI operator notification (above the prompt line, not in the chat stream):

```
----[ SECURITY EVENT ]----
Cato block at 14:33:02 | group: main | code: PROMPT_INJECTION
No payload content recorded. Audit entry: cato_block #4821
--------------------------
```

The operator notification:
- Is clearly labeled as a system event (not a conversational response)
- Shows the block timestamp, group, and the internal risk code (the operator is the administrator, not the user — they can handle technical labels)
- Explicitly states "No payload content recorded" — a compliance statement confirming the system behaved according to its privacy design
- Provides the audit entry reference for incident investigation

The session block count in the status hint increments immediately when this notification fires, giving the operator an ambient signal without requiring them to read the notification in detail.

### Broker unavailable

When the Token Broker is unreachable, the orchestrator fails closed: no task proceeds without a valid token (orchestrator-spec.md §2.4 failure mode). The orchestrator queues inbound messages and does not spawn containers.

**Current gap:** There is no specification of what the TUI displays during this state. A user who sends a message while the broker is unreachable may see their message accepted by the prompt and then nothing happen.

**Recommended broker unavailable notification — in the chat stream:**

```
[system] Your request is queued. The Token Broker is temporarily unreachable.

No tasks will run until the broker is available. Your message will be
processed automatically when it reconnects.

If this persists for more than a few minutes, restart OpenGolem:
  systemctl --user restart opengolem   (Linux)
  launchctl kickstart -k gui/<uid>/com.opengolem   (macOS)
```

**In the status hint:** when the broker is unreachable, update the channel status display:

```
[golem_guard | tui]  blocks: 0  | broker: UNREACHABLE
opengolem>
```

The `broker: UNREACHABLE` marker is visually alarming by design — the system is in safe-hold and the user should know immediately.

**Recovery:** When the broker reconnects, the status hint reverts to the normal display and a brief advisory appears:

```
[system] Token Broker reconnected. Processing queued messages.
```

---

## Information Hierarchy Assessment: Security State Legibility

The target user spectrum has sharply different needs for security state information:

| Security signal | Non-technical user | Power user |
|---|---|---|
| Security mode (`golem_guard / supervised / power`) | Needs to know it exists and what it means in one sentence | Needs the exact mode name for compliance documentation |
| Active container count | "Is Alef working on my request?" | "How many concurrent tasks are running?" |
| Cato socket status | "Is the safety layer on?" | "Is Cato reachable and returning responses?" |
| Broker status | Does not think about this | Critical — no tokens means no tasks |
| Session block count | "Something was stopped?" | "How many Cato events this session?" |
| Recent hansei report | Does not need this | Required for governance review |

**Assessment:** The health panel as specified places all six items at the same priority level. The wireframe above (SYSTEM STATUS → CHANNELS → TASKS → audit events → GOVERNANCE) addresses this. The security state most relevant to a non-technical user — "is the safety layer running?" — appears in SYSTEM STATUS (Cato: `[ok]`) and is above the fold. The security state most relevant to a power user — broker reachability, session blocks, hansei report status — is distributed appropriately across SYSTEM STATUS, TASKS, and GOVERNANCE.

**The one gap in the wireframe:** Active containers is listed in TASKS, but the security implication of an active container is not labeled. A power user looking at `Active containers: 1` knows this means a task is in progress. A non-technical user may not understand why this is on a "health" panel at all. A one-line annotation helps:

```
  TASKS
  Active containers: 1   (Alef is working on a request)
  Queue depth:       0
  Session blocks:    0
```

The parenthetical is suppressed when `Active containers: 0`.

---

## Supervised Mode Pending-Approval State

The v1.0 spec (ARCHITECTURE.md §3.0) defines Supervised mode as: a Call Inspector soft block where "outbound call or action is held until the user confirms or cancels on the channel." The orchestrator spec §3.0 says the orchestrator "implements Supervised user-confirm/cancel flows." No spec currently defines what the TUI displays during the pending-approval window.

**Gap:** If there is no unambiguous UI signal that the system is waiting for approval, the operator may think the system is hung, send another message, or close the terminal — potentially orphaning the pending task.

**Recommended pending-approval state design:**

When the orchestrator enters the pending-approval window, the TUI replaces the normal `opengolem>` prompt for the duration of the window:

```
----[ APPROVAL NEEDED ]----
The assistant is about to take an action that requires your confirmation.

  Action:  Make an API call to an external service
  Risk:    This call was flagged by the safety inspector (advisory)
  Group:   main

  Type YES to proceed, NO to cancel, or DETAILS for more information.
---------------------------
supervised> _
```

The normal `opengolem>` prompt is suspended while `supervised>` is active. Any input that is not `YES`, `NO`, or `DETAILS` is acknowledged with: `Type YES to proceed or NO to cancel.` On `DETAILS`, the full inspection result is displayed. On `YES` or `NO`, the normal prompt and status hint resume.

Note from stream-j-cli-tui.md open question 4 and Jim's response: Supervised mode approval is per-channel. If the active group uses Telegram, the approval prompt appears in Telegram, not in the TUI. The TUI-level approval prompt applies when the TUI is the active channel for the group being supervised.

---

## Recommendations

| # | Surface | Recommendation | Segment |
|---|---------|----------------|---------|
| R1 | Admin commands | Add `npm run help` script to `package.json`; print grouped command surface | Both |
| R2 | Health panel footer | Add one-line command reference: `npm run help \| npm run status \| Ctrl-D to close` | Non-technical |
| R3 | README.md | Add "Administrative commands" section cross-referencing skills and `npm run help` | Both |
| R4 | `npm run status` | Default to human-readable summary; `--json` flag for raw JSON | Non-technical |
| R5 | TUI prompt | Add status hint below prompt: security mode, active channels, session block count | Both |
| R6 | TUI startup | Suppress `opengolem>` prompt until broker and Cato are confirmed healthy; show pre-prompt status block | Non-technical |
| R7 | TUI startup | Show one-time Ctrl-D discovery nudge on first run; suppress on subsequent starts | Non-technical |
| R8 | Health panel | Implement three-tier hierarchy: System Status + Channels + Tasks above fold; Audit Events + Governance below fold | Both |
| R9 | Health panel | Add `[ok] / [degraded] / [unreachable]` three-value status vocabulary; align with orchestrator health response schema | Power user |
| R10 | Health panel | Annotate `Active containers: N` with `(Alef is working on a request)` when N > 0 | Non-technical |
| R11 | Container TTL expiry | Define user-facing notification text (conversational, with resume instructions) and operator notification (labeled box, audit reference) | Both |
| R12 | Cato block | Add operator-facing security event notification (labeled box above prompt) distinct from user-facing `[BLOCKED]` chat message | Both |
| R13 | Broker unavailable | Add in-chat advisory with restart instructions; add `broker: UNREACHABLE` marker to status hint | Both |
| R14 | Supervised mode | Define `supervised>` approval prompt that replaces normal prompt during pending-approval window | Both |
| R15 | Skill application errors | Error on validation failure must name the failing field, required value, and where to add it | Power user |

---

## Open Questions for PM

1. **R5 (status hint — queue depth):** Should `queue: N` appear in the status hint when a message is queued (i.e., a task is active and a new message arrived), or is queue depth a health-panel-only signal? The tradeoff: always-visible queue depth tells the user why their message is not getting a response; it adds one more term to the status hint that a non-technical user may not understand.


**From Jim:** This had already been approved, why ask again?

2. **R6 (startup prompt suppression):** Should prompt suppression apply only when the broker or Cato is *unreachable*, or also when they are *degraded*? If degraded means "reachable but returning errors," should the system still show the prompt with a warning banner, or suppress entirely? This is a behavioral spec question for the orchestrator startup sequence.

**From Jim:** I need a message in all cases to help the users ask for help and the admins to debug


3. **R7 (one-time discovery nudge state):** Where does the "tip shown" state live? `data/tui-tips-shown` is a file in the data directory. Confirm this is the right location, or whether a `groups/main/.tui-state` approach is preferable if different groups could have different tip histories.

**From Jim:** Both, can be shut off globally but activated / decativated by group / channel


4. **R8 (health panel — hansei report section):** The GOVERNANCE section shows "Last hansei report" date and unread count. Should it also show the KPI summary inline (three values with trend arrows), or is that too much data for the health panel and better left to `npm run status` or the dashboard skill? Stream-k-dashboard.md covers the full dashboard; this review covers only the TUI health panel.

**From Jim:** Summary is fine (especially important of admin is not checking too often), but details on status or dashboard


5. **R14 (supervised mode — per-channel scope):** Jim's response to stream-j open question 4 confirms approval is per-channel. Is it possible for a single group to have multiple active channels simultaneously (e.g., the same group is reachable via both TUI and Telegram)? If so, when a supervised soft-block occurs, which channel's approval prompt fires? This has a scheduling implication: can both channels receive the approval prompt, or does the orchestrator pick one?


**From Jim:** No. Groups are per channel. People in the channel are the group members. We don't have a "groups" allowlist as far as I know.



---

*Produced: 2026-04-07 | Awaiting Jim's gate (PM approval)*
