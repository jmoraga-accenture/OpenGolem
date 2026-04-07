# UX Review: Setup and Onboarding
*M3 — Stream I | UX/Interaction Designer | 2026-04-07*
*Status: Ready for PM review (Jim's gate)*

---

## Inputs Read

| Document | Section |
|----------|---------|
| `README.md` | Full document |
| `docs/ARCHITECTURE.md` | §1.3 Startup Order and Dependencies |
| `docs/specs/orchestrator-spec.md` | §3.1 Startup Sequence |
| `docs/specs/channel-adapters-spec.md` | Adapter startup, failure modes |
| `scripts/setup.sh` | Full script |
| `.env.example` | Full file |

---

## Executive Summary

The setup experience is structurally sound for an enterprise operator but creates multiple silent failure paths for a non-expert user. Three root problems drive most of the risk: the credential configuration step offers no decision guidance (the user must choose among three credential variables with no stated hierarchy), startup dependency failures produce either tool-native errors with no OpenGolem attribution or a healthy-looking prompt that silently queues all messages, and the paths from "quick start complete" to "channel added" and "skill applied" are not documented in the primary user-facing document. The recommendations below are specific and bounded; none requires architectural change.

---

## Cognitive Load Assessment

### Step 1 — Clone and `cp .env.example .env`

**Current state (README.md line 28):** The quick start instructs the user to run `cp .env.example .env` and then "add your Anthropic credential." The `.env.example` file lists three credential-adjacent variables: `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, and (implicitly) `ANTHROPIC_BASE_URL_UPSTREAM`. None is marked as the correct choice for a given user.

**Load by segment:**
- Non-expert: High. The user opens `.env.example`, sees three options with no guidance, and must guess. The most common guess (entering an API key under `ANTHROPIC_API_KEY`) is correct for most users, but a Claude Code subscriber who runs `claude setup-token` instead will set `CLAUDE_CODE_OAUTH_TOKEN` — also correct. The problem is that both paths are presented without explanation, so a user who uses the wrong one for their account type will get an auth failure inside a container with no diagnostic message that names the credential as the problem.
- Enterprise operator: Low. They know which variable to use from previous Anthropic API experience.

**Load by segment — credential backend selection:**
The configuration reference table (README.md lines 43–55) presents three credential backends (`env`, `bitwarden`, `onecli`) as a flat list with no recommendation order. A non-expert will not understand that `env` is the correct default for personal use and that the others require additional infrastructure. `bitwarden` and `onecli` entries, with their associated variables (`BW_SESSION`, `ONECLI_GATEWAY_URL`), are visible at a time when the user has not yet established that the basic `env` path works.

**Assessment: the credential configuration step is the highest-load step in the setup flow and the most likely source of first-run failure.**

---

### Step 2 — `npm install` and `npm run build`

**Load by segment:** Low for both segments. Standard Node.js workflow. No issues identified.

---

### Step 3 — `./container/build.sh`

**Current state (README.md line 31):** The user runs the container build script. If Docker is not running or not installed, the error output comes from Docker, not from OpenGolem. The word "OpenGolem" does not appear in the error.

**Load by segment:**
- Non-expert: Medium-to-High. The user sees Docker error output and cannot determine whether OpenGolem is broken or Docker is the problem. Docker's own error messages vary by installation method and OS.
- Enterprise operator: Low. They know Docker error attribution.

**Specific failure text a non-expert will see (Docker not running on Linux):**
```
Cannot connect to the Docker daemon at unix:///var/run/docker.sock.
Is the docker daemon running?
```
There is no mention of OpenGolem, no next-step, and no indication whether the OpenGolem installation is otherwise valid.

---

### Step 4 — `npm test`

**Current state (README.md line 32):** `npm test` appears in the quick start as a sequential step before `npm run dev`. It runs 505 tests.

**Load by segment:**
- Non-expert: Medium. Running a test suite as part of installation is unusual outside software development contexts. The user does not know whether a test failure is blocking (it is not, in practice) or whether they must understand the failure before proceeding.
- Enterprise operator: Low. They recognize CI hygiene; they will also immediately want to know which tests, if any, are environment-dependent.

**Issue:** There is a stale test count in the quick start. README.md line 32 says "505 tests"; `CLAUDE.md` says "563 tests passing." This inconsistency will cause confusion for a user who runs `npm test` and sees 563 tests pass when the documentation said 505.

---

### Step 5 — `npm run dev`

**Current state:** The user starts OpenGolem. The system must complete startup in a specific order: Token Broker must be listening, then Cato must be listening, then the Orchestrator starts (ARCHITECTURE.md §1.3). In the single-process `npm run dev` mode, all three long-lived processes start together and the orchestrator waits for the broker and Cato before marking itself healthy (orchestrator-spec.md §3.1, steps 4–5).

**Load by segment:**
- Non-expert: Low, assuming startup succeeds. The TUI prompt appears and the user types.
- Non-expert, failure case: High. If the startup dependency chain fails (broker or Cato unreachable), the orchestrator enters safe-hold: it queues messages but does not spawn containers. No current specification describes what the TUI displays during this state. The user may see the `opengolem>` prompt and conclude the system is healthy.
- Enterprise operator: Medium. They will check logs, but the log output for startup dependency failures is not specified in any document read for this review.

---

### Step 6 — First message

**Current state:** The first message at the `opengolem>` prompt triggers a container spawn. The container image must exist (from `./container/build.sh`). If it does not, Docker's "no such image" error appears in logs, not at the TUI prompt.

**Load by segment:**
- Non-expert: High if container image is missing. The TUI prompt accepts input, the user sends a message, and nothing appears to happen. The error is in logs that the user has not been told to watch.

---

### Step 7 — Channel registration (Telegram)

**Current state (README.md lines 62–65):** Adding Telegram requires setting `TELEGRAM_BOT_TOKEN` and `OPENGOLEM_CHANNELS` in `.env` and restarting. The channel notes section describes this as a feature description, not a sequential setup flow. There is no numbered list of steps.

**For Telegram groups specifically:** The README introduces `TELEGRAM_ALLOW_GROUPS`, `TELEGRAM_VALID_USERS`, and `sender-allowlist.json` in a single dense paragraph. A non-expert enabling group mode for the first time must understand five distinct concepts simultaneously: bot token, valid users list, allow groups flag, chat ID discovery (`/chatid`), and allowlist JSON format.

**Load by segment:**
- Non-expert: High. The current channel notes read as feature documentation, not a setup flow. The user is not told the order of operations.
- Enterprise operator: Medium. They will understand bot token mechanics; the allowlist JSON format and the chat ID discovery method still require documentation.

---

### Step 8 — Group creation

**Current state:** Group creation is not documented in README.md. The orchestrator automatically creates `groups/{name}/CLAUDE.md` on first container spawn (orchestrator-spec.md §2.5, pre-spawn file checks). The mechanism for creating a named group beyond the default is unspecified in user-facing documentation.

**Load by segment:**
- Non-expert: Blocked. There is no documented path.
- Enterprise operator: They may infer `mkdir groups/mygroup` from the architecture, but this is inference, not documentation.

---

### Step 9 — Skill application

**Current state:** Skills are mentioned in the README features list (line 14: "Alef (SOUL.md, M5)") and in the documentation index. The README does not describe how to apply a skill. The `/setup`, `/add-telegram`, and other skills are listed in `CLAUDE.md` (developer reference) but not in `README.md` (user-facing document).

**Load by segment:**
- Non-expert: Blocked. No path from README to skill application.
- Enterprise operator: They will find the skills in `CLAUDE.md`, but `CLAUDE.md` is a developer reference document, not a user guide.

---

## Annotated User Flow

*From clone to first successful agent response, with friction points marked.*

```
[CLONE]
  git clone <repo> && cd OpenGolem
  ↓ [no friction]

[CREDENTIAL CONFIGURATION]  ← FRICTION POINT F1
  cp .env.example .env
  Open .env — which variable? No guidance.
  ↓
  [if wrong variable] → auth error at Step 8, no recovery path documented
  [if right variable] ↓

[INSTALL]
  npm install && npm run build
  ↓ [no friction]

[CONTAINER BUILD]  ← FRICTION POINT F2
  ./container/build.sh
  [if Docker not running] → Docker error, no OpenGolem attribution, no recovery
  [if Docker running] ↓

[TEST]  ← MINOR FRICTION F3
  npm test
  [if fails] → user does not know whether this blocks startup
  [if passes] ↓

[STARTUP]  ← FRICTION POINT F4
  npm run dev
  [if broker/Cato unhealthy] → safe-hold, prompt appears but messages silently queue
  [if container image missing] → first message fails silently in logs
  [if healthy] → opengolem> prompt appears

[FIRST MESSAGE]
  User types at opengolem>
  → Container spawned (default group)
  → Agent responds via TUI
  ↓ [FIRST SUCCESS — if all prior steps resolved correctly]

  [if auth failure] ← FRICTION POINT F5
    Error returned via sentinel protocol as "agent response"
    Visually indistinguishable from a real agent response
    No credential diagnostic

[CHANNEL REGISTRATION]  ← FRICTION POINT F6
  User wants to add Telegram
  Set TELEGRAM_BOT_TOKEN + OPENGOLEM_CHANNELS in .env → restart
  [if bot token missing or wrong] → adapter fails silently (log only)
  [if bot token valid] → adapter registers; user messages bot
  [for groups] ← FRICTION POINT F7
    TELEGRAM_ALLOW_GROUPS + TELEGRAM_VALID_USERS + allowlist JSON
    /chatid discovery step not in sequential form
    Five concepts simultaneously, no step ordering

[GROUP CREATION]  ← DEAD END DE1
  User wants a second context group
  No documented path in README.md
  mkdir groups/mygroup is the correct action but not described

[SKILL APPLICATION]  ← DEAD END DE2
  User wants to extend capabilities
  No path from README.md to skill application
  Skills exist in CLAUDE.md (developer reference), not in user guide
```

---

## Recommendations

### R1 — Add a credential decision block to `.env.example`

**What to change:** In `.env.example`, before the `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` lines, insert a commented decision block:

```
# --- CHOOSE ONE CREDENTIAL TYPE (only one is needed) ---
#
# Option A (most users): API key from console.anthropic.com
# ANTHROPIC_API_KEY=sk-ant-...
#
# Option B (Claude Code subscribers): OAuth token
#   Run: claude setup-token
#   Then set:
# CLAUDE_CODE_OAUTH_TOKEN=<token from above>
#
# Option C (enterprise with custom endpoint):
# ANTHROPIC_API_KEY=...
# ANTHROPIC_BASE_URL_UPSTREAM=https://your-enterprise-endpoint
#
# If unsure: use Option A.
# --------------------------------------------------------
```

**Why:** The credential step is the most common first-run failure point. Users who choose the wrong variable receive an authentication error inside a container with no actionable diagnostic. Converting the variable list into an explicit decision tree at the point of use eliminates the guessing step.

**Segment:** Primarily non-expert. Enterprise operators already know which variable to use.

---

### R2 — Add a Docker health check to `./container/build.sh`

**What to change:** At the top of `scripts/setup.sh` (which is the bootstrap script) and at the top of `./container/build.sh`, add:

```bash
if ! docker info > /dev/null 2>&1; then
  echo "OpenGolem: Docker is not running or not installed."
  echo "  Install Docker: https://docs.docker.com/get-docker/"
  echo "  Start Docker, then re-run this script."
  exit 1
fi
```

**Why:** Docker errors appear without OpenGolem attribution. A non-expert cannot distinguish a broken OpenGolem installation from a stopped Docker daemon. This three-line check converts an opaque error into a directed recovery step.

**Segment:** Primarily non-expert.

---

### R3 — Specify startup error messages for dependency failures

**What to change:** Define the exact text the orchestrator writes to stderr/TUI when startup dependencies fail. These are not yet specified in any document. The developer implementing the orchestrator startup sequence (M24) needs them.

**Broker unreachable:**
```
OpenGolem: Token Broker is not reachable.
  Expected socket: data/sockets/broker.sock
  The system is in safe-hold: messages will queue but no tasks will run.

  Recovery (single process / npm run dev): restart OpenGolem.
  Recovery (separate processes): start the Token Broker before the orchestrator.
```

**Cato socket missing:**
```
OpenGolem: Cato oversight process is not reachable.
  Expected socket: data/sockets/cato.sock
  No containers will be spawned until Cato is reachable.
  This is by design — all agent actions require Cato approval.

  Recovery (single process / npm run dev): restart OpenGolem.
  Recovery (separate processes): start Cato before the orchestrator.
```

**Why:** The orchestrator spec §3.1 defines startup steps 4–5 as blocking waits for broker and Cato, but does not specify what text is written during the wait or on failure. Without specified messages, the developer will write whatever they think is appropriate, and the result may not be actionable for a non-expert.

**Segment:** Both. Enterprise operators benefit from the socket path; non-experts benefit from the restart instruction.

---

### R4 — Specify startup error messages for missing credentials

**What to change:** Define two error messages for the Token Broker credential path:

**`.env` file absent:**
```
OpenGolem: No credential configuration found.
  Expected: a .env file in the project directory.

  Quick fix:
    cp .env.example .env
    Then add your Anthropic API key to .env.

  See README.md → Quick start for credential setup.
```

**`.env` present but credential variable missing:**
```
OpenGolem: Credential not set in .env.
  ANTHROPIC_API_KEY is not set and CLAUDE_CODE_OAUTH_TOKEN is not set.

  Open .env and uncomment one of:
    ANTHROPIC_API_KEY=your-key-here     (from console.anthropic.com)
    CLAUDE_CODE_OAUTH_TOKEN=your-token  (from: claude setup-token)
```

**Why:** The current behavior (per channel-adapters-spec.md, failure mode "Channel credential absent at startup") is that the adapter "logs a startup error naming the missing credential." Naming the variable is correct but insufficient — the error must also point to where to set it.

**Segment:** Primarily non-expert.

---

### R5 — Add an agent container image existence check at startup

**What to change:** Before the orchestrator accepts any messages (before displaying the `opengolem>` prompt), check for the existence of the agent container image:

```
OpenGolem: Agent container image not found.
  Expected image: opengolem-agent

  Build it with:
    ./container/build.sh

  This takes 2–5 minutes on first run.
```

**Why:** If the user runs `npm run dev` without having run `./container/build.sh`, the first message they send will trigger a container spawn that fails with a Docker "no such image" error. This error appears in logs, not at the TUI prompt. The user sees their message disappear with no response. Checking at startup and reporting before the prompt appears converts a silent mid-flow failure into a directed pre-flight failure.

**Segment:** Primarily non-expert.

---

### R6 — Reframe `npm test` in the quick start

**What to change:** In README.md, change the quick start sequence from:

```bash
npm test              # 505 tests, all green
npm run dev           # opengolem> prompt
```

to:

```bash
npm run dev           # opengolem> prompt
npm test              # optional: verify your installation (563 tests)
```

Or move `npm test` to an explicit "Verify your installation" section after the quick start block.

Also correct the test count from 505 to 563, consistent with `CLAUDE.md`.

**Why:** Running a test suite is not a setup step for most users. Its current placement implies it is a prerequisite; its current count (505) conflicts with the actual count (563). Both issues create unnecessary confusion at a moment when the user wants to get to the prompt as quickly as possible.

**Segment:** Primarily non-expert.

---

### R7 — Add progressive disclosure for credential backend options

**What to change:** In README.md, replace the single `OPENGOLEM_CREDENTIAL_BACKEND` row in the configuration table with a "Credential backends" subsection placed *after* the quick start and *before* the full configuration table:

```
## Credential backends

**Personal use (default):** `OPENGOLEM_CREDENTIAL_BACKEND=env`
Your API key lives in `.env`. Correct for a single user on a trusted machine.

**Shared or always-on deployment:** `OPENGOLEM_CREDENTIAL_BACKEND=bitwarden`
Keys live in Bitwarden. Requires `BW_SESSION`, `BW_ITEM_NAME`, `BW_FIELD_NAME`.

**Enterprise with OneCLI vault:** `OPENGOLEM_CREDENTIAL_BACKEND=onecli`
Keys are resolved through your OneCLI gateway. Requires `ONECLI_GATEWAY_URL`
and `ONECLI_GATEWAY_TOKEN`.

If unsure, start with `env`.
```

**Why:** The current configuration reference presents all three backends in a flat table row with no hierarchy and no recommendation. A non-expert reads `env | bitwarden | onecli` and does not know that `env` is the correct starting point. The final sentence ("If unsure, start with `env`") removes decision burden without removing the options for enterprise operators.

**Segment:** Both. The hierarchy helps non-experts choose; the structured description helps enterprise operators identify the right upgrade path.

---

### R8 — Document security mode behavior, including risk of `power` mode

**What to change:** In README.md, expand the `OPENGOLEM_SECURITY_MODE` table entry:

| Variable | Default | Description |
|---|---|---|
| `OPENGOLEM_SECURITY_MODE` | `golem_guard` | Inspector mode. `golem_guard`: all Call Inspector checks enforced automatically (recommended). `supervised`: checks enforced; ambiguous cases require your confirmation. `power`: reduced automatic enforcement — for advanced users who understand the tradeoffs. **Do not change from `golem_guard` unless you have a specific reason.** |

**Why:** The name `power` implies strength or capability. A non-expert may interpret it as more security rather than less. The current documentation does not describe what changes between modes. The recommended change adds behavioral description and an explicit "do not change" note. This is a responsible AI consideration: `power` mode materially weakens the inspection layer and its documentation must not invite casual use.

**Segment:** Both. The "do not change" note is primarily for non-experts. Enterprise operators who have a reason to use `supervised` or `power` mode will still find the modes documented.

---

### R9 — Add a Telegram setup flow as a numbered sequence

**What to change:** In README.md, convert the Telegram channel notes from feature description to a numbered setup flow:

```
## Adding Telegram

1. Create a bot at https://t.me/botfather and copy the token.
2. Add to `.env`:
     TELEGRAM_BOT_TOKEN=<your token>
     OPENGOLEM_CHANNELS=tui,telegram
     TELEGRAM_VALID_USERS=<your Telegram numeric user ID>
3. Restart OpenGolem.
4. Send any message to your bot in Telegram. Alef will respond.

**To find your Telegram user ID:** Message @userinfobot.

**For group chats:** Set TELEGRAM_ALLOW_GROUPS=1 and run /chatid in
the target group to get the group ID, then add it to sender-allowlist.json.
```

**Why:** The current channel notes paragraph introduces `TELEGRAM_ALLOW_GROUPS`, `TELEGRAM_VALID_USERS`, `sender-allowlist.json`, and the `/chatid` command simultaneously. A non-expert enabling basic DM-only Telegram does not need to understand group allowlists. The numbered flow gives them success for the common case first; group configuration is a separate step they reach only when they need it.

**Segment:** Primarily non-expert. Enterprise operators benefit from the explicit `/chatid` step.

---

### R10 — Add "Working with groups" section to README.md

**What to change:** Add a brief section explaining the group model and how to create a named group:

```
## Working with groups

OpenGolem routes every conversation to a named group. The default group is
created automatically when you first send a message.

To create a named group:
  mkdir groups/mygroup
  # Optionally: add a groups/mygroup/CLAUDE.md with initial context

Each group has its own isolated memory, container, and conversation history.
Groups cannot read each other's data.
```

**Why:** Group creation is currently implicit. A user who wants a separate context (e.g. one group for work, one for personal) has no documented path. The orchestrator creates `CLAUDE.md` automatically on first spawn, but the user must know to create the directory first.

**Segment:** Both. Non-experts need the path. Enterprise operators deploying for a team need to understand the isolation model before creating groups for multiple users.

---

### R11 — Add a skills section to README.md

**What to change:** Add a "Adding capabilities (skills)" section to README.md:

```
## Adding capabilities (skills)

OpenGolem's capabilities are extended through skills. To apply a skill,
open Claude Code in this directory and use the skill's slash command:

  /add-telegram      — Add Telegram as a channel
  /add-whatsapp      — Add WhatsApp as a channel
  /claw              — Install the command-line agent tool
  /debug             — Troubleshoot container issues
  /setup             — Re-run initial setup or reconfigure

Run any skill command to see its interactive setup flow.
```

**Why:** Skills are mentioned in the features list but the path from "I want this feature" to "I have applied this skill" is not documented in the user-facing README. The skills catalog lives in `CLAUDE.md`, which is a developer reference. The README must bridge this gap.

**Segment:** Both. Non-experts need to know skills exist and how to apply them. Enterprise operators need to know which slash commands correspond to which capabilities before they start deployment.

---

### R12 — Suppress the `opengolem>` prompt until all startup dependencies are healthy

**What to change:** In the TUI adapter, do not display the `opengolem>` prompt until the orchestrator has confirmed that the Token Broker and Cato are both healthy (orchestrator-spec.md §3.1, steps 4–8 complete). While the startup check is in progress, display a status line:

```
OpenGolem starting...
  Token Broker:  checking...
  Cato:          checking...
```

Replace with a success line when ready:

```
OpenGolem ready.
  Token Broker:  ok
  Cato:          ok
  Channels:      tui

opengolem>
```

**Why:** The current design (implied by the spec's startup sequence) does not specify what the TUI displays during the dependency health checks. A user who starts the orchestrator before the broker or Cato are ready will see either nothing or the prompt — and either interpretation (system healthy, or system broken) is plausible. Suppressing the prompt until readiness eliminates the ambiguous state entirely.

**Segment:** Both. This is especially important for non-experts who interpret the presence of a prompt as confirmation that the system is operational.

---

### R13 — Map sentinel protocol errors to visually distinct TUI output

**What to change:** When the orchestrator receives a sentinel result with `"status": "error"`, render it in the TUI with a visual distinction from agent response output. Proposed format:

```
[system error] Container failed: authentication error.
  Check your API key in .env (ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN).
  For 401 errors: verify the key is valid at console.anthropic.com.
```

For non-credential errors, the format is:
```
[system error] Container failed: <reason>.
  Check logs for details: logs/opengolem.log
```

**Why:** The sentinel protocol (`container-runner.ts` + `agent-runner/src/index.ts`) returns `"status": "error"` for any container failure, including authentication failures. This error is currently routed to the TUI as an outbound message — visually identical to an agent response. A non-expert who receives an auth error will read it as Alef speaking and may attempt to respond to it as a conversation, not diagnose it as a system error.

**Segment:** Primarily non-expert.

---

## Dead-End Inventory

A dead end is a state the user can reach during setup where no documented next step exists and no system output directs recovery.

| ID | How the user reaches this state | Current system behavior | Gap | Covers |
|----|--------------------------------|------------------------|-----|--------|
| DE-1 | Sets wrong credential variable in `.env` (e.g. sets `ANTHROPIC_API_KEY` but account requires OAuth token) | Auth error returned from container via sentinel protocol, displayed as agent response in TUI | Error output is visually identical to agent response; does not identify credential as the problem | R1, R13 |
| DE-2 | Runs `./container/build.sh` with Docker not running | Docker error output with no OpenGolem attribution | User cannot determine whether OpenGolem is broken or Docker is the problem | R2 |
| DE-3 | Runs `npm run dev` with Token Broker unreachable | Orchestrator enters safe-hold; behavior at TUI is unspecified | Prompt may appear with no indication that messages are silently queuing | R3, R12 |
| DE-4 | Runs `npm run dev` with Cato socket missing | Same as DE-3 | Same gap | R3, R12 |
| DE-5 | Runs `npm run dev` without having built the container image | First message silently fails; Docker "no such image" error appears in logs only | No startup check; TUI prompt appears and accepts input normally | R5 |
| DE-6 | `.env` file is missing entirely | Token Broker credential resolution fails with a variable-name error | Error names the variable but not that `.env` is missing or where to create it | R4 |
| DE-7 | `.env` present, both credential variables left commented | Same as DE-6 | Same gap | R4 |
| DE-8 | Sets `OPENGOLEM_CHANNELS=telegram` without `TELEGRAM_BOT_TOKEN` | Telegram adapter fails to register; adapter logs a startup error (channel-adapters-spec.md failure mode) | Log-only error; TUI advisory not specified; if running headless (no TUI), the system has no channel and no reachable surface to display the error | R3, and headless-specific: the spec does not define stderr output for headless no-channel failures |
| DE-9 | Sets `OPENGOLEM_CHANNELS=telegram` only (headless, no TUI) with an invalid bot token | System starts with no working channel; unreachable by any channel | No stderr fallback specified; logs are the only output | Write to stderr: "No channels are available. Check TELEGRAM_BOT_TOKEN and restart." |
| DE-10 | Wants to create a second group | No documented path | `mkdir groups/mygroup` is correct but not described anywhere in README.md | R10 |
| DE-11 | Wants to apply a skill | No path from README.md to skill application | Skills catalog is in `CLAUDE.md` (developer reference), not surfaced in user-facing README | R11 |
| DE-12 | API key is valid but expired or revoked | Container returns HTTP 401 via sentinel; same display issue as DE-1 | No diagnostic that maps HTTP 401 to "check your key at console.anthropic.com" | R13 |

---

## Open Questions for PM

1. **Prompt suppression (R12):** Should the TUI prompt be suppressed entirely until broker and Cato are confirmed healthy, or should the prompt appear with an advisory banner? Suppression is cleaner UX but changes current startup behavior and may break scripts that wait for the prompt to appear as a startup signal.

2. **Headless channel failure (DE-9):** When running headless with no working channel, the recommended recovery is a message to stderr. The architecture specifies no web UI and no push notification path. Confirm that stderr is the agreed fallback for headless startup failures, or identify a log file path that should be documented as the canonical failure surface.

3. **Sentinel error classification (R13, DE-1):** Mapping HTTP 401/403 from the credential proxy to a TUI-visible credential diagnostic requires either the orchestrator to inspect the container's error result and classify it, or the credential proxy to return a structured error type that the orchestrator recognizes. Which component owns this classification?

4. **Group creation documentation (R10):** Is explicit group creation (via a CLI command) on the roadmap, or is the `mkdir groups/{name}` convention intentional and permanent? The recommendation in R10 documents the current implicit model; if a CLI command is planned, the documentation should reference it instead.

5. **Test count (R6):** The test count discrepancy (README.md: 505, CLAUDE.md: 563) should be resolved. Which is authoritative, and should the README omit the count entirely to avoid future staleness?

---

*Produced: 2026-04-07 | Awaiting Jim's gate (PM approval)*
